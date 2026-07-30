"""Phase 7 submission tests: id validation, auth/gating, PDF handling, commits.

GitHub is stubbed — no test here makes a network call or writes to a real repo.
Run it directly (no test framework, no extra dependencies):

    python3 test_submissions.py

Runs every check, then exits non-zero if any failed, so CI can gate on it.
"""
import base64
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
    "GITHUB_WRITE_TOKEN": "ghp_fake_token_for_tests",
    "SUBMIT_BRANCH": "main",
    "SUBMIT_ALLOWLIST": "",
    "RATE_LIMIT_SUBMISSIONS": "50",
})
os.environ.pop("ALLOW_INSECURE_SESSION_SECRET", None)

import main  # noqa: E402
importlib.reload(main)
from fastapi.testclient import TestClient  # noqa: E402

client = TestClient(main.app)
client.__enter__()

USER = main.User(id=1, login="contributor")
OTHER = main.User(id=2, login="outsider")
hdr = lambda u: {"Authorization": f"Bearer {main.make_token(u)}"}

PAPER = {
    "id": "kuhn-1962-structure",
    "title": "The Structure of Scientific Revolutions",
    "authors": ["Thomas S. Kuhn"],
    "year": 1962,
    "venue": "University of Chicago Press",
    "doi": "",
    "url": "",
    "tags": ["philosophy"],
    "annotation": {"author_github": "someone-else", "summary": "Paradigms."},
    "highlights": [],
}
MINIMAL_PDF = b"%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n"


class FakeGitHub:
    """Records every request and answers like the Contents API."""

    def __init__(self, existing=()):
        self.existing = set(existing)
        self.puts = []      # (path, decoded bytes, message, had_sha)
        self.gets = []

    def handler(self, method, url, **kw):
        path = url.split("/contents/", 1)[1].split("?")[0] if "/contents/" in url else url
        if method == "GET":
            self.gets.append(path)
            if path in self.existing:
                return FakeResponse(200, {"sha": "deadbeef", "path": path})
            return FakeResponse(404, {"message": "Not Found"})
        body = kw.get("json") or {}
        self.puts.append((
            path,
            base64.b64decode(body.get("content", "")),
            body.get("message", ""),
            "sha" in body,
        ))
        self.existing.add(path)
        return FakeResponse(201, {
            "commit": {"html_url": f"https://github.com/x/y/commit/abc#{path}"},
            "content": {"html_url": f"https://github.com/x/y/blob/main/{path}"},
        })


class FakeResponse:
    def __init__(self, status_code, payload):
        self.status_code = status_code
        self._payload = payload
        self.text = json.dumps(payload)

    def json(self):
        return self._payload


class FakeAsyncClient:
    """Stands in for httpx.AsyncClient as an async context manager."""

    def __init__(self, gh):
        self._gh = gh

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def get(self, url, **kw):
        return self._gh.handler("GET", url, **kw)

    async def put(self, url, **kw):
        return self._gh.handler("PUT", url, **kw)


def submit(body, user=USER, existing=(), gh=None):
    """POST /papers with GitHub stubbed; returns (response, fake_github)."""
    fake = gh or FakeGitHub(existing=existing)
    real = main.httpx.AsyncClient
    main.httpx.AsyncClient = lambda *a, **k: FakeAsyncClient(fake)
    try:
        return client.post("/papers", headers=hdr(user), json=body), fake
    finally:
        main.httpx.AsyncClient = real


# ---- id validation: the security-critical part -------------------------------

TRAVERSAL_IDS = [
    "../../.github/workflows/evil",
    "../secrets",
    "foo/bar",
    "foo\\bar",
    ".hidden",
    "a.b",
    "-leading",
    "trailing-",
    "with space",
    "sym$bol",
    "",
    "x" * 61,
    "..",
    "%2e%2e%2fetc",
    "a\nb",
]

