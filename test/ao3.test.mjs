import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSource } from "../tools/shelf-repo/lib/runner.mjs";

// Offline tests against saved AO3 pages (trimmed). When AO3 changes its markup, save
// fresh copies into fixtures/ and fix the selectors until these pass again.

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, "../sources/ao3");
const fixture = (name) => readFile(path.join(here, "fixtures", "ao3", name), "utf8");

function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push(url);
    for (const [pattern, reply] of routes) {
      if (pattern.test(url)) {
        const r = typeof reply === "function" ? await reply(url, init) : reply;
        return { status: r.status ?? 200, url: r.url ?? url, headers: Object.entries(r.headers ?? {}), text: async () => r.body ?? "" };
      }
    }
    return { status: 404, url, headers: [], text: async () => "" };
  };
  impl.calls = calls;
  return impl;
}

test("filters describe sort, status, rating, language and exclusions", async () => {
  const { call } = await loadSource(dir, { fetchImpl: fakeFetch([]) });
  const filters = await call("getFilters");
  assert.deepEqual(filters.map((f) => f.id), ["sort", "complete", "rating", "language", "exclude", "nocrossovers"]);
  assert.ok(filters.every((f) => ["select", "multi", "toggle"].includes(f.type)));
});

test("search builds the query from filters and reads blurbs", async () => {
  const fetchImpl = fakeFetch([[/\/works\/search/, { body: await fixture("search.html") }]]);
  const { call } = await loadSource(dir, { fetchImpl });
  const page = await call("search", "tea", 2, {
    sort: ["kudos_count"], complete: ["T"], rating: ["11"], language: ["en"],
    exclude: ["Major Character Death", "Rape/Non-Con"], nocrossovers: ["true"],
  });
  const url = decodeURIComponent(fetchImpl.calls[0]);
  assert.match(url, /work_search\[query\]=tea/);
  assert.match(url, /work_search\[sort_column\]=kudos_count/);
  assert.match(url, /work_search\[complete\]=T/);
  assert.match(url, /work_search\[rating_ids\]=11/);
  assert.match(url, /work_search\[excluded_tag_names\]=Major Character Death,Rape\/Non-Con/);
  assert.match(url, /work_search\[crossover\]=F/);
  assert.match(url, /page=2/);

  assert.equal(page.hasMore, true);
  assert.equal(page.results.length, 2);
  const [a, b] = page.results;
  assert.equal(a.id, "1001");
  assert.equal(a.title, "Tea at the Edge of the World");
  assert.deepEqual(a.authors, ["fern"]);
  assert.deepEqual(a.fandoms, ["Hollow Tide"]);
  assert.equal(a.rating, "Teen And Up Audiences");
  assert.deepEqual(a.tags, ["Mara/Ilse", "Slow Burn", "Tea"]);
  assert.equal(a.wordCount, 48210);
  assert.equal(a.chapterCount, "3/12");
  assert.equal(a.kudos, 1204);
  assert.equal(a.updatedAt, "2024-01-12T00:00:00Z");
  assert.deepEqual(b.authors, ["a", "b"]);
  assert.deepEqual(b.fandoms, ["Hollow Tide", "Other Show"]);
});

test("work page reads tags, stats, series and downloads", async () => {
  const fetchImpl = fakeFetch([[/\/works\/1001\?view_adult=true$/, { body: await fixture("work.html") }]]);
  const { call } = await loadSource(dir, { fetchImpl });
  const work = await call("getWork", "1001");
  assert.equal(work.title, "Tea at the Edge of the World");
  assert.deepEqual(work.authors, ["fern"]);
  assert.equal(work.rating, "Teen And Up Audiences");
  assert.deepEqual(work.categories, ["F/F"]);
  assert.deepEqual(work.characters, ["Mara", "Ilse"]);
  assert.deepEqual(work.relationships, ["Mara/Ilse"]);
  assert.equal(work.language, "English");
  assert.equal(work.status, "In progress");
  assert.equal(work.bookmarks, 310);
  assert.equal(work.hits, 20113);
  assert.equal(work.publishedAt, "2023-11-02T00:00:00Z");
  assert.equal(work.updatedAt, "2024-01-12T00:00:00Z");
  assert.deepEqual(work.series, [{ title: "the Lighthouse Letters", part: 2, id: "77", url: "https://archiveofourown.org/series/77" }]);
  assert.equal(work.downloads.EPUB, "https://archiveofourown.org/downloads/1001/Tea.epub?updated_at=1");
  assert.match(work.summaryHTML, /one kettle/);
});

test("chapter index", async () => {
  const fetchImpl = fakeFetch([[/navigate/, { body: await fixture("navigate.html") }]]);
  const { call } = await loadSource(dir, { fetchImpl });
  const chapters = await call("getChapters", "1001");
  assert.deepEqual(chapters.map((c) => [c.id, c.title, c.number]), [["5001", "Arrival", 1], ["5002", "Fog", 2], ["5003", "Biscuits", 3]]);
  assert.equal(chapters[2].publishedAt, "2024-01-12T00:00:00Z");
});

test("chapter text with notes, without the landmark heading", async () => {
  const fetchImpl = fakeFetch([[/\/chapters\/5001/, { body: await fixture("chapter.html") }]]);
  const { call } = await loadSource(dir, { fetchImpl });
  const content = await call("getChapterContent", "1001", "5001");
  assert.equal(content.type, "text");
  assert.match(content.html, /kettle sang/);
  assert.doesNotMatch(content.html, /Chapter Text/);
  assert.match(content.notesBefore, /Chapter note/);
  assert.match(content.notesBefore, /Work note/);
  assert.match(content.notesAfter, /biscuits/);
});

test("restricted works and rate limiting give clear errors", async () => {
  const restricted = fakeFetch([[/works\/2/, { url: "https://archiveofourown.org/users/login?restricted=true", body: "<html>Log in</html>" }]]);
  await assert.rejects((await loadSource(dir, { fetchImpl: restricted })).call("getWork", "2"), /logged-in AO3 users/);
  const limited = fakeFetch([[/works\/3/, { status: 429, body: "Retry later" }]]);
  await assert.rejects((await loadSource(dir, { fetchImpl: limited })).call("getWork", "3"), /slow down/);
});

test("the manifest keeps AO3 explicit, slow, and filterable", async () => {
  const { manifest } = await loadSource(dir, { fetchImpl: fakeFetch([]) });
  assert.equal(manifest.contentRating, "explicit");
  assert.ok(manifest.rateLimit.minIntervalMs >= 3000);
  assert.deepEqual(manifest.capabilities, ["filters"]);
});

test("links to works and chapters give the work id", async () => {
  const { call } = await loadSource(dir, { fetchImpl: fakeFetch([]) });
  assert.equal(await call("idFromURL", "https://archiveofourown.org/works/1001/chapters/5003"), "1001");
  assert.equal(await call("idFromURL", "https://archiveofourown.org/users/fern"), null);
});
