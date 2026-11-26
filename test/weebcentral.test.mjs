import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSource } from "../tools/shelf-repo/lib/runner.mjs";

// Offline tests against trimmed copies of Weeb Central pages saved in November 2026.
// When the site changes its markup, save fresh copies into fixtures/ and fix the
// selectors in sources/weebcentral/main.js until these pass again.

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, "../sources/weebcentral");
const fixture = (name) => readFile(path.join(here, "fixtures", "weebcentral", name), "utf8");

function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, headers: init?.headers ?? {} });
    for (const [pattern, body] of routes) {
      if (pattern.test(url)) return { status: 200, url, headers: [], text: async () => body };
    }
    return { status: 404, url, headers: [], text: async () => "" };
  };
  impl.calls = calls;
  return impl;
}

const SERIES = "01J76XYCPSY3C4BNPBRY8JMCBE";

test("search reads cards and builds the query", async () => {
  const fetchImpl = fakeFetch([[/\/search\/data\?/, await fixture("search.html")]]);
  const { call } = await loadSource(dir, { fetchImpl });
  const page = await call("search", "solo leveling", 2, { type: ["Manhwa"], official: ["true"] });

  assert.equal(page.results.length, 2);
  assert.equal(page.hasMore, false);
  const [first, second] = page.results;
  assert.equal(first.id, SERIES);
  assert.equal(first.title, "Solo Leveling");
  assert.deepEqual(first.authors, ["GEE So-Lyung", "JANG Sung-Lak", "Redice Studio"]);
  assert.equal(first.coverURL, `https://temp.compsci88.com/cover/fallback/${SERIES}.jpg`);
  assert.equal(first.format, "manhwa");
  assert.deepEqual(first.tags, ["Action", "Adventure", "Fantasy", "Shounen"]);
  assert.equal(second.title, "Solo Leveling: Ragnarok");

  const url = new URL(fetchImpl.calls[0].url);
  assert.equal(url.searchParams.get("text"), "solo leveling");
  assert.equal(url.searchParams.get("offset"), "32");
  assert.equal(url.searchParams.get("official"), "True");
  assert.equal(url.searchParams.get("adult"), "False");
  assert.deepEqual(url.searchParams.getAll("included_type"), ["Manhwa"]);
});

test("adult series are only searched for when explicit sources are allowed", async () => {
  const fetchImpl = fakeFetch([[/\/search\/data\?/, ""]]);
  const { call } = await loadSource(dir, { fetchImpl, settings: { maxRating: "explicit" } });
  const page = await call("search", "", 1, {});
  assert.deepEqual(page.results, []);
  const url = new URL(fetchImpl.calls[0].url);
  assert.equal(url.searchParams.get("adult"), "Any");
  assert.equal(url.searchParams.get("sort"), "Popularity");
});

test("getWork reads the series page", async () => {
  const fetchImpl = fakeFetch([[new RegExp(`/series/${SERIES}$`), await fixture("series.html")]]);
  const { call } = await loadSource(dir, { fetchImpl });
  const work = await call("getWork", SERIES);
  assert.equal(work.title, "Solo Leveling");
  assert.deepEqual(work.authors, ["GEE So-Lyung", "JANG Sung-Lak", "Redice Studio"]);
  assert.deepEqual(work.tags, ["Action", "Adventure", "Fantasy", "Shounen"]);
  assert.equal(work.format, "manhwa");
  assert.equal(work.status, "Complete");
  assert.equal(work.rating, "General Audiences");
  assert.match(work.summaryHTML, /^<p>E-class hunter .* money &amp; no abilities/);
  assert.equal(work.url, `https://weebcentral.com/series/${SERIES}`);
});

