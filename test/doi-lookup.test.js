// Tests for js/doi-lookup.js — run via `node --test test/*.test.js`.
//
// fetch is injected, so nothing here touches the network. Covers both registries:
// Crossref (which had no test coverage at all while it lived inside the
// DOM-coupled contribute.js) and the DataCite fallback.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const DOI = require("../js/doi-lookup.js");

// ---- extractDoi -------------------------------------------------------------

test("extracts a bare DOI", () => {
  assert.equal(DOI.extractDoi("10.1038/nature14539"), "10.1038/nature14539");
});

test("extracts a DOI from a doi.org URL", () => {
  assert.equal(DOI.extractDoi("https://doi.org/10.1038/nature14539"), "10.1038/nature14539");
  assert.equal(DOI.extractDoi("http://dx.doi.org/10.1038/nature14539"), "10.1038/nature14539");
});

test("extracts a DOI embedded in surrounding prose", () => {
  assert.equal(DOI.extractDoi("see (doi: 10.1000/xyz123) for details"), "10.1000/xyz123");
});

test("strips trailing sentence punctuation", () => {
  assert.equal(DOI.extractDoi("10.1000/xyz123."), "10.1000/xyz123");
  assert.equal(DOI.extractDoi("10.1000/xyz123,"), "10.1000/xyz123");
  assert.equal(DOI.extractDoi("(10.1000/xyz123)"), "10.1000/xyz123");
});

test("derives a DOI from a Zenodo record URL that contains none", () => {
  // The reported case: this URL has no DOI in it, so the old regex found
  // nothing and the user got a blank form.
  assert.equal(
    DOI.extractDoi("https://zenodo.org/records/17677327"),
    "10.5281/zenodo.17677327",
  );
});

test("handles Zenodo's older singular /record/ path", () => {
  assert.equal(DOI.extractDoi("https://zenodo.org/record/1234567"), "10.5281/zenodo.1234567");
});

test("prefers an explicit DOI over a URL-derived one", () => {
  assert.equal(
    DOI.extractDoi("https://zenodo.org/records/17677327 doi:10.5281/zenodo.999"),
    "10.5281/zenodo.999",
  );
});

test("returns empty for input with no derivable DOI", () => {
  for (const s of ["", "   ", "not a doi", "https://example.com/paper", null, undefined]) {
    assert.equal(DOI.extractDoi(s), "", `unexpected hit for ${JSON.stringify(s)}`);
  }
});

// ---- Crossref mapping -------------------------------------------------------

const CROSSREF_MSG = {
  title: ["Deep learning"],
  author: [
    { given: "Yann", family: "LeCun" },
    { given: "Yoshua", family: "Bengio" },
    { name: "Geoffrey Hinton" },
  ],
  issued: { "date-parts": [[2015, 5, 27]] },
  "container-title": ["Nature"],
  publisher: "Springer Science and Business Media LLC",
  DOI: "10.1038/nature14539",
  URL: "http://dx.doi.org/10.1038/nature14539",
  abstract: "<jats:p>Deep learning allows  computational models</jats:p>",
  subject: ["Multidisciplinary"],
};

test("maps a Crossref record onto the internal shape", () => {
  const r = DOI.crossrefToRecord(CROSSREF_MSG);
  assert.equal(r.title, "Deep learning");
  assert.deepEqual(r.authors, ["Yann LeCun", "Yoshua Bengio", "Geoffrey Hinton"]);
  assert.equal(r.year, 2015);
  assert.equal(r.venue, "Nature");
  assert.equal(r.doi, "10.1038/nature14539");
  assert.deepEqual(r.tags, ["Multidisciplinary"]);
});

test("Crossref abstract is stripped of markup and collapsed", () => {
  assert.equal(DOI.crossrefToRecord(CROSSREF_MSG).abstract, "Deep learning allows computational models");
});

test("Crossref falls back to publisher when there is no container title", () => {
  const r = DOI.crossrefToRecord({ title: ["T"], publisher: "Some Press" });
  assert.equal(r.venue, "Some Press");
});

