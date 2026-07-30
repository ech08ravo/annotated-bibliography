// Tests for js/bibtex-parser.js — run via `node --test test/*.test.js`.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const BIB = require("../js/bibtex-parser.js");

const SAMPLE = `
@article{vaswani2017attention,
  title     = {Attention Is All You Need},
  author    = {Vaswani, Ashish and Shazeer, Noam and Parmar, Niki},
  year      = {2017},
  journal   = {NeurIPS},
  doi       = {10.48550/arXiv.1706.03762},
  url       = {https://arxiv.org/abs/1706.03762},
  keywords  = {attention, transformers},
  pages     = {5998--6008},
  abstract  = {We propose the Transformer.}
}
`;

test("parses an entry's core fields", () => {
  const [r] = BIB.parseBibTeX(SAMPLE);
  assert.equal(r.title, "Attention Is All You Need");
  assert.equal(r.year, 2017);
  assert.equal(r.venue, "NeurIPS");
  assert.equal(r.doi, "10.48550/arXiv.1706.03762");
  assert.equal(r.url, "https://arxiv.org/abs/1706.03762");
  assert.equal(r.abstract, "We propose the Transformer.");
});

test("splits 'and'-separated authors and inverts each name", () => {
  const [r] = BIB.parseBibTeX(SAMPLE);
  assert.deepEqual(r.authors, ["Ashish Vaswani", "Noam Shazeer", "Niki Parmar"]);
});

test("splits keywords on commas and semicolons", () => {
  const [r] = BIB.parseBibTeX(SAMPLE);
  assert.deepEqual(r.tags, ["attention", "transformers"]);
  const [s] = BIB.parseBibTeX("@misc{k, title={T}, keywords={a; b, c}}");
  assert.deepEqual(s.tags, ["a", "b", "c"]);
});

test("converts a '--' page range to an en dash", () => {
  const [r] = BIB.parseBibTeX(SAMPLE);
  assert.equal(r.pages, "5998–6008");
});

test("emits the same record shape as the RIS parser", () => {
  const RIS = require("../js/ris-parser.js");
  const [bib] = BIB.parseBibTeX(SAMPLE);
  const [ris] = RIS.parseRIS("TY  - JOUR\nTI  - X\nER  - ");
  // Both feed RIS.toPaper, so their key sets must stay compatible.
  for (const k of Object.keys(ris)) {
    assert.ok(k in bib, `bibtex record is missing '${k}' that RIS records have`);
  }
});

test("accepts quoted and bare field values alongside braced ones", () => {
  const src = `@article{k, title = "A Quoted Title", year = 1999, journal = {J} }`;
  const [r] = BIB.parseBibTeX(src);
  assert.equal(r.title, "A Quoted Title");
  assert.equal(r.year, 1999);
  assert.equal(r.venue, "J");
});

test("accepts parenthesis-delimited entries", () => {
  const [r] = BIB.parseBibTeX("@article(k, title = {Paren Entry}, year = {2001})");
  assert.equal(r.title, "Paren Entry");
  assert.equal(r.year, 2001);
});

test("preserves text inside nested braces, stripping the braces", () => {
  const [r] = BIB.parseBibTeX("@article{k, title = {A {BERT} Study}}");
  assert.equal(r.title, "A BERT Study");
});

test("cleans common LaTeX accents and commands", () => {
  const [r] = BIB.parseBibTeX(`@article{k, title={Caf\\'{e} \\emph{Society} R\\&D}, author={Sch{\\"o}lkopf, Bernhard}}`);
  // \'{e} reduces to a bare "e"; the parser strips accents rather than mapping
  // them to precomposed characters.
  assert.equal(r.title, "Cafe Society R&D");
  assert.deepEqual(r.authors, ["Bernhard Scholkopf"]);
});

test("converts a tilde to a space", () => {
  const [r] = BIB.parseBibTeX("@book{k, title={Volume~1}}");
  assert.equal(r.title, "Volume 1");
});

test("skips @comment, @preamble and @string blocks", () => {
  const src = `
@comment{ this { nested } is ignored }
@string{ acm = "ACM Press" }
@preamble{ "\\newcommand{\\x}{y}" }
@book{real, title = {A Real Book}, year = {1962}}
`;
  const recs = BIB.parseBibTeX(src);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].title, "A Real Book");
});

test("parses several entries in one file", () => {
  const src = SAMPLE + `
@book{kuhn1962,
  title  = {The Structure of Scientific Revolutions},
  author = {Kuhn, Thomas S.},
  year   = {1962},
  publisher = {University of Chicago Press}
}
`;
  const recs = BIB.parseBibTeX(src);
  assert.equal(recs.length, 2);
  assert.equal(recs[1].publisher, "University of Chicago Press");
  assert.deepEqual(recs[1].authors, ["Thomas S. Kuhn"]);
});

test("drops entries with neither title nor author", () => {
  assert.deepEqual(BIB.parseBibTeX("@misc{empty, year = {2020}}"), []);
});

test("strips doi: and doi.org prefixes", () => {
  for (const raw of ["doi: 10.1/abc", "https://doi.org/10.1/abc", "https://dx.doi.org/10.1/abc"]) {
    const [r] = BIB.parseBibTeX(`@article{k, title={X}, doi={${raw}}}`);
    assert.equal(r.doi, "10.1/abc", `failed for ${raw}`);
  }
});

test("only takes howpublished as a url when it looks like one", () => {
  const [web] = BIB.parseBibTeX("@misc{k, title={X}, howpublished={https://example.com}}");
  assert.equal(web.url, "https://example.com");
  const [print] = BIB.parseBibTeX("@misc{k, title={X}, howpublished={Printed leaflet}}");
  assert.equal(print.url, "");
});

test("falls back to booktitle and school for venue and publisher", () => {
  const [r] = BIB.parseBibTeX("@inproceedings{k, title={X}, booktitle={Proc. of Things}}");
  assert.equal(r.venue, "Proc. of Things");
  const [t] = BIB.parseBibTeX("@phdthesis{k, title={X}, school={Some University}}");
  assert.equal(t.publisher, "Some University");
});

test("recovers from a malformed field without losing the entry", () => {
  const [r] = BIB.parseBibTeX("@article{k, title = {Good}, bogusfield, year = {2020}}");
  assert.equal(r.title, "Good");
  assert.equal(r.year, 2020);
});

test("drops internal bookkeeping fields from finalized records", () => {
  const [r] = BIB.parseBibTeX(SAMPLE);
  for (const k of ["_notes", "_editors", "_type", "_key"]) {
    assert.ok(!(k in r), `${k} leaked into the record`);
  }
});

test("collects editors and notes when present", () => {
  const [r] = BIB.parseBibTeX("@book{k, title={X}, editor={Doe, Jane and Roe, Rick}, note={First printing}}");
  assert.deepEqual(r.editors, ["Jane Doe", "Rick Roe"]);
  assert.equal(r.notes, "First printing");
});

test("empty input yields no records", () => {
  assert.deepEqual(BIB.parseBibTeX(""), []);
  assert.deepEqual(BIB.parseBibTeX("no entries here"), []);
});

test("normalizeAuthor matches the RIS parser's behaviour", () => {
  const RIS = require("../js/ris-parser.js");
  for (const name of ["Vaswani, Ashish", "Ashish Vaswani", "Plato,", "  Kuhn,  Thomas S.  "]) {
    assert.equal(BIB.normalizeAuthor(name), RIS.normalizeAuthor(name), `diverged on '${name}'`);
  }
});
