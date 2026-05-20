// Listing page logic. Loads papers/index.json, then each paper file, pulls
// reaction/comment counts from GitHub Issues. Browsing: free-text search, a
// clickable tag facet (AND filtering), sorting, citation counts (OpenAlex),
// shareable URL state (?q=&tags=&sort=), and multi-select export.

(async function () {
  const statusEl = document.getElementById("status");
  const listEl   = document.getElementById("papers");
  const searchEl = document.getElementById("search");
  const sortEl   = document.getElementById("sort");
  const tagbarEl = document.getElementById("tagbar");

  // export bar
  const barEl     = document.getElementById("exportbar");
  const countEl   = document.getElementById("export-count");
  const allEl     = document.getElementById("select-all");
  const formatEl  = document.getElementById("export-format");
  const dlEl       = document.getElementById("export-download");
  const copyEl     = document.getElementById("export-copy");
  const clearSelEl = document.getElementById("export-clear");

  function setStatus(msg) { statusEl.textContent = msg; }

  let papers = [];
  let currentRows = [];
  const selectedTags = new Set();
  const selectedIds  = new Set();

  // --- restore state from the URL so views are shareable ------------------
  (function readURL() {
    const params = new URLSearchParams(location.search);
    searchEl.value = params.get("q") || "";
    const sort = params.get("sort");
    if (sort && [...sortEl.options].some(o => o.value === sort)) sortEl.value = sort;
    (params.get("tags") || "").split(",").map(s => s.trim()).filter(Boolean)
      .forEach(t => selectedTags.add(t));
  })();

  function writeURL() {
    const params = new URLSearchParams();
    const q = searchEl.value.trim();
    if (q) params.set("q", q);
    if (selectedTags.size) params.set("tags", [...selectedTags].join(","));
    if (sortEl.value && sortEl.value !== "recent") params.set("sort", sortEl.value);
    const qs = params.toString();
    history.replaceState(null, "", qs ? `?${qs}` : location.pathname);
  }

  // --- load data ----------------------------------------------------------
  try {
    setStatus("Loading bibliography…");
    const index = await fetch("papers/index.json").then(r => r.json());
    papers = await Promise.all(
      index.map(id =>
        fetch(`papers/${id}.json`)
          .then(r => r.ok ? r.json() : Promise.reject(`Missing papers/${id}.json`))
      )
    );
  } catch (e) {
    setStatus(`Couldn't load papers: ${e}`);
    return;
  }
  const byId = new Map(papers.map(p => [p.id, p]));

  // GitHub stats: concurrent, best-effort.
  await Promise.all(papers.map(async (p) => {
    p._stats = { upvotes: 0, comments: 0 };
    if (!p.issue) return;
    try { p._stats = await GH.getIssueStats(p.issue); } catch (_) {}
  }));

  // --- filtering ----------------------------------------------------------
  function matchesSearch(p, q) {
    if (!q) return true;
    const hay = [
      p.title, (p.authors || []).join(" "), (p.tags || []).join(" "),
      p.venue, p.annotation?.summary
    ].filter(Boolean).join(" ").toLowerCase();
    return hay.includes(q);
  }
  function matchesTags(p) {
    if (!selectedTags.size) return true;
    const tags = new Set(p.tags || []);
    for (const t of selectedTags) if (!tags.has(t)) return false; // AND
    return true;
  }

  // --- render -------------------------------------------------------------
  function render() {
    const q = searchEl.value.trim().toLowerCase();
    currentRows = papers.filter(p => matchesSearch(p, q) && matchesTags(p));

    const sort = sortEl.value;
    currentRows.sort((a, b) => {
      if (sort === "title")    return (a.title || "").localeCompare(b.title || "");
      if (sort === "upvotes")  return (b._stats.upvotes || 0) - (a._stats.upvotes || 0);
      if (sort === "comments") return (b._stats.comments || 0) - (a._stats.comments || 0);
      if (sort === "citations")return (b.citations?.count || 0) - (a.citations?.count || 0);
      if (sort === "oldest")   return (a.year || 0) - (b.year || 0) || (a.title || "").localeCompare(b.title || "");
      return (b.year || 0) - (a.year || 0) || (a.title || "").localeCompare(b.title || ""); // recent
    });

    listEl.innerHTML = currentRows.map(cardHTML).join("");

    const total = papers.length, shown = currentRows.length;
    const filtered = q || selectedTags.size;
    if (!shown) setStatus(filtered ? "No papers match the current filters." : "No papers yet.");
    else setStatus(filtered
      ? `Showing ${shown} of ${total} paper${total === 1 ? "" : "s"}.`
      : `${total} paper${total === 1 ? "" : "s"}.`);

    renderTagBar();
    renderExportBar();
    writeURL();
  }

  function renderTagBar() {
    const counts = new Map();
    for (const p of papers) for (const t of (p.tags || [])) counts.set(t, (counts.get(t) || 0) + 1);
    const tags = [...counts.keys()].sort((a, b) => (counts.get(b) - counts.get(a)) || a.localeCompare(b));
    if (!tags.length) { tagbarEl.innerHTML = ""; return; }

    let html = `<span class="tagbar-label">Tags:</span>`;
    html += tags.map(t => {
      const active = selectedTags.has(t);
      return `<button type="button" class="tag tag-btn${active ? " active" : ""}"
        data-tag="${escapeAttr(t)}" aria-pressed="${active}">${escapeHTML(t)}<span class="tag-count">${counts.get(t)}</span></button>`;
    }).join("");
    if (selectedTags.size) html += `<button type="button" class="tagbar-clear" data-clear="1">Clear filters</button>`;
    tagbarEl.innerHTML = html;
  }

  function renderExportBar() {
    if (!barEl) return;
    const n = selectedIds.size;
    barEl.hidden = n === 0;
    if (countEl) countEl.textContent = `${n} selected`;
    if (allEl) {
      const shownIds = currentRows.map(p => p.id);
      const allShownSelected = shownIds.length > 0 && shownIds.every(id => selectedIds.has(id));
      allEl.checked = allShownSelected;
    }
  }

  function fmtNum(n) { return Number(n || 0).toLocaleString(); }

  function cardHTML(p) {
    const authors = (p.authors || []).join(", ");
    const tags = (p.tags || []).map(t =>
      `<button type="button" class="tag tag-btn${selectedTags.has(t) ? " active" : ""}" data-tag="${escapeAttr(t)}">${escapeHTML(t)}</button>`
    ).join("");
    const summary = p.annotation?.summary
      ? `<p class="paper-summary">${escapeHTML(p.annotation.summary)}</p>` : "";
    const meta = [authors, p.year, p.venue].filter(Boolean).map(escapeHTML).join(" · ");
    const hCount = (p.highlights || []).length;
    const cites = p.citations
      ? `<span title="Citations (${escapeAttr(p.citations.source || "source")})">📊 ${fmtNum(p.citations.count)}</span>` : "";
    const checked = selectedIds.has(p.id) ? " checked" : "";
    return `
      <li class="paper-card">
        <label class="select-box" title="Select for export">
          <input type="checkbox" class="select-cb" data-select="${escapeAttr(p.id)}"${checked}>
        </label>
        <h2><a href="paper.html?id=${encodeURIComponent(p.id)}">${escapeHTML(p.title)}</a></h2>
        <p class="paper-meta">${meta}</p>
        <div class="paper-tags">${tags}</div>
        ${summary}
        <div class="paper-footer">
          <div class="counts">
            <span title="Upvotes on GitHub issue">👍 ${p._stats.upvotes}</span>
            <span title="Comments on GitHub issue">💬 ${p._stats.comments}</span>
            <span title="Inline highlights">✏️ ${hCount}</span>
            ${cites}
          </div>
        </div>
      </li>`;
  }

  function toggleTag(tag) {
    if (selectedTags.has(tag)) selectedTags.delete(tag); else selectedTags.add(tag);
    render();
  }

  // --- export -------------------------------------------------------------
  function selectedPapers() { return papers.filter(p => selectedIds.has(p.id)); }

  function doExport(copy) {
    const sel = selectedPapers();
    if (!sel.length) return;
    const out = Exporter.buildExport(sel, formatEl.value);
    if (copy) {
      navigator.clipboard.writeText(out.text)
        .then(() => setStatus(`Copied ${sel.length} reference${sel.length === 1 ? "" : "s"} (${formatEl.value}) to clipboard.`))
        .catch(() => setStatus("Couldn't copy — try Export to download instead."));
    } else {
      const blob = new Blob([out.text], { type: out.mime });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = out.filename;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(a.href);
      setStatus(`Exported ${sel.length} reference${sel.length === 1 ? "" : "s"} as ${out.filename}.`);
    }
  }

  function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }
  function escapeAttr(s) { return escapeHTML(s).replace(/"/g, "&quot;"); }

  // --- events -------------------------------------------------------------
  searchEl.addEventListener("input", render);
  sortEl.addEventListener("change", render);
  tagbarEl.addEventListener("click", (e) => {
    if (e.target.closest("[data-clear]")) { selectedTags.clear(); render(); return; }
    const btn = e.target.closest("[data-tag]");
    if (btn) toggleTag(btn.dataset.tag);
  });
  listEl.addEventListener("click", (e) => {
    const tagBtn = e.target.closest("[data-tag]");
    if (tagBtn) { e.preventDefault(); toggleTag(tagBtn.dataset.tag); }
  });
  listEl.addEventListener("change", (e) => {
    const cb = e.target.closest(".select-cb");
    if (!cb) return;
    if (cb.checked) selectedIds.add(cb.dataset.select); else selectedIds.delete(cb.dataset.select);
    renderExportBar();
  });

  if (allEl) allEl.addEventListener("change", () => {
    const shownIds = currentRows.map(p => p.id);
    if (allEl.checked) shownIds.forEach(id => selectedIds.add(id));
    else shownIds.forEach(id => selectedIds.delete(id));
    render();
  });
  if (dlEl)       dlEl.addEventListener("click", () => doExport(false));
  if (copyEl)     copyEl.addEventListener("click", () => doExport(true));
  if (clearSelEl) clearSelEl.addEventListener("click", () => { selectedIds.clear(); render(); });

  // Sort option for citations only matters once data exists; harmless otherwise.
  render();
})();