test("Crossref mapping tolerates an empty record", () => {
  const r = DOI.crossrefToRecord({});
  assert.equal(r.title, "(untitled)");
  assert.deepEqual(r.authors, []);
  assert.equal(r.year, null);
});

// ---- DataCite mapping -------------------------------------------------------

// Shape taken from the live response for 10.5281/zenodo.17677327.
const DATACITE_ATTRS = {
  doi: "10.5281/zenodo.17677327",
  titles: [{ title: "Navigating the third space: Proceedings of the 2024 Third Space Symposium" }],
  publicationYear: 2025,
  publisher: "TELedvisors Network",
  url: "https://zenodo.org/doi/10.5281/zenodo.17677327",
  types: { resourceTypeGeneral: "ConferenceProceeding" },
  creators: [
    { name: "Simpson, Colin" },
    { name: "Altena, Sharon" },
    { givenName: "Elizabeth", familyName: "Black" },
  ],
  subjects: [{ subject: "third space" }, { subject: "higher education" }],
  descriptions: [
    { descriptionType: "Other", description: "ignore me" },
    { descriptionType: "Abstract", description: "<p>Proceedings  of the symposium.</p>" },
  ],
};

test("maps a DataCite record onto the internal shape", () => {
  const r = DOI.dataciteToRecord(DATACITE_ATTRS);
  assert.equal(r.title, "Navigating the third space: Proceedings of the 2024 Third Space Symposium");
  assert.equal(r.year, 2025);
  assert.equal(r.doi, "10.5281/zenodo.17677327");
  assert.equal(r.publisher, "TELedvisors Network");
  assert.deepEqual(r.tags, ["third space", "higher education"]);
});

test("DataCite creators are normalised to 'Given Family' either way they arrive", () => {
  const r = DOI.dataciteToRecord(DATACITE_ATTRS);
  assert.deepEqual(r.authors, ["Colin Simpson", "Sharon Altena", "Elizabeth Black"]);
});

test("DataCite prefers the Abstract description over others", () => {
  assert.equal(DOI.dataciteToRecord(DATACITE_ATTRS).abstract, "Proceedings of the symposium.");
});

test("DataCite falls back to the first description when none is an Abstract", () => {
  const r = DOI.dataciteToRecord({ descriptions: [{ descriptionType: "Other", description: "only one" }] });
  assert.equal(r.abstract, "only one");
});

test("DataCite uses container title for venue when present, else publisher", () => {
  assert.equal(DOI.dataciteToRecord({ container: { title: "J. of Things" }, publisher: "Pub" }).venue, "J. of Things");
  assert.equal(DOI.dataciteToRecord({ publisher: "Pub" }).venue, "Pub");
});

test("DataCite coerces a string publicationYear", () => {
  assert.equal(DOI.dataciteToRecord({ publicationYear: "1999" }).year, 1999);
  assert.equal(DOI.dataciteToRecord({ publicationYear: "n/a" }).year, null);
});

test("DataCite mapping tolerates an empty record", () => {
  const r = DOI.dataciteToRecord({});
  assert.equal(r.title, "(untitled)");
  assert.deepEqual(r.authors, []);
  assert.deepEqual(r.tags, []);
});

test("dataciteAuthor inverts 'Family, Given' and passes plain names through", () => {
  assert.equal(DOI.dataciteAuthor({ name: "Black, Elizabeth" }), "Elizabeth Black");
  assert.equal(DOI.dataciteAuthor({ name: "Elizabeth Black" }), "Elizabeth Black");
  assert.equal(DOI.dataciteAuthor({ name: "CSIRO" }), "CSIRO");
  assert.equal(DOI.dataciteAuthor({ givenName: "A", familyName: "B" }), "A B");
  assert.equal(DOI.dataciteAuthor(null), "");
});

test("both mappings agree on the record's key set, so either can feed toPaper", () => {
  assert.deepEqual(
    Object.keys(DOI.crossrefToRecord(CROSSREF_MSG)).sort(),
    Object.keys(DOI.dataciteToRecord(DATACITE_ATTRS)).sort(),
  );
});

// ---- lookup: registry routing ----------------------------------------------