test("getChapters lists chapters oldest first", async () => {
  const fetchImpl = fakeFetch([[/\/full-chapter-list$/, await fixture("chapters.html")]]);
  const { call } = await loadSource(dir, { fetchImpl });
  const chapters = await call("getChapters", SERIES);
  assert.deepEqual(chapters.map((c) => c.title), ["Chapter 0", "S2 - Chapter 10.5", "Chapter 199", "Chapter 200"]);
  assert.deepEqual(chapters.map((c) => c.number), [0, 10.5, 199, 200]);
  assert.equal(chapters[3].id, "01J76XZ666GREP4DQDKEP1YDZG");
  assert.equal(chapters[3].publishedAt, "2024-09-07T17:04:15.717Z");
});

test("getChapterContent returns every page with a referer", async () => {
  const fetchImpl = fakeFetch([[/\/chapters\/01J76XZ666GREP4DQDKEP1YDZG\/images\?/, await fixture("images.html")]]);
  const { call } = await loadSource(dir, { fetchImpl });
  const content = await call("getChapterContent", SERIES, "01J76XZ666GREP4DQDKEP1YDZG");
  assert.equal(content.type, "images");
  assert.deepEqual(content.pages.map((p) => p.url), [1, 2, 3].map((n) => `https://hot.planeptune.us/manga/Solo-Leveling/0200-00${n}.png`));
  assert.equal(content.pages[0].headers.Referer, "https://weebcentral.com/");
});

test("idFromURL reads series links and ignores other sites", async () => {
  const { call } = await loadSource(dir, { fetchImpl: fakeFetch([]) });
  assert.equal(await call("idFromURL", `https://weebcentral.com/series/${SERIES}/Solo-Leveling`), SERIES);
  assert.equal(await call("idFromURL", "https://example.com/series/" + SERIES), null);
});

test("filters are well formed", async () => {
  const { call } = await loadSource(dir, { fetchImpl: fakeFetch([]) });
  const filters = await call("getFilters");
  assert.deepEqual(filters.map((f) => f.id), ["sort", "order", "type", "status", "official", "anime", "genres"]);
});

test("browse lists read the search endpoint sorted, with no query", async () => {
  const fetchImpl = fakeFetch([[/\/search\/data\?/, await fixture("search.html")]]);
  const { call } = await loadSource(dir, { fetchImpl });
  const listings = await call("getListings");
  assert.deepEqual(listings.map((l) => l.id), ["latest", "popular", "subscribers", "added"]);

  const page = await call("getListing", "popular", 1);
  const url = decodeURIComponent(fetchImpl.calls[0].url);
  assert.match(url, /[?&]text=&/);
  assert.match(url, /sort=Popularity/);
  assert.match(url, /order=Descending/);
  assert.equal(page.results.length, 2);
  await assert.rejects(call("getListing", "nope", 1), /Unknown list/);
});

test("newer apps get genres, order and anime filters, mapped to the site's search", async () => {
  const fetchImpl = fakeFetch([[/\/search\/data/, await fixture("search.html")]]);
  const { call } = await loadSource(dir, { fetchImpl });
  const filters = await call("getFilters");
  const genres = filters.find((f) => f.id === "genres");
  assert.equal(genres.type, "tags");
  assert.equal(genres.workField, "tags");
  assert.ok(genres.excludable);
  assert.ok(genres.options.some((o) => o.id === "Action"));
  assert.ok(!genres.options.some((o) => o.id === "Adult"), "adult genres stay hidden by default");

  await call("search", "", 1, { genres: ["Action", "Fantasy"], "genres.exclude": ["Horror"], order: ["Ascending"], anime: ["True"] });
  const url = decodeURIComponent(fetchImpl.calls[0].url);
  assert.match(url, /included_tag=Action&included_tag=Fantasy/);
  assert.match(url, /excluded_tag=Horror/);
  assert.match(url, /order=Ascending/);
  assert.match(url, /anime=True/);
});

test("apps before 0.4 keep the four simple filters", async () => {
  const { call } = await loadSource(dir, { fetchImpl: fakeFetch([]), filterTypes: null });
  const filters = await call("getFilters");
  assert.deepEqual(filters.map((f) => f.id), ["sort", "type", "status", "official"]);
});
