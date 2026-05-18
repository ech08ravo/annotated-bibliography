#!/usr/bin/env node
// Rewrite papers/index.json so it contains every paper file in papers/,
// preserving existing order and appending new ones at the end.

const fs = require("fs");
const path = require("path");

const PAPERS_DIR = path.resolve(__dirname, "..", "papers");
const INDEX_PATH = path.join(PAPERS_DIR, "index.json");

let existing = [];
try { existing = JSON.parse(fs.readFileSync(INDEX_PATH, "utf8")); } catch (_) {}

const seen = new Set();
const order = [];

// Keep the existing order for ids that still have files
for (const id of existing) {
  const fpath = path.join(PAPERS_DIR, `${id}.json`);
  if (fs.existsSync(fpath) && !seen.has(id)) {
    seen.add(id);
    order.push(id);
  }
}

// Append any paper files that aren't yet in the index, sorted alphabetically
const onDisk = fs.readdirSync(PAPERS_DIR)
  .filter(f => f.endsWith(".json") && f !== "index.json")
  .map(f => f.replace(/\.json$/, ""))
  .sort();

for (const id of onDisk) {
  if (!seen.has(id)) {
    seen.add(id);
    order.push(id);
  }
}

fs.writeFileSync(INDEX_PATH, JSON.stringify(order, null, 2) + "\n");
console.log(`papers/index.json now has ${order.length} paper(s).`);
