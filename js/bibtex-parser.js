// BibTeX parser. Works in the browser (assigns to window.BIB) and in Node
// (module.exports). No dependencies.
//
// Emits records in the SAME internal shape as js/ris-parser.js, so the parsed
// output can be handed straight to RIS.toPaper(record, opts) to produce paper
// JSON. We deliberately keep one path from "parsed record" to "paper".
//
// Handles: @type{key, field = {value}, field = "value", field = bareword },
// nested braces in values, "and"-separated author lists, common LaTeX accents
// and commands, and @string/@comment/@preamble blocks (skipped).

(function (root) {
  // BibTeX field -> record field. Either a string (assign if empty) or a
  // function that mutates the in-progress record.
  const FIELD = {
    title: "title",
    author: (r, v) => { splitNames(v).forEach(a => r.authors.push(a)); },
    editor: (r, v) => { splitNames(v).forEach(e => r._editors.push(e)); },
    year: (r, v) => { r.year = parseYear(v); },
    date: (r, v) => { if (!r.year) r.year = parseYear(v); },
    journal: "venue",
    journaltitle: "venue",
    booktitle: "venue",
    publisher: "publisher",
    school: "publisher",
    institution: "publisher",
    doi: "doi",
    url: (r, v) => { if (!r.url) r.url = v; },
    howpublished: (r, v) => { if (!r.url && /^https?:\/\//i.test(v)) r.url = v; },
    abstract: "abstract",
    note: (r, v) => { r._notes.push(v); },
    keywords: (r, v) => { splitList(v).forEach(k => r.tags.push(k)); },
    volume: "volume",
    number: "issue_number",
    pages: (r, v) => { r.pages = v.replace(/--/g, "–"); },
    isbn: "issn_isbn",
    issn: "issn_isbn",
  };

  function parseBibTeX(text) {
    const records = [];
    const s = String(text).replace(/^﻿/, "");
    const n = s.length;
    let i = 0;

    while (i < n) {
      while (i < n && s[i] !== "@") i++;
      if (i >= n) break;
      i++; // skip '@'

      let type = "";
      while (i < n && /[a-zA-Z]/.test(s[i])) { type += s[i]; i++; }
      type = type.toLowerCase();

      while (i < n && /\s/.test(s[i])) i++;
      const open = s[i];
      if (open !== "{" && open !== "(") continue;
      const close = open === "{" ? "}" : ")";
      i++; // skip opening delimiter

      // Skip non-entry blocks entirely (balanced).
      if (type === "comment" || type === "preamble" || type === "string") {
        let depth = 1;
        while (i < n && depth > 0) {
          if (s[i] === open) depth++;
          else if (s[i] === close) depth--;
          i++;
        }
        continue;
      }

      // Citation key, up to the first comma.
      let key = "";
      while (i < n && s[i] !== "," && s[i] !== close) { key += s[i]; i++; }
      if (s[i] === ",") i++;

      const rec = blankRecord();
      rec._type = type;
      rec._key = key.trim();

      // Fields.
      while (i < n) {
        while (i < n && /[\s,]/.test(s[i])) i++;     // skip separators
        if (i >= n || s[i] === close) { i++; break; }

        let name = "";
        while (i < n && /[A-Za-z0-9_\-]/.test(s[i])) { name += s[i]; i++; }
        name = name.toLowerCase();

        while (i < n && /\s/.test(s[i])) i++;
        if (s[i] !== "=") {                          // malformed; resync
          while (i < n && s[i] !== "," && s[i] !== close) i++;
          continue;
        }
        i++; // skip '='
        while (i < n && /\s/.test(s[i])) i++;

        let value = "";
        if (s[i] === "{") {
          let depth = 0;
          do {
            const c = s[i];
            if (c === "{") { if (depth > 0) value += c; depth++; }
            else if (c === "}") { depth--; if (depth > 0) value += c; }
            else value += c;
            i++;
          } while (i < n && depth > 0);
        } else if (s[i] === '"') {
          i++; // skip opening quote
          let depth = 0;
          while (i < n) {
            const c = s[i];
            if (c === "{") { depth++; value += c; }
            else if (c === "}") { depth--; value += c; }
            else if (c === '"' && depth === 0) { i++; break; }
            else value += c;
            i++;
          }
        } else {
          // Bare value: number or unquoted string macro.
          while (i < n && s[i] !== "," && s[i] !== close && !/\s/.test(s[i])) {
            value += s[i]; i++;
          }
        }

        applyField(rec, name, cleanTeX(value));
      }

      if (rec.title || rec.authors.length) records.push(finalize(rec));
    }
    return records;
  }

  function applyField(rec, name, value) {
    const h = FIELD[name];
    if (!h || value === "") return;
    if (typeof h === "string") { if (!rec[h]) rec[h] = value; }
    else h(rec, value);
  }

  function blankRecord() {
    return {
      title: "", authors: [], year: null, venue: "", publisher: "",
      doi: "", url: "", abstract: "", tags: [], volume: "",
      issue_number: "", issn_isbn: "",
      _type: "", _key: "", _notes: [], _editors: [],
    };
  }

  function finalize(r) {
    if (r._notes.length) r.notes = r._notes.join("\n\n");
    if (r._editors.length) r.editors = r._editors;
    if (r.doi) r.doi = r.doi.replace(/^(doi:\s*|https?:\/\/(dx\.)?doi\.org\/)/i, "");
    delete r._notes; delete r._editors; delete r._type; delete r._key;
    return r;
  }

  // Split a BibTeX name list on " and " (but not "{and}" inside braces).
  function splitNames(v) {
    return String(v)
      .split(/\s+and\s+/i)
      .map(s => normalizeAuthor(cleanTeX(s)))
      .filter(Boolean);
  }

  function splitList(v) {
    return String(v).split(/[;,]/).map(s => cleanTeX(s).trim()).filter(Boolean);
  }

  // "Vaswani, Ashish" -> "Ashish Vaswani"; passes through "Ashish Vaswani".
  function normalizeAuthor(s) {
    s = String(s).trim();
    if (!s) return "";
    const comma = s.indexOf(",");
    if (comma === -1) return s;
    const last = s.slice(0, comma).trim();
    const rest = s.slice(comma + 1).trim();
    return rest ? `${rest} ${last}` : last;
  }

  function parseYear(s) {
    const m = String(s).match(/(\d{4})/);
    return m ? parseInt(m[1], 10) : null;
  }

  // Strip the most common LaTeX noise so values read naturally.
  function cleanTeX(s) {
    s = String(s);
    // Accents: \"o, \"{o}, \'{e}, \^a, \~n, \=u, \.z  ->  base letter
    s = s.replace(/\\[`'^"~=.]\s*\{?\s*([A-Za-z])\s*\}?/g, "$1");
    s = s.replace(/\{\\[a-zA-Z]+\}/g, "");      // {\ss}, {\dh} -> drop
    s = s.replace(/\\[a-zA-Z]+\s*/g, "");        // \emph, \textit ... -> drop command
    s = s.replace(/\\&/g, "&").replace(/~/g, " ");
    s = s.replace(/[{}]/g, "");                  // strip remaining braces
    s = s.replace(/\s+/g, " ").trim();
    return s;
  }

  const api = { parseBibTeX, normalizeAuthor };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.BIB = api;
})(typeof window !== "undefined" ? window : globalThis);
