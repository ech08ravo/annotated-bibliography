// RIS parser. Works in the browser (assigns to window.RIS) and in Node
// (module.exports). No dependencies.
//
// RIS spec is loose in practice. We accept either two-letter tags followed by
// two spaces and a hyphen ("TY  - JOUR") or one space ("TY - JOUR"). Records
// are separated by "ER  -" lines. Repeated tags (AU, KW) accumulate.

(function (root) {
  // Map RIS tag -> handler. Either a string (single value field) or a function
  // that mutates the in-progress record. Unknown tags are ignored.
  const HANDLERS = {
    TY: (r, v) => { r._type = v; },
    TI: "title", T1: "title", CT: "title",
    AU: (r, v) => { r.authors.push(normalizeAuthor(v)); },
    A1: (r, v) => { r.authors.push(normalizeAuthor(v)); },
    A2: (r, v) => { r._editors.push(normalizeAuthor(v)); },
    PY: (r, v) => { r.year = parseYear(v); },
    Y1: (r, v) => { if (!r.year) r.year = parseYear(v); },
    DA: (r, v) => { if (!r.year) r.year = parseYear(v); },
    JO: "venue", JF: "venue", JA: "venue", T2: "venue", T3: "venue",
    BT: "venue", PB: "publisher",
    DO: "doi",
    UR: (r, v) => { if (!r.url) r.url = v; },
    L1: (r, v) => { if (!r.url) r.url = v; },
    AB: "abstract", N2: "abstract",
    N1: (r, v) => { r._notes.push(v); },
    KW: (r, v) => { r.tags.push(v.trim()); },
    SP: "_pageStart", EP: "_pageEnd",
    VL: "volume", IS: "issue_number",
    SN: "issn_isbn",
    ID: (r, v) => { r._risId = v; },
  };

  function parseRIS(text) {
    const records = [];
    let cur = null;

    // Normalize line endings, drop BOM
    const lines = String(text).replace(/^﻿/, "").split(/\r?\n/);
    let pending = null;  // continuation buffer for multi-line tag values

    function flushPending(rec) {
      if (!pending) return;
      const { tag, value } = pending;
      apply(rec, tag, value);
      pending = null;
    }

    for (const rawLine of lines) {
      const line = rawLine.replace(/\s+$/, "");
      const m = line.match(/^([A-Z][A-Z0-9])\s{1,2}- ?(.*)$/);

      if (m) {
        const tag = m[1];
        const value = m[2];
        if (cur) flushPending(cur);

        if (tag === "TY") {
          cur = blankRecord();
          cur._type = value;
        } else if (tag === "ER") {
          if (cur) {
            flushPending(cur);
            records.push(finalize(cur));
            cur = null;
          }
        } else if (cur) {
          pending = { tag, value };
        }
      } else if (line.trim() && cur && pending) {
        // continuation line for the pending tag
        pending.value += " " + line.trim();
      }
    }
    if (cur) {
      flushPending(cur);
      records.push(finalize(cur));
    }
    return records;
  }

  function apply(rec, tag, value) {
    const h = HANDLERS[tag];
    if (!h) return;
    if (typeof h === "string") {
      if (!rec[h]) rec[h] = value;
    } else {
      h(rec, value);
    }
  }

  function blankRecord() {
    return {
      title: "",
      authors: [],
      year: null,
      venue: "",
      publisher: "",
      doi: "",
      url: "",
      abstract: "",
      tags: [],
      volume: "",
      issue_number: "",
      issn_isbn: "",
      _type: "",
      _notes: [],
      _editors: [],
      _pageStart: "",
      _pageEnd: "",
      _risId: "",
    };
  }

  function finalize(r) {
    // Pages combined for convenience (rarely used in our schema but handy).
    if (r._pageStart || r._pageEnd) {
      r.pages = [r._pageStart, r._pageEnd].filter(Boolean).join("–");
    }
    if (r._notes.length) r.notes = r._notes.join("\n\n");
    if (r._editors.length) r.editors = r._editors;

    // Strip leading "doi:" prefixes
    if (r.doi) r.doi = r.doi.replace(/^(doi:\s*|https?:\/\/(dx\.)?doi\.org\/)/i, "");

    // Drop internals
    delete r._notes; delete r._editors; delete r._pageStart; delete r._pageEnd;
    delete r._risId; delete r._type;
    return r;
  }

  // "Vaswani, Ashish" -> "Ashish Vaswani"; passes through plain "Ashish Vaswani"
  function normalizeAuthor(s) {
    s = String(s).trim();
    const comma = s.indexOf(",");
    if (comma === -1) return s;
    const last  = s.slice(0, comma).trim();
    const rest  = s.slice(comma + 1).trim();
    return rest ? `${rest} ${last}` : last;
  }

  function parseYear(s) {
    const m = String(s).match(/(\d{4})/);
    return m ? parseInt(m[1], 10) : null;
  }

  // Generate a stable short id: firstauthor-year-firstword
  function generateId(record) {
    const author = (record.authors[0] || "anon")
      .split(" ").pop().toLowerCase()
      .replace(/[^a-z0-9]+/g, "");
    const year = record.year || "n.d.";
    const stop = new Set(["a","an","the","on","of","in","and","or","for","to","with","is","are"]);
    const firstWord = (record.title || "untitled")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(w => w && !stop.has(w))[0] || "untitled";
    return `${author || "anon"}-${year}-${firstWord}`.slice(0, 60);
  }

  // Convert a parsed RIS record to our paper JSON schema.
  function toPaper(record, opts = {}) {
    const id = opts.id || generateId(record);
    const paper = {
      id,
      title: record.title || "(untitled)",
      authors: record.authors,
      year: record.year,
      venue: record.venue || record.publisher || "",
      doi: record.doi || "",
      url: record.url || "",
      tags: record.tags,
      annotation: {
        author_github: opts.author_github || "",
        summary: record.abstract || "",
        method: "",
        evaluation: "",
        relevance: ""
      },
      highlights: []
    };
    if (opts.pdf) paper.pdf = opts.pdf;
    return paper;
  }

  const api = { parseRIS, toPaper, generateId, normalizeAuthor };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.RIS = api;
})(typeof window !== "undefined" ? window : globalThis);
