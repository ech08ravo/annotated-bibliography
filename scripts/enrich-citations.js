#!/usr/bin/env node
// Enrich each papers/*.json with citation data from OpenAlex (free, no key).
// Writes a "citations" object:
//
//   "citations": {
//     "source": "openalex",
//     "count": 1234,
//     "by_year": [{ "year": 2024, "count": 300 }, ...],
//     "openalex_id": "https://openalex.org/W...",
//     "matched_by": "doi",        // "doi" | "title" — how we found the work
//     "retrieved": "2026-05-20"
//   }
//
// Matching strategy: look the work up by DOI first. If the paper has no DOI or
// the DOI isn't in OpenAlex (common for arXiv DOIs like 10.48550/arXiv.*, and
// for older books), fall back to a title search — but only accept a result
// whose publication year is within TITLE_YEAR_TOLERANCE of the paper's year.
// This refuses to guess: a fuzzy title with no year-confirmed match is skipped
// rather than risk attaching some near-namesake's citation count.
//
// To avoid noisy commits we only rewrite a file when the meaningful data
// (count / by_year / openalex_id / matched_by) actually changed; "retrieved"
// is bumped only then. OpenAlex asks callers to identify themselves via a
// mailto in the "polite pool" — set OPENALEX_MAILTO (falls back to a generic
// address).
//
// Node 20+ (uses global fetch). No dependencies. Designed for a GitHub Action
// but runs locally too: `node scripts/enrich-citations.js`.

const fs = require("fs");
const path = require("path");

const PAPERS_DIR = path.resolve(__dirname, "..", "papers");
const MAILTO = process.env.OPENALEX_MAILTO || "bibliography@example.com";
const TODAY = new Date().toISOString().slice(0, 10);
// How far a title-search hit's publication year may drift from the paper's own
// year and still count as the same work (books get reissued a year or two off).
const TITLE_YEAR_TOLERANCE = 1;

async function fetchOpenAlex(doi) {
  const clean = String(doi).replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").trim();
  const url = `https://api.openalex.org/works/doi:${encodeURIComponent(clean)}`
            + `?mailto=${encodeURIComponent(MAILTO)}`;
  const res = await fetch(url, { headers: { "Accept": "application/json" } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`OpenAlex HTTP ${res.status}`);
  return res.json();
}

// Fallback lookup by title, used when there's no DOI or the DOI isn't indexed.
// Results are requested sorted by citation count, so the first hit within the
// year window is the most-cited plausible match. Returns null (rather than a
// low-confidence guess) when the paper has no year or nothing lines up.
async function fetchByTitle(title, year) {
  if (!title || !year) return null;
  const q = encodeURIComponent(String(title).trim());
  const url = `https://api.openalex.org/works`
            + `?filter=title.search:${q}`
            + `&sort=cited_by_count:desc&per-page=25`
            + `&mailto=${encodeURIComponent(MAILTO)}`;
  const res = await fetch(url, { headers: { "Accept": "application/json" } });
  if (!res.ok) throw new Error(`OpenAlex HTTP ${res.status}`);
  const data = await res.json();
  const match = (data.results || []).find(w =>
    typeof w.publication_year === "number" &&
    Math.abs(w.publication_year - year) <= TITLE_YEAR_TOLERANCE
  );
  return match || null;
}

function toCitations(work, matchedBy) {
  const byYear = (work.counts_by_year || [])
    .map(c => ({ year: c.year, count: c.cited_by_count }))
    .sort((a, b) => a.year - b.year);
  return {
    source: "openalex",
    count: work.cited_by_count || 0,
    by_year: byYear,
    openalex_id: work.id || "",
    matched_by: matchedBy,
  };
}

// Compare ignoring the volatile "retrieved" timestamp.
function sameData(a, b) {
  if (!a || !b) return false;
  const strip = (c) => JSON.stringify({ count: c.count, by_year: c.by_year, openalex_id: c.openalex_id, matched_by: c.matched_by });
  return strip(a) === strip(b);
}

async function main() {
  if (!fs.existsSync(PAPERS_DIR)) { console.log("No papers/ directory."); return; }
  const files = fs.readdirSync(PAPERS_DIR)
    .filter(f => f.endsWith(".json") && f !== "index.json");

  let updated = 0, skipped = 0, failed = 0;

  for (const fname of files) {
    const fpath = path.join(PAPERS_DIR, fname);
    let paper;
    try { paper = JSON.parse(fs.readFileSync(fpath, "utf8")); }
    catch (e) { console.error(`! ${fname}: bad JSON (${e.message})`); failed++; continue; }

    try {
      // DOI first; fall back to a year-guarded title search.
      let work = null, matchedBy = null;
      if (paper.doi) {
        work = await fetchOpenAlex(paper.doi);
        if (work) matchedBy = "doi";
      }
      if (!work) {
        work = await fetchByTitle(paper.title, paper.year);
        if (work) matchedBy = "title";
      }
      if (!work) { console.log(`- ${paper.id}: no confident OpenAlex match`); skipped++; continue; }

      const fresh = toCitations(work, matchedBy);
      if (sameData(paper.citations, fresh)) { skipped++; continue; }

      paper.citations = { ...fresh, retrieved: TODAY };
      fs.writeFileSync(fpath, JSON.stringify(paper, null, 2) + "\n");
      updated++;
      console.log(`✓ ${paper.id}: ${fresh.count} citations (by ${matchedBy})`);
    } catch (e) {
      console.error(`! ${paper.id}: ${e.message}`);
      failed++;
    }

    // Be polite to the API.
    await new Promise(r => setTimeout(r, 200));
  }

  const summary = `Citations: ${updated} updated, ${skipped} unchanged/skipped, ${failed} failed.`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## ${summary}\n`);
  }
}

// Only run when invoked directly, so tests can require the helpers below
// without triggering a live API sweep over papers/.
if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}

module.exports = {
  fetchOpenAlex,
  fetchByTitle,
  toCitations,
  sameData,
  TITLE_YEAR_TOLERANCE,
};
