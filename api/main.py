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
import re
import json
import time
import base64
import sqlite3
import secrets
import asyncio
import logging
from typing import Any, Dict, List, Optional
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
RATE_LIMIT_SUBMISSIONS = int(os.environ.get("RATE_LIMIT_SUBMISSIONS", "10"))

# --- paper submissions (Phase 7) ---------------------------------------------
# "owner/repo" the proxy commits papers into, and a token with contents:write
# on it. Submissions are disabled (503) unless both are set.
GITHUB_REPO = os.environ.get("GITHUB_REPO", "")
GITHUB_WRITE_TOKEN = os.environ.get("GITHUB_WRITE_TOKEN", "")
# Commit target. Point this at a review branch instead of main if you'd rather
# submissions arrive as a PR than land directly.
SUBMIT_BRANCH = os.environ.get("SUBMIT_BRANCH", "main")
# If non-empty, only these GitHub logins may submit. Empty = any signed-in user.
SUBMIT_ALLOWLIST = {
    s.strip().lower()
    for s in os.environ.get("SUBMIT_ALLOWLIST", "").split(",")
    if s.strip()
}
MAX_PDF_BYTES = int(os.environ.get("MAX_PDF_BYTES", str(10 * 1024 * 1024)))

# --- issue read-through cache (Phase 10) -------------------------------------
# Reading issue stats straight from the browser costs one unauthenticated GitHub
# request per paper per visitor, against a 60/hour per-IP ceiling. Proxying and
# caching turns that into one upstream sweep per TTL for the whole site.
# A token is optional but raises the upstream ceiling from 60 to 5,000/hour.
GITHUB_READ_TOKEN = os.environ.get("GITHUB_READ_TOKEN", "") or GITHUB_WRITE_TOKEN
ISSUE_CACHE_TTL = int(os.environ.get("ISSUE_CACHE_TTL", "300"))
# Safety stop for pagination, so a huge repo can't wedge a request.
ISSUE_MAX_PAGES = int(os.environ.get("ISSUE_MAX_PAGES", "10"))

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
        _prune_issue_cache()
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


# --- issue stats + comments (read-through cache) -----------------------------
#
# The site previously read these straight from GitHub in the browser: one request
# per paper, per visitor, against an unauthenticated 60/hour per-IP limit — so a
# shared office or campus IP ran dry after a couple of page loads, and because the
# front-end swallowed the failures, counts silently rendered as zero.
#
# Here the whole issue list is fetched in ONE upstream sweep and cached, so the
# cost is independent of both the number of papers and the number of visitors.

_issue_cache: Dict[str, tuple] = {}


def _cache_get(key: str):
    hit = _issue_cache.get(key)
    if not hit:
        return None
    expires_at, value = hit
    if expires_at < time.monotonic():
        _issue_cache.pop(key, None)
        return None
    return value


def _cache_put(key: str, value, ttl: Optional[int] = None) -> None:
    _issue_cache[key] = (time.monotonic() + (ttl if ttl is not None else ISSUE_CACHE_TTL), value)


def _prune_issue_cache() -> None:
    """Drop expired entries so keys nobody asks for again don't linger."""
    now = time.monotonic()
    for key in [k for k, (expires_at, _) in _issue_cache.items() if expires_at < now]:
        _issue_cache.pop(key, None)


