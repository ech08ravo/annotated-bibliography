"""
Textbook API — write-proxy / backend for the annotated bibliography.

Phase 3: 5-star ratings with GitHub login (one rating per GitHub user per paper).
Designed to grow: submissions (Phase 1) and comments (Phase 4) get added as new
routers later. Storage is SQLite; auth is GitHub OAuth (web flow); the static
GitHub Pages site talks to this over HTTPS at textbook-api.webgrid.online.

Auth model (cross-origin friendly, no third-party cookies):
  1. site sends user to  GET /auth/login
  2. we bounce to GitHub, GitHub calls back to  GET /auth/callback
  3. we exchange the code, read the user, mint a signed bearer token, and
     redirect back to the site with  #token=...  in the URL fragment
  4. the site stores the token and sends it as  Authorization: Bearer <token>
"""

import os
import time
import sqlite3
import secrets
import asyncio
import logging
from collections import defaultdict, deque
from contextlib import closing
from datetime import datetime, timezone

import httpx
from itsdangerous import URLSafeTimedSerializer, BadSignature, SignatureExpired
from fastapi import FastAPI, Depends, HTTPException, Header, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse, JSONResponse
from pydantic import BaseModel, conint, constr

log = logging.getLogger("textbook-api")

# --- config (all from env; nothing secret hardcoded) -------------------------

GITHUB_CLIENT_ID = os.environ.get("GITHUB_CLIENT_ID", "")
GITHUB_CLIENT_SECRET = os.environ.get("GITHUB_CLIENT_SECRET", "")
# Signs bearer tokens. MUST be set to a long random value in production.
SESSION_SECRET = os.environ.get("SESSION_SECRET", "")
# Where to send the user back after login (the GitHub Pages site).
SITE_ORIGIN = os.environ.get("SITE_ORIGIN", "https://ech08ravo.github.io")
SITE_REDIRECT = os.environ.get("SITE_REDIRECT", SITE_ORIGIN + "/annotated-bibliography/")
# This API's own public base, used to build the OAuth callback URL.
API_BASE = os.environ.get("API_BASE", "https://textbook-api.webgrid.online")
# Comma-separated list of origins allowed to call the API from the browser.
ALLOWED_ORIGINS = [
    o.strip() for o in os.environ.get("ALLOWED_ORIGINS", SITE_ORIGIN).split(",") if o.strip()
]
DB_PATH = os.environ.get("DB_PATH", "/data/ratings.db")
TOKEN_MAX_AGE = int(os.environ.get("TOKEN_MAX_AGE", str(60 * 60 * 24 * 30)))  # 30 days

# GitHub logins allowed to delete anyone's comment. Comma-separated, e.g.
# MODERATORS=ech08ravo,someone-else
MODERATORS = {
    m.strip().lower()
    for m in os.environ.get("MODERATORS", "").split(",")
    if m.strip()
}

# Per-user write limits (requests per hour, per endpoint group).
RATE_LIMIT_COMMENTS = int(os.environ.get("RATE_LIMIT_COMMENTS", "20"))
RATE_LIMIT_RATINGS = int(os.environ.get("RATE_LIMIT_RATINGS", "60"))

# Nightly SQLite snapshots kept alongside the live db.
BACKUP_DIR = os.environ.get("BACKUP_DIR", "/data/backups")
BACKUP_KEEP = int(os.environ.get("BACKUP_KEEP", "7"))
BACKUP_INTERVAL_SECONDS = int(os.environ.get("BACKUP_INTERVAL_SECONDS", str(60 * 60 * 24)))

# Escape hatch for local development ONLY — never set this in production.
ALLOW_INSECURE_SECRET = os.environ.get("ALLOW_INSECURE_SESSION_SECRET") == "1"

