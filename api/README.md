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
| POST   | `/papers`            | bearer | submit a paper: commits `papers/<id>.json` (+ optional PDF) |
| GET    | `/issues`            | no     | upvote/comment counts for every issue, cached |
| GET    | `/issues/{n}/comments`| no    | GitHub discussion comments for one issue, cached |

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

## Issue reads (`GET /issues`)

The site used to read upvote and comment counts straight from GitHub in the
browser: **one request per paper, per visitor**, against an unauthenticated
60/hour **per-IP** limit. A shared office or campus IP ran dry after a couple of
page loads, and because the front-end swallowed the errors the counts silently
rendered as zero rather than failing visibly.

`GET /issues` fetches the repo's whole issue list in **one** upstream sweep and
caches it for `ISSUE_CACHE_TTL` seconds, so upstream cost is independent of both
the paper count and the visitor count. Pull requests are filtered out;
pagination is followed up to `ISSUE_MAX_PAGES`. `GET /issues/{n}/comments` is
cached per issue and returns only the fields the page renders rather than
mirroring GitHub's full user object.

`GITHUB_READ_TOKEN` is optional — it raises the upstream ceiling from 60 to
5,000/hour, and a read-only fine-grained token suffices. Without any token the
cache still helps, since it collapses every visitor into one upstream call per
TTL. `X-Cache: hit|miss` on the response tells you which path served it.

The front-end falls back to reading GitHub directly if this proxy is
unreachable, so the site degrades rather than breaking.

## Submissions (`POST /papers`)

Body is `{"paper": {...}, "pdf_base64": "..."}` — the paper JSON the contribute
page builds, plus optionally the PDF's bytes. The proxy commits
`papers/<id>.json` (and `papers/pdfs/<id>.pdf`) to `SUBMIT_BRANCH` using
`GITHUB_WRITE_TOKEN`, and the existing `create-issues.yml` Action then mints the
paper's discussion issue.

Returns `503` unless both `GITHUB_REPO` and `GITHUB_WRITE_TOKEN` are set, so the
endpoint is inert until you deliberately configure it. The site treats that as a
signal to fall back to its GitHub pull-request flow.

Three things worth knowing:

- **The `id` is validated, not sanitised.** It becomes a path inside the repo, so
  it must match `^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$` — no dots, no slashes,
  no leading or trailing hyphen. Case and surrounding whitespace are coerced
  (lowercasing cannot introduce a path character); anything else is rejected.
  This is what stops a crafted id from writing outside `papers/`.
- **The annotation is credited to the authenticated user**, overwriting whatever
  `annotation.author_github` the client sent.
- **The PDF is committed before the JSON**, and `paper.pdf` is only set once the
  upload succeeded. Doing it the other way round is how a paper ends up
  referencing a PDF nobody uploaded.

**On the credential:** `ROADMAP.md` originally specified a GitHub App. This uses
a fine-grained PAT instead — no JWT signing, no new dependency, no App
installation to maintain, and it can be scoped to this single repository with
only `Contents: read and write`. The tradeoffs a GitHub App would buy are
short-lived auto-rotating tokens and commits attributed to a bot identity rather
than the token's owner. If you want those, `_gh_headers()` is the only function
that needs to change.

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
./venv/bin/python test_submissions.py
./venv/bin/python test_issue_cache.py
```

`test_hardening.py` covers secret handling, per-user rate limiting, moderator
deletion, and backup retention. `test_submissions.py` covers `POST /papers`:
path-traversal rejection, allowlist gating, PDF validation and ordering, and
what actually lands in the commit — with GitHub stubbed, so it never makes a
network call or writes to a real repo. `test_issue_cache.py` covers the issue
read-through cache, asserting the *number of upstream calls* rather than just the
payload — the point of the feature is that the count stops scaling with papers
and visitors. No test framework or extra dependencies; all three exit non-zero on
failure.

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
