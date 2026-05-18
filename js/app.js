// Listing page logic. Loads papers/index.json, then each paper file,
// pulls reaction/comment counts from GitHub Issues for sort + display.

(async function () {
  const statusEl = document.getElementById("status");
  const listEl   = document.getElementById("papers");
  const searchEl = document.getElementById("search");
  const sortEl   = document.getElementById("sort");

  function setStatus(msg) { statusEl.textContent = msg; }

  let papers = [];

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
      const stats = await GH.getIssueStats(p.issue);
      p._stats = stats;
    } catch (_) { /* leave defaults */ }
  }));

  setStatus(`${papers.length} paper${papers.length === 1 ? "" : "s"}.`);

  function render() {
    const q = searchEl.value.trim().toLowerCase();
    let rows = papers.slice();

    if (q) {
      rows = rows.filter(p => {
        const hay = [
          p.title, (p.authors || []).join(" "), (p.tags || []).join(" "),
          p.venue, p.annotation?.summary
        ].filter(Boolean).join(" ").toLowerCase();
        return hay.includes(q);
      });
    }

    const sort = sortEl.value;
    rows.sort((a, b) => {
      if (sort === "title")   return (a.title || "").localeCompare(b.title || "");
      if (sort === "upvotes") return (b._stats.upvotes || 0) - (a._stats.upvotes || 0);
      // recent = by year desc, then title
      return (b.year || 0) - (a.year || 0) || (a.title || "").localeCompare(b.title || "");
    });

    listEl.innerHTML = rows.map(cardHTML).join("");
  }

  function cardHTML(p) {
    const authors = (p.authors || []).join(", ");
    const tags = (p.tags || []).map(t => `<span class="tag">${escapeHTML(t)}</span>`).join("");
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

  function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  searchEl.addEventListener("input", render);
  sortEl.addEventListener("change", render);
  render();
})();
