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

test("apps before 0.4 get only the filters they can show", async () => {
  const { call } = await loadSource(dir, { fetchImpl: fakeFetch([]), filterTypes: null });
  const filters = await call("getFilters");
  assert.deepEqual(filters.map((f) => f.id), ["sort", "complete", "rating", "language", "exclude", "nocrossovers"]);
  assert.ok(filters.every((f) => ["select", "multi", "toggle"].includes(f.type)));
});

test("newer apps get AO3's full search", async () => {
  const { call } = await loadSource(dir, { fetchImpl: fakeFetch([]) });
  const filters = await call("getFilters");
  const ids = filters.map((f) => f.id);
  for (const id of ["fandoms", "characters", "relationships", "freeforms", "warnings", "categories", "othertags",
    "words", "kudos", "hits", "updated", "crossover", "direction", "title", "creators"]) {
    assert.ok(ids.includes(id), id);
  }
  assert.equal(new Set(ids).size, ids.length);
  const byID = Object.fromEntries(filters.map((f) => [f.id, f]));
  assert.equal(byID.fandoms.type, "tags");
  assert.equal(byID.fandoms.workField, "fandoms");
  assert.equal(byID.freeforms.workField, "tags");
  assert.ok(byID.fandoms.excludable && byID.fandoms.suggests);
  assert.equal(byID.words.type, "range");
  // Labels match the work page, so a tapped tag finds its option.
  assert.ok(byID.rating.options.some((o) => o.label === "Teen And Up Audiences"));
  assert.ok(byID.categories.options.some((o) => o.label === "F/M"));
  assert.ok(byID.language.options.length > 20);
});

test("full search maps every filter to AO3's fields", async () => {
  const fetchImpl = fakeFetch([[/\/works\/search/, { body: await fixture("search.html") }]]);
  const { call } = await loadSource(dir, { fetchImpl });
  await call("search", "", 1, {
    sort: ["word_count"], direction: ["asc"], crossover: ["T"], oneshot: ["true"], updated: ["< 1 month"],
    fandoms: ["Hollow Tide", "Other Show"], "fandoms.exclude": ["Bad Show"],
    characters: ["Mara"], relationships: ["Mara/Ilse"], freeforms: ["Slow Burn"], "freeforms.exclude": ["Angst"],
    warnings: ["No Archive Warnings Apply"], "warnings.exclude": ["Major Character Death"],
    categories: ["116", "21"], othertags: ["Tea"],
    words: ["1000", "5000"], kudos: ["100", ""], hits: ["", "999"], bookmarks: ["", ""],
    title: ["edge"], creators: ["fern"],
  });
  const url = decodeURIComponent(fetchImpl.calls[0]);
  assert.match(url, /work_search\[query\]=&/);
  assert.match(url, /work_search\[sort_direction\]=asc/);
  assert.match(url, /work_search\[crossover\]=T/);
  assert.match(url, /work_search\[single_chapter\]=1/);
  assert.match(url, /work_search\[revised_at\]=< 1 month/);
  assert.match(url, /work_search\[fandom_names\]=Hollow Tide,Other Show/);
  assert.match(url, /work_search\[character_names\]=Mara&/);
  assert.match(url, /work_search\[relationship_names\]=Mara\/Ilse/);
  assert.match(url, /work_search\[freeform_names\]=Slow Burn/);
  assert.match(url, /work_search\[other_tag_names\]=Tea/);
  assert.match(url, /work_search\[excluded_tag_names\]=Bad Show,Angst,Major Character Death/);
  assert.match(url, /work_search\[archive_warning_ids\]\[\]=16/);
  assert.match(url, /work_search\[category_ids\]\[\]=116&work_search\[category_ids\]\[\]=21/);
  assert.match(url, /work_search\[word_count\]=1000-5000/);
  assert.match(url, /work_search\[kudos_count\]=>99/);
  assert.match(url, /work_search\[hits\]=<1000/);
  assert.match(url, /work_search\[bookmarks_count\]=&/);
  assert.match(url, /work_search\[title\]=edge/);
  assert.match(url, /work_search\[creators\]=fern/);
});

