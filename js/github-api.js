// Thin GitHub REST client. Unauthenticated; relies on the public Issues API.
// Configure your repo coordinates here.

const GH_OWNER = "ech08ravo";
const GH_REPO  = "annotated-bibliography";

const GH = (function () {
  const API = "https://api.github.com";

  function issueUrl(num) {
    return `https://github.com/${GH_OWNER}/${GH_REPO}/issues/${num}`;
  }

  // Returns { upvotes, comments }. Upvotes are the count of 👍 reactions.
  async function getIssueStats(num) {
    const res = await fetch(`${API}/repos/${GH_OWNER}/${GH_REPO}/issues/${num}`, {
      headers: { "Accept": "application/vnd.github+json" }
    });
    if (!res.ok) throw new Error(`issue #${num}: HTTP ${res.status}`);
    const data = await res.json();
    return {
      upvotes:  data.reactions ? (data.reactions["+1"] || 0) : 0,
      comments: data.comments  || 0,
    };
  }

  async function getIssueComments(num) {
    const res = await fetch(
      `${API}/repos/${GH_OWNER}/${GH_REPO}/issues/${num}/comments?per_page=100`,
      { headers: { "Accept": "application/vnd.github+json" } }
    );
    if (!res.ok) throw new Error(`comments #${num}: HTTP ${res.status}`);
    return await res.json();
  }

  return { issueUrl, getIssueStats, getIssueComments };
})();
