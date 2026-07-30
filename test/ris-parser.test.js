// Tests for js/ris-parser.js — run via `node --test test/`.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const RIS = require("../js/ris-parser.js");

const SAMPLE = [
  "TY  - JOUR",
  "TI  - Attention Is All You Need",
  "AU  - Vaswani, Ashish",
  "AU  - Shazeer, Noam",
  "PY  - 2017",
  "JO  - NeurIPS",
  "DO  - 10.48550/arXiv.1706.03762",
  "UR  - https://arxiv.org/abs/1706.03762",
  "KW  - attention",
  "KW  - transformers",
  "AB  - We propose the Transformer.",
  "ER  - ",
].join("\n");

test("parses a single record's core fields", () => {
  const [r] = RIS.parseRIS(SAMPLE);
  assert.equal(r.title, "Attention Is All You Need");
  assert.equal(r.year, 2017);
  assert.equal(r.venue, "NeurIPS");
  assert.equal(r.doi, "10.48550/arXiv.1706.03762");
  assert.equal(r.url, "https://arxiv.org/abs/1706.03762");
  assert.equal(r.abstract, "We propose the Transformer.");
});

test("repeated AU and KW tags accumulate in order", () => {
  const [r] = RIS.parseRIS(SAMPLE);
  assert.deepEqual(r.authors, ["Ashish Vaswani", "Noam Shazeer"]);
  assert.deepEqual(r.tags, ["attention", "transformers"]);
});

test("accepts both one-space and two-space tag separators", () => {
  const oneSpace = "TY - JOUR\nTI - Terse Form\nPY - 1999\nER - ";
  const [r] = RIS.parseRIS(oneSpace);
  assert.equal(r.title, "Terse Form");
  assert.equal(r.year, 1999);
});

test("splits multiple records on ER", () => {
  const two = SAMPLE + "\n" + [
    "TY  - BOOK",
    "TI  - The Structure of Scientific Revolutions",
    "AU  - Kuhn, Thomas S.",
    "PY  - 1962",
    "ER  - ",
  ].join("\n");
  const recs = RIS.parseRIS(two);
  assert.equal(recs.length, 2);
  assert.equal(recs[1].title, "The Structure of Scientific Revolutions");
  assert.deepEqual(recs[1].authors, ["Thomas S. Kuhn"]);
});

test("normalizeAuthor inverts 'Family, Given' and passes plain names through", () => {
  assert.equal(RIS.normalizeAuthor("Vaswani, Ashish"), "Ashish Vaswani");
  assert.equal(RIS.normalizeAuthor("Ashish Vaswani"), "Ashish Vaswani");
  assert.equal(RIS.normalizeAuthor("  Kuhn,  Thomas S.  "), "Thomas S. Kuhn");
  // A trailing comma with no given name should not leave a dangling space.
  assert.equal(RIS.normalizeAuthor("Plato,"), "Plato");
});

test("extracts a 4-digit year from a full date string", () => {
  const [r] = RIS.parseRIS("TY  - JOUR\nTI  - X\nPY  - 2017/06/12\nER  - ");
  assert.equal(r.year, 2017);
});

test("Y1 and DA only fill year when PY is absent", () => {
  const [withPy] = RIS.parseRIS("TY  - JOUR\nTI  - X\nPY  - 2017\nY1  - 1999\nER  - ");
  assert.equal(withPy.year, 2017);
  const [noPy] = RIS.parseRIS("TY  - JOUR\nTI  - X\nY1  - 1999\nER  - ");
  assert.equal(noPy.year, 1999);
});

test("strips doi: and doi.org prefixes", () => {
  for (const raw of ["doi: 10.1/abc", "https://doi.org/10.1/abc", "https://dx.doi.org/10.1/abc"]) {
    const [r] = RIS.parseRIS(`TY  - JOUR\nTI  - X\nDO  - ${raw}\nER  - `);
    assert.equal(r.doi, "10.1/abc", `failed for ${raw}`);
  }
});

