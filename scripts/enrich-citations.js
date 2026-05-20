#!/usr/bin/env node
// Enrich each papers/*.json that has a DOI with citation data from OpenAlex
// (free, no key). Writes a "citations" object:
//
//   "citations": {
//     "source": "openalex",
//     "count": 1234,
//     "by_year": [{ "year": 2024, "count": 300 }, ...],
//     "openalex_id": "https://openalex.org/W...",
//     "retrieved": "2026-05-20"
//   }
//
// To avoid noisy commits we only rewrite a file when the meaningful data
// (count / by_year / openalex_id) actually changed; "retrieved" is bumped only
// then. OpenAlex asks callers to identify themselves via a mailto in the
// "polite pool" — set OPENALEX_MAILTO (falls back to a generic address).
//
// Node 20+ (uses global fetch). No dependencies. Designed for a GitHub Action
// but runs locally too: `node scripts/enrich-citations.js`.

const fs = require("fs");
const path = require("path");

const PAPERS_DIR = path.resolve(__dirname, "..", "papers");
const MAILTO = process.env.OPENALEX_MAILTO || "bibliography@example.com";
const TODAY = new Date().toISOString().slice(0, 10);

async function fetchOpenAlex(doi) {
  const clean = String(doi).replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").trim();
  const url = `https://api.openalex.org/works/doi:${encodeURIComponent(clean)}`
            + `?mailto=${encodeURIComponent(MAILTO)}`;
  const res = await fetch(url, { headers: { "Accept": "application/json" } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`OpenAlex HTTP ${res.status}`);
  return res.json();
}

function toCitations(work) {
  const byYear = (work.counts_by_year || [])
    .map(c => ({ year: c.year, count: c.cited_by_count }))
    .sort((a, b) => a.year - b.year);
  return {
    source: "openalex",
    count: work.cited_by_count || 0,
    by_year: byYear,
    openalex_id: work.id || "",
  };
}

// Compare ignoring the volatile "retrieved" timestamp.
function sameData(a, b) {
  if (!a || !b) return false;
  const strip = (c) => JSON.stringify({ count: c.count, by_year: c.by_year, openalex_id: c.openalex_id });
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

    if (!paper.doi) { skipped++; continue; }

    try {
      const work = await fetchOpenAlex(paper.doi);
      if (!work) { console.log(`- ${paper.id}: not found on OpenAlex`); skipped++; continue; }

      const fresh = toCitations(work);
      if (sameData(paper.citations, fresh)) { skipped++; continue; }

      paper.citations = { ...fresh, retrieved: TODAY };
      fs.writeFileSync(fpath, JSON.stringify(paper, null, 2) + "\n");
      updated++;
      console.log(`✓ ${paper.id}: ${fresh.count} citations`);
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

main().catch(e => { console.error(e); process.exit(1); });
