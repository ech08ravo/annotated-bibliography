"""Phase 8 hardening tests: secret handling, rate limits, moderation, backups.

No test framework or extra dependencies — run it directly:

    python3 test_hardening.py

Runs every check, then exits non-zero if any failed, so CI can gate on it."""
import importlib
import os
import subprocess
import sys
import tempfile

API_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, API_DIR)

failures = []


def check(label, cond, detail=""):
    print(f"{'PASS' if cond else 'FAIL'}  {label}{'  -- ' + detail if detail and not cond else ''}")
    if not cond:
        failures.append(label)


# 1. Refuses to boot with no SESSION_SECRET -----------------------------------
env = {k: v for k, v in os.environ.items() if k != "SESSION_SECRET"}
env.pop("ALLOW_INSECURE_SESSION_SECRET", None)
proc = subprocess.run(
    [sys.executable, "-c", "import main"],
    cwd=API_DIR, env=env, capture_output=True, text=True,
)
check("refuses to start without SESSION_SECRET", proc.returncode != 0)
check("error message names SESSION_SECRET", "SESSION_SECRET is not set" in proc.stderr)

# 2. Dev escape hatch boots with an ephemeral secret ---------------------------
env2 = dict(env, ALLOW_INSECURE_SESSION_SECRET="1", DB_PATH=tempfile.mktemp(suffix=".db"))
proc2 = subprocess.run(
    [sys.executable, "-c", "import main; print('booted')"],
    cwd=API_DIR, env=env2, capture_output=True, text=True,
)
check("ALLOW_INSECURE_SESSION_SECRET=1 boots", "booted" in proc2.stdout, proc2.stderr[-400:])
check("insecure boot logs a warning", "ephemeral random secret" in proc2.stderr, proc2.stderr[-300:])

# 3. Live app behaviour --------------------------------------------------------
tmp = tempfile.mkdtemp()
os.environ.update({
    "SESSION_SECRET": "test-secret-not-real",
    "DB_PATH": os.path.join(tmp, "ratings.db"),
    "BACKUP_DIR": os.path.join(tmp, "backups"),
    "MODERATORS": "TheMod",            # deliberately mixed case
    "RATE_LIMIT_COMMENTS": "3",
    "RATE_LIMIT_RATINGS": "2",
    "BACKUP_INTERVAL_SECONDS": "0",    # don't run the timer during tests
    "BACKUP_KEEP": "2",
})
os.environ.pop("ALLOW_INSECURE_SESSION_SECRET", None)

import main  # noqa: E402
importlib.reload(main)
from fastapi.testclient import TestClient  # noqa: E402

# Enter the context manager so FastAPI's startup event actually fires
# (plain TestClient(app) skips it, leaving the schema uncreated).
client = TestClient(main.app)
client.__enter__()

r = client.get("/health")
check("/health reports 0.3.0", r.json().get("version") == "0.3.0", str(r.json()))

author = main.User(id=1, login="author")
mod = main.User(id=2, login="themod")          # lowercase vs MODERATORS=TheMod
stranger = main.User(id=3, login="stranger")
hdr = lambda u: {"Authorization": f"Bearer {main.make_token(u)}"}

check("moderator match is case-insensitive", main.is_moderator(mod))
check("non-moderator not elevated", not main.is_moderator(stranger))
check("/auth/me exposes is_moderator",
      client.get("/auth/me", headers=hdr(mod)).json().get("is_moderator") is True)

# Rate limiting: comments limit is 3
codes = [
    client.post("/comments", headers=hdr(author),
                json={"paper_id": "p1", "section": "summary", "body": f"c{i}"}).status_code
    for i in range(4)
]
check("first 3 comments accepted", codes[:3] == [200, 200, 200], str(codes))
check("4th comment rate-limited (429)", codes[3] == 429, str(codes))

r = client.post("/comments", headers=hdr(author),
                json={"paper_id": "p1", "section": "summary", "body": "again"})
check("429 carries Retry-After header", "retry-after" in {k.lower() for k in r.headers})

# Limits are per user, not global
r = client.post("/comments", headers=hdr(stranger),
                json={"paper_id": "p1", "section": "summary", "body": "hi"})
check("rate limit is per-user", r.status_code == 200, str(r.status_code))

# Ratings have their own bucket (limit 2) and weren't consumed by comments
rcodes = [
    client.post("/ratings", headers=hdr(author),
                json={"paper_id": "p1", "stars": 4}).status_code
    for _ in range(3)
]
check("ratings bucket independent of comments", rcodes[:2] == [200, 200], str(rcodes))
check("ratings limit enforced", rcodes[2] == 429, str(rcodes))

# Validation still runs before the limiter
r = client.post("/comments", headers=hdr(stranger),
                json={"paper_id": "p1", "section": "bogus", "body": "x"})
check("invalid section still rejected (400)", r.status_code == 400, str(r.status_code))

# Moderation
cid = client.get("/comments/p1").json()["comments"][0]["id"]
check("stranger cannot delete another's comment",
      client.delete(f"/comments/{cid}", headers=hdr(stranger)).status_code == 403)
r = client.delete(f"/comments/{cid}", headers=hdr(mod))
check("moderator can delete any comment", r.status_code == 200, str(r.status_code))
check("response flags moderator action", r.json().get("by_moderator") is True, str(r.json()))

own = client.post("/comments", headers=hdr(stranger),
                  json={"paper_id": "p2", "section": "general", "body": "mine"}).json()
r = client.delete(f"/comments/{own['id']}", headers=hdr(stranger))
check("author still deletes own comment", r.status_code == 200)
check("own deletion not flagged as moderated", r.json().get("by_moderator") is False, str(r.json()))
check("deleting missing comment 404s",
      client.delete("/comments/99999", headers=hdr(mod)).status_code == 404)
check("delete requires auth", client.delete(f"/comments/{cid}").status_code == 401)

# Backups: snapshot is a real, readable copy; retention trims oldest
import sqlite3  # noqa: E402
paths = [main._backup_once() for _ in range(3)]
check("snapshots get unique filenames", len(set(paths)) == 3, str(paths))
check("newest snapshots retained", all(os.path.exists(p) for p in paths[-2:]))
check("oldest snapshot pruned by retention", not os.path.exists(paths[0]))
with sqlite3.connect(paths[-1]) as snap:
    rows = snap.execute("SELECT COUNT(*) FROM ratings").fetchone()[0]
check("snapshot contains rating data", rows >= 1, f"rows={rows}")
kept = [f for f in os.listdir(os.environ["BACKUP_DIR"]) if f.endswith(".db")]
check("retention keeps only BACKUP_KEEP=2", len(kept) == 2, f"kept={len(kept)}")

# Bucket pruning doesn't wipe active windows
before = len(main._rate_buckets)
main._prune_rate_buckets()
check("prune retains active windows", len(main._rate_buckets) == before,
      f"{before} -> {len(main._rate_buckets)}")

client.__exit__(None, None, None)

# 4. Startup with backups enabled schedules the task without erroring ----------
os.environ["BACKUP_INTERVAL_SECONDS"] = "3600"
os.environ["DB_PATH"] = os.path.join(tmp, "ratings2.db")
importlib.reload(main)
with TestClient(main.app) as c2:
    check("startup with backups enabled serves requests",
          c2.get("/health").status_code == 200)
check("schema created on startup", os.path.exists(os.environ["DB_PATH"]))

print()
print(f"{'ALL CHECKS PASSED' if not failures else 'FAILURES: ' + ', '.join(failures)}")
sys.exit(1 if failures else 0)
