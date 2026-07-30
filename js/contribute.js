// Browser-side contribute page. Three ways in — a bibliographic file
// (RIS or BibTeX), a link/DOI (metadata from Crossref or DataCite), or a PDF
// (metadata read with PDF.js) — all converge on one annotate-and-submit UI.
//
// Submission routes through submitPaper(): signed in, it POSTs to the auth/write
// proxy, which commits the paper (and uploads its PDF) with its own credential.
// Signed out — or if the proxy is unreachable or unconfigured — it falls back to
// the no-backend paths (pre-filled PR, download, copy) so the page is never a
// dead end. All routing stays in that one function; see SUBMIT below.

(function () {
  const dropzone  = document.getElementById("dropzone");
  const fileInput = document.getElementById("file");
  const idInput   = document.getElementById("identifier");
  const idBtn     = document.getElementById("identifier-btn");
  const pdfInput  = document.getElementById("pdf");
  const recordsEl = document.getElementById("records");
  const statusEl  = document.getElementById("status");
  const ghUserEl  = document.getElementById("gh-user");

  let nextIdx = 0;
  // paper.id -> File, for PDFs we can upload on a signed-in submission.
  const pdfFiles = new Map();

  // The auth client (js/ratings.js) owns the GitHub token; it may be absent if
  // that script failed to load, so every use is guarded.
  function auth() { return typeof Ratings !== "undefined" ? Ratings : null; }
  function signedIn() { const a = auth(); return !!(a && a.getToken()); }

  // Restore previously-entered username
  try {
    const saved = localStorage.getItem("contribute.ghUser");
    if (saved) ghUserEl.value = saved;
  } catch (_) {}
  ghUserEl.addEventListener("input", () => {
    try { localStorage.setItem("contribute.ghUser", ghUserEl.value); } catch (_) {}
  });

  function setStatus(msg) { statusEl.textContent = msg || ""; }

  // Status line with links in it. Built from DOM nodes rather than innerHTML so
  // a paper title can never inject markup.
  function setStatusParts(...parts) {
    statusEl.textContent = "";
    parts.filter(Boolean).forEach(part => {
      statusEl.appendChild(typeof part === "string" ? document.createTextNode(part) : part);
    });
  }

  function statusLink(href, text) {
    const a = document.createElement("a");
    a.href = href;
    a.textContent = text;
    a.target = "_blank";
    a.rel = "noopener";
    return a;
  }
  function ghUser() { return ghUserEl.value.trim(); }

  // ---- Method 1: bibliographic file (RIS or BibTeX) ----------------------

  ["dragenter", "dragover"].forEach(ev =>
    dropzone.addEventListener(ev, e => {
      e.preventDefault(); e.stopPropagation();
      dropzone.classList.add("over");
    }));
  ["dragleave", "drop"].forEach(ev =>
    dropzone.addEventListener(ev, e => {
      e.preventDefault(); e.stopPropagation();
      dropzone.classList.remove("over");
    }));
  dropzone.addEventListener("drop", e => {
    if (e.dataTransfer && e.dataTransfer.files) handleFiles(e.dataTransfer.files);
  });
  fileInput.addEventListener("change", () => handleFiles(fileInput.files));

  async function handleFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    setStatus(`Reading ${files.length} file${files.length === 1 ? "" : "s"}…`);

    let records = [];
    for (const f of files) {
      try {
        const text = await f.text();
        records = records.concat(parseBibliography(text, f.name));
      } catch (e) {
        console.error(`Failed to read ${f.name}`, e);
      }
    }

    if (!records.length) {
      setStatus("No records found. Make sure it's a real RIS export (records start with TY  - / end with ER  -) or a BibTeX file (@article{…}).");
      return;
    }
    appendPapers(records.map(toPaper));
    setStatus(`${records.length} record${records.length === 1 ? "" : "s"} parsed. Add your commentary for each, then submit.`);
  }

  // Pick a parser by extension, then by content as a fallback.
  function parseBibliography(text, name) {
    const lower = (name || "").toLowerCase();
    if (lower.endsWith(".bib") || lower.endsWith(".bibtex")) return BIB.parseBibTeX(text);
    if (lower.endsWith(".ris")) return RIS.parseRIS(text);
    const ris = RIS.parseRIS(text);
    if (ris.length) return ris;
    if (/@\w+\s*[{(]/.test(text)) return BIB.parseBibTeX(text);
    return [];
  }

  // ---- Method 2: link or DOI (Crossref, then DataCite) -------------------

  idBtn.addEventListener("click", fetchByIdentifier);
  idInput.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); fetchByIdentifier(); }
  });

  async function fetchByIdentifier() {
    const raw = idInput.value.trim();
    if (!raw) return;
    const doi = DOILookup.extractDoi(raw);

    if (doi) {
      setStatus(`Looking up ${doi}…`);
      try {
        // Crossref first, then DataCite — the latter covers Zenodo, Figshare,
        // Dryad, OSF, datasets and theses, which Crossref 404s on.
        const hit = await DOILookup.lookup(doi);
        if (hit) {
          const paper = toPaper(hit.record);
          appendPapers([paper]);
          setStatus(`Found "${paper.title}" via ${hit.source}. Add your commentary, then submit.`);
        } else {
          appendPapers([toPaper({ ...blankRecord(), doi })]);
          setStatus(`${doi} isn't in Crossref or DataCite. Added a blank entry — fill it in below.`);
        }
      } catch (e) {
        setStatus(`Couldn't reach Crossref or DataCite for ${doi} (${e.message}). Added a blank entry — fill it in below.`);
        appendPapers([toPaper({ ...blankRecord(), doi })]);
      }
    } else if (/^https?:\/\//i.test(raw)) {
      appendPapers([toPaper({ ...blankRecord(), url: raw })]);
      setStatus("Added a link. Fill in the title and details, then submit.");
    } else {
      setStatus("Enter a DOI (e.g. 10.1000/xyz) or a full URL (https://…).");
      return;
    }
    idInput.value = "";
  }

  function blankRecord() {
    return {
      title: "", authors: [], year: null, venue: "", publisher: "",
      doi: "", url: "", abstract: "", tags: [],
    };
  }


  // ---- Method 3: PDF (metadata via PDF.js) -------------------------------

  pdfInput.addEventListener("change", () => {
    const f = (pdfInput.files || [])[0];
    if (f) handlePdf(f);
  });

  let _pdfjs;
  function ensurePdfJs() {
    if (typeof pdfjsLib !== "undefined") return Promise.resolve(pdfjsLib);
    if (_pdfjs) return _pdfjs;
    _pdfjs = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
      s.onload = () => {
        try {
          pdfjsLib.GlobalWorkerOptions.workerSrc =
            "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
        } catch (_) {}
        resolve(pdfjsLib);
      };
      s.onerror = () => reject(new Error("PDF.js failed to load"));
      document.head.appendChild(s);
    });
    return _pdfjs;
  }

  async function readPdfMeta(file) {
    try {
      const lib = await ensurePdfJs();
      const buf = await file.arrayBuffer();
      const pdf = await lib.getDocument({ data: buf }).promise;
      const md = await pdf.getMetadata();
      const info = (md && md.info) || {};
      return { title: (info.Title || "").trim(), author: (info.Author || "").trim() };
    } catch (_) { return {}; }
  }

  async function handlePdf(file) {
    setStatus(`Reading ${file.name}…`);
    const meta = await readPdfMeta(file);
    const fromName = file.name.replace(/\.pdf$/i, "").replace(/[_]+/g, " ").replace(/\s+/g, " ").trim();
    const authors = meta.author
      ? meta.author.split(/\s*;\s*|\s+and\s+|\s*,\s*(?=[A-Z])/).map(s => BIB.normalizeAuthor(s)).filter(Boolean)
      : [];
    const paper = toPaper({
      title: meta.title || fromName || "(untitled)",
      authors, year: null, venue: "", doi: "", url: "", abstract: "", tags: [],
    });
    // Stored relative to papers/ — js/paper.js resolves `papers/${paper.pdf}`,
    // so the "pdfs/" prefix belongs in the value.
    paper.pdf = `pdfs/${paper.id}.pdf`;
    paper._pdfPending = file.name;
    // Hold the bytes so a signed-in submission can upload the file itself
    // rather than leaving the JSON pointing at a PDF nobody added.
    pdfFiles.set(paper.id, file);
    appendPapers([paper]);
    setStatus(
      signedIn()
        ? `Read "${file.name}". Add commentary, then submit — the PDF will be uploaded with it.`
        : `Read "${file.name}". Add commentary, then submit — and attach the PDF as papers/${paper.pdf} in the PR.`
    );
    pdfInput.value = "";
  }

  // ---- Shared: build a paper, render the form, submit --------------------

  function toPaper(record) {
    return RIS.toPaper(record, { author_github: ghUser() });
  }

  function appendPapers(papers) {
    papers.forEach(paper => recordsEl.appendChild(recordNode(paper, nextIdx++)));
  }

  function recordNode(paper, idx) {
    const div = document.createElement("div");
    div.className = "record";
    div.dataset.idx = String(idx);

    const authorList = (paper.authors || []).join(", ");
    const meta = [authorList, paper.year, paper.venue].filter(Boolean).join(" · ");

    const pdfNote = !paper._pdfPending
      ? ""
      : signedIn()
        ? `<div class="help-box" style="margin:0 0 0.75rem;">
             <strong>PDF:</strong> <code>${escapeHTML(paper._pdfPending)}</code> will be uploaded
             to <code>papers/${escapeHTML(paper.pdf)}</code> with this submission.
           </div>`
        : `<div class="help-box" style="margin:0 0 0.75rem;">
             <strong>PDF:</strong> binary files can't ride along in the pre-filled link.
             After opening the PR, add <code>${escapeHTML(paper._pdfPending)}</code> to the repo
             at <code>papers/${escapeHTML(paper.pdf)}</code> — or sign in to have it uploaded
             automatically.
           </div>`;

    div.innerHTML = `
      <h3>${escapeHTML(paper.title || "(untitled)")}</h3>
      <p class="meta">${escapeHTML(meta)}</p>
      ${pdfNote}

      <div class="row">
        <label class="field">
          <span>Paper id (filename will be &lt;id&gt;.json)</span>
          <input type="text" data-field="id" value="${escapeAttr(paper.id)}">
        </label>
        <label class="field">
          <span>Tags (comma separated)</span>
          <input type="text" data-field="tags" value="${escapeAttr((paper.tags || []).join(", "))}">
        </label>
      </div>

      <div class="row">
        <label class="field">
          <span>Title</span>
          <input type="text" data-field="title" value="${escapeAttr(paper.title || "")}">
        </label>
        <label class="field">
          <span>Year</span>
          <input type="text" data-field="year" value="${escapeAttr(paper.year || "")}">
        </label>
      </div>

      <label class="field">
        <span>Commentary — your annotation: what does this paper claim, and why is it on our list?</span>
        <textarea data-field="summary">${escapeHTML(paper.annotation.summary || "")}</textarea>
      </label>
      <label class="field">
        <span>Method <span class="small">(optional)</span> — how do they test it?</span>
        <textarea data-field="method"></textarea>
      </label>
      <label class="field">
        <span>Evaluation <span class="small">(optional)</span> — strengths, weaknesses, what convinced you</span>
        <textarea data-field="evaluation"></textarea>
      </label>
      <label class="field">
        <span>Relevance <span class="small">(optional)</span> — why this is on our list</span>
        <textarea data-field="relevance"></textarea>
      </label>

      <div class="actions-row">
        <button class="btn primary" data-act="pr">${signedIn() ? "Submit paper" : "Open pull request on GitHub"}</button>
        <button class="btn" data-act="download">Download JSON</button>
        <button class="btn" data-act="copy">Copy JSON</button>
        <button class="btn" data-act="dismiss">Dismiss</button>
      </div>
    `;

    div.addEventListener("click", (e) => {
      const btn = e.target.closest("button");
      if (!btn) return;
      const current = readForm(div, paper);
      if (btn.dataset.act === "pr")       submitPaper(current);
      if (btn.dataset.act === "download") downloadJSON(current);
      if (btn.dataset.act === "copy")     copyJSON(current);
      if (btn.dataset.act === "dismiss")  div.remove();
    });
    return div;
  }

  function readForm(div, basePaper) {
    const get = (f) => (div.querySelector(`[data-field="${f}"]`) || {}).value || "";
    const tags = get("tags").split(",").map(s => s.trim()).filter(Boolean);
    const yearRaw = get("year").trim();
    const yearMatch = yearRaw.match(/\d{4}/);
    const paper = {
      ...basePaper,
      id: get("id").trim() || basePaper.id,
      title: get("title").trim() || basePaper.title,
      year: yearMatch ? parseInt(yearMatch[0], 10) : (basePaper.year || null),
      tags,
      annotation: {
        author_github: ghUser() || basePaper.annotation.author_github || "",
        summary:    get("summary").trim(),
        method:     get("method").trim(),
        evaluation: get("evaluation").trim(),
        relevance:  get("relevance").trim()
      },
      highlights: basePaper.highlights || []
    };
    if (basePaper.pdf) paper.pdf = basePaper.pdf;
    delete paper._pdfPending;   // internal UI marker, never written out
    return paper;
  }

  // SUBMIT — the single seam for the write path.
  //
  // Signed in: POST to the proxy, which commits the paper (and its PDF) with
  // its own credential. Otherwise, or if that fails for any reason, fall back
  // to the no-backend path so the page never becomes a dead end.
  async function submitPaper(paper) {
    if (!signedIn()) {
      openPR(paper);
      return;
    }

    setStatus(`Submitting "${paper.title}"…`);
    try {
      const body = { paper };
      const file = pdfFiles.get(paper.id);
      if (file) body.pdf_base64 = await fileToBase64(file);

      const res = await fetch(auth().API + "/papers", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + auth().getToken(),
        },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        const out = await res.json();
        pdfFiles.delete(paper.id);
        const where = out.commit_url || out.file_url;
        // The paper's own page works immediately — it reads papers/<id>.json,
        // which is already committed. The main list takes a minute longer,
        // because it reads papers/index.json, and that is updated by the
        // create-issues Action after this commit, followed by a Pages rebuild.
        // Saying so beats leaving the contributor staring at an unchanged page.
        setStatusParts(
          `Submitted "${paper.title}"${out.pdf_path ? " (with PDF)" : ""}. `,
          statusLink(`paper.html?id=${encodeURIComponent(out.id)}`, "Open its page"),
          " — it joins the main list in a minute or so, once its discussion issue"
          + " is created and the site rebuilds.",
          where ? " " : null,
          where ? statusLink(where, "View the commit") : null,
        );
        return;
      }

      // 409 means the id is taken — retrying via the PR flow would just create
      // the same collision, so stop and let the user pick another id.
      const detail = await errorDetail(res);
      if (res.status === 409) {
        setStatus(`Not submitted: ${detail} Change the id field and try again.`);
        return;
      }
      setStatus(`Couldn't submit (${res.status}: ${detail}) — falling back to the GitHub flow.`);
    } catch (e) {
      setStatus(`Couldn't reach the submission API (${e.message}) — falling back to the GitHub flow.`);
    }

    openPR(paper);
  }

  async function errorDetail(res) {
    try {
      const j = await res.json();
      return typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail || j);
    } catch (_) {
      return res.statusText || "unknown error";
    }
  }

  // Base64 without the "data:...;base64," prefix the API doesn't expect.
  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => {
        const s = String(r.result);
        const comma = s.indexOf(",");
        resolve(comma === -1 ? s : s.slice(comma + 1));
      };
      r.onerror = () => reject(new Error("couldn't read the PDF"));
      r.readAsDataURL(file);
    });
  }

  function openPR(paper) {
    const json = JSON.stringify(paper, null, 2) + "\n";
    const url = `https://github.com/${GH_OWNER}/${GH_REPO}/new/main/papers`
              + `?filename=${encodeURIComponent(paper.id + ".json")}`
              + `&value=${encodeURIComponent(json)}`;
    // GitHub URLs over ~8KB get truncated or rejected. Fall back to copy.
    if (url.length > 7500) {
      copyJSON(paper);
      setStatus(`Annotation too long to send via URL — JSON copied to clipboard instead. Go to https://github.com/${GH_OWNER}/${GH_REPO}/new/main/papers, name the file "${paper.id}.json", and paste.`);
      return;
    }
    window.open(url, "_blank", "noopener");
    setStatus(`Opened GitHub in a new tab. Scroll down and click "Propose changes" to submit "${paper.title}".`);
  }

  function downloadJSON(paper) {
    const blob = new Blob([JSON.stringify(paper, null, 2) + "\n"], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${paper.id}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(a.href);
  }
  async function copyJSON(paper) {
    try {
      await navigator.clipboard.writeText(JSON.stringify(paper, null, 2));
      setStatus(`Copied JSON for "${paper.title}" to clipboard.`);
    } catch (_) {
      setStatus("Couldn't copy to clipboard. Use Download instead.");
    }
  }

  function escapeHTML(s) {
    return String(s ?? "").replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }
  function escapeAttr(s) { return escapeHTML(s).replace(/"/g, "&quot;"); }
})();