for bad in TRAVERSAL_IDS:
    r, fake = submit({"paper": {**PAPER, "id": bad}})
    label = f"rejects id {bad!r}"
    check(label, r.status_code in (400, 422), f"got {r.status_code}")
    if fake.puts:
        check(f"{label} without writing anything", False, f"wrote {[p[0] for p in fake.puts]}")

check("accepts a well-formed id", submit({"paper": PAPER})[0].status_code == 200)
check("accepts digits and interior hyphens",
      submit({"paper": {**PAPER, "id": "a1-b2-c3"}})[0].status_code == 200)
# Case and surrounding whitespace are coerced rather than rejected: lowercasing
# cannot introduce a path character, so it is safe, and it spares the user a
# pointless error. The coerced id is what gets committed, in both the filename
# and the JSON body, so the two can never disagree.
r, fake = submit({"paper": {**PAPER, "id": "  Kuhn-1962  "}})
check("coerces case and whitespace in the id", r.status_code == 200, str(r.status_code))
check("coerced id is used for the filename",
      fake.puts[0][0] == "papers/kuhn-1962.json", fake.puts[0][0])
check("coerced id is written into the JSON body",
      json.loads(fake.puts[0][1])["id"] == "kuhn-1962")
check("response reports the coerced id", r.json()["id"] == "kuhn-1962", str(r.json().get("id")))

# The regex is the contract; assert it directly too.
check("PAPER_ID_RE rejects traversal", not main.PAPER_ID_RE.match("../x"))
check("PAPER_ID_RE accepts a single character", bool(main.PAPER_ID_RE.match("a")))

# ---- auth and gating --------------------------------------------------------

check("submission requires auth", client.post("/papers", json={"paper": PAPER}).status_code == 401)

os.environ["SUBMIT_ALLOWLIST"] = "Contributor"          # deliberately mixed case
importlib.reload(main)
check("allowlisted user may submit (case-insensitive)",
      submit({"paper": PAPER})[0].status_code == 200)
r, fake = submit({"paper": PAPER}, user=OTHER)
check("non-allowlisted user is refused", r.status_code == 403, str(r.status_code))
check("refusal writes nothing", not fake.puts)

os.environ["SUBMIT_ALLOWLIST"] = ""
importlib.reload(main)
check("empty allowlist lets any signed-in user submit",
      submit({"paper": PAPER}, user=OTHER)[0].status_code == 200)

# ---- required fields --------------------------------------------------------

check("rejects a paper with no authors",
      submit({"paper": {**PAPER, "authors": []}})[0].status_code == 400)
check("rejects a blank title",
      submit({"paper": {**PAPER, "title": "   "}})[0].status_code == 422)
check("rejects a missing id", submit({"paper": {k: v for k, v in PAPER.items() if k != "id"}})[0].status_code == 422)

# ---- what actually gets committed ------------------------------------------

r, fake = submit({"paper": PAPER})
check("commits exactly one file with no PDF", len(fake.puts) == 1, str([p[0] for p in fake.puts]))
path, content, message, _ = fake.puts[0]
check("commits to papers/<id>.json", path == "papers/kuhn-1962-structure.json", path)
written = json.loads(content)
check("credits the annotation to the authenticated user, not the client's claim",
      written["annotation"]["author_github"] == "contributor",
      written["annotation"]["author_github"])
check("commit message names the submitter", "@contributor" in message, message)
check("stored JSON ends with a trailing newline", content.endswith(b"\n"))
check("stored JSON is pretty-printed", b'\n  "title"' in content)
check("no pdf field when no PDF was sent", "pdf" not in written, str(written.get("pdf")))
check("response reports the path", r.json()["path"] == "papers/kuhn-1962-structure.json")
check("response reports no pdf_path", r.json()["pdf_path"] is None)

# A client-supplied pdf field must not survive without an actual upload —
# that is precisely the phantom-PDF bug #4 had to fix by hand.
r, fake = submit({"paper": {**PAPER, "pdf": "pdfs/kuhn-1962-structure.pdf"}})
written = json.loads(fake.puts[0][1])
check("strips a phantom pdf field when no PDF is uploaded", "pdf" not in written, str(written.get("pdf")))

