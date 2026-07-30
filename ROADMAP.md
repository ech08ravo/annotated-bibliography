# Roadmap — Shared Annotated Bibliography

Planning doc translating the feature wishlist into a sequenced, architecture-aware plan.

**Status (2026-07):** Phases 0–6 are built and live. The static site is deployed on
GitHub Pages and the auth/write proxy runs at `textbook-api.webgrid.online`. One gap
remains in the original plan — the Phase 1 write path was never wired to the proxy, so
submitting still means downloading JSON by hand (see Phase 7). Phases 7–12 below cover
that gap plus the hardening, testing, and content work needed before the group uses this
in earnest.

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

## Phase 1 — Easy "submit a document + commentary" — ⚠️ partially done

**Built:** the contribution flow accepts an **RIS or BibTeX (.bib)** file, a **PDF**, or a
**link / DOI** (metadata auto-fetched), plus the document-level commentary
(summary / method / evaluation / relevance). `js/bibtex-parser.js` and the three input
modes in `js/contribute.js` are live.

**Completed in Phase 7:** the write path through the proxy. (An earlier revision of this
document described `submitPaper()` as terminating at a "Download JSON" button — that was
wrong. It called `openPR()`, which opens GitHub's prefilled new-file form. That worked, but
required the contributor to have repo write access or fork the repo, sent them off-site to
finish, silently couldn't carry a PDF, and fell back to the clipboard once the annotation
pushed the URL past ~7.5KB. Phase 7 removes all four limits for signed-in users.)

## Phase 2 — Browsing as much as contributing — ✅ done

Make discovery first-class on `index.html`: full-text search over title/authors/annotation,
filter by tag, and sort (year, recently added — and average rating once Phase 3 lands).
Pure front-end.

## Phase 3 — 5-star ratings with averages — ✅ done

Live: the proxy stores one rating per GitHub user in SQLite (`ratings` table, primary key
`(paper_id, gh_user_id)`) and the site renders averages on cards and the detail page.
Note this diverged from the original plan of App-committed data files in the repo — the
SQLite table proved simpler, at the cost of the data living outside git (see Phase 8 on
backups).

## Phase 4 — Comments on annotations — ✅ done

Implemented as per-section comment threads stored by the proxy (chosen over
issue-per-annotation), posted from the site and rendered inline on the paper page.
Sections are constrained to `summary` / `method` / `evaluation` / `relevance` / `general`.

## Phase 5 — Citation data (scite-style) — ✅ done (OpenAlex; supporting/contrasting breakdown not yet)

A scheduled Action (`.github/workflows/`, `scripts/enrich-citations.js`) enriches each
paper from OpenAlex. Matching is DOI-first with a year-guarded title-search fallback for
papers whose DOI isn't indexed (e.g. arXiv `10.48550/arXiv.*`) or that have no DOI. The
scite-style supporting/mentioning/contrasting breakdown is not implemented — OpenAlex
gives counts and by-year totals only.

## Phase 6 — Export curated reference list — ✅ done

Multi-select papers and export the selection to BibTeX, RIS, formatted citations
(APA / MLA / Chicago), or Markdown. Pure front-end.

---

## Resolved decisions

- **Repo coordinates:** `ech08ravo/annotated-bibliography`, served on GitHub Pages.
- **Proxy stack:** Python (FastAPI + SQLite), containerised — see `api/`.
- **Citation source:** OpenAlex (free, no key); scite's supporting/contrasting breakdown
  deferred.

---

# Phases 7–12 — from "built" to "usable by the group"

Phases 0–6 proved the architecture. What's left is the work that turns a live demo into
something a reading group can actually be pointed at: the missing write path, the hardening
that has to precede it, a test suite, and real content.

## Sequencing — hardening before the write path

The tempting order is Phase 7 first, since it's the visible gap. Resist it. **Phase 7 is
the first feature that lets other people write to the repo through our server.** The
secret-handling fix, rate limits, moderation, and a test suite should exist *before* that
door opens, not after. Recommended order: **8 → 9 → 7 → 10 → 11 → 12**.

Phases 8, 9 and 7 shipped in that order; 10–12 remain.

```
Phase 8  Harden the API        ─┐
Phase 9  Tests + CI            ─┴─→  Phase 7  Write path (submissions)
                                          │
                                          ├─→ Phase 10  Read-path scaling
                                          ├─→ Phase 11  Seed real content
                                          └─→ Phase 12  Polish
```

## Phase 8 — Harden the API (do first)

Four issues in `api/main.py`, in severity order:

1. **`SESSION_SECRET` falls back to a hardcoded dev value.** `signer` is constructed with
   `SESSION_SECRET or "dev-only-insecure-secret"`. If the env var is ever unset in
   production the app boots happily and every bearer token becomes forgeable by anyone who
   reads this repo. Fail loudly at startup instead of falling back.