def _gh_read_headers() -> Dict[str, str]:
    h = {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if GITHUB_READ_TOKEN:
        h["Authorization"] = f"Bearer {GITHUB_READ_TOKEN}"
    return h


async def _fetch_issue_stats() -> Dict[str, Dict[str, int]]:
    """One paginated sweep of the repo's issues -> {number: {upvotes, comments}}."""
    stats: Dict[str, Dict[str, int]] = {}
    async with httpx.AsyncClient(timeout=20) as client:
        for page in range(1, ISSUE_MAX_PAGES + 1):
            r = await client.get(
                f"{GITHUB_API}/repos/{GITHUB_REPO}/issues",
                params={"state": "all", "per_page": 100, "page": page},
                headers=_gh_read_headers(),
            )
            if r.status_code >= 400:
                raise HTTPException(502, f"GitHub issue read failed ({r.status_code}).")
            batch = r.json()
            if not isinstance(batch, list) or not batch:
                break
            for issue in batch:
                # The issues endpoint also returns pull requests; skip them.
                if "pull_request" in issue:
                    continue
                reactions = issue.get("reactions") or {}
                stats[str(issue.get("number"))] = {
                    "upvotes": reactions.get("+1", 0) or 0,
                    "comments": issue.get("comments", 0) or 0,
                }
            if len(batch) < 100:
                break
    return stats


@app.get("/issues")
async def issue_stats():
    """Upvote and comment counts for every issue, keyed by issue number."""
    if not GITHUB_REPO:
        raise HTTPException(503, "GITHUB_REPO is not configured.")
    cached = _cache_get("issues")
    if cached is not None:
        return JSONResponse(cached, headers={"X-Cache": "hit"})
    stats = await _fetch_issue_stats()
    _cache_put("issues", stats)
    return JSONResponse(stats, headers={"X-Cache": "miss"})


@app.get("/issues/{number}/comments")
async def issue_comments(number: int):
    """GitHub discussion comments for one issue, cached."""
    if not GITHUB_REPO:
        raise HTTPException(503, "GITHUB_REPO is not configured.")
    if number < 1:
        raise HTTPException(400, "Invalid issue number.")
    key = f"comments:{number}"
    cached = _cache_get(key)
    if cached is not None:
        return JSONResponse(cached, headers={"X-Cache": "hit"})

    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.get(
            f"{GITHUB_API}/repos/{GITHUB_REPO}/issues/{number}/comments",
            params={"per_page": 100},
            headers=_gh_read_headers(),
        )
    if r.status_code == 404:
        raise HTTPException(404, f"Issue #{number} not found.")
    if r.status_code >= 400:
        raise HTTPException(502, f"GitHub comment read failed ({r.status_code}).")

    payload = r.json()
    if not isinstance(payload, list):
        payload = []
    # Pass through only the fields the site renders, so the response stays small
    # and we aren't mirroring GitHub's whole user object to the browser.
    out = [
        {
            "id": c.get("id"),
            "body": c.get("body", ""),
            "created_at": c.get("created_at", ""),
            "html_url": c.get("html_url", ""),
            "user": {
                "login": (c.get("user") or {}).get("login", ""),
                "avatar_url": (c.get("user") or {}).get("avatar_url", ""),
                "html_url": (c.get("user") or {}).get("html_url", ""),
            },
        }
        for c in payload
    ]
    _cache_put(key, out)
    return JSONResponse(out, headers={"X-Cache": "miss"})


# --- paper submissions -------------------------------------------------------
#
# Closes the Phase 1 write path: the site can now commit a paper (and its PDF)
# through this proxy instead of sending the user to GitHub's prefilled new-file
# form, which required repo write access and broke on annotations over ~7.5KB
# of URL.

# A paper id becomes a path inside the repo, so it is the one field that must be
# validated strictly rather than sanitised. Lowercase alphanumerics and interior
# hyphens only: no dots, no slashes, no leading/trailing hyphen. This is what
# stops "../../.github/workflows/evil" from being written.
PAPER_ID_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$")

GITHUB_API = "https://api.github.com"


class AnnotationIn(BaseModel):
    author_github: str = ""
    summary: constr(strip_whitespace=True, max_length=20000) = ""
    method: constr(strip_whitespace=True, max_length=20000) = ""
    evaluation: constr(strip_whitespace=True, max_length=20000) = ""
    relevance: constr(strip_whitespace=True, max_length=20000) = ""


class PaperIn(BaseModel):
    # extra="allow" so fields the front-end adds later (pages, citations, ...)
    # survive the round trip rather than being silently dropped.
    model_config = {"extra": "allow"}

    id: str
    title: constr(strip_whitespace=True, min_length=1, max_length=500)
    authors: List[constr(strip_whitespace=True, min_length=1, max_length=200)] = []
    year: Optional[int] = None
    venue: str = ""
    doi: str = ""
    url: str = ""
    tags: List[constr(strip_whitespace=True, max_length=100)] = []
    annotation: AnnotationIn = AnnotationIn()
    highlights: List[Any] = []


class SubmissionIn(BaseModel):
    paper: PaperIn
    pdf_base64: Optional[str] = None


def _gh_headers() -> Dict[str, str]:
    return {
        "Authorization": f"Bearer {GITHUB_WRITE_TOKEN}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }


async def _gh_get_file(client: httpx.AsyncClient, path: str) -> Optional[dict]:
    """Return the file's metadata, or None if it doesn't exist."""
    r = await client.get(
        f"{GITHUB_API}/repos/{GITHUB_REPO}/contents/{path}",
        params={"ref": SUBMIT_BRANCH},
        headers=_gh_headers(),
    )
    if r.status_code == 404:
        return None
    if r.status_code >= 400:
        raise HTTPException(502, f"GitHub read failed ({r.status_code}).")
    return r.json()


async def _gh_put_file(
    client: httpx.AsyncClient, path: str, content: bytes, message: str, sha: Optional[str] = None
) -> dict:
    body = {
        "message": message,
        "content": base64.b64encode(content).decode("ascii"),
        "branch": SUBMIT_BRANCH,
    }
    if sha:
        body["sha"] = sha
    r = await client.put(
        f"{GITHUB_API}/repos/{GITHUB_REPO}/contents/{path}", json=body, headers=_gh_headers()
    )
    if r.status_code not in (200, 201):
        # Surface the status but not GitHub's body, which can echo the token.
        raise HTTPException(502, f"GitHub write failed for {path} ({r.status_code}).")
    return r.json()


@app.post("/papers")
async def submit_paper(body: SubmissionIn, user: User = Depends(current_user)):
    enforce_rate_limit("submissions", user.id, RATE_LIMIT_SUBMISSIONS)

    if SUBMIT_ALLOWLIST and user.login.lower() not in SUBMIT_ALLOWLIST:
        raise HTTPException(403, "Your account is not on the submission allowlist.")
    if not (GITHUB_REPO and GITHUB_WRITE_TOKEN):
        raise HTTPException(
            503,
            "Submissions are not configured on this server. "
            "Set GITHUB_REPO and GITHUB_WRITE_TOKEN to enable them.",
        )

    paper = body.paper.model_dump()
    # Drop UI-internal markers (e.g. _pdfPending) that extra="allow" let through.
    paper = {k: v for k, v in paper.items() if not k.startswith("_")}

    paper["id"] = pid = str(paper["id"]).strip().lower()
    if not PAPER_ID_RE.match(pid):
        raise HTTPException(
            400,
            "Invalid paper id. Use lowercase letters, digits and hyphens, "
            "e.g. 'kuhn-1962-structure'.",
        )
    if not paper["authors"]:
        raise HTTPException(400, "At least one author is required.")

    # The annotation is credited to the authenticated user, never to whatever
    # the client claimed.
    paper["annotation"]["author_github"] = user.login

    pdf_bytes: Optional[bytes] = None
    if body.pdf_base64:
        try:
            pdf_bytes = base64.b64decode(body.pdf_base64, validate=True)
        except Exception:
            raise HTTPException(400, "pdf_base64 is not valid base64.")
        if len(pdf_bytes) > MAX_PDF_BYTES:
            raise HTTPException(413, f"PDF exceeds {MAX_PDF_BYTES // (1024 * 1024)} MB.")
        if not pdf_bytes.startswith(b"%PDF-"):
            raise HTTPException(400, "That file is not a PDF.")

    json_path = f"papers/{pid}.json"
    pdf_path = f"papers/pdfs/{pid}.pdf"

    async with httpx.AsyncClient(timeout=30) as client:
        if await _gh_get_file(client, json_path):
            raise HTTPException(409, f"A paper with id '{pid}' already exists.")

        # Store the PDF first and only then reference it from the JSON. Doing it
        # the other way round is how a paper ends up pointing at a PDF that was
        # never uploaded (the phantom-PDF bug fixed in #4).
        if pdf_bytes:
            existing = await _gh_get_file(client, pdf_path)
            await _gh_put_file(
                client, pdf_path, pdf_bytes,
                f"Add PDF for {pid} (submitted by @{user.login})",
                sha=(existing or {}).get("sha"),
            )
            # Paths are stored relative to papers/ — js/paper.js resolves
            # `papers/${paper.pdf}`.
            paper["pdf"] = f"pdfs/{pid}.pdf"
        else:
            paper.pop("pdf", None)

        content = (json.dumps(paper, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
        result = await _gh_put_file(
            client, json_path, content,
            f"Add paper: {paper['title'][:60]} (submitted by @{user.login})",
        )

    log.info("paper %s submitted by %s", pid, user.login)
    return {
        "id": pid,
        "path": json_path,
        "pdf_path": pdf_path if pdf_bytes else None,
        "branch": SUBMIT_BRANCH,
        "commit_url": (result.get("commit") or {}).get("html_url", ""),
        "file_url": (result.get("content") or {}).get("html_url", ""),
    }


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
