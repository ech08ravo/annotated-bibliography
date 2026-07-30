# Shared Annotated Bibliography

A collaborative tool for academic teams to share, annotate, and discuss papers. Built as a static site that lives in this GitHub repo — no backend required.

## How it works

- **Papers** live in `papers/` as one JSON file per paper, plus an optional PDF in `papers/pdfs/`.
- **Annotations** are part of each paper file: a long-form bibliographic annotation (summary / method / evaluation / relevance) and an optional list of inline PDF highlights with notes.
- **Upvotes and the paper-level discussion** live on GitHub Issues. Each paper is auto-linked to one issue in this repo; reactions (👍) are upvotes and issue comments are the paper-level thread, read unauthenticated and shown as counts. **Per-annotation comments and 5-star ratings** are handled by the write proxy (see below), where contributors sign in through GitHub — no separate accounts.
- **Adding a paper** uses one of three paths described in [CONTRIBUTING.md](CONTRIBUTING.md): a web form that imports an RIS export from Zotero or EndNote, a `imports/` folder for bulk RIS dumps, or a hand-edited JSON file.

## Ratings, comments & sign-in

Beyond the static site, a small **write proxy** (see [`api/`](api/) — Python / FastAPI +
SQLite, containerised, running at `textbook-api.webgrid.online`) handles the things GitHub
Pages can't do on its own: GitHub sign-in (OAuth web flow), 5-star ratings (one per user
per paper), and per-annotation comment threads. The front-end talks to it over HTTPS
(`js/ratings.js`, `js/comments.js`); if the proxy is unreachable, ratings/comments simply
don't show and the rest of the site is unaffected.

## Automation

GitHub Actions keep the bookkeeping out of contributors' way:

- **`.github/workflows/import-ris.yml`** — when a `.ris` file lands in `imports/`, convert each record to a paper JSON, create its issue, update the index, and delete the import file.
- **`.github/workflows/create-issues.yml`** — whenever a paper JSON lands without an `issue` field, create the matching discussion issue and write the number back into the JSON. Also keeps `papers/index.json` in sync with what's actually in `papers/`.
- **`.github/workflows/enrich-citations.yml`** (scheduled) — enriches each paper with OpenAlex citation data (`scripts/enrich-citations.js`): DOI lookup first, with a year-guarded title-search fallback for papers whose DOI isn't indexed or that have none.

These rely only on the default `GITHUB_TOKEN`, which the workflow files request the right permissions for.

## Repo layout

```
.
├── index.html                       # paper listing page
├── paper.html                       # paper detail + PDF viewer
├── contribute.html                  # in-browser RIS importer
├── css/styles.css
├── js/
│   ├── app.js                       # listing page logic (search / sort / tags / export)
│   ├── paper.js                     # detail page logic
│   ├── pdf-viewer.js                # PDF.js + highlight overlay
│   ├── github-api.js                # fetches reactions + comments
│   ├── ratings.js                   # ratings + GitHub sign-in client (talks to api/)
│   ├── comments.js                  # per-annotation comment client (talks to api/)
│   ├── export.js                    # BibTeX / RIS / APA / MLA / Chicago / Markdown
│   ├── ris-parser.js                # RIS parser (used in browser and Node)
│   ├── bibtex-parser.js             # BibTeX parser (used in browser and Node)
│   └── contribute.js                # contribute page logic
├── api/                             # Python write proxy: sign-in, ratings, comments
├── scripts/
│   ├── import-ris.js                # consumes imports/*.ris -> papers/*.json
│   ├── create-missing-issues.js     # creates GitHub Issues for new papers
│   ├── enrich-citations.js          # adds OpenAlex citation data to papers/*.json
│   └── update-index.js              # rebuilds papers/index.json from disk
├── test/                             # Node unit tests (node --test test/*.test.js)
├── .github/workflows/
│   ├── ci.yml                        # tests + data integrity on every push/PR
│   ├── import-ris.yml
│   ├── create-issues.yml
│   └── enrich-citations.yml
├── papers/
│   ├── index.json                   # ordered list of paper ids
│   ├── <id>.json                    # one file per paper
│   └── pdfs/<id>.pdf                # optional PDF
├── imports/                         # drop .ris files here for bulk import
├── CONTRIBUTING.md
└── README.md
```

## Running locally

```
python3 -m http.server 8000
```

Then open <http://localhost:8000/>. To exercise the importer scripts locally, you just need Node 18+:

```
node scripts/import-ris.js
node scripts/update-index.js
```

(The `create-missing-issues.js` script needs `GITHUB_REPOSITORY` and `GITHUB_TOKEN` in the environment — it's meant for the Action, not local runs.)

## Tests

No test framework and no `package.json` — the front-end suites use Node's built-in
runner, and the API suite is a plain script:

```
node --test test/*.test.js     # parsers, exporters, citation matching
cd api && python3 test_hardening.py   # API auth, rate limits, moderation, backups
```

`.github/workflows/ci.yml` runs both on every push and pull request, and additionally
syntax-checks the JS, validates each paper JSON file, and fails if `papers/index.json`
has drifted out of sync with `papers/`.

## Config

Edit the constants at the top of `js/github-api.js`:

```js
const GH_OWNER = "your-github-username";
const GH_REPO  = "your-repo-name";
```

The site uses the unauthenticated GitHub REST API for reads (issues and comments), which is rate-limited to ~60 requests per hour per IP. Plenty for a small team. If you outgrow that, swap in a Personal Access Token in `github-api.js` or move to GitHub's GraphQL API.

## Status

Live and feature-complete against the [roadmap](ROADMAP.md) (Phases 0–6). Working
end-to-end: browse papers (search / sort / tag filter / shareable URLs), view a paper with
its annotation and inline highlights, sign in with GitHub, rate papers (1–5 stars with
averages), comment per annotation section, see upvote/comment counts from GitHub Issues,
and export a curated selection to BibTeX / RIS / APA / MLA / Chicago / Markdown. Three
routes for adding papers (web form, bulk RIS in `imports/`, hand-edited JSON). Citation
data is refreshed from OpenAlex on a schedule. Styling is minimal on purpose — easy to
replace later.
