#!/usr/bin/env node
// Bulk-import .ris files from imports/ into papers/.
// Generates a paper-JSON skeleton per record (no annotation body — contributors
// can fill that in later via PR), updates papers/index.json, and removes the
// import file after consuming it. Idempotent: skips ids that already exist.

const fs = require("fs");
const path = require("path");

const RIS = require("../js/ris-parser.js");

const ROOT       = path.resolve(__dirname, "..");
const IMPORT_DIR = path.join(ROOT, "imports");
const PAPERS_DIR = path.join(ROOT, "papers");
const INDEX_PATH = path.join(PAPERS_DIR, "index.json");

function readJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); }
  catch (_) { return fallback; }
}
function writeJSON(p, data) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + "\n");
}
function uniqueId(baseId, existingIds) {
  if (!existingIds.has(baseId)) return baseId;
  let i = 2;
  while (existingIds.has(`${baseId}-${i}`)) i++;
  return `${baseId}-${i}`;
}

function main() {
  if (!fs.existsSync(IMPORT_DIR)) {
    console.log("No imports/ directory; nothing to do.");
    return;
  }
  fs.mkdirSync(PAPERS_DIR, { recursive: true });

  const indexList = readJSON(INDEX_PATH, []);
  const existingIds = new Set(indexList);

  // Also add any orphan paper files not in the index
  for (const f of fs.readdirSync(PAPERS_DIR)) {
    if (f.endsWith(".json") && f !== "index.json") existingIds.add(f.replace(/\.json$/, ""));
  }

  const importFiles = fs.readdirSync(IMPORT_DIR).filter(f => f.toLowerCase().endsWith(".ris"));
  if (!importFiles.length) {
    console.log("No .ris files in imports/.");
    return;
  }

  const added = [];

  for (const f of importFiles) {
    const fpath = path.join(IMPORT_DIR, f);
    const text = fs.readFileSync(fpath, "utf8");
    const records = RIS.parseRIS(text);
    console.log(`${f}: ${records.length} record(s).`);
    for (const r of records) {
      const baseId = RIS.generateId(r);
      const id = uniqueId(baseId, existingIds);
      existingIds.add(id);
      const paper = RIS.toPaper(r, { id });
      writeJSON(path.join(PAPERS_DIR, `${id}.json`), paper);
      indexList.push(id);
      added.push({ id, title: paper.title });
    }
    fs.unlinkSync(fpath);
  }

  // Dedupe index just in case
  const seen = new Set();
  const dedup = [];
  for (const id of indexList) {
    if (seen.has(id)) continue;
    seen.add(id);
    dedup.push(id);
  }
  writeJSON(INDEX_PATH, dedup);

  console.log(`Imported ${added.length} paper(s):`);
  for (const a of added) console.log(`  - ${a.id}  ${a.title}`);

  // Emit summary for GitHub Actions
  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = [
      `## Imported ${added.length} paper${added.length === 1 ? "" : "s"}`,
      "",
      ...added.map(a => `- \`${a.id}\` — ${a.title}`)
    ];
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
  }
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `added_count=${added.length}\n`);
  }
}

if (require.main === module) {
  try { main(); }
  catch (e) { console.error(e); process.exit(1); }
}