2. **No rate limiting** on `POST /ratings` or `POST /comments`. Any authenticated GitHub
   account can post 5,000-character comments in a loop.
3. **No moderation.** `DELETE /comments/{id}` restricts deletion to the comment's author
   with no maintainer override, so there is no way to remove abuse.
4. **No backup.** SQLite at `DB_PATH` (`/data/ratings.db`) is the only copy of every rating
   and comment, and — unlike paper JSON — it lives outside git.

## Phase 9 — Tests and CI — ✅ done

86 JS tests in `test/` plus the API suite in `api/test_hardening.py`, all wired into
`.github/workflows/ci.yml`. No test framework and no `package.json` — Node's built-in
`node --test` runner and a plain Python script, so there are no dependencies to maintain.

- `test/ris-parser.test.js` / `test/bibtex-parser.test.js` — parsing, author
  normalization, year extraction, DOI prefix stripping, LaTeX cleanup, malformed input.
  These were the highest-risk files: a parser bug corrupts stored data silently.
- `test/export.test.js` — every formatter, plus **round-trip tests** (export → parse →
  compare) that pin the exporters against both parsers, so a change on either side that
  breaks interchange fails loudly.
- `test/enrich-citations.test.js` — the DOI/title matching logic with `fetch` stubbed;
  no test touches the network or `papers/`.
- CI also syntax-checks every JS file, validates paper JSON (required fields, id/filename
  agreement, no phantom PDF references), and fails if `papers/index.json` has drifted.

`scripts/enrich-citations.js` gained a `require.main === module` guard so its helpers can
be imported without triggering a live API sweep.

## Phase 7 — Close the write path — ✅ done

`POST /papers` on the proxy commits `papers/<id>.json` (and `papers/pdfs/<id>.pdf` when a
PDF is attached) to `SUBMIT_BRANCH`, and the existing `create-issues.yml` Action mints the
discussion issue as before. `submitPaper()` in `js/contribute.js` posts there when the user
is signed in, and falls back to the pre-existing GitHub / download / copy paths when signed
out, when the endpoint is unconfigured, or on any error — so the page is never a dead end.

**Submission gating (decided):** a GitHub login is required, consistent with ratings and
comments. `SUBMIT_ALLOWLIST` optionally narrows that to named logins; left empty, any
signed-in GitHub user may submit, bounded by `RATE_LIMIT_SUBMISSIONS` (10/hour by default).
Anonymous submission was rejected — it needs a moderation queue nobody would staff.

**Credential (deviation from the original plan):** this uses a fine-grained PAT scoped to
the one repository rather than a GitHub App. No JWT signing, no new dependency, no App
installation to maintain. A GitHub App would buy auto-rotating short-lived tokens and
bot-attributed commits; `_gh_headers()` in `api/main.py` is the only function that would
need to change. See `api/README.md`.

Two related bugs fixed while wiring this up:

- `js/contribute.js` stored `paper.pdf` as `"<id>.pdf"`, but `js/paper.js` resolves
  `papers/${paper.pdf}` — so every PDF-bearing submission produced a broken link. Now
  `"pdfs/<id>.pdf"`.
- A client-supplied `pdf` field is stripped unless a PDF was actually uploaded, and the PDF
  is committed *before* the JSON that references it. This is the phantom-PDF class of bug
  #4 had to fix by hand, now structurally prevented and covered by CI.

## Phase 10 — Read-path scaling

`js/github-api.js` reads issues and reactions unauthenticated, which GitHub rate-limits to
~60 requests/hour **per IP**. Every paper card triggers a fetch, so a shared office or
campus IP exhausts that within a few page loads — and the failure is invisible, since
reactions and comment counts simply stop appearing. Move issue reads behind the proxy
(which can authenticate, raising the ceiling to 5,000/hour) and cache the responses.

## Phase 11 — Seed real content

`papers/` currently holds three sample records (Kuhn, Rawls, Vaswani). Three papers is a
demo, not a bibliography. Bulk-import the group's actual reading list via `imports/` and
write genuine annotations for a first handful. This is the phase that determines whether the
tool gets used, and the only one that isn't code.

Related: citation data stays empty until `enrich-citations.yml` runs — trigger it manually
after the PR #4 logic landed.

## Phase 12 — Polish

- Mobile and accessibility pass over `css/styles.css`.
- `papers/pdfs/` is documented in the README but does not exist; PR #4 removed a paper's
  phantom PDF reference, which suggests the PDF upload path has never been exercised
  end-to-end. Verify it or drop the feature.
- **scite-style breakdown** for Phase 5 (supporting / mentioning / contrasting) if a data
  source becomes available.
