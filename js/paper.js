// Paper detail page. Loads one paper file, renders bibliographic annotation,
// PDF (if present) with highlight overlays, comments + upvote link from GitHub.

(async function () {
  const root = document.getElementById("root");
  const params = new URLSearchParams(window.location.search);
  const id = params.get("id");

  if (!id) { root.textContent = "No paper id in URL."; return; }
  if (!/^[a-zA-Z0-9_\-]+$/.test(id)) { root.textContent = "Invalid paper id."; return; }

  let paper;
  try {
    paper = await fetch(`papers/${id}.json`).then(r => {
      if (!r.ok) throw new Error("not found");
      return r.json();
    });
  } catch (_) {
    root.textContent = `Couldn't load paper '${id}'.`;
    return;
  }

  document.title = `${paper.title} · Shared Annotated Bibliography`;

  // Build the page shell synchronously so things appear quickly.
  const authorList = (paper.authors || []).join(", ");
  const meta = [authorList, paper.year, paper.venue].filter(Boolean).map(esc).join(" · ");
  const tags = (paper.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join("");
  const ann  = paper.annotation || {};
  const issueUrl = paper.issue ? GH.issueUrl(paper.issue) : null;

  let citeLine = "";
  if (paper.citations) {
    const c = paper.citations;
    const recent = (c.by_year || []).slice(-3).reverse()
      .map(y => `${y.year}: ${Number(y.count).toLocaleString()}`).join(" · ");
    const src = [c.source, c.retrieved].filter(Boolean).map(esc).join(", ");
    citeLine = `<p class="meta cite-line">📊 Cited ${Number(c.count || 0).toLocaleString()} times`
      + (src ? ` <span class="cite-src">· ${src}</span>` : "")
      + (recent ? `<br><span class="cite-src">recent — ${esc(recent)}</span>` : "")
      + `</p>`;
  }

  root.innerHTML = `
    <header>
      <h1>${esc(paper.title)}</h1>
      <p class="meta">${meta}</p>
      <div class="paper-tags">${tags}</div>
      ${citeLine}
    </header>

    <div class="actions">
      ${paper.url ? `<a href="${esc(paper.url)}" target="_blank" rel="noopener">Open source ↗</a>` : ""}
      ${paper.doi ? `<a href="https://doi.org/${esc(paper.doi)}" target="_blank" rel="noopener">DOI</a>` : ""}
      ${issueUrl ? `<a href="${issueUrl}#issue-comment-box" target="_blank" rel="noopener" id="comment-link">💬 Comment on GitHub</a>` : ""}
      ${issueUrl ? `<a href="${issueUrl}" target="_blank" rel="noopener" id="upvote-link">👍 React on GitHub</a>` : ""}
    </div>

    <section class="annotation">
      ${ann.author_github ? `<p class="meta">Annotated by <a href="https://github.com/${esc(ann.author_github)}" target="_blank" rel="noopener">@${esc(ann.author_github)}</a></p>` : ""}
      ${section("Summary", ann.summary)}
      ${section("Method", ann.method)}
      ${section("Evaluation", ann.evaluation)}
      ${section("Relevance", ann.relevance)}
    </section>

    ${paper.pdf ? `
      <h2>PDF</h2>
      <div id="pdf" class="pdf-wrap">Loading PDF…</div>
    ` : ""}

    ${(paper.highlights || []).length ? `
      <section class="highlight-list">
        <h3>Inline highlights</h3>
        <ol id="highlights">${(paper.highlights).map(highlightItemHTML).join("")}</ol>
      </section>
    ` : ""}

    <section class="comments">
      <h3>Discussion</h3>
      <p class="meta" id="stats">…</p>
      <ul id="comments-list"></ul>
    </section>
  `;

  // Render the PDF with overlays
  if (paper.pdf) {
    try {
      await PDFViewer.render({
        url: `papers/${paper.pdf}`,
        container: document.getElementById("pdf"),
        highlights: paper.highlights || [],
        onHighlightClick: (h) => {
          const target = document.getElementById(`hl-${h.id}`);
          if (target) target.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      });
    } catch (err) {
      document.getElementById("pdf").textContent = `Couldn't render PDF: ${err.message || err}`;
    }
  }

  // Comments + reaction count
  if (paper.issue) {
    try {
      const [stats, comments] = await Promise.all([
        GH.getIssueStats(paper.issue),
        GH.getIssueComments(paper.issue),
      ]);
      document.getElementById("stats").textContent =
        `${stats.upvotes} upvote${stats.upvotes === 1 ? "" : "s"} · ${stats.comments} comment${stats.comments === 1 ? "" : "s"} on GitHub`;
      document.getElementById("comments-list").innerHTML = comments.map(commentHTML).join("") ||
        `<li>No comments yet. <a href="${issueUrl}" target="_blank" rel="noopener">Start the discussion ↗</a></li>`;
    } catch (e) {
      document.getElementById("stats").textContent =
        `Couldn't load GitHub data (${e.message || e}). See the issue directly.`;
    }
  } else {
    document.getElementById("stats").textContent =
      "No GitHub issue linked for this paper — no comments yet.";
  }

  function section(title, body) {
    if (!body) return "";
    return `<section><h3>${title}</h3><p>${esc(body)}</p></section>`;
  }
  function highlightItemHTML(h) {
    const by = h.author_github
      ? `<span class="by">— <a href="https://github.com/${esc(h.author_github)}" target="_blank" rel="noopener">@${esc(h.author_github)}</a>, page ${esc(h.page)}</span>`
      : `<span class="by">page ${esc(h.page)}</span>`;
    return `
      <li id="hl-${esc(h.id)}">
        <blockquote>“${esc(h.quote || "")}”</blockquote>
        ${h.note ? `<div class="note">${esc(h.note)}</div>` : ""}
        ${by}
      </li>`;
  }
  function commentHTML(c) {
    return `
      <li>
        <div class="by"><a href="${c.user.html_url}" target="_blank" rel="noopener">@${esc(c.user.login)}</a> · <a href="${c.html_url}" target="_blank" rel="noopener">${new Date(c.created_at).toLocaleDateString()}</a></div>
        <div class="body">${esc(c.body || "")}</div>
      </li>`;
  }
  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }
})();