test("tag suggestions come from AO3's autocomplete", async () => {
  const fetchImpl = fakeFetch([
    [/\/autocomplete\/fandom\?term=hol/, { body: JSON.stringify([{ id: "Hollow Tide", name: "Hollow Tide" }, { id: "Holby City", name: "Holby City" }]) }],
    [/\/autocomplete\/tag\?/, { status: 500 }],
  ]);
  const { call } = await loadSource(dir, { fetchImpl });
  assert.deepEqual(await call("suggest", "fandoms", "hol"), [
    { id: "Hollow Tide", label: "Hollow Tide" }, { id: "Holby City", label: "Holby City" },
  ]);
  assert.deepEqual(await call("suggest", "othertags", "tea"), []);
  assert.deepEqual(await call("suggest", "fandoms", "h"), []);
  assert.deepEqual(await call("suggest", "warnings", "maj"), []);
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

test("the manifest keeps AO3 explicit, slow, filterable and browsable", async () => {
  const { manifest } = await loadSource(dir, { fetchImpl: fakeFetch([]) });
  assert.equal(manifest.contentRating, "explicit");
  assert.ok(manifest.rateLimit.minIntervalMs >= 3000);
  assert.deepEqual(manifest.capabilities, ["filters", "listings", "account"]);
  assert.equal(manifest.account.loginURL, "https://archiveofourown.org/users/login");
});

test("links to works and chapters give the work id", async () => {
  const { call } = await loadSource(dir, { fetchImpl: fakeFetch([]) });
  assert.equal(await call("idFromURL", "https://archiveofourown.org/works/1001/chapters/5003"), "1001");
  assert.equal(await call("idFromURL", "https://archiveofourown.org/users/fern"), null);
});

test("browse lists read AO3's search with a sort and no query", async () => {
  const fetchImpl = fakeFetch([[/\/works\/search/, { body: await fixture("search.html") }]]);
  const { call } = await loadSource(dir, { fetchImpl });
  const listings = await call("getListings");
  assert.deepEqual(listings.map((l) => l.id), ["updated", "week", "kudos", "new"]);
  assert.ok(listings.every((l) => l.title && !("sort" in l)));

  const page = await call("getListing", "week", 2);
  const url = decodeURIComponent(fetchImpl.calls[0]);
  assert.match(url, /work_search\[query\]=&/);
  assert.match(url, /work_search\[sort_column\]=kudos_count/);
  assert.match(url, /work_search\[revised_at\]=< 1 week/);
  assert.match(url, /work_search\[language_id\]=en/);
  assert.match(url, /page=2/);
  assert.ok(page.results.length > 0);

  await call("getListing", "updated", 1);
  const plain = decodeURIComponent(fetchImpl.calls[1]);
  assert.match(plain, /sort_column\]=revised_at/);
  assert.match(plain, /revised_at\]=&/);
  await assert.rejects(call("getListing", "nope", 1), /Unknown list/);
});

// Signed in. The app passes the username as the "account" setting and sends AO3's
// session cookie itself, so these pages are what AO3 shows a signed-in reader.

const signedIn = { settings: { account: "fern_reads", maxRating: "explicit" } };

test("getAccount reads the username from AO3's header, and null when logged out", async () => {
  const inside = fakeFetch([[/archiveofourown\.org\/$/, { body: await fixture("home-signed-in.html") }]]);
  assert.deepEqual(await (await loadSource(dir, { fetchImpl: inside })).call("getAccount"),
    { username: "fern_reads", url: "https://archiveofourown.org/users/fern_reads" });
  const outside = fakeFetch([[/archiveofourown\.org\/$/, { body: await fixture("home-signed-out.html") }]]);
  assert.equal(await (await loadSource(dir, { fetchImpl: outside })).call("getAccount"), null);
});

