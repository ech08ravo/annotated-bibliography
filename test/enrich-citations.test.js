// Tests for scripts/enrich-citations.js — run via `node --test test/*.test.js`.
//
// The network is stubbed: no test here touches OpenAlex or papers/. This covers
// the matching logic added in #4, whose whole point is refusing to attach a
// near-namesake's citation count to the wrong paper.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const enrich = require("../scripts/enrich-citations.js");

// Swap in a fake fetch for the duration of fn(), recording requested URLs.
async function withFetch(handler, fn) {
  const real = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url, opts) => {
    urls.push(url);
    return handler(url, opts);
  };
  try {
    return await fn(urls);
  } finally {
    globalThis.fetch = real;
  }
}

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const status = (code) => ({ ok: false, status: code, json: async () => ({}) });

// ---- fetchOpenAlex ----------------------------------------------------------

test("fetchOpenAlex queries by doi: and returns the work", async () => {
  const work = { id: "https://openalex.org/W1", cited_by_count: 5 };
  const got = await withFetch(() => ok(work), async (urls) => {
    const r = await enrich.fetchOpenAlex("10.1/abc");
    assert.match(urls[0], /\/works\/doi:10\.1%2Fabc\?/);
    return r;
  });
  assert.deepEqual(got, work);
});

test("fetchOpenAlex strips doi.org prefixes before querying", async () => {
  for (const raw of ["https://doi.org/10.1/abc", "https://dx.doi.org/10.1/abc", "  10.1/abc  "]) {
    await withFetch(() => ok({}), async (urls) => {
      await enrich.fetchOpenAlex(raw);
      assert.match(urls[0], /doi:10\.1%2Fabc\?/, `failed for ${raw}`);
    });
  }
});

test("fetchOpenAlex returns null on 404 rather than throwing", async () => {
  const got = await withFetch(() => status(404), () => enrich.fetchOpenAlex("10.48550/arXiv.1706.03762"));
  assert.equal(got, null);
});

test("fetchOpenAlex throws on other HTTP errors", async () => {
  await withFetch(() => status(500), async () => {
    await assert.rejects(() => enrich.fetchOpenAlex("10.1/abc"), /OpenAlex HTTP 500/);
  });
});

// ---- fetchByTitle -----------------------------------------------------------

test("fetchByTitle refuses to search without both a title and a year", async () => {
  await withFetch(() => { throw new Error("should not be called"); }, async (urls) => {
    assert.equal(await enrich.fetchByTitle("", 2017), null);
    assert.equal(await enrich.fetchByTitle("A Title", null), null);
    assert.equal(await enrich.fetchByTitle(null, null), null);
    assert.equal(urls.length, 0, "made a network call it should have skipped");
  });
});

test("fetchByTitle requests results sorted by citation count", async () => {
  await withFetch(() => ok({ results: [] }), async (urls) => {
    await enrich.fetchByTitle("Attention Is All You Need", 2017);
    assert.match(urls[0], /filter=title\.search:Attention%20Is%20All%20You%20Need/);
    assert.match(urls[0], /sort=cited_by_count:desc/);
  });
});

test("fetchByTitle accepts a hit inside the year tolerance", async () => {
  const body = { results: [{ id: "W1", publication_year: 1963, cited_by_count: 100 }] };
  const got = await withFetch(() => ok(body), () => enrich.fetchByTitle("Structure", 1962));
  assert.equal(got.id, "W1");
});

test("fetchByTitle skips hits outside the year tolerance", async () => {
  const body = { results: [{ id: "TooOld", publication_year: 1950, cited_by_count: 999 }] };
  const got = await withFetch(() => ok(body), () => enrich.fetchByTitle("Structure", 1962));
  assert.equal(got, null, "attached a work published 12 years off");
});

test("fetchByTitle prefers the first in-window hit over a more-cited out-of-window one", async () => {
  const body = {
    results: [
      { id: "Namesake", publication_year: 1801, cited_by_count: 50000 },
      { id: "Real", publication_year: 2017, cited_by_count: 10 },
    ],
  };
  const got = await withFetch(() => ok(body), () => enrich.fetchByTitle("Attention", 2017));
  assert.equal(got.id, "Real");
});

test("fetchByTitle ignores results with no usable publication year", async () => {
  const body = { results: [{ id: "NoYear", cited_by_count: 10 }, { id: "Bad", publication_year: "2017" }] };
  const got = await withFetch(() => ok(body), () => enrich.fetchByTitle("X", 2017));
  assert.equal(got, null);
});

test("fetchByTitle handles a response with no results array", async () => {
  const got = await withFetch(() => ok({}), () => enrich.fetchByTitle("X", 2017));
  assert.equal(got, null);
});

test("fetchByTitle throws on an HTTP error", async () => {
  await withFetch(() => status(503), async () => {
    await assert.rejects(() => enrich.fetchByTitle("X", 2017), /OpenAlex HTTP 503/);
  });
});

test("the year tolerance is documented as 1", () => {
  assert.equal(enrich.TITLE_YEAR_TOLERANCE, 1);
});

// ---- toCitations ------------------------------------------------------------

test("toCitations shapes the citation block and records how it matched", () => {
  const work = {
    id: "https://openalex.org/W1",
    cited_by_count: 1510,
    counts_by_year: [{ year: 2024, cited_by_count: 30 }, { year: 2023, cited_by_count: 20 }],
  };
  assert.deepEqual(enrich.toCitations(work, "title"), {
    source: "openalex",
    count: 1510,
    by_year: [{ year: 2023, count: 20 }, { year: 2024, count: 30 }],
    openalex_id: "https://openalex.org/W1",
    matched_by: "title",
  });
});

test("toCitations sorts by_year ascending regardless of input order", () => {
  const work = { counts_by_year: [{ year: 2025, cited_by_count: 1 }, { year: 2001, cited_by_count: 2 }, { year: 2013, cited_by_count: 3 }] };
  assert.deepEqual(enrich.toCitations(work, "doi").by_year.map(y => y.year), [2001, 2013, 2025]);
});

test("toCitations defaults a work with no counts", () => {
  assert.deepEqual(enrich.toCitations({}, "doi"), {
    source: "openalex", count: 0, by_year: [], openalex_id: "", matched_by: "doi",
  });
});

// ---- sameData ---------------------------------------------------------------

const BLOCK = {
  source: "openalex",
  count: 10,
  by_year: [{ year: 2020, count: 10 }],
  openalex_id: "W1",
  matched_by: "doi",
};

test("sameData ignores the volatile retrieved timestamp", () => {
  assert.ok(enrich.sameData({ ...BLOCK, retrieved: "2026-01-01" }, { ...BLOCK, retrieved: "2026-07-30" }));
});

test("sameData detects a change in any meaningful field", () => {
  for (const [field, value] of [
    ["count", 11],
    ["openalex_id", "W2"],
    ["matched_by", "title"],
    ["by_year", [{ year: 2021, count: 10 }]],
  ]) {
    assert.ok(!enrich.sameData(BLOCK, { ...BLOCK, [field]: value }), `missed a change to ${field}`);
  }
});

test("sameData treats a missing side as different, so first runs always write", () => {
  assert.ok(!enrich.sameData(undefined, BLOCK));
  assert.ok(!enrich.sameData(BLOCK, undefined));
  assert.ok(!enrich.sameData(undefined, undefined));
});
