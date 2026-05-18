#!/usr/bin/env node
// For each papers/*.json that has no "issue" field, create a GitHub Issue
// in the current repo and write the issue number back into the JSON.
// Designed to run inside a GitHub Action with the default GITHUB_TOKEN.

const fs = require("fs");
const path = require("path");
const https = require("https");

const PAPERS_DIR = path.resolve(__dirname, "..", "papers");

const REPO = process.env.GITHUB_REPOSITORY;     // "owner/repo"
const TOKEN = process.env.GITHUB_TOKEN;
if (!REPO || !TOKEN) {
  console.error("GITHUB_REPOSITORY and GITHUB_TOKEN env vars required.");
  process.exit(1);
}

function ghRequest(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: "api.github.com",
      method,
      path: urlPath,
      headers: {
        "Authorization": `Bearer ${TOKEN}`,
        "Accept": "application/vnd.github+json",
        "User-Agent": "annotated-bib-action",
        "Content-Type": "application/json",
        ...(data ? { "Content-Length": Buffer.byteLength(data) } : {})
      }
    }, res => {
      let buf = "";
      res.on("data", c => buf += c);
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(buf)); } catch (_) { resolve(buf); }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${buf}`));
        }
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

async function createIssue(paper) {
  const authors = (paper.authors || []).join(", ");
  const body = [
    `Discussion thread for the paper [${paper.title}](https://github.com/${REPO}/blob/main/papers/${paper.id}.json).`,
    "",
    `**Authors:** ${authors || "—"}`,
    `**Year:** ${paper.year || "—"}`,
    `**Venue:** ${paper.venue || "—"}`,
    paper.url ? `**Source:** ${paper.url}` : "",
    "",
    "👍 React on this issue to upvote. Reply below to comment.",
  ].filter(Boolean).join("\n");

  return ghRequest("POST", `/repos/${REPO}/issues`, {
    title: paper.title,
    body,
    labels: ["paper"]
  });
}

async function main() {
  if (!fs.existsSync(PAPERS_DIR)) {
    console.log("No papers/ directory.");
    return;
  }
  const files = fs.readdirSync(PAPERS_DIR).filter(f => f.endsWith(".json") && f !== "index.json");
  let created = 0;

  for (const fname of files) {
    const fpath = path.join(PAPERS_DIR, fname);
    const paper = JSON.parse(fs.readFileSync(fpath, "utf8"));
    if (paper.issue) continue;

    console.log(`Creating issue for ${paper.id}…`);
    try {
      const issue = await createIssue(paper);
      paper.issue = issue.number;
      fs.writeFileSync(fpath, JSON.stringify(paper, null, 2) + "\n");
      created++;
      console.log(`  → issue #${issue.number}`);
    } catch (e) {
      console.error(`  ! failed to create issue for ${paper.id}: ${e.message}`);
    }
  }

  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `## Created ${created} discussion issue${created === 1 ? "" : "s"}\n`);
  }
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `created_count=${created}\n`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