test("account lists say which ones can be imported", async () => {
  const { call } = await loadSource(dir, { fetchImpl: fakeFetch([]), ...signedIn });
  const lists = await call("getAccountLists");
  assert.deepEqual(lists.map((l) => [l.id, l.importable]), [["bookmarks", true], ["later", true], ["history", false], ["subscriptions", true]]);
});

test("bookmarks read the person's bookmark blurbs and skip deleted works", async () => {
  const fetchImpl = fakeFetch([[/\/users\/fern_reads\/bookmarks\?page=1$/, { body: await fixture("bookmarks.html") }]]);
  const { call } = await loadSource(dir, { fetchImpl, ...signedIn });
  const page = await call("getAccountList", "bookmarks", 1);
  assert.deepEqual(page.results.map((r) => r.id), ["1001", "2002"]);
  assert.equal(page.results[1].title, "Salt & Static");
  assert.deepEqual(page.results[0].fandoms, ["Hollow Tide"]);
  assert.equal(page.results[0].wordCount, 12345);
  assert.equal(page.hasMore, true);
});

test("Marked for Later and subscriptions", async () => {
  const fetchImpl = fakeFetch([
    [/readings\?show=to-read&page=2$/, { body: await fixture("later.html") }],
    [/subscriptions\?type=works&page=1$/, { body: await fixture("subscriptions.html") }],
  ]);
  const { call } = await loadSource(dir, { fetchImpl, ...signedIn });
  const later = await call("getAccountList", "later", 2);
  assert.deepEqual(later.results.map((r) => r.title), ["Lantern Hours"]);
  assert.equal(later.hasMore, false);
  const subs = await call("getAccountList", "subscriptions", 1);
  assert.deepEqual(subs.results, [{ id: "1001", title: "Tea at the Edge of the World", authors: ["fern"], format: "fic" }]);
});

test("account lists need a session", async () => {
  const { call } = await loadSource(dir, { fetchImpl: fakeFetch([]) });
  await assert.rejects(call("getAccountList", "bookmarks", 1), /Sign in to AO3/);
  // Cookie expired: AO3 answers with the logged-out header.
  const expired = fakeFetch([[/bookmarks/, { body: await fixture("home-signed-out.html") }]]);
  await assert.rejects((await loadSource(dir, { fetchImpl: expired, ...signedIn })).call("getAccountList", "bookmarks", 1), /signed you out/);
});

test("a signed-in work page carries Marked for Later, subscription and kudos state", async () => {
  const fresh = fakeFetch([[/works\/1001\?/, { body: await fixture("work-signed-in.html") }]]);
  const work = await (await loadSource(dir, { fetchImpl: fresh, ...signedIn })).call("getWork", "1001");
  assert.deepEqual(work.account, { markedForLater: false, subscribed: false });
  const done = fakeFetch([[/works\/1001\?/, { body: await fixture("work-signed-in-done.html") }]]);
  const after = await (await loadSource(dir, { fetchImpl: done, ...signedIn })).call("getWork", "1001");
  assert.deepEqual(after.account, { markedForLater: true, subscribed: true, kudos: true });
  // Logged out there's no account state at all.
  const anon = await (await loadSource(dir, { fetchImpl: fakeFetch([[/works\/1001\?/, { body: await fixture("work.html") }]]) })).call("getWork", "1001");
  assert.equal(anon.account, undefined);
});

test("restricted works point to signing in", async () => {
  const restricted = fakeFetch([[/works\/2/, { url: "https://archiveofourown.org/users/login?restricted=true", body: "<html>Log in</html>" }]]);
  await assert.rejects((await loadSource(dir, { fetchImpl: restricted })).call("getWork", "2"), /Sign in to AO3 in Settings > Accounts/);
  await assert.rejects((await loadSource(dir, { fetchImpl: restricted, ...signedIn })).call("getWork", "2"), /signed you out/);
});

