// Issue stats and comments for the site.
//
// Reads go through the API proxy when it's reachable: it fetches the whole issue
// list in one upstream sweep and caches it, so the cost no longer scales with the
// number of papers or the number of visitors. Reading directly from the browser
// costs one unauthenticated GitHub request per paper per visitor against a
// 60/hour per-IP ceiling — a shared office or campus IP ran dry after a couple of
// page loads, and the counts silently rendered as zero.
//
// Direct GitHub remains the fallback, so the site still works if the proxy is
// down or unconfigured.

const GH_OWNER = "ech08ravo";
const GH_REPO  = "annotated-bibliography";

const GH = (function () {
  const API = "https://api.github.com";
  // Same origin the ratings/comments client uses; kept local so this file has no
  // load-order dependency on js/ratings.js.
  const PROXY = "https://textbook-api.webgrid.online";

  const ghHeaders = { "Accept": "application/vnd.github+json" };

  function issueUrl(num) {
    return `https://github.com/${GH_OWNER}/${GH_REPO}/issues/${num}`;
  }

  // Cached promise for the batch call, so concurrent callers on one page load
  // share a single request.
  let _allStats = null;

  // Returns { "<issue number>": { upvotes, comments } } for every issue, or null
  // if the proxy is unavailable — callers then fall back to per-issue reads.
  function allIssueStats() {
    if (_allStats) return _allStats;
    _allStats = (async () => {
      try {
        const res = await fetch(`${PROXY}/issues`);
        if (!res.ok) return null;
        return await res.json();
      } catch (_) {
        return null;
      }
    })();
    return _allStats;
  }

  // Returns { upvotes, comments }. Upvotes are the count of 👍 reactions.
  async function getIssueStats(num) {
    const all = await allIssueStats();
    if (all && Object.prototype.hasOwnProperty.call(all, String(num))) {
      return all[String(num)];
    }
    // Fallback: read this one issue straight from GitHub.
    const res = await fetch(`${API}/repos/${GH_OWNER}/${GH_REPO}/issues/${num}`, {
      headers: ghHeaders,
    });
    if (!res.ok) throw new Error(`issue #${num}: HTTP ${res.status}`);
    const data = await res.json();
    return {
      upvotes:  data.reactions ? (data.reactions["+1"] || 0) : 0,
      comments: data.comments  || 0,
    };
  }

  // Stats for many issues at once — one proxy call for the whole listing page.
  // Falls back to concurrent per-issue GitHub reads, best-effort per issue.
  async function getIssueStatsMany(numbers) {
    const out = {};
    const wanted = (numbers || []).filter(Boolean).map(String);
    const all = await allIssueStats();
    if (all) {
      wanted.forEach(n => { out[n] = all[n] || { upvotes: 0, comments: 0 }; });
      return out;
    }
    await Promise.all(wanted.map(async (n) => {
      try { out[n] = await getIssueStats(n); }
      catch (_) { out[n] = { upvotes: 0, comments: 0 }; }
    }));
    return out;
  }

  async function getIssueComments(num) {
    try {
      const res = await fetch(`${PROXY}/issues/${num}/comments`);
      if (res.ok) return await res.json();
    } catch (_) { /* fall through to GitHub */ }

    const res = await fetch(
      `${API}/repos/${GH_OWNER}/${GH_REPO}/issues/${num}/comments?per_page=100`,
      { headers: ghHeaders }
    );
    if (!res.ok) throw new Error(`comments #${num}: HTTP ${res.status}`);
    return await res.json();
  }

  return { issueUrl, getIssueStats, getIssueStatsMany, getIssueComments };
})();
