"""Phase 10 tests: the issue read-through cache.

GitHub is stubbed and upstream calls are counted — the whole point of this
feature is that the number of upstream requests stops scaling with papers and
visitors, so the tests assert the call count, not just the payload.

    python3 test_issue_cache.py
"""
import importlib
import json
import os
import sys
import tempfile

API_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, API_DIR)

failures = []


def check(label, cond, detail=""):
    print(f"{'PASS' if cond else 'FAIL'}  {label}{'  -- ' + detail if detail and not cond else ''}")
    if not cond:
        failures.append(label)


tmp = tempfile.mkdtemp()
os.environ.update({
    "SESSION_SECRET": "test-secret-not-real",
    "DB_PATH": os.path.join(tmp, "ratings.db"),
    "BACKUP_DIR": os.path.join(tmp, "backups"),
    "BACKUP_INTERVAL_SECONDS": "0",
    "GITHUB_REPO": "ech08ravo/annotated-bibliography",
    "GITHUB_WRITE_TOKEN": "",
    "GITHUB_READ_TOKEN": "",
    "ISSUE_CACHE_TTL": "300",
})
os.environ.pop("ALLOW_INSECURE_SESSION_SECRET", None)

import main  # noqa: E402
importlib.reload(main)
from fastapi.testclient import TestClient  # noqa: E402

client = TestClient(main.app)
client.__enter__()


class FakeResponse:
    def __init__(self, status_code, payload):
        self.status_code = status_code
        self._payload = payload
        self.text = json.dumps(payload)

    def json(self):
        return self._payload


def issue(number, upvotes=0, comments=0, is_pr=False):
    d = {"number": number, "comments": comments, "reactions": {"+1": upvotes}}
    if is_pr:
        d["pull_request"] = {"url": "..."}
    return d


class FakeGitHub:
    def __init__(self, pages=None, comments=None, status=200):
        # pages: list of lists, one per upstream page
        self.pages = pages if pages is not None else [[]]
        self.comments = comments if comments is not None else []
        self.status = status
        self.calls = []          # every requested URL
        self.headers_seen = []

    def get(self, url, **kw):
        self.calls.append(url)
        self.headers_seen.append(kw.get("headers") or {})
        if self.status != 200:
            return FakeResponse(self.status, {"message": "boom"})
        if url.endswith("/comments"):
            return FakeResponse(200, self.comments)
        page = int((kw.get("params") or {}).get("page", 1))
        body = self.pages[page - 1] if page - 1 < len(self.pages) else []
        return FakeResponse(200, body)


class FakeAsyncClient:
    def __init__(self, gh):
        self._gh = gh

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def get(self, url, **kw):
        return self._gh.get(url, **kw)


def with_gh(gh, fn):
    real = main.httpx.AsyncClient
    main.httpx.AsyncClient = lambda *a, **k: FakeAsyncClient(gh)
    try:
        return fn()
    finally:
        main.httpx.AsyncClient = real


def reset_cache():
    main._issue_cache.clear()


# ---- batch stats ------------------------------------------------------------

reset_cache()
gh = FakeGitHub(pages=[[issue(1, 3, 2), issue(2, 0, 7)]])
r = with_gh(gh, lambda: client.get("/issues"))
check("returns stats keyed by issue number", r.status_code == 200 and r.json() == {
    "1": {"upvotes": 3, "comments": 2},
    "2": {"upvotes": 0, "comments": 7},
}, str(r.json()))
check("first call is a cache miss", r.headers.get("X-Cache") == "miss", str(r.headers.get("X-Cache")))
check("one upstream call for the whole repo", len(gh.calls) == 1, str(gh.calls))

# The core claim: repeated visitors cost nothing upstream.
r2 = with_gh(gh, lambda: client.get("/issues"))
check("second call is served from cache", r2.headers.get("X-Cache") == "hit")
check("cached call makes no upstream request", len(gh.calls) == 1, str(len(gh.calls)))
check("cached payload is identical", r2.json() == r.json())

for _ in range(20):
    with_gh(gh, lambda: client.get("/issues"))
check("20 more visitors still cost zero upstream calls", len(gh.calls) == 1, str(len(gh.calls)))

# ---- cache expiry -----------------------------------------------------------

reset_cache()
os.environ["ISSUE_CACHE_TTL"] = "0"
importlib.reload(main)
gh = FakeGitHub(pages=[[issue(1, 1, 1)]])
with_gh(gh, lambda: client.get("/issues"))
with_gh(gh, lambda: client.get("/issues"))
check("a zero TTL re-fetches every time", len(gh.calls) == 2, str(len(gh.calls)))
os.environ["ISSUE_CACHE_TTL"] = "300"
importlib.reload(main)

# ---- pagination and filtering ----------------------------------------------

reset_cache()
gh = FakeGitHub(pages=[[issue(i) for i in range(1, 101)], [issue(101, 5, 5)]])
r = with_gh(gh, lambda: client.get("/issues"))
check("follows pagination past a full page", "101" in r.json(), str(len(r.json())))
check("stops after a short page", len(gh.calls) == 2, str(len(gh.calls)))
check("collects every issue across pages", len(r.json()) == 101, str(len(r.json())))

reset_cache()
gh = FakeGitHub(pages=[[issue(1, 2, 2), issue(2, 9, 9, is_pr=True)]])
r = with_gh(gh, lambda: client.get("/issues"))
check("excludes pull requests from issue stats", list(r.json().keys()) == ["1"], str(r.json()))

