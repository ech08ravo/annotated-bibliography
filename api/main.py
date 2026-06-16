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
from contextlib import closing

import httpx
from itsdangerous import URLSafeTimedSerializer, BadSignature, SignatureExpired
from fastapi import FastAPI, Depends, HTTPException, Header, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse, JSONResponse
from pydantic import BaseModel, conint

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

signer = URLSafeTimedSerializer(SESSION_SECRET or "dev-only-insecure-secret", salt="textbook-auth")

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


# --- app ---------------------------------------------------------------------

app = FastAPI(title="Textbook API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
    allow_credentials=False,
)


@app.on_event("startup")
def _startup():
    init_db()


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
    return {"id": user.id, "login": user.login}


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
