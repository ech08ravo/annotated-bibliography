# Textbook API

Backend / write-proxy for the annotated bibliography. Phase 3 = 5-star ratings
with GitHub login (one rating per GitHub user per paper). Built to grow:
submissions (Phase 1) and comments (Phase 4) become additional routers later.

- **Stack:** FastAPI + SQLite, runs as a Docker container.
- **Host:** the DreamCompute box, behind the existing nginx container.
- **Public URL:** https://textbook-api.webgrid.online
- **Internal:** container listens on the docker bridge at `172.17.0.1:8090`;
  nginx terminates TLS and proxies in. The API is never exposed directly.

## Endpoints

| Method | Path                 | Auth   | Purpose                                  |
|--------|----------------------|--------|------------------------------------------|
| GET    | `/health`            | no     | liveness check                           |
| GET    | `/auth/login`        | no     | start GitHub OAuth, redirects to GitHub  |
| GET    | `/auth/callback`     | no     | OAuth callback; redirects back with token|
| GET    | `/auth/me`           | bearer | current logged-in user                   |
| POST   | `/ratings`           | bearer | upsert `{paper_id, stars}` (1–5)         |
| GET    | `/ratings/{paper_id}`| opt    | average + count (+ your rating if auth)  |
| GET    | `/ratings`           | no     | all paper averages (for cards)           |

## Deploy (on the server)

```bash
cd /home/ubuntu
git clone https://github.com/ech08ravo/annotated-bibliography.git textbook   # first time
cd textbook/api
cp .env.example .env          # then fill it in (see below)
docker compose up -d --build
curl -s http://172.17.0.1:8090/health
```

### .env

- `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` — from a GitHub OAuth App whose
  callback URL is `https://textbook-api.webgrid.online/auth/callback`.
- `SESSION_SECRET` — `python3 -c "import secrets; print(secrets.token_urlsafe(48))"`
- `SITE_ORIGIN` / `SITE_REDIRECT` / `ALLOWED_ORIGINS` — the live GitHub Pages URL.

`/health` and `GET /ratings` work without OAuth configured; login and posting
ratings need the GitHub credentials filled in.

## nginx

The vhost in `nginx/textbook-api.conf` is appended to the nginx container's
existing config (`/home/ubuntu/nginx/webgrid.conf`). It adds the
`textbook-api.webgrid.online` server blocks only; the webgrid.online blocks are
untouched. Always `nginx -t` before reloading.
