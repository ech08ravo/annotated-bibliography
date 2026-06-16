// Comments client for the Textbook API. Per-annotation-section threads.
// Shares auth with the ratings client (same bearer token via Ratings.getToken).

const Comments = (function () {
  const API = "https://textbook-api.webgrid.online";

  function authHeaders(extra) {
    const h = Object.assign({}, extra || {});
    const t = (typeof Ratings !== "undefined") ? Ratings.getToken() : null;
    if (t) h["Authorization"] = "Bearer " + t;
    return h;
  }

  async function list(paperId) {
    try {
      const r = await fetch(API + "/comments/" + encodeURIComponent(paperId));
      if (!r.ok) return { comments: [] };
      return await r.json();
    } catch (_) { return { comments: [] }; }
  }

  async function post(paperId, section, body) {
    const r = await fetch(API + "/comments", {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ paper_id: paperId, section, body }),
    });
    if (r.status === 401) throw new Error("Please sign in again.");
    if (!r.ok) throw new Error("Couldn't post comment (HTTP " + r.status + ").");
    return await r.json();
  }

  async function remove(id) {
    const r = await fetch(API + "/comments/" + encodeURIComponent(id), {
      method: "DELETE",
      headers: authHeaders(),
    });
    if (!r.ok) throw new Error("Couldn't delete (HTTP " + r.status + ").");
    return await r.json();
  }

  return { list, post, remove };
})();
