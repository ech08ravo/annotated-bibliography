// Ratings client for the Textbook API (textbook-api.webgrid.online).
// Handles GitHub login (web flow), stores the bearer token, and renders
// star widgets. Best-effort: if the API is unreachable, ratings just don't
// show and the rest of the site is unaffected.

const Ratings = (function () {
  const API = "https://textbook-api.webgrid.online";
  const TOKEN_KEY = "textbook_token";

  // --- token / auth -------------------------------------------------------

  function getToken() {
    try { return localStorage.getItem(TOKEN_KEY) || null; } catch (_) { return null; }
  }
  function setToken(t) {
    try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch (_) {}
  }
  function authHeaders(extra) {
    const h = Object.assign({}, extra || {});
    const t = getToken();
    if (t) h["Authorization"] = "Bearer " + t;
    return h;
  }

  // After OAuth, the API redirects back with #token=... in the fragment.
  // Capture it, store it, and scrub it from the URL.
  function captureTokenFromHash() {
    if (!location.hash) return;
    const m = location.hash.match(/token=([^&]+)/);
    if (m) {
      setToken(decodeURIComponent(m[1]));
      history.replaceState(null, "", location.pathname + location.search);
    }
  }

  function login() { window.location.href = API + "/auth/login"; }
  function logout() { setToken(null); renderAccount(); }

  let _me = null;
  async function me() {
    if (!getToken()) return null;
    if (_me) return _me;
    try {
      const r = await fetch(API + "/auth/me", { headers: authHeaders() });
      if (!r.ok) { if (r.status === 401) setToken(null); return null; }
      _me = await r.json();
      return _me;
    } catch (_) { return null; }
  }

  // --- ratings data -------------------------------------------------------

  async function all() {
    try {
      const r = await fetch(API + "/ratings");
      if (!r.ok) return {};
      return await r.json();
    } catch (_) { return {}; }
  }

  async function get(paperId) {
    try {
      const r = await fetch(API + "/ratings/" + encodeURIComponent(paperId), { headers: authHeaders() });
      if (!r.ok) return null;
      return await r.json();
    } catch (_) { return null; }
  }

  async function post(paperId, stars) {
    const r = await fetch(API + "/ratings", {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ paper_id: paperId, stars }),
    });
    if (r.status === 401) { setToken(null); throw new Error("Please sign in again."); }
    if (!r.ok) throw new Error("Couldn't save rating (HTTP " + r.status + ").");
    return await r.json();
  }

  // --- rendering helpers --------------------------------------------------

  // Read-only star line for cards / headers.
  function starsStatic(avg, count) {
    if (!count) return `<span class="stars stars-empty" title="No ratings yet">☆☆☆☆☆ <span class="rating-meta">unrated</span></span>`;
    const full = Math.round(avg);
    let s = "";
    for (let i = 1; i <= 5; i++) s += i <= full ? "★" : "☆";
    return `<span class="stars" title="${avg} from ${count} rating${count === 1 ? "" : "s"}">${s} <span class="rating-meta">${avg} (${count})</span></span>`;
  }

  // Interactive 5-star control for the detail page.
  function starsInteractive(your) {
    let s = "";
    for (let i = 1; i <= 5; i++) {
      const on = your && i <= your;
      s += `<button type="button" class="star-btn${on ? " on" : ""}" data-stars="${i}" aria-label="${i} star${i === 1 ? "" : "s"}">${on ? "★" : "☆"}</button>`;
    }
    return `<span class="star-input" role="group" aria-label="Your rating">${s}</span>`;
  }

  // --- account UI (header) ------------------------------------------------

  async function renderAccount() {
    const el = document.getElementById("account");
    if (!el) return;
    _me = null; // re-check
    const user = await me();
    if (user) {
      el.innerHTML =
        `<span class="account-user">@${esc(user.login)}</span>` +
        `<button type="button" class="btn account-out">Sign out</button>`;
      el.querySelector(".account-out").addEventListener("click", logout);
    } else {
      el.innerHTML = `<button type="button" class="btn account-in">Sign in with GitHub</button>`;
      el.querySelector(".account-in").addEventListener("click", login);
    }
  }

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  // Run as soon as the script loads.
  captureTokenFromHash();
  document.addEventListener("DOMContentLoaded", renderAccount);

  return {
    API, login, logout, me, all, get, post,
    getToken, starsStatic, starsInteractive, renderAccount,
  };
})();
