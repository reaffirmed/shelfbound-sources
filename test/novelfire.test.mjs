import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSource } from "../tools/shelf-repo/lib/runner.mjs";

// Offline tests against trimmed copies of NovelFire pages saved in November 2026.
// When the site changes its markup, save fresh copies into fixtures/ and fix the
// selectors in sources/novelfire/main.js until these pass again.

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, "../sources/novelfire");
const fixture = (name) => readFile(path.join(here, "fixtures", "novelfire", name), "utf8");

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

test("title search reads cards and the next-page link", async () => {
  const fetchImpl = fakeFetch([[/\/search\?keyword=/, await fixture("search.html")]]);
  const { call } = await loadSource(dir, { fetchImpl });
  const page = await call("search", "shadow monarch", 2, { genres: ["Action"] });

  assert.equal(fetchImpl.calls[0].url, "https://novelfire.net/search?keyword=shadow%20monarch&page=2");
  assert.equal(page.hasMore, true);
  assert.equal(page.results.length, 2);
  const [first, second] = page.results;
  assert.equal(first.id, "sss-transmigration-i-can-extract-and-evolve-overpowered-shadows");
  assert.equal(first.title, "SSS Transmigration: I Can Extract And Evolve Overpowered Shadows");
  assert.equal(first.coverURL, "https://novelfire.net/server-1/sss-transmigration-i-can-extract-and-evolve-overpowered-shadows.jpg");
  assert.equal(first.chapterCount, "65");
  assert.equal(first.format, "novel");
  assert.equal(second.title, "Shadow Monarch in DC");
});

test("an empty search uses the filter page and maps every filter", async () => {
  const fetchImpl = fakeFetch([
    [/\/ajax\/getTags\?term=Reincarnation/, JSON.stringify({ status: 200, data: [{ id: 315, name: "Reincarnated in Another World" }, { id: 41, name: "Reincarnation" }] })],
    [/\/ajax\/getTags\?term=Harem/, JSON.stringify({ status: 200, data: [{ id: 9, name: "Harem Seeking Protagonist" }] })],
    [/\/search-adv\?/, await fixture("adv.html")],
  ]);
  const { call } = await loadSource(dir, { fetchImpl });
  const page = await call("search", "", 3, {
    sort: ["monthly-view"], status: ["1"], origin: ["1", "4"], chapters: ["100", ""], rating: ["4"],
    genres: ["Action", "Fantasy"], genreMatch: ["or"], tags: ["Reincarnation"], "tags.exclude": ["Harem"],
  });

  const url = new URL(fetchImpl.calls.at(-1).url);
  assert.equal(url.pathname, "/search-adv");
  assert.equal(url.searchParams.get("ctgcon"), "or");
  assert.deepEqual(url.searchParams.getAll("categories[]"), ["3", "6"]);
  assert.deepEqual(url.searchParams.getAll("country_id[]"), ["1", "4"]);
  assert.equal(url.searchParams.get("totalchapter"), "100,1000000");
  assert.equal(url.searchParams.get("rating"), "4");
  assert.equal(url.searchParams.get("status"), "1");
  assert.equal(url.searchParams.get("sort"), "monthly-view");
  assert.deepEqual(url.searchParams.getAll("tags[]"), ["41"], "an exact name match wins over the first suggestion");
  assert.deepEqual(url.searchParams.getAll("tags_excluded[]"), ["9"]);
  assert.equal(url.searchParams.get("page"), "3");

  assert.equal(page.hasMore, true);
  assert.deepEqual(page.results.map((r) => r.id), ["lord-of-the-mysteries", "reverend-insanity"]);
  assert.equal(page.results[0].title, "Lord of the Mysteries");
  assert.equal(page.results[0].coverURL, "https://novelfire.net/server-1/lord-of-the-mysteries.jpg", "lazy covers use data-src");
  assert.equal(page.results[0].chapterCount, "1432");
  assert.deepEqual(page.results[0].tags, ["Completed"]);
});

test("genres that are only left out use the site's exclude mode", async () => {
  const fetchImpl = fakeFetch([[/\/search-adv\?/, await fixture("adv.html")]]);
  const { call } = await loadSource(dir, { fetchImpl });
  await call("search", "", 1, { "genres.exclude": ["Harem", "Yaoi"] });
  const url = new URL(fetchImpl.calls[0].url);
  assert.equal(url.searchParams.get("ctgcon"), "exclude");
  assert.deepEqual(url.searchParams.getAll("categories[]"), ["7", "14"]);
  assert.equal(url.searchParams.get("totalchapter"), "0");
  assert.equal(url.searchParams.get("sort"), "rank-top");
});

test("tag suggestions come from the site's lookup", async () => {
  const fetchImpl = fakeFetch([[/\/ajax\/getTags\?term=reinc/, JSON.stringify({ data: [{ id: 620, name: "Reincarnated as a Monster" }, { id: 41, name: "Reincarnation" }] })]]);
  const { call } = await loadSource(dir, { fetchImpl });
  assert.deepEqual(await call("suggest", "tags", "reinc"), [
    { id: "Reincarnated as a Monster", label: "Reincarnated as a Monster" },
    { id: "Reincarnation", label: "Reincarnation" },
  ]);
  assert.deepEqual(await call("suggest", "tags", "re"), []);
  assert.deepEqual(await call("suggest", "genres", "reinc"), []);
});

