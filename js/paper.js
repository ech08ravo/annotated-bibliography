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

    <section class="rating-block">
      <h3>Rating</h3>
      <div id="rating-area" class="rating-area">…</div>
    </section>

    <section class="annotation">
      ${ann.author_github ? `<p class="meta">Annotated by <a href="https://github.com/${esc(ann.author_github)}" target="_blank" rel="noopener">@${esc(ann.author_github)}</a></p>` : ""}
      ${section("Summary", ann.summary, "summary")}
      ${section("Method", ann.method, "method")}
      ${section("Evaluation", ann.evaluation, "evaluation")}
      ${section("Relevance", ann.relevance, "relevance")}
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

  // --- ratings ------------------------------------------------------------
  if (typeof Ratings !== "undefined") {
    renderRating();
  }

  async function renderRating() {
    const area = document.getElementById("rating-area");
    if (!area) return;
    const [data, user] = await Promise.all([Ratings.get(id), Ratings.me()]);
    const avg = data?.average, count = data?.count || 0, your = data?.your_rating || 0;

    const summary = Ratings.starsStatic(avg, count);
    let body;
    if (user) {
      body = `<div class="rating-mine">
                <span class="rating-label">Your rating:</span>
                ${Ratings.starsInteractive(your)}
              </div>
              <p class="meta rating-avg">Average: ${summary}</p>
              <p class="meta rating-msg" id="rating-msg"></p>`;
    } else {
      body = `<p class="meta rating-avg">Average: ${summary}</p>
              <p class="meta"><button type="button" class="btn" id="rating-signin">Sign in with GitHub to rate</button></p>`;
    }
    area.innerHTML = body;

    const signin = document.getElementById("rating-signin");
    if (signin) signin.addEventListener("click", () => Ratings.login());

    area.querySelectorAll(".star-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const stars = Number(btn.dataset.stars);
        const msg = document.getElementById("rating-msg");
        if (msg) msg.textContent = "Saving…";
        try {
          const res = await Ratings.post(id, stars);
          // re-render with the new state
          area.querySelectorAll(".star-btn").forEach((b, i) => {
            const on = i < stars;
            b.classList.toggle("on", on);
            b.textContent = on ? "★" : "☆";
          });
          const avgEl = area.querySelector(".rating-avg");
          if (avgEl) avgEl.innerHTML = "Average: " + Ratings.starsStatic(res.average, res.count);
          if (msg) msg.textContent = "Saved — you rated this " + stars + " star" + (stars === 1 ? "" : "s") + ".";
        } catch (e) {
          if (msg) msg.textContent = e.message || "Couldn't save rating.";
        }
      });
    });
  }

  function section(title, body, key) {
    if (!body) return "";
    const thread = key ? `<div class="comment-thread" data-section="${key}"></div>` : "";
    return `<section><h3>${title}</h3><p>${esc(body)}</p>${thread}</section>`;
  }

  // --- comments (per annotation section) ----------------------------------
  if (typeof Comments !== "undefined") {
    renderComments();
  }

  async function renderComments() {
    const threads = Array.from(document.querySelectorAll(".comment-thread"));
    if (!threads.length) return;
    const [data, user] = await Promise.all([Comments.list(id), Ratings.me()]);
    const bySection = {};
    (data?.comments || []).forEach(c => { (bySection[c.section] = bySection[c.section] || []).push(c); });

    threads.forEach(el => {
      const sec = el.dataset.section;
      el.innerHTML = threadHTML(sec, bySection[sec] || [], user);
      wireThread(el, sec, user);
    });
  }

  function threadHTML(sec, list, user) {
    const items = list.map(c => commentItemHTML(c, user)).join("")
      || `<li class="comment-empty">No comments yet.</li>`;
    const form = user
      ? `<form class="comment-form">
           <textarea class="comment-input" rows="2" maxlength="5000" placeholder="Add a comment on the ${esc(sec)}…"></textarea>
           <button type="submit" class="btn">Post</button>
         </form>`
      : `<p class="meta"><button type="button" class="btn comment-signin">Sign in with GitHub to comment</button></p>`;
    return `
      <button type="button" class="thread-toggle" aria-expanded="false">💬 ${list.length} comment${list.length === 1 ? "" : "s"}</button>
      <div class="thread-body" hidden>
        <ul class="comment-list">${items}</ul>
        ${form}
      </div>`;
  }

  function commentItemHTML(c, user) {
    const mine = user && user.id === c.user_id;
    const del = mine ? `<button type="button" class="comment-del" data-id="${c.id}" title="Delete">✕</button>` : "";
    const when = new Date((c.created_at || 0) * 1000).toLocaleDateString();
    return `
      <li data-id="${c.id}">
        <div class="by"><a href="https://github.com/${esc(c.login)}" target="_blank" rel="noopener">@${esc(c.login)}</a> · ${when} ${del}</div>
        <div class="body">${esc(c.body)}</div>
      </li>`;
  }

  function wireThread(el, sec, user) {
    const toggle = el.querySelector(".thread-toggle");
    const bodyEl = el.querySelector(".thread-body");
    if (toggle && bodyEl) toggle.addEventListener("click", () => {
      const open = bodyEl.hidden;
      bodyEl.hidden = !open;
      toggle.setAttribute("aria-expanded", String(open));
    });

    const signin = el.querySelector(".comment-signin");
    if (signin) signin.addEventListener("click", () => Ratings.login());

    const form = el.querySelector(".comment-form");
    if (form) form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const ta = form.querySelector(".comment-input");
      const text = (ta.value || "").trim();
      if (!text) return;
      const btn = form.querySelector("button");
      btn.disabled = true;
      try {
        await Comments.post(id, sec, text);
        ta.value = "";
        await renderComments();
        const reopen = document.querySelector(`.comment-thread[data-section="${sec}"] .thread-toggle`);
        if (reopen) reopen.click();
      } catch (err) {
        alert(err.message || "Couldn't post comment.");
      } finally { btn.disabled = false; }
    });

    el.querySelectorAll(".comment-del").forEach(b => b.addEventListener("click", async () => {
      if (!confirm("Delete this comment?")) return;
      try { await Comments.remove(Number(b.dataset.id)); await renderComments(); }
      catch (err) { alert(err.message || "Couldn't delete."); }
    }));
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