# Refuse to start without a real signing secret. Previously this silently fell
# back to a hardcoded dev value, which would have made every bearer token
# forgeable by anyone reading this repo if the env var were ever unset.
if not SESSION_SECRET:
    if not ALLOW_INSECURE_SECRET:
        raise RuntimeError(
            "SESSION_SECRET is not set. Generate one with:\n"
            '  python3 -c "import secrets; print(secrets.token_urlsafe(48))"\n'
            "and set it in the environment. For local development only, you may set "
            "ALLOW_INSECURE_SESSION_SECRET=1 to run with an ephemeral random secret "
            "(all existing sessions are invalidated on every restart)."
        )
    # Random per-process, not a fixed string: tokens can't be forged from source,
    # and a restart simply logs everyone out.
    SESSION_SECRET = secrets.token_urlsafe(48)
    log.warning(
        "SESSION_SECRET unset; using an ephemeral random secret. "
        "Sessions will not survive a restart. DO NOT use this in production."
    )

signer = URLSafeTimedSerializer(SESSION_SECRET, salt="textbook-auth")

# --- tiny SQLite layer -------------------------------------------------------


def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    with closing(db()) as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS ratings (
                paper_id   TEXT    NOT NULL,
                gh_user_id INTEGER NOT NULL,
                gh_login   TEXT    NOT NULL,
                stars      INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (paper_id, gh_user_id)
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS comments (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                paper_id   TEXT    NOT NULL,
                section    TEXT    NOT NULL,
                gh_user_id INTEGER NOT NULL,
                gh_login   TEXT    NOT NULL,
                body       TEXT    NOT NULL,
                created_at INTEGER NOT NULL
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_comments_paper ON comments(paper_id)"
        )
        conn.commit()


# --- auth helpers ------------------------------------------------------------


class User(BaseModel):
    id: int
    login: str


def make_token(user: User) -> str:
    return signer.dumps({"id": user.id, "login": user.login})


def current_user(authorization: str = Header(default="")) -> User:
    if not authorization.startswith("Bearer "):
        raise HTTPException(401, "Missing bearer token")
    raw = authorization.split(" ", 1)[1]
    try:
        data = signer.loads(raw, max_age=TOKEN_MAX_AGE)
    except SignatureExpired:
        raise HTTPException(401, "Session expired, please log in again")
    except BadSignature:
        raise HTTPException(401, "Invalid token")
    return User(id=data["id"], login=data["login"])


def is_moderator(user: User) -> bool:
    return user.login.lower() in MODERATORS


# --- rate limiting -----------------------------------------------------------
#
# In-memory sliding window, keyed by (endpoint group, GitHub user id). This is
# correct because the service runs as a single uvicorn worker in one container
# (see docker-compose.yml). If it is ever scaled to multiple workers or
# replicas, each would keep its own counters and the effective limit would
# multiply — move the buckets to shared storage at that point.

_rate_buckets: "defaultdict[tuple[str, int], deque[float]]" = defaultdict(deque)
RATE_WINDOW_SECONDS = 3600


def enforce_rate_limit(bucket: str, user_id: int, limit: int) -> None:
    """Allow `limit` requests per user per hour for this bucket, else 429."""
    now = time.monotonic()
    cutoff = now - RATE_WINDOW_SECONDS
    hits = _rate_buckets[(bucket, user_id)]
    while hits and hits[0] <= cutoff:
        hits.popleft()
    if len(hits) >= limit:
        retry_after = max(1, int(hits[0] + RATE_WINDOW_SECONDS - now) + 1)
        raise HTTPException(
            429,
            f"Rate limit reached ({limit} per hour). Try again in {retry_after}s.",
            headers={"Retry-After": str(retry_after)},
        )
    hits.append(now)


def _prune_rate_buckets() -> None:
    """Drop windows that have fully aged out, so idle users don't leak memory."""
    cutoff = time.monotonic() - RATE_WINDOW_SECONDS
    for key in [k for k, v in _rate_buckets.items() if not v or v[-1] <= cutoff]:
        del _rate_buckets[key]


# --- backups -----------------------------------------------------------------
#
# The SQLite file is the only copy of every rating and comment, and unlike the
# paper JSON it does not live in git. Snapshot it on a timer using SQLite's own
# backup API, which produces a consistent copy even with concurrent writers
# (a plain file copy does not).


def _backup_once() -> str:
    os.makedirs(BACKUP_DIR, exist_ok=True)
    # Microsecond precision, not seconds: two snapshots taken in the same second
    # would otherwise resolve to the same filename and silently overwrite each
    # other. Still sorts lexicographically, which the retention sweep relies on.
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    dest = os.path.join(BACKUP_DIR, f"ratings-{stamp}.db")
    with closing(db()) as src, closing(sqlite3.connect(dest)) as dst:
        src.backup(dst)
    snapshots = sorted(
        f for f in os.listdir(BACKUP_DIR)
        if f.startswith("ratings-") and f.endswith(".db")
    )
    for stale in snapshots[:-BACKUP_KEEP] if BACKUP_KEEP > 0 else []:
        os.remove(os.path.join(BACKUP_DIR, stale))
    return dest


async def _backup_loop() -> None:
    while True:
        try:
            dest = await asyncio.to_thread(_backup_once)
            log.info("sqlite backup written: %s", dest)
        except Exception as exc:  # never let a backup failure kill the service
            log.error("sqlite backup failed: %s", exc)
        _prune_rate_buckets()
        await asyncio.sleep(BACKUP_INTERVAL_SECONDS)


# --- app ---------------------------------------------------------------------

app = FastAPI(title="Textbook API", version="0.3.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
    allow_credentials=False,
)

# Annotation sections a comment thread can attach to (+ "general" for the paper).
ALLOWED_SECTIONS = {"summary", "method", "evaluation", "relevance", "general"}


@app.on_event("startup")
async def _startup():
    init_db()
    if BACKUP_INTERVAL_SECONDS > 0:
        asyncio.create_task(_backup_loop())


@app.get("/health")
def health():
    return {"ok": True, "service": "textbook-api", "version": app.version}


# --- GitHub OAuth web flow ---------------------------------------------------


@app.get("/auth/login")
def auth_login():
    if not GITHUB_CLIENT_ID:
        raise HTTPException(500, "GITHUB_CLIENT_ID not configured")
    state = secrets.token_urlsafe(16)
    url = (
        "https://github.com/login/oauth/authorize"
        f"?client_id={GITHUB_CLIENT_ID}"
        f"&redirect_uri={API_BASE}/auth/callback"
        f"&scope=read:user"
        f"&state={state}"
    )
    return RedirectResponse(url)


@app.get("/auth/callback")
def auth_callback(code: str = "", state: str = ""):
    if not code:
        raise HTTPException(400, "Missing code")
    with httpx.Client(timeout=10) as client:
        tok = client.post(
            "https://github.com/login/oauth/access_token",
            headers={"Accept": "application/json"},
            data={
                "client_id": GITHUB_CLIENT_ID,
                "client_secret": GITHUB_CLIENT_SECRET,
                "code": code,
                "redirect_uri": f"{API_BASE}/auth/callback",
            },
        ).json()
        access = tok.get("access_token")
        if not access:
            raise HTTPException(401, "GitHub token exchange failed")
        gh = client.get(
            "https://api.github.com/user",
            headers={"Authorization": f"Bearer {access}", "Accept": "application/json"},
        ).json()
    user = User(id=gh["id"], login=gh["login"])
    token = make_token(user)
    # Hand the token back to the site via the URL fragment (never sent to a server).
    return RedirectResponse(f"{SITE_REDIRECT}#token={token}")


@app.get("/auth/me")
def auth_me(user: User = Depends(current_user)):
    return {"id": user.id, "login": user.login, "is_moderator": is_moderator(user)}


# --- ratings -----------------------------------------------------------------


class RatingIn(BaseModel):
    paper_id: str
    stars: conint(ge=1, le=5)


def _summary(conn, paper_id: str):
    row = conn.execute(
        "SELECT COUNT(*) n, AVG(stars) avg FROM ratings WHERE paper_id = ?",
        (paper_id,),
    ).fetchone()
    return {
        "paper_id": paper_id,
        "count": row["n"],
        "average": round(row["avg"], 2) if row["avg"] is not None else None,
    }


@app.post("/ratings")
def post_rating(body: RatingIn, user: User = Depends(current_user)):
    enforce_rate_limit("ratings", user.id, RATE_LIMIT_RATINGS)
    with closing(db()) as conn:
        conn.execute(
            """
            INSERT INTO ratings (paper_id, gh_user_id, gh_login, stars, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(paper_id, gh_user_id)
            DO UPDATE SET stars = excluded.stars,
                          gh_login = excluded.gh_login,
                          updated_at = excluded.updated_at
            """,
            (body.paper_id, user.id, user.login, int(body.stars), int(time.time())),
        )
        conn.commit()
        out = _summary(conn, body.paper_id)
    out["your_rating"] = int(body.stars)
    return out


@app.get("/ratings/{paper_id}")
def get_rating(paper_id: str, authorization: str = Header(default="")):
    with closing(db()) as conn:
        out = _summary(conn, paper_id)
        # include the caller's own rating if they're logged in
        your = None
        if authorization.startswith("Bearer "):
            try:
                u = current_user(authorization)
                r = conn.execute(
                    "SELECT stars FROM ratings WHERE paper_id = ? AND gh_user_id = ?",
                    (paper_id, u.id),
                ).fetchone()
                your = r["stars"] if r else None
            except HTTPException:
                your = None
    out["your_rating"] = your
    return out


@app.get("/ratings")
def all_ratings():
    """Batch averages for every rated paper — used to render stars on cards."""
    with closing(db()) as conn:
        rows = conn.execute(
            "SELECT paper_id, COUNT(*) n, AVG(stars) avg FROM ratings GROUP BY paper_id"
        ).fetchall()
    return {
        r["paper_id"]: {"count": r["n"], "average": round(r["avg"], 2)} for r in rows
    }


# --- comments (per annotation section) --------------------------------------


class CommentIn(BaseModel):
    paper_id: str
    section: str
    body: constr(strip_whitespace=True, min_length=1, max_length=5000)


def _comment_row(r):
    return {
        "id": r["id"],
        "section": r["section"],
        "login": r["gh_login"],
        "user_id": r["gh_user_id"],
        "body": r["body"],
        "created_at": r["created_at"],
    }


@app.get("/comments/{paper_id}")
def get_comments(paper_id: str):
    """All comments for a paper, oldest first. The front-end groups by section."""
    with closing(db()) as conn:
        rows = conn.execute(
            "SELECT * FROM comments WHERE paper_id = ? ORDER BY created_at ASC",
            (paper_id,),
        ).fetchall()
    return {"paper_id": paper_id, "comments": [_comment_row(r) for r in rows]}


@app.post("/comments")
def post_comment(body: CommentIn, user: User = Depends(current_user)):
    if body.section not in ALLOWED_SECTIONS:
        raise HTTPException(400, f"Invalid section. Allowed: {sorted(ALLOWED_SECTIONS)}")
    enforce_rate_limit("comments", user.id, RATE_LIMIT_COMMENTS)
    now = int(time.time())
    with closing(db()) as conn:
        cur = conn.execute(
            """
            INSERT INTO comments (paper_id, section, gh_user_id, gh_login, body, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (body.paper_id, body.section, user.id, user.login, body.body, now),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM comments WHERE id = ?", (cur.lastrowid,)).fetchone()
    return _comment_row(row)


@app.delete("/comments/{comment_id}")
def delete_comment(comment_id: int, user: User = Depends(current_user)):
    """Authors may delete their own comment; moderators may delete any."""
    moderator = is_moderator(user)
    with closing(db()) as conn:
        row = conn.execute(
            "SELECT gh_user_id, gh_login FROM comments WHERE id = ?", (comment_id,)
        ).fetchone()
        if not row:
            raise HTTPException(404, "Comment not found")
        if row["gh_user_id"] != user.id and not moderator:
            raise HTTPException(403, "You can only delete your own comment")
        conn.execute("DELETE FROM comments WHERE id = ?", (comment_id,))
        conn.commit()
    if moderator and row["gh_user_id"] != user.id:
        log.info(
            "moderator %s deleted comment %s by %s",
            user.login, comment_id, row["gh_login"],
        )
    return {"deleted": comment_id, "by_moderator": moderator and row["gh_user_id"] != user.id}
