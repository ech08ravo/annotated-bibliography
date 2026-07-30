// Tests for js/export.js — run via `node --test test/*.test.js`.
//
// The round-trip tests are the valuable ones: they pin export against the two
// parsers, so a change to either side that breaks interchange fails here.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const Exporter = require("../js/export.js");
const RIS = require("../js/ris-parser.js");
const BIB = require("../js/bibtex-parser.js");

const PAPER = {
  id: "vaswani-2017-attention",
  title: "Attention Is All You Need",
  authors: ["Ashish Vaswani", "Noam Shazeer"],
  year: 2017,
  venue: "NeurIPS",
  doi: "10.48550/arXiv.1706.03762",
  url: "https://arxiv.org/abs/1706.03762",
  tags: ["attention", "transformers"],
  annotation: { summary: "We propose the Transformer." },
};

const KUHN = {
  id: "kuhn-1962-structure",
  title: "The Structure of Scientific Revolutions",
  authors: ["Thomas S. Kuhn"],
  year: 1962,
  venue: "University of Chicago Press",
  tags: [],
};

// ---- BibTeX -----------------------------------------------------------------

test("bibtex emits @article when a venue is present, @misc otherwise", () => {
  assert.match(Exporter.bibtex(PAPER), /^@article\{vaswani-2017-attention,/);
  assert.match(Exporter.bibtex({ id: "x", title: "T" }), /^@misc\{x,/);
});

test("bibtex inverts author names and joins with ' and '", () => {
  assert.match(Exporter.bibtex(PAPER), /author = \{Vaswani, Ashish and Shazeer, Noam\}/);
});

test("bibtex sanitises the citation key", () => {
  assert.match(Exporter.bibtex({ id: "has spaces & punct!", title: "T" }), /^@misc\{hasspacespunct,/);
});

test("bibtex omits absent fields", () => {
  const out = Exporter.bibtex({ id: "x", title: "T" });
  for (const f of ["author", "year", "doi", "url", "keywords"]) {
    assert.ok(!out.includes(`${f} = {`), `unexpected ${f} field`);
  }
});

test("bibtex strips braces from values so output stays parseable", () => {
  const out = Exporter.bibtex({ id: "x", title: "A {BERT} Study" });
  assert.match(out, /title = \{A BERT Study\}/);
});

// ---- RIS --------------------------------------------------------------------

test("ris emits JOUR with a venue and GEN without", () => {
  assert.match(Exporter.ris(PAPER), /^TY {2}- JOUR/);
  assert.match(Exporter.ris({ id: "x", title: "T" }), /^TY {2}- GEN/);
});

test("ris emits one AU line per author, inverted", () => {
  const lines = Exporter.ris(PAPER).split("\n");
  assert.deepEqual(
    lines.filter(l => l.startsWith("AU  - ")),
    ["AU  - Vaswani, Ashish", "AU  - Shazeer, Noam"],
  );
});

test("ris emits one KW line per tag and terminates with ER", () => {
  const lines = Exporter.ris(PAPER).trim().split("\n");
  assert.deepEqual(lines.filter(l => l.startsWith("KW  - ")), ["KW  - attention", "KW  - transformers"]);
  assert.equal(lines[lines.length - 1].trim(), "ER  -");
});

test("ris carries the annotation summary into AB", () => {
  assert.match(Exporter.ris(PAPER), /AB {2}- We propose the Transformer\./);
});

// ---- Citation styles --------------------------------------------------------

test("apa formats authors, year, title, venue and doi", () => {
  assert.equal(
    Exporter.apa(PAPER),
    "Vaswani, A., & Shazeer, N. (2017). Attention Is All You Need. NeurIPS. https://doi.org/10.48550/arXiv.1706.03762",
  );
});

test("apa uses the url when there is no doi, and omits both when neither exists", () => {
  assert.match(Exporter.apa({ ...PAPER, doi: "" }), /https:\/\/arxiv\.org\/abs\/1706\.03762$/);
  assert.equal(Exporter.apa({ ...PAPER, doi: "", url: "" }).endsWith("NeurIPS."), true);
});

test("apa joins a single author without an ampersand", () => {
  assert.equal(Exporter.apa(KUHN), "Kuhn, T. S. (1962). The Structure of Scientific Revolutions. University of Chicago Press.");
});

test("apa uses ', & ' before the final author of three", () => {
  const three = { ...PAPER, authors: ["Ashish Vaswani", "Noam Shazeer", "Niki Parmar"] };
  assert.match(Exporter.apa(three), /^Vaswani, A\., Shazeer, N\., & Parmar, N\. \(2017\)\./);
});

test("mla varies by author count: one, two, then et al.", () => {
  assert.match(Exporter.mla(KUHN), /^Kuhn, Thomas S\. "The Structure/);
  assert.match(Exporter.mla(PAPER), /^Vaswani, Ashish, and Noam Shazeer\. "Attention/);
  const three = { ...PAPER, authors: ["Ashish Vaswani", "Noam Shazeer", "Niki Parmar"] };
  assert.match(Exporter.mla(three), /^Vaswani, Ashish, et al\. "Attention/);
});

test("mla does not double a period after an abbreviated name", () => {
  assert.ok(!Exporter.mla(KUHN).includes("Kuhn, Thomas S.."));
});

test("chicago puts the year in parentheses and appends the doi", () => {
  assert.equal(
    Exporter.chicago(PAPER),
    'Vaswani, Ashish, and Noam Shazeer. "Attention Is All You Need." NeurIPS (2017). https://doi.org/10.48550/arXiv.1706.03762',
  );
});

test("styles tolerate a paper with no authors", () => {
  const bare = { id: "x", title: "Anonymous Work", year: 2000 };
  for (const style of ["apa", "mla", "chicago"]) {
    const out = Exporter[style](bare);
    assert.ok(out.includes("Anonymous Work"), `${style} dropped the title`);
    assert.ok(!out.startsWith("."), `${style} left a leading period`);
  }
});

// ---- Markdown + dispatcher --------------------------------------------------

test("markdown emits a heading and one bullet per paper", () => {
  const md = Exporter.markdown([PAPER, KUHN]);
  assert.match(md, /^# References\n\n- /);
  assert.equal(md.trim().split("\n").filter(l => l.startsWith("- ")).length, 2);
});

test("buildExport returns text, filename and mime per format", () => {
  const expected = {
    bibtex: ["references.bib", "application/x-bibtex"],
    ris: ["references.ris", "application/x-research-info-systems"],
    markdown: ["references.md", "text/markdown"],
    apa: ["references-apa.txt", "text/plain"],
    mla: ["references-mla.txt", "text/plain"],
    chicago: ["references-chicago.txt", "text/plain"],
  };
  for (const [format, [filename, mime]] of Object.entries(expected)) {
    const out = Exporter.buildExport([PAPER], format);
    assert.equal(out.filename, filename, `wrong filename for ${format}`);
    assert.equal(out.mime, mime, `wrong mime for ${format}`);
    assert.ok(out.text.length > 0, `empty text for ${format}`);
  }
});

test("buildExport throws on an unknown format", () => {
  assert.throws(() => Exporter.buildExport([PAPER], "endnote"), /Unknown export format: endnote/);
});

test("buildExport handles an empty or missing selection", () => {
  assert.equal(Exporter.buildExport([], "bibtex").text, "");
  assert.equal(Exporter.buildExport(undefined, "bibtex").text, "");
  assert.match(Exporter.buildExport([], "markdown").text, /^# References/);
});

// ---- Round trips ------------------------------------------------------------

test("RIS export parses back to the same core fields", () => {
  const [back] = RIS.parseRIS(Exporter.ris(PAPER));
  assert.equal(back.title, PAPER.title);
  assert.deepEqual(back.authors, PAPER.authors);
  assert.equal(back.year, PAPER.year);
  assert.equal(back.venue, PAPER.venue);
  assert.equal(back.doi, PAPER.doi);
  assert.equal(back.url, PAPER.url);
  assert.deepEqual(back.tags, PAPER.tags);
  assert.equal(back.abstract, PAPER.annotation.summary);
});

test("BibTeX export parses back to the same core fields", () => {
  const [back] = BIB.parseBibTeX(Exporter.bibtex(PAPER));
  assert.equal(back.title, PAPER.title);
  assert.deepEqual(back.authors, PAPER.authors);
  assert.equal(back.year, PAPER.year);
  assert.equal(back.venue, PAPER.venue);
  assert.equal(back.doi, PAPER.doi);
  assert.equal(back.url, PAPER.url);
  assert.deepEqual(back.tags, PAPER.tags);
});

test("a multi-paper RIS export round-trips every record", () => {
  const text = Exporter.buildExport([PAPER, KUHN], "ris").text;
  const back = RIS.parseRIS(text);
  assert.equal(back.length, 2);
  assert.deepEqual(back.map(r => r.title), [PAPER.title, KUHN.title]);
});

test("a multi-paper BibTeX export round-trips every record", () => {
  const text = Exporter.buildExport([PAPER, KUHN], "bibtex").text;
  const back = BIB.parseBibTeX(text);
  assert.equal(back.length, 2);
  assert.deepEqual(back.map(r => r.title), [PAPER.title, KUHN.title]);
});

test("RIS round trip survives a regenerated id", () => {
  const [back] = RIS.parseRIS(Exporter.ris(PAPER));
  assert.equal(RIS.generateId(back), PAPER.id);
});