# UI-internal markers must not be persisted.
r, fake = submit({"paper": {**PAPER, "_pdfPending": "local.pdf"}})
written = json.loads(fake.puts[0][1])
check("drops UI-internal underscore fields", "_pdfPending" not in written, str(written.keys()))

# Unknown-but-legitimate fields survive.
r, fake = submit({"paper": {**PAPER, "pages": "1–20"}})
check("preserves extra schema fields", json.loads(fake.puts[0][1]).get("pages") == "1–20")

# ---- PDF handling -----------------------------------------------------------

r, fake = submit({"paper": PAPER, "pdf_base64": base64.b64encode(MINIMAL_PDF).decode()})
check("uploads the PDF and the JSON", len(fake.puts) == 2, str([p[0] for p in fake.puts]))
check("PDF is committed first, so the JSON never points at a missing file",
      fake.puts[0][0] == "papers/pdfs/kuhn-1962-structure.pdf", fake.puts[0][0])
check("PDF bytes round-trip intact", fake.puts[0][1] == MINIMAL_PDF)
written = json.loads(fake.puts[1][1])
check("pdf field is relative to papers/ (js/paper.js resolves papers/${pdf})",
      written["pdf"] == "pdfs/kuhn-1962-structure.pdf", str(written.get("pdf")))
check("response reports the pdf_path", r.json()["pdf_path"] == "papers/pdfs/kuhn-1962-structure.pdf")

r, fake = submit({"paper": PAPER, "pdf_base64": base64.b64encode(b"not a pdf at all").decode()})
check("rejects a non-PDF upload", r.status_code == 400, str(r.status_code))
check("rejecting a non-PDF writes nothing", not fake.puts, str([p[0] for p in fake.puts]))

r, _ = submit({"paper": PAPER, "pdf_base64": "!!! not base64 !!!"})
check("rejects malformed base64", r.status_code == 400, str(r.status_code))

os.environ["MAX_PDF_BYTES"] = "100"
importlib.reload(main)
big = b"%PDF-1.4" + b"x" * 500
r, fake = submit({"paper": PAPER, "pdf_base64": base64.b64encode(big).decode()})
check("rejects an oversized PDF with 413", r.status_code == 413, str(r.status_code))
check("oversized PDF writes nothing", not fake.puts)
os.environ.pop("MAX_PDF_BYTES")
importlib.reload(main)

# ---- conflicts and configuration -------------------------------------------

r, fake = submit({"paper": PAPER}, existing={"papers/kuhn-1962-structure.json"})
check("existing id conflicts with 409", r.status_code == 409, str(r.status_code))
check("conflict writes nothing", not fake.puts)

os.environ["GITHUB_WRITE_TOKEN"] = ""
importlib.reload(main)
r, fake = submit({"paper": PAPER})
check("unconfigured server returns 503", r.status_code == 503, str(r.status_code))
check("503 message names the missing settings", "GITHUB_WRITE_TOKEN" in r.json().get("detail", ""))
os.environ["GITHUB_WRITE_TOKEN"] = "ghp_fake_token_for_tests"
importlib.reload(main)

# ---- rate limiting ----------------------------------------------------------

os.environ["RATE_LIMIT_SUBMISSIONS"] = "2"
importlib.reload(main)
codes = []
for i in range(3):
    r, _ = submit({"paper": {**PAPER, "id": f"paper-{i}"}})
    codes.append(r.status_code)
check("submissions are rate-limited per user", codes == [200, 200, 429], str(codes))
check("submission limit is separate from the comments bucket",
      client.post("/comments", headers=hdr(USER),
                  json={"paper_id": "p", "section": "general", "body": "hi"}).status_code == 200)

client.__exit__(None, None, None)

print()
print(f"{'ALL CHECKS PASSED' if not failures else 'FAILURES: ' + ', '.join(failures)}")
sys.exit(1 if failures else 0)