reset_cache()
gh = FakeGitHub(pages=[[{"number": 4}]])
r = with_gh(gh, lambda: client.get("/issues"))
check("defaults missing reactions/comments to zero",
      r.json() == {"4": {"upvotes": 0, "comments": 0}}, str(r.json()))

reset_cache()
gh = FakeGitHub(pages=[[issue(1, 1, 1)] * 100 for _ in range(20)])
r = with_gh(gh, lambda: client.get("/issues"))
check("pagination is bounded by ISSUE_MAX_PAGES", len(gh.calls) <= main.ISSUE_MAX_PAGES,
      f"{len(gh.calls)} calls vs cap {main.ISSUE_MAX_PAGES}")

# ---- upstream failures ------------------------------------------------------

reset_cache()
gh = FakeGitHub(status=403)
r = with_gh(gh, lambda: client.get("/issues"))
check("upstream 403 surfaces as 502", r.status_code == 502, str(r.status_code))
check("a failed sweep is not cached",
      with_gh(FakeGitHub(pages=[[issue(1, 1, 1)]]), lambda: client.get("/issues")).status_code == 200)

# ---- comments ---------------------------------------------------------------

reset_cache()
raw = [{
    "id": 11, "body": "Good point", "created_at": "2026-01-01T00:00:00Z",
    "html_url": "https://github.com/x/y/issues/1#issuecomment-11",
    "user": {"login": "octocat", "avatar_url": "a.png", "html_url": "u",
             "node_id": "secret", "email": "leak@example.com"},
    "author_association": "OWNER",
}]
gh = FakeGitHub(comments=raw)
r = with_gh(gh, lambda: client.get("/issues/1/comments"))
check("returns comments for an issue", r.status_code == 200 and len(r.json()) == 1, str(r.json()))
c = r.json()[0]
check("passes through the rendered fields",
      (c["id"], c["body"], c["user"]["login"]) == (11, "Good point", "octocat"), str(c))
check("does not mirror GitHub's whole user object",
      set(c["user"].keys()) == {"login", "avatar_url", "html_url"}, str(c["user"].keys()))
check("drops unrendered top-level fields", "author_association" not in c, str(c.keys()))

r2 = with_gh(gh, lambda: client.get("/issues/1/comments"))
check("comments are cached per issue", r2.headers.get("X-Cache") == "hit")
check("cached comments make no upstream call", len(gh.calls) == 1, str(len(gh.calls)))

with_gh(gh, lambda: client.get("/issues/2/comments"))
check("a different issue is a separate cache entry", len(gh.calls) == 2, str(len(gh.calls)))

reset_cache()
gh404 = FakeGitHub(status=404)
check("missing issue returns 404",
      with_gh(gh404, lambda: client.get("/issues/999/comments")).status_code == 404)
check("invalid issue number is rejected",
      client.get("/issues/0/comments").status_code == 400)
check("non-numeric issue number is rejected",
      client.get("/issues/abc/comments").status_code == 422)

reset_cache()
gh = FakeGitHub(comments={"message": "unexpected shape"})
r = with_gh(gh, lambda: client.get("/issues/1/comments"))
check("a non-list comments payload yields an empty list", r.json() == [], str(r.json()))

# ---- token handling ---------------------------------------------------------

reset_cache()
gh = FakeGitHub(pages=[[issue(1)]])
with_gh(gh, lambda: client.get("/issues"))
check("sends no Authorization header when no token is set",
      "Authorization" not in gh.headers_seen[0], str(gh.headers_seen[0].keys()))

os.environ["GITHUB_READ_TOKEN"] = "ghp_read_only_fake"
importlib.reload(main)
reset_cache()
gh = FakeGitHub(pages=[[issue(1)]])
with_gh(gh, lambda: client.get("/issues"))
check("uses GITHUB_READ_TOKEN when provided",
      gh.headers_seen[0].get("Authorization") == "Bearer ghp_read_only_fake",
      str(gh.headers_seen[0].get("Authorization")))

os.environ["GITHUB_READ_TOKEN"] = ""
os.environ["GITHUB_WRITE_TOKEN"] = "ghp_write_fake"
importlib.reload(main)
check("falls back to the write token for reads",
      main.GITHUB_READ_TOKEN == "ghp_write_fake", main.GITHUB_READ_TOKEN)

# ---- unconfigured -----------------------------------------------------------

os.environ["GITHUB_REPO"] = ""
importlib.reload(main)
reset_cache()
check("unconfigured repo returns 503 for stats", client.get("/issues").status_code == 503)
check("unconfigured repo returns 503 for comments",
      client.get("/issues/1/comments").status_code == 503)
os.environ["GITHUB_REPO"] = "ech08ravo/annotated-bibliography"
importlib.reload(main)

# ---- prune ------------------------------------------------------------------

reset_cache()
main._cache_put("stale", {"x": 1}, ttl=-1)
main._cache_put("fresh", {"x": 2}, ttl=300)
main._prune_issue_cache()
check("prune drops expired entries", "stale" not in main._issue_cache)
check("prune keeps live entries", "fresh" in main._issue_cache)

client.__exit__(None, None, None)

print()
print(f"{'ALL CHECKS PASSED' if not failures else 'FAILURES: ' + ', '.join(failures)}")
sys.exit(1 if failures else 0)
