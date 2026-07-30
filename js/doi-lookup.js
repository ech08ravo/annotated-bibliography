// DOI / identifier lookup. Works in the browser (window.DOILookup) and in Node
// (module.exports). No dependencies.
//
// A DOI can be registered with any of several agencies, and each has its own
// metadata API. Crossref covers most journal articles; DataCite covers Zenodo,
// Figshare, Dryad, OSF, institutional repositories, datasets and theses — the
// grey literature a reading group cites just as often. Asking only Crossref
// meant a Zenodo DOI 404'd and the contributor had to type everything by hand.
//
// Both APIs are free, need no key, and send CORS headers that permit calls
// straight from the site, so this stays a front-end lookup with no proxying.
//
// Records come out in the same internal shape the RIS and BibTeX parsers emit,
// so the result can be handed to RIS.toPaper() like any other source.

(function (root) {
  const CROSSREF = "https://api.crossref.org/works/";
  const DATACITE = "https://api.datacite.org/dois/";

  // Landing-page URLs that don't contain their own DOI, but whose DOI is
  // derivable from the URL. Zenodo mints 10.5281/zenodo.<record id>.
  const URL_DOI_RULES = [
    { re: /zenodo\.org\/records?\/(\d+)/i, doi: m => `10.5281/zenodo.${m[1]}` },
  ];

  // Pull a DOI out of raw user input: a bare DOI, a doi.org link, or a known
  // landing-page URL. Returns "" when there's nothing to go on.
  function extractDoi(s) {
    const raw = String(s || "").trim();

    const direct = raw.match(/10\.\d{4,9}\/[^\s"'<>]+/i);
    if (direct) return direct[0].replace(/[.,;)]+$/, "");

    for (const rule of URL_DOI_RULES) {
      const m = raw.match(rule.re);
      if (m) return rule.doi(m);
    }
    return "";
  }

  function blank() {
    return {
      title: "", authors: [], year: null, venue: "", publisher: "",
      doi: "", url: "", abstract: "", tags: [],
    };
  }

  // ---- Crossref ----------------------------------------------------------

  function crossrefToRecord(m) {
    m = m || {};
    const authors = (m.author || [])
      .map(a => [a.given, a.family].filter(Boolean).join(" ").trim() || a.name || "")
      .filter(Boolean);
    const dp = (m.issued && m.issued["date-parts"] && m.issued["date-parts"][0]) || [];
    const abstract = m.abstract
      ? String(m.abstract).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
      : "";
    return {
      ...blank(),
      title: (m.title && m.title[0]) || "(untitled)",
      authors,
      year: dp[0] || null,
      venue: (m["container-title"] && m["container-title"][0]) || m.publisher || "",
      publisher: m.publisher || "",
      doi: m.DOI || "",
      url: m.URL || "",
      abstract,
      tags: (m.subject || []).slice(0, 8),
    };
  }

  // ---- DataCite ----------------------------------------------------------

  // DataCite creators give either a structured given/family pair or a single
  // "name" that is usually already "Family, Given".
  function dataciteAuthor(c) {
    if (!c) return "";
    const pair = [c.givenName, c.familyName].filter(Boolean).join(" ").trim();
    if (pair) return pair;
    const name = String(c.name || "").trim();
    if (!name) return "";
    const comma = name.indexOf(",");
    if (comma === -1) return name;
    const last = name.slice(0, comma).trim();
    const rest = name.slice(comma + 1).trim();
    return rest ? `${rest} ${last}` : last;
  }

  function dataciteToRecord(a) {
    a = a || {};
    const titles = a.titles || [];
    const descriptions = a.descriptions || [];
    const abstractEntry =
      descriptions.find(d => d && d.descriptionType === "Abstract") || descriptions[0] || {};
    // container.title is the journal/proceedings for DataCite-registered
    // articles; publisher is the repository or society otherwise.
    const container = (a.container && a.container.title) || "";
    return {
      ...blank(),
      title: (titles[0] && titles[0].title) || "(untitled)",
      authors: (a.creators || []).map(dataciteAuthor).filter(Boolean),
      year: typeof a.publicationYear === "number"
        ? a.publicationYear
        : (parseInt(a.publicationYear, 10) || null),
      venue: container || a.publisher || "",
      publisher: a.publisher || "",
      doi: a.doi || "",
      url: a.url || "",
      abstract: String(abstractEntry.description || "")
        .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
      tags: (a.subjects || [])
        .map(s => String((s && s.subject) || "").trim())
        .filter(Boolean)
        .slice(0, 8),
    };
  }

  // ---- lookup ------------------------------------------------------------

  // Try Crossref, then DataCite. Returns { record, source } or null when the
  // DOI isn't in either. Throws only if every registry errored, so the caller
  // can distinguish "not found" from "couldn't reach anything".
  //
  // fetchImpl is injectable so this is testable without a browser.
  async function lookup(doi, opts) {
    const options = opts || {};
    const doFetch = options.fetchImpl || (typeof fetch !== "undefined" ? fetch : null);
    if (!doFetch) throw new Error("no fetch available");
    if (!doi) return null;

    const headers = { "Accept": "application/json" };
    let reached = false;

    // Crossref first: better metadata for journal articles, which are the
    // common case.
    try {
      const res = await doFetch(CROSSREF + encodeURIComponent(doi), { headers });
      reached = true;
      if (res.ok) {
        const data = await res.json();
        if (data && data.message) {
          return { record: crossrefToRecord(data.message), source: "crossref" };
        }
      } else if (res.status !== 404) {
        reached = false;   // a 5xx is not a definitive "not here"
      }
    } catch (_) { /* try DataCite */ }

    try {
      const res = await doFetch(DATACITE + encodeURIComponent(doi), { headers });
      if (res.ok) {
        const data = await res.json();
        const attrs = data && data.data && data.data.attributes;
        if (attrs) return { record: dataciteToRecord(attrs), source: "datacite" };
      } else if (res.status === 404) {
        reached = true;
      }
    } catch (_) { /* fall through */ }

    if (reached) return null;                      // genuinely not found
    throw new Error("couldn't reach Crossref or DataCite");
  }

  const api = { extractDoi, lookup, crossrefToRecord, dataciteToRecord, dataciteAuthor };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.DOILookup = api;
})(typeof window !== "undefined" ? window : globalThis);
