// Browser-side contribute page. Reads .ris file(s), parses them with
// the shared RIS module, lets the user annotate each record, then
// produces downloadable paper-JSON files.

(function () {
  const dropzone = document.getElementById("dropzone");
  const fileInput = document.getElementById("file");
  const recordsEl = document.getElementById("records");
  const statusEl  = document.getElementById("status");
  const ghUserEl  = document.getElementById("gh-user");

  // Restore previously-entered username
  try {
    const saved = localStorage.getItem("contribute.ghUser");
    if (saved) ghUserEl.value = saved;
  } catch (_) {}
  ghUserEl.addEventListener("input", () => {
    try { localStorage.setItem("contribute.ghUser", ghUserEl.value); } catch (_) {}
  });

  function setStatus(msg) { statusEl.textContent = msg || ""; }

  // Drag-and-drop wiring
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

    let allRecords = [];
    for (const f of files) {
      try {
        const text = await f.text();
        const recs = RIS.parseRIS(text);
        if (!recs.length) {
          console.warn(`No RIS records found in ${f.name}`);
          continue;
        }
        allRecords = allRecords.concat(recs);
      } catch (e) {
        console.error(`Failed to parse ${f.name}`, e);
      }
    }

    if (!allRecords.length) {
      setStatus("No records found. Make sure the file is a real RIS export (each record starts with TY  - and ends with ER  -).");
      return;
    }

    setStatus(`${allRecords.length} record${allRecords.length === 1 ? "" : "s"} parsed. Add your annotation for each, then download.`);
    renderRecords(allRecords);
  }

  function renderRecords(records) {
    recordsEl.innerHTML = "";
    records.forEach((r, i) => {
      const paper = RIS.toPaper(r, {
        author_github: ghUserEl.value.trim() || "",
      });
      const node = recordNode(paper, i);
      recordsEl.appendChild(node);
    });
  }

  function recordNode(paper, idx) {
    const div = document.createElement("div");
    div.className = "record";
    div.dataset.idx = String(idx);

    const authorList = (paper.authors || []).join(", ");
    const meta = [authorList, paper.year, paper.venue].filter(Boolean).join(" · ");

    div.innerHTML = `
      <h3>${escapeHTML(paper.title)}</h3>
      <p class="meta">${escapeHTML(meta)}</p>

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

      <label class="field">
        <span>Summary — one paragraph: what does the paper claim?</span>
        <textarea data-field="summary">${escapeHTML(paper.annotation.summary || "")}</textarea>
      </label>
      <label class="field">
        <span>Method — how do they test it?</span>
        <textarea data-field="method"></textarea>
      </label>
      <label class="field">
        <span>Evaluation — strengths, weaknesses, what convinced you</span>
        <textarea data-field="evaluation"></textarea>
      </label>
      <label class="field">
        <span>Relevance — why this is on our list</span>
        <textarea data-field="relevance"></textarea>
      </label>

      <div class="actions-row">
        <button class="btn primary" data-act="download">Download paper JSON</button>
        <button class="btn" data-act="copy">Copy JSON to clipboard</button>
        <button class="btn" data-act="dismiss">Dismiss</button>
      </div>
    `;

    div.addEventListener("click", (e) => {
      const btn = e.target.closest("button");
      if (!btn) return;
      const current = readForm(div, paper);
      if (btn.dataset.act === "download") downloadJSON(current);
      if (btn.dataset.act === "copy")     copyJSON(current);
      if (btn.dataset.act === "dismiss")  div.remove();
    });
    return div;
  }

  function readForm(div, basePaper) {
    const get = (f) => (div.querySelector(`[data-field="${f}"]`) || {}).value || "";
    const tags = get("tags").split(",").map(s => s.trim()).filter(Boolean);
    return {
      ...basePaper,
      id: get("id").trim() || basePaper.id,
      tags,
      annotation: {
        author_github: ghUserEl.value.trim() || basePaper.annotation.author_github || "",
        summary:    get("summary").trim(),
        method:     get("method").trim(),
        evaluation: get("evaluation").trim(),
        relevance:  get("relevance").trim()
      }
    };
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
