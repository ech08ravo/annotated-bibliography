# Shared Annotated Bibliography

A collaborative tool for academic teams to share, annotate, and discuss papers. Built as a static site that lives in this GitHub repo — no backend required.

## How it works

- **Papers** live in `papers/` as one JSON file per paper, plus an optional PDF in `papers/pdfs/`.
- **Annotations** are part of each paper file: a long-form bibliographic annotation (summary / method / evaluation / relevance) and an optional list of inline PDF highlights with notes.
- **Comments and upvotes** live on GitHub Issues. Each paper is auto-linked to one issue in this repo. Reactions (👍) are upvotes, issue comments are the comment thread. Contributors authenticate as themselves through GitHub — no separate accounts.
- **Adding a paper** uses one of three paths described in [CONTRIBUTING.md](CONTRIBUTING.md): a web form that imports an RIS export from Zotero or EndNote, a `imports/` folder for bulk RIS dumps, or a hand-edited JSON file.

## Automation

Two GitHub Actions keep the bookkeeping out of contributors' way:

- **`.github/workflows/import-ris.yml`** — when a `.ris` file lands in `imports/`, convert each record to a paper JSON, create its issue, update the index, and delete the import file.
- **`.github/workflows/create-issues.yml`** — whenever a paper JSON lands without an `issue` field, create the matching discussion issue and write the number back into the JSON. Also keeps `papers/index.json` in sync with what's actually in `papers/`.

Both rely only on the default `GITHUB_TOKEN`, which the workflow files request the right permissions for.

## Repo layout

```
.
├── index.html                       # paper listing page
├── paper.html                       # paper detail + PDF viewer
├── contribute.html                  # in-browser RIS importer
├── css/styles.css
├── js/
│   ├── app.js                       # listing page logic
│   ├── paper.js                     # detail page logic
│   ├── pdf-viewer.js                # PDF.js + highlight overlay
│   ├── github-api.js                # fetches reactions + comments
│   ├── ris-parser.js                # RIS parser (used in browser and Node)
│   └── contribute.js                # contribute page logic
├── scripts/
│   ├── import-ris.js                # consumes imports/*.ris -> papers/*.json
│   ├── create-missing-issues.js     # creates GitHub Issues for new papers
│   └── update-index.js              # rebuilds papers/index.json from disk
├── .github/workflows/
│   ├── import-ris.yml
│   └── create-issues.yml
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

## Config

Edit the constants at the top of `js/github-api.js`:

```js
const GH_OWNER = "your-github-username";
const GH_REPO  = "your-repo-name";
```

The site uses the unauthenticated GitHub REST API for reads (issues and comments), which is rate-limited to ~60 requests per hour per IP. Plenty for a small team. If you outgrow that, swap in a Personal Access Token in `github-api.js` or move to GitHub's GraphQL API.

## Status

Walking skeleton with automation. Working end-to-end: list papers, view a paper, see PDF highlights, see comments + upvote count, click through to GitHub to comment or react. Two routes for adding papers (web form, bulk RIS in `imports/`) and a fallback hand-edit path. Styling is minimal on purpose — easy to replace later.