function workSequence(pages) {
  // Answers the work page from `pages` in order, so the state can change after an action.
  let n = 0;
  return async () => ({ body: await fixture(pages[Math.min(n++, pages.length - 1)]) });
}

test("Mark for Later opens AO3's mark link and reads the state back", async () => {
  const fetchImpl = fakeFetch([
    [/works\/1001\/mark_for_later$/, { body: "<html></html>" }],
    [/works\/1001\?/, workSequence(["work-signed-in.html", "work-signed-in-done.html"])],
  ]);
  const { call } = await loadSource(dir, { fetchImpl, ...signedIn });
  const state = await call("setWorkState", "1001", "markedForLater", true);
  assert.equal(state.markedForLater, true);
  assert.ok(fetchImpl.calls.some((u) => u.endsWith("/works/1001/mark_for_later")));
});

test("nothing is sent when the work is already in the wanted state", async () => {
  const fetchImpl = fakeFetch([[/works\/1001\?/, { body: await fixture("work-signed-in-done.html") }]]);
  const { call } = await loadSource(dir, { fetchImpl, ...signedIn });
  await call("setWorkState", "1001", "markedForLater", true);
  await call("setWorkState", "1001", "kudos", true);
  assert.ok(fetchImpl.calls.every((u) => /works\/1001\?/.test(u)));
});

test("kudos and subscribe post AO3's forms with the page's token", async () => {
  const posts = [];
  const record = (status) => async (url, init) => { posts.push({ url, body: init.body, headers: init.headers }); return { status, body: "{}" }; };
  const fetchImpl = fakeFetch([
    [/\/kudos$/, record(201)],
    [/\/users\/fern_reads\/subscriptions$/, record(200)],
    [/works\/1001\?/, workSequence(["work-signed-in.html", "work-signed-in.html", "work-signed-in-done.html"])],
  ]);
  const { call } = await loadSource(dir, { fetchImpl, ...signedIn });
  assert.equal((await call("setWorkState", "1001", "kudos", true)).kudos, true);
  const params = new URLSearchParams(posts[0].body);
  assert.equal(params.get("authenticity_token"), "tok-work-456");
  assert.equal(params.get("kudo[commentable_id]"), "1001");
  assert.equal(params.get("kudo[commentable_type]"), "Work");
  assert.equal(posts[0].headers["X-CSRF-Token"], "tok-work-456");

  assert.equal((await call("setWorkState", "1001", "subscribed", true)).subscribed, true);
  const sub = new URLSearchParams(posts[1].body);
  assert.equal(sub.get("subscription[subscribable_id]"), "1001");
  assert.equal(sub.get("_method"), null);
});

test("unsubscribing deletes the subscription named on the work page", async () => {
  const posts = [];
  const fetchImpl = fakeFetch([
    [/\/subscriptions\/555$/, async (url, init) => { posts.push(init.body); return { status: 200, body: "{}" }; }],
    [/works\/1001\?/, workSequence(["work-signed-in-done.html", "work-signed-in.html"])],
  ]);
  const { call } = await loadSource(dir, { fetchImpl, ...signedIn });
  assert.equal((await call("setWorkState", "1001", "subscribed", false)).subscribed, false);
  assert.equal(new URLSearchParams(posts[0]).get("_method"), "delete");
});

test("kudos can't be taken back, and actions need a session", async () => {
  const fetchImpl = fakeFetch([[/works\/1001\?/, { body: await fixture("work-signed-in-done.html") }]]);
  await assert.rejects((await loadSource(dir, { fetchImpl, ...signedIn })).call("setWorkState", "1001", "kudos", false), /take kudos back/);
  await assert.rejects((await loadSource(dir, { fetchImpl })).call("setWorkState", "1001", "kudos", true), /Sign in to AO3/);
});