test("joins continuation lines onto the pending tag", () => {
  const wrapped = [
    "TY  - JOUR",
    "TI  - A Very Long Title That",
    "      Wraps Across Lines",
    "PY  - 2020",
    "ER  - ",
  ].join("\n");
  const [r] = RIS.parseRIS(wrapped);
  assert.equal(r.title, "A Very Long Title That Wraps Across Lines");
});

test("first value wins for single-value fields", () => {
  const [r] = RIS.parseRIS("TY  - JOUR\nTI  - First\nT1  - Second\nER  - ");
  assert.equal(r.title, "First");
});

test("combines page range with an en dash", () => {
  const [r] = RIS.parseRIS("TY  - JOUR\nTI  - X\nSP  - 5998\nEP  - 6008\nER  - ");
  assert.equal(r.pages, "5998–6008");
});

test("ignores unknown tags and content before the first TY", () => {
  const noisy = "Provider: Test\nZZ  - junk\nTY  - JOUR\nTI  - Clean\nXX  - ignored\nER  - ";
  const recs = RIS.parseRIS(noisy);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].title, "Clean");
  assert.equal(recs[0].junk, undefined);
});

test("drops internal bookkeeping fields from finalized records", () => {
  const [r] = RIS.parseRIS(SAMPLE);
  for (const k of ["_notes", "_editors", "_pageStart", "_pageEnd", "_risId", "_type"]) {
    assert.ok(!(k in r), `${k} leaked into the record`);
  }
});

test("empty input yields no records", () => {
  assert.deepEqual(RIS.parseRIS(""), []);
  assert.deepEqual(RIS.parseRIS("\n\n"), []);
});

test("generateId builds family-year-firstword, skipping stopwords", () => {
  const [r] = RIS.parseRIS(SAMPLE);
  assert.equal(RIS.generateId(r), "vaswani-2017-attention");
});

test("generateId falls back for missing author, year, and title", () => {
  assert.equal(RIS.generateId({ authors: [], year: null, title: "" }), "anon-n.d.-untitled");
});

test("generateId strips punctuation from the family name", () => {
  const id = RIS.generateId({ authors: ["Thomas S. Kuhn"], year: 1962, title: "The Structure of Scientific Revolutions" });
  assert.equal(id, "kuhn-1962-structure");
});

test("toPaper maps a record onto the paper schema", () => {
  const [r] = RIS.parseRIS(SAMPLE);
  const p = RIS.toPaper(r, { author_github: "ech08ravo" });
  assert.equal(p.id, "vaswani-2017-attention");
  assert.equal(p.title, "Attention Is All You Need");
  assert.deepEqual(p.authors, ["Ashish Vaswani", "Noam Shazeer"]);
  assert.equal(p.year, 2017);
  assert.equal(p.venue, "NeurIPS");
  assert.equal(p.annotation.author_github, "ech08ravo");
  assert.equal(p.annotation.summary, "We propose the Transformer.");
  assert.deepEqual(p.highlights, []);
  // No PDF unless one is supplied — a phantom pdf path 404s on the live site.
  assert.ok(!("pdf" in p));
});

test("toPaper honours explicit id and pdf options", () => {
  const [r] = RIS.parseRIS(SAMPLE);
  const p = RIS.toPaper(r, { id: "custom-id", pdf: "pdfs/x.pdf" });
  assert.equal(p.id, "custom-id");
  assert.equal(p.pdf, "pdfs/x.pdf");
});

test("toPaper falls back to publisher for venue and marks untitled records", () => {
  const [r] = RIS.parseRIS("TY  - BOOK\nAU  - Kuhn, Thomas S.\nPB  - Univ. Chicago Press\nPY  - 1962\nER  - ");
  const p = RIS.toPaper(r);
  assert.equal(p.venue, "Univ. Chicago Press");
  assert.equal(p.title, "(untitled)");
});