test("getWork reads the novel page", async () => {
  const fetchImpl = fakeFetch([[/\/book\/shadow-slave$/, await fixture("book.html")]]);
  const { call } = await loadSource(dir, { fetchImpl });
  const work = await call("getWork", "shadow-slave");
  assert.equal(work.title, "Shadow Slave");
  assert.deepEqual(work.authors, ["Guiltythree"]);
  assert.equal(work.coverURL, "https://novelfire.net/server-1/shadow-slave.jpg");
  assert.deepEqual(work.tags, ["Action", "Adventure", "Fantasy", "Romance"]);
  assert.equal(work.chapterCount, "3256");
  assert.equal(work.status, "Ongoing");
  assert.equal(work.format, "novel");
  assert.equal(work.rating, undefined);
  assert.match(work.summaryHTML, /^<p>Growing up in poverty/);
  assert.doesNotMatch(work.summaryHTML, /Show More/);
  assert.equal(work.url, "https://novelfire.net/book/shadow-slave");
});

test("getChapters walks every page of the chapter list, oldest first", async () => {
  const fetchImpl = fakeFetch([
    [/\/chapters\?page=2$/, await fixture("chapters2.html")],
    [/\/chapters\?page=3$/, await fixture("chapters3.html")],
    [/\/chapters$/, await fixture("chapters1.html")],
  ]);
  const { call } = await loadSource(dir, { fetchImpl });
  const chapters = await call("getChapters", "shadow-slave");
  assert.deepEqual(chapters.map((c) => c.id), ["chapter-1", "chapter-2", "chapter-3", "chapter-4", "chapter-5"]);
  assert.deepEqual(chapters.map((c) => c.number), [1, 2, 3, 4, 5]);
  assert.equal(chapters[0].title, "Chapter 1 - 1: Nightmare Begins");
  assert.equal(chapters[0].publishedAt, "2022-06-02T14:30:56Z");
  assert.equal(fetchImpl.calls.length, 3);
});

test("getChapterContent returns the text without ads or scripts", async () => {
  const fetchImpl = fakeFetch([[/\/book\/shadow-slave\/chapter-2$/, await fixture("chapter.html")]]);
  const { call } = await loadSource(dir, { fetchImpl });
  const content = await call("getChapterContent", "shadow-slave", "chapter-2");
  assert.equal(content.type, "text");
  assert.match(content.html, /^<p>Sunny dreamt of a mountain\.<\/p>/);
  assert.match(content.html, /resumed its usual pace/);
  assert.doesNotMatch(content.html, /advert|<script/);
});

test("browse lists use the filter page sorted", async () => {
  const fetchImpl = fakeFetch([[/\/search-adv\?/, await fixture("adv.html")]]);
  const { call } = await loadSource(dir, { fetchImpl });
  const listings = await call("getListings");
  assert.deepEqual(listings.map((l) => l.id), ["latest", "today", "month", "rank", "completed"]);
  await call("getListing", "completed", 2);
  const url = new URL(fetchImpl.calls[0].url);
  assert.equal(url.searchParams.get("sort"), "rank-top");
  assert.equal(url.searchParams.get("status"), "1");
  assert.equal(url.searchParams.get("page"), "2");
  await assert.rejects(call("getListing", "nope", 1), /Unknown list/);
});

test("filters: full set on new apps, adult genres only when explicit sources are allowed", async () => {
  const { call } = await loadSource(dir, { fetchImpl: fakeFetch([]) });
  const filters = await call("getFilters");
  assert.deepEqual(filters.map((f) => f.id), ["sort", "status", "origin", "chapters", "rating", "genres", "genreMatch", "tags", "tagMatch"]);
  const genres = filters.find((f) => f.id === "genres");
  assert.equal(genres.type, "tags");
  assert.ok(genres.excludable);
  assert.ok(!genres.options.some((o) => o.id === "Smut"));
  assert.equal(filters.find((f) => f.id === "chapters").type, "range");
  assert.ok(filters.find((f) => f.id === "tags").suggests);

  const explicit = await loadSource(dir, { fetchImpl: fakeFetch([]), settings: { maxRating: "explicit" } });
  const all = await explicit.call("getFilters");
  assert.ok(all.find((f) => f.id === "genres").options.some((o) => o.id === "Smut"));
});

test("apps before 0.4 get sort, status and a genre menu", async () => {
  const fetchImpl = fakeFetch([[/\/search-adv\?/, await fixture("adv.html")]]);
  const { call } = await loadSource(dir, { fetchImpl, filterTypes: null });
  const filters = await call("getFilters");
  assert.deepEqual(filters.map((f) => [f.id, f.type]), [["sort", "select"], ["status", "select"], ["genres", "multi"]]);
  await call("search", "", 1, { genres: ["3"] });
  assert.deepEqual(new URL(fetchImpl.calls[0].url).searchParams.getAll("categories[]"), ["3"]);
});

test("idFromURL reads novel and chapter links", async () => {
  const { call } = await loadSource(dir, { fetchImpl: fakeFetch([]) });
  assert.equal(await call("idFromURL", "https://novelfire.net/book/shadow-slave/chapter-12"), "shadow-slave");
  assert.equal(await call("idFromURL", "https://example.com/book/shadow-slave"), null);
});

test("a 429 is asked again, since the app waits before the next request", async () => {
  const body = await fixture("book.html");
  let n = 0;
  const fetchImpl = async (url) => {
    n++;
    if (n === 1) return { status: 429, url, headers: [], text: async () => "Too Many Requests" };
    return { status: 200, url, headers: [], text: async () => body };
  };
  const { call } = await loadSource(dir, { fetchImpl });
  assert.equal((await call("getWork", "shadow-slave")).title, "Shadow Slave");
  assert.equal(n, 2);

  const always = async (url) => ({ status: 429, url, headers: [], text: async () => "" });
  const busy = await loadSource(dir, { fetchImpl: always });
  await assert.rejects(busy.call("getWork", "shadow-slave"), /slow down/);
});
