# Textbook API

Backend / write-proxy for the annotated bibliography. Serves 5-star ratings
(Phase 3, one rating per GitHub user per paper) and per-section annotation
comments (Phase 4), both behind GitHub login. Paper submissions (the Phase 1
write path) are not implemented yet — see Phase 7 in `../ROADMAP.md`.

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
| GET    | `/auth/me`           | bearer | current logged-in user (+ `is_moderator`)|
| POST   | `/ratings`           | bearer | upsert `{paper_id, stars}` (1–5)         |
| GET    | `/ratings/{paper_id}`| opt    | average + count (+ your rating if auth)  |
| GET    | `/ratings`           | no     | all paper averages (for cards)           |
| GET    | `/comments/{paper_id}`| no    | all comments for a paper (grouped by section client-side) |
| POST   | `/comments`          | bearer | post `{paper_id, section, body}`         |
| DELETE | `/comments/{id}`     | bearer | delete your own comment (moderators: any)|

Writes are rate-limited per GitHub user per hour — `POST /comments` and
`POST /ratings` have separate budgets and return `429` with a `Retry-After`
header once exhausted.

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
- `SESSION_SECRET` — **required**; the app refuses to start without it.
  Generate with `python3 -c "import secrets; print(secrets.token_urlsafe(48))"`.
  For local development only, `ALLOW_INSECURE_SESSION_SECRET=1` runs with an
  ephemeral random secret instead (every restart logs everyone out).
- `SITE_ORIGIN` / `SITE_REDIRECT` / `ALLOWED_ORIGINS` — the live GitHub Pages URL.
- `MODERATORS` — comma-separated GitHub logins allowed to delete any comment.
- `RATE_LIMIT_COMMENTS` / `RATE_LIMIT_RATINGS` — per-user writes per hour
  (default 20 / 60).
- `BACKUP_DIR` / `BACKUP_KEEP` / `BACKUP_INTERVAL_SECONDS` — nightly SQLite
  snapshots and how many to retain. Set the interval to `0` to disable.

`/health` and `GET /ratings` work without OAuth configured; login and posting
ratings need the GitHub credentials filled in.

## Backups

The SQLite file holds every rating and comment and — unlike the paper JSON — does
not live in git. A background task snapshots it to `BACKUP_DIR` on a timer using
SQLite's own backup API, which produces a consistent copy even while writes are
in flight (a plain `cp` does not). Snapshots are pruned to the newest
`BACKUP_KEEP`. Restore by stopping the container and copying a snapshot over
`ratings.db`. The volume itself is still a single host — copy snapshots off-box
if the data matters.

## Tests

```bash
cd api
python3 -m venv venv && ./venv/bin/pip install -r requirements.txt
./venv/bin/python test_hardening.py
```

Covers secret handling, per-user rate limiting, moderator deletion, and backup
retention. No test framework or extra dependencies; exits non-zero on failure.

## Rate limiting caveat

Rate-limit counters are held in memory, which is correct for the current
deployment (one uvicorn worker in one container). If this is ever scaled to
multiple workers or replicas, each would keep its own counters and the effective
limit would multiply — move the buckets to shared storage at that point.

## nginx

The vhost in `nginx/textbook-api.conf` is appended to the nginx container's
existing config (`/home/ubuntu/nginx/webgrid.conf`). It adds the
`textbook-api.webgrid.online` server blocks only; the webgrid.online blocks are
untouched. Always `nginx -t` before reloading.
