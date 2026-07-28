# Roadmap — Shared Annotated Bibliography

Planning doc translating the feature wishlist into a sequenced, architecture-aware plan.

**Status (2026-07):** Phases 0–6 are built and live. The static site is deployed on
GitHub Pages and the auth/write proxy runs at `textbook-api.webgrid.online`. Remaining
work is polish and real data rather than new architecture — see the per-phase notes below.

## Guiding principle

The site stays a **static site on GitHub Pages**, and data lives **in GitHub wherever it
can**. We only reach for an external server for the things GitHub genuinely can't do
cleanly (authenticated writes on a user's behalf, and rating aggregation).

## Architecture decisions

- **Hosting:** unchanged — static site served from the repo (GitHub Pages).
- **Data home:** the repo itself (paper JSON + optional PDF) and GitHub Issues (comment
  threads + upvotes), read unauthenticated as today.
- **Write path (new):** a small **auth/write proxy** running on your own server, holding a
  **GitHub App** credential. The static site sends authenticated user actions (submit a
  paper, rate, comment) to the proxy, which commits to the repo / posts the issue on the
  user's behalf. This is the one new piece of infrastructure, and it's deliberately thin.
- **Citation data:** fetched by a **scheduled GitHub Action** from a free source
  (OpenAlex or Semantic Scholar; scite.ai proper if a token is available) and written into
  each paper's JSON. No live server involved.
- **Ratings:** stored as App-committed data files in the repo, aggregated for display. If
  the GitHub route proves too clunky, fall back to a small table on your own server.

## What underpins what

```
auth/write proxy (your server + GitHub App)
        │
        ├── Phase 1  Easy submission + commentary   (needs write path)
        ├── Phase 3  5-star ratings                  (needs write path + storage)
        └── Phase 4  Comments on annotations         (needs write path)

independent front-end wins (no proxy needed):
        ├── Phase 2  Browsing (search / filter / sort)
        ├── Phase 5  Citation data (Action-driven)
        └── Phase 6  Export curated reference list
```

Phases 2 and 6 are pure front-end and can ship early for quick momentum while the proxy is
stood up.

---

## Phase 0 — Config & deploy hygiene (quick) — ✅ done

Repo coordinates are `ech08ravo/annotated-bibliography`; Pages is live; the Actions run
green against it.


`js/github-api.js` currently points at `GH_OWNER = "ech08ravo"`,
`GH_REPO = "annotated-bibliography"`. Confirm the real repo coordinates, enable GitHub
Pages, and verify the existing Actions (`import-ris.yml`, `create-issues.yml`) run against
the live repo. Foundation for everything else.

## Phase 1 — Easy "submit a document + commentary" (first build) — ✅ done

The contribution flow accepts any of:

- an **RIS or BibTeX (.bib)** bibliographic file,
- a **PDF**, or
- a **link / DOI** (metadata auto-fetched via Crossref/OpenAlex),

plus a **document-level commentary** (the existing summary / method / evaluation /
relevance annotation). On submit, the proxy creates the paper JSON (and stores the PDF if
provided) and the existing Action mints its discussion issue.

Work: extend `js/ris-parser.js` to also parse BibTeX; extend `contribute.html` /
`contribute.js` for the three input modes + PDF upload; wire the write path through the
proxy (fallback: today's "download JSON → drop in `imports/`" flow).

## Phase 2 — Browsing as much as contributing — ✅ done

Make discovery first-class on `index.html`: full-text search over title/authors/annotation,
filter by tag, and sort (year, recently added — and average rating once Phase 3 lands).
Pure front-end.

## Phase 3 — 5-star ratings with averages — ✅ done

Live: the proxy stores one rating per GitHub user in SQLite and the site renders averages
on cards and the detail page.


Logged-in users rate a paper 1–5; the proxy records one rating per user (App-committed
data file per paper), and the site shows the average on cards and the detail page.
This is the feature most worth your own server if GitHub-committed ratings feel heavy.

## Phase 4 — Comments on annotations — ✅ done

Implemented as per-section comment threads stored by the proxy (chosen over
issue-per-annotation), posted from the site and rendered inline on the paper page.


Move from per-paper comments to per-annotation: surface the thread inline on the paper page
and let users post from the site (via the proxy) rather than only clicking through to
GitHub. Mechanism TBD — structured issue comments vs. issue-per-annotation.

## Phase 5 — Citation data (scite-style) — ✅ done (OpenAlex; supporting/contrasting breakdown not yet)

A scheduled Action (`.github/workflows/`, `scripts/enrich-citations.js`) enriches each
paper from OpenAlex. Matching is DOI-first with a year-guarded title-search fallback for
papers whose DOI isn't indexed (e.g. arXiv `10.48550/arXiv.*`) or that have no DOI. The
scite-style supporting/mentioning/contrasting breakdown is not implemented — OpenAlex
gives counts and by-year totals only.


A scheduled Action enriches each paper with citation count and, where available, the
supporting / mentioning / contrasting breakdown (scite's "Smart Citations" model), pulling
from OpenAlex or Semantic Scholar (free) or scite's API (token required). Displayed as
badges on cards and the detail page.

## Phase 6 — Export curated reference list — ✅ done

Multi-select papers and export the selection to BibTeX, RIS, formatted citations
(APA / MLA / Chicago), or Markdown. Pure front-end.

---

## Resolved decisions

- **Repo coordinates:** `ech08ravo/annotated-bibliography`, served on GitHub Pages.
- **Proxy stack:** Python (FastAPI + SQLite), containerised — see `api/`.
- **Citation source:** OpenAlex (free, no key); scite's supporting/contrasting breakdown
  deferred.

## Remaining polish (post-build)

- **scite-style breakdown** for Phase 5 (supporting / mentioning / contrasting) if a data
  source becomes available.
- **Submission gating** — confirm whether submitting should require a GitHub login vs.
  moderated anonymous submissions.
- **Seed citation data:** the sample papers only populate once the enrich Action runs (or
  is triggered manually); the arXiv-DOI paper relies on the title-search fallback.
