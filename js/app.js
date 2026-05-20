// Listing page logic. Loads papers/index.json, then each paper file,
// pulls reaction/comment counts from GitHub Issues for sort + display.
// Browsing: free-text search, a clickable tag facet (AND filtering), sorting,
// and shareable state in the URL (?q=&tags=&sort=).

(async function () {
  const statusEl = document.getElementById("status");
  const listEl   = document.getElementById("papers");
  const searchEl = document.getElementById("search");
  const sortEl   = document.getElementById("sort");
  const tagbarEl = document.getElementById("tagbar");

  function setStatus(msg) { statusEl.textContent = msg; }

  let papers = [];
  const selectedTags = new Set();

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

  // Fetch GitHub stats lazily but concurrently. If config is missing or the
  // network fails, we still render the cards — counts just default to zero.
  await Promise.all(papers.map(async (p) => {
    p._stats = { upvotes: 0, comments: 0 };
    if (!p.issue) return;
    try {
      p._stats = await GH.getIssueStats(p.issue);
    } catch (_) { /* leave defaults */ }
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
    let rows = papers.filter(p => matchesSearch(p, q) && matchesTags(p));

    const sort = sortEl.value;
    rows.sort((a, b) => {
      if (sort === "title")    return (a.title || "").localeCompare(b.title || "");
      if (sort === "upvotes")  return (b._stats.upvotes || 0) - (a._stats.upvotes || 0);
      if (sort === "comments") return (b._stats.comments || 0) - (a._stats.comments || 0);
      if (sort === "oldest")   return (a.year || 0) - (b.year || 0) || (a.title || "").localeCompare(b.title || "");
      return (b.year || 0) - (a.year || 0) || (a.title || "").localeCompare(b.title || ""); // recent
    });

    listEl.innerHTML = rows.map(cardHTML).join("");

    const total = papers.length;
    const shown = rows.length;
    const filtered = q || selectedTags.size;
    if (!shown) {
      setStatus(filtered ? "No papers match the current filters." : "No papers yet.");
    } else {
      setStatus(filtered
        ? `Showing ${shown} of ${total} paper${total === 1 ? "" : "s"}.`
        : `${total} paper${total === 1 ? "" : "s"}.`);
    }

    renderTagBar();
    writeURL();
  }

  function renderTagBar() {
    const counts = new Map();
    for (const p of papers) {
      for (const t of (p.tags || [])) counts.set(t, (counts.get(t) || 0) + 1);
    }
    const tags = [...counts.keys()].sort((a, b) =>
      (counts.get(b) - counts.get(a)) || a.localeCompare(b));

    if (!tags.length) { tagbarEl.innerHTML = ""; return; }

    let html = `<span class="tagbar-label">Tags:</span>`;
    html += tags.map(t => {
      const active = selectedTags.has(t);
      return `<button type="button" class="tag tag-btn${active ? " active" : ""}"
        data-tag="${escapeAttr(t)}" aria-pressed="${active}">${escapeHTML(t)}<span class="tag-count">${counts.get(t)}</span></button>`;
    }).join("");
    if (selectedTags.size) {
      html += `<button type="button" class="tagbar-clear" data-clear="1">Clear filters</button>`;
    }
    tagbarEl.innerHTML = html;
  }

  function cardHTML(p) {
    const authors = (p.authors || []).join(", ");
    const tags = (p.tags || []).map(t =>
      `<button type="button" class="tag tag-btn${selectedTags.has(t) ? " active" : ""}" data-tag="${escapeAttr(t)}">${escapeHTML(t)}</button>`
    ).join("");
    const summary = p.annotation?.summary
      ? `<p class="paper-summary">${escapeHTML(p.annotation.summary)}</p>`
      : "";
    const meta = [authors, p.year, p.venue].filter(Boolean).map(escapeHTML).join(" · ");
    const hCount = (p.highlights || []).length;
    return `
      <li class="paper-card">
        <h2><a href="paper.html?id=${encodeURIComponent(p.id)}">${escapeHTML(p.title)}</a></h2>
        <p class="paper-meta">${meta}</p>
        <div class="paper-tags">${tags}</div>
        ${summary}
        <div class="paper-footer">
          <div class="counts">
            <span title="Upvotes on GitHub issue">👍 ${p._stats.upvotes}</span>
            <span title="Comments on GitHub issue">💬 ${p._stats.comments}</span>
            <span title="Inline highlights">✏️ ${hCount}</span>
          </div>
        </div>
      </li>`;
  }

  function toggleTag(tag) {
    if (selectedTags.has(tag)) selectedTags.delete(tag);
    else selectedTags.add(tag);
    render();
  }

  function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }
  function escapeAttr(s) { return escapeHTML(s).replace(/"/g, "&quot;"); }

  // --- events (delegated for the dynamic tag buttons) ---------------------
  searchEl.addEventListener("input", render);
  sortEl.addEventListener("change", render);
  tagbarEl.addEventListener("click", (e) => {
    const clear = e.target.closest("[data-clear]");
    if (clear) { selectedTags.clear(); render(); return; }
    const btn = e.target.closest("[data-tag]");
    if (btn) toggleTag(btn.dataset.tag);
  });
  listEl.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-tag]");
    if (btn) { e.preventDefault(); toggleTag(btn.dataset.tag); }
  });

  render();
})();
