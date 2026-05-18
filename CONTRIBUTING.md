# Contributing a paper

Three ways, pick whichever fits.

---

## Path A — Web form (easiest, one paper at a time, with annotation)

1. Export the paper from Zotero or EndNote as an **RIS** file.
   - **Zotero:** right-click the item → Export Items → Format: *RIS* → Save.
   - **EndNote:** select reference → File → Export → Output style: *RefMan (RIS) Export*.
2. Open the project's **Contribute** page (`contribute.html` on the deployed site).
3. Drop the `.ris` file in. The page parses it and shows a form.
4. Fill in your annotation (summary / method / evaluation / relevance) and your GitHub username, then click **Download paper JSON**.
5. Commit the downloaded file to `papers/` in this repo via a pull request. (Drag-drop into GitHub's web file editor is fine.)

That's it. When the PR merges, a GitHub Action creates the discussion issue and updates the listing automatically.

---

## Path B — Bulk import (whole reading list, no per-paper annotation)

1. Export multiple references as one `.ris` file from Zotero or EndNote.
2. Add it to the `imports/` folder in this repo (web UI works fine).
3. Push or merge to `main`. The **Import RIS** GitHub Action:
   - Generates a `papers/<id>.json` skeleton per record (annotation fields left blank).
   - Creates a GitHub Issue per paper for comments and upvotes.
   - Updates `papers/index.json`.
   - Deletes the import file.
4. People can fill in the annotations later via individual PRs that edit `papers/<id>.json`.

---

## Path C — Hand-edit the JSON (full control, including PDF highlights)

Use this when you want to add inline PDF highlights or you don't have a citation manager handy.

Create `papers/<short-id>.json`. Use a short URL-safe id (e.g. `smith-2023-attention`).

```json
{
  "id": "smith-2023-attention",
  "title": "On Attention in Large Language Models",
  "authors": ["Alice Smith", "Bob Jones"],
  "year": 2023,
  "venue": "NeurIPS",
  "doi": "10.0000/example",
  "url": "https://arxiv.org/abs/0000.00000",
  "pdf": "pdfs/smith-2023-attention.pdf",
  "tags": ["attention", "LLM", "survey"],
  "annotation": {
    "author_github": "your-github-username",
    "summary": "One paragraph: what does the paper claim?",
    "method": "How do they test it?",
    "evaluation": "Strengths, weaknesses, what convinced you or didn't.",
    "relevance": "Why this is on our list."
  },
  "highlights": [
    {
      "id": "h1",
      "page": 3,
      "rect": [0.12, 0.41, 0.78, 0.46],
      "quote": "We find that attention heads specialize early in training.",
      "note": "Useful framing for the related-work section of our paper.",
      "author_github": "your-github-username"
    }
  ]
}
```

Field notes:

- `id` — short, URL-safe, hyphen-separated. Filename is `<id>.json`.
- `pdf` — relative path under `papers/`. Optional.
- `issue` — **don't set this yourself**. The GitHub Action assigns the issue number after the paper file lands on `main`.
- `highlights[].rect` — `[x0, y0, x1, y1]` in normalized page coordinates (0–1, top-left origin).
- `highlights` — optional.

Open a PR. After merge, the Action fills in `issue`, updates `papers/index.json`, and creates the discussion thread on GitHub Issues.

---

## How comments and upvotes work

Each paper is paired with a GitHub Issue (created automatically). On any paper's detail page, the **👍 React on GitHub** button takes you to its issue, where you can add a 👍 reaction (the upvote) or post a comment. The bibliography listing page shows the counts.