// Build a fetch stub that answers per-host and records the hosts called.
function stubFetch(routes) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    for (const [needle, res] of Object.entries(routes)) {
      if (url.includes(needle)) {
        if (res instanceof Error) throw res;
        return { ok: res.status < 400, status: res.status, json: async () => res.body };
      }
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  impl.calls = calls;
  return impl;
}

const CR_OK = { status: 200, body: { message: CROSSREF_MSG } };
const DC_OK = { status: 200, body: { data: { attributes: DATACITE_ATTRS } } };
const NOT_FOUND = { status: 404, body: {} };

test("uses Crossref when it has the DOI, without calling DataCite", async () => {
  const f = stubFetch({ "api.crossref.org": CR_OK, "api.datacite.org": DC_OK });
  const hit = await DOI.lookup("10.1038/nature14539", { fetchImpl: f });
  assert.equal(hit.source, "crossref");
  assert.equal(hit.record.title, "Deep learning");
  assert.equal(f.calls.length, 1, "should not have consulted DataCite");
});

test("falls back to DataCite on a Crossref 404 — the reported Zenodo case", async () => {
  const f = stubFetch({ "api.crossref.org": NOT_FOUND, "api.datacite.org": DC_OK });
  const hit = await DOI.lookup("10.5281/zenodo.17677327", { fetchImpl: f });
  assert.equal(hit.source, "datacite");
  assert.equal(hit.record.year, 2025);
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls[0].includes("crossref"), "Crossref should be tried first");
});

test("returns null when neither registry has the DOI", async () => {
  const f = stubFetch({ "api.crossref.org": NOT_FOUND, "api.datacite.org": NOT_FOUND });
  assert.equal(await DOI.lookup("10.9999/nope", { fetchImpl: f }), null);
});

test("falls back to DataCite when Crossref errors outright", async () => {
  const f = stubFetch({ "api.crossref.org": new Error("network down"), "api.datacite.org": DC_OK });
  const hit = await DOI.lookup("10.5281/zenodo.1", { fetchImpl: f });
  assert.equal(hit.source, "datacite");
});

test("throws when neither registry is reachable, so 'not found' stays distinguishable", async () => {
  const f = stubFetch({
    "api.crossref.org": new Error("network down"),
    "api.datacite.org": new Error("network down"),
  });
  await assert.rejects(() => DOI.lookup("10.1/x", { fetchImpl: f }), /couldn't reach/);
});

test("a Crossref 5xx does not mask a DataCite miss as 'not found'", async () => {
  const f = stubFetch({ "api.crossref.org": { status: 503, body: {} }, "api.datacite.org": new Error("down") });
  await assert.rejects(() => DOI.lookup("10.1/x", { fetchImpl: f }), /couldn't reach/);
});

test("an empty DOI short-circuits without any request", async () => {
  const f = stubFetch({});
  assert.equal(await DOI.lookup("", { fetchImpl: f }), null);
  assert.equal(f.calls.length, 0);
});

test("the DOI is URL-encoded in the request", async () => {
  const f = stubFetch({ "api.crossref.org": CR_OK });
  await DOI.lookup("10.5281/zenodo.1", { fetchImpl: f });
  assert.ok(f.calls[0].includes("10.5281%2Fzenodo.1"), f.calls[0]);
});

test("a Crossref 200 with no message body falls through to DataCite", async () => {
  const f = stubFetch({ "api.crossref.org": { status: 200, body: {} }, "api.datacite.org": DC_OK });
  const hit = await DOI.lookup("10.1/x", { fetchImpl: f });
  assert.equal(hit.source, "datacite");
});

test("lookup output feeds RIS.toPaper cleanly", () => {
  const RIS = require("../js/ris-parser.js");
  for (const rec of [DOI.crossrefToRecord(CROSSREF_MSG), DOI.dataciteToRecord(DATACITE_ATTRS)]) {
    const p = RIS.toPaper(rec, { author_github: "ech08ravo" });
    assert.ok(p.id && /^[a-z0-9][a-z0-9-]*$/.test(p.id), `bad id: ${p.id}`);
    assert.ok(p.title && p.authors.length);
  }
});
