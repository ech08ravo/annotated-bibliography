// Reference exporter. Works in the browser (window.Exporter) and in Node
// (module.exports). Turns paper objects into BibTeX, RIS, formatted citation
// strings (APA / MLA / Chicago), or a Markdown reference list.
//
// Citation-style formatting is best-effort: good enough to paste and tidy, not
// a substitute for a full CSL engine.

(function (root) {

  // "Ashish Vaswani" -> { given: "Ashish", family: "Vaswani" }
  function nameParts(full) {
    const parts = String(full).trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return { given: "", family: "" };
    if (parts.length === 1) return { given: "", family: parts[0] };
    const family = parts.pop();
    return { given: parts.join(" "), family };
  }
  function initials(given) {
    return given.split(/\s+/).filter(Boolean).map(w => w[0].toUpperCase() + ".").join(" ");
  }
  // "Family, Given" — for BibTeX/RIS author fields.
  function invName(full) {
    const { given, family } = nameParts(full);
    return given ? `${family}, ${given}` : family;
  }

  // ---- BibTeX ------------------------------------------------------------
  function bibKey(p) { return String(p.id || "ref").replace(/[^A-Za-z0-9_-]/g, ""); }

  function bibtex(p) {
    const type = p.venue ? "article" : "misc";
    const f = [];
    if (p.title) f.push(["title", p.title]);
    if ((p.authors || []).length) f.push(["author", p.authors.map(invName).join(" and ")]);
    if (p.year) f.push(["year", String(p.year)]);
    if (p.venue) f.push([type === "article" ? "journal" : "howpublished", p.venue]);
    if (p.doi) f.push(["doi", p.doi]);
    if (p.url) f.push(["url", p.url]);
    if ((p.tags || []).length) f.push(["keywords", p.tags.join(", ")]);
    const body = f.map(([k, v]) => `  ${k} = {${String(v).replace(/[{}]/g, "")}}`).join(",\n");
    return `@${type}{${bibKey(p)},\n${body}\n}\n`;
  }

  // ---- RIS ---------------------------------------------------------------
  function ris(p) {
    const L = [];
    L.push(`TY  - ${p.venue ? "JOUR" : "GEN"}`);
    if (p.title) L.push(`TI  - ${p.title}`);
    (p.authors || []).forEach(a => L.push(`AU  - ${invName(a)}`));
    if (p.year) L.push(`PY  - ${p.year}`);
    if (p.venue) L.push(`JO  - ${p.venue}`);
    if (p.doi) L.push(`DO  - ${p.doi}`);
    if (p.url) L.push(`UR  - ${p.url}`);
    (p.tags || []).forEach(t => L.push(`KW  - ${t}`));
    if (p.annotation && p.annotation.summary) L.push(`AB  - ${p.annotation.summary}`);
    L.push("ER  - ");
    return L.join("\n") + "\n\n";
  }

  // ---- Formatted citation styles ----------------------------------------
  function apaAuthors(authors) {
    const list = authors.map(a => {
      const { given, family } = nameParts(a);
      const ini = initials(given);
      return ini ? `${family}, ${ini}` : family;
    });
    if (!list.length) return "";
    if (list.length === 1) return list[0];
    return list.slice(0, -1).join(", ") + ", & " + list[list.length - 1];
  }
  function apa(p) {
    const a = apaAuthors(p.authors || []);
    const y = p.year ? ` (${p.year}).` : "";
    const t = p.title ? ` ${p.title}.` : "";
    const v = p.venue ? ` ${p.venue}.` : "";
    const d = p.doi ? ` https://doi.org/${p.doi}` : (p.url ? ` ${p.url}` : "");
    return `${a}${y}${t}${v}${d}`.trim();
  }

  function leadAuthor(authors) {
    if (!authors.length) return "";
    const { given, family } = nameParts(authors[0]);
    return given ? `${family}, ${given}` : family;
  }
  // Append ". " without doubling a period the string already ends with.
  function dot(s) { return s ? s.replace(/\.\s*$/, "") + ". " : ""; }
  function mla(p) {
    const a = mlaAuthors(p.authors || []);
    const t = p.title ? `"${p.title}." ` : "";
    const v = p.venue ? `${p.venue}, ` : "";
    const y = p.year ? `${p.year}.` : "";
    return `${dot(a)}${t}${v}${y}`.trim();
  }
  function mlaAuthors(authors) {
    if (!authors.length) return "";
    if (authors.length === 1) return leadAuthor(authors);
    if (authors.length === 2) return `${leadAuthor(authors)}, and ${authors[1]}`;
    return `${leadAuthor(authors)}, et al.`;
  }
  function chicago(p) {
    const a = mlaAuthors(p.authors || []);
    const t = p.title ? `"${p.title}." ` : "";
    const v = p.venue ? `${p.venue} ` : "";
    const y = p.year ? `(${p.year}).` : "";
    const d = p.doi ? ` https://doi.org/${p.doi}` : "";
    return `${dot(a)}${t}${v}${y}${d}`.trim();
  }

  // ---- Markdown list -----------------------------------------------------
  function markdown(papers) {
    const out = ["# References", ""];
    papers.forEach(p => out.push(`- ${apa(p)}`));
    return out.join("\n") + "\n";
  }

  // ---- Dispatcher --------------------------------------------------------
  const STYLES = { apa, mla, chicago };

  function buildExport(papers, format) {
    papers = papers || [];
    switch (format) {
      case "bibtex":
        return { text: papers.map(bibtex).join("\n"), filename: "references.bib", mime: "application/x-bibtex" };
      case "ris":
        return { text: papers.map(ris).join(""), filename: "references.ris", mime: "application/x-research-info-systems" };
      case "markdown":
        return { text: markdown(papers), filename: "references.md", mime: "text/markdown" };
      case "apa":
      case "mla":
      case "chicago":
        return { text: papers.map(STYLES[format]).join("\n\n") + "\n", filename: `references-${format}.txt`, mime: "text/plain" };
      default:
        throw new Error(`Unknown export format: ${format}`);
    }
  }

  const api = { buildExport, bibtex, ris, apa, mla, chicago, markdown };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Exporter = api;
})(typeof window !== "undefined" ? window : globalThis);
