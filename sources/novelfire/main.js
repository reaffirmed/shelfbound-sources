// NovelFire (novelfire.net): translated web novels and light novels. Plain server-rendered
// pages, read the same way a browser does:
//
//   title search  /search?keyword=…&page=N                li.novel-item cards
//   filters       /search-adv?categories[]=…&status=…&sort=…&page=N   same cards
//   novel         /book/<slug>                              .novel-info, .summary
//   chapters      /book/<slug>/chapters?page=N              100 per page, oldest first
//   chapter       /book/<slug>/chapter-<n>                  #content
//
// The novel's slug is its ID and the chapter's slug ("chapter-12") is the chapter ID.
// NovelFire's title search can't be combined with its filters, so filters apply when
// the search box is empty. Requests are 1.5 seconds apart, and a long novel's chapter
// list (100 chapters a page) takes a while to load the first time. The site is behind
// Cloudflare; when it shows a bot check the app asks the person to verify in its browser.

const BASE = "https://novelfire.net";

// The fallback genre list, used when the site's advanced search form (/search-adv) can't
// be read. The form itself has the full list, including genres rated for adults.
const GENRES = [
  ["3", "Action"], ["4", "Adventure"], ["46", "Anime"], ["47", "Arts"], ["5", "Comedy"], ["24", "Drama"],
  ["44", "Eastern"], ["48", "Fan-fiction"], ["6", "Fantasy"], ["19", "Game"], ["25", "Gender Bender"],
  ["12", "Historical"], ["37", "Horror"], ["49", "Isekai"], ["2", "Josei"], ["45", "Lgbt+"],
  ["50", "Magic"], ["51", "Magical realism"], ["52", "Manhua"], ["15", "Martial Arts"], ["34", "Mecha"],
  ["53", "Military"], ["54", "Modern life"], ["55", "Movies"], ["16", "Mystery"], ["64", "Other"],
  ["9", "Psychological"], ["56", "Realistic fiction"], ["43", "Reincarnation"], ["1", "Romance"],
  ["21", "School Life"], ["20", "Sci-fi"], ["10", "Seinen"], ["38", "Shoujo"], ["57", "Shoujo ai"],
  ["17", "Shounen"], ["39", "Shounen Ai"], ["13", "Slice of Life"], ["42", "Sports"], ["18", "Supernatural"],
  ["58", "System"], ["32", "Tragedy"], ["63", "Urban"], ["59", "Urban life"], ["60", "Video games"],
  ["61", "War"], ["31", "Wuxia"], ["23", "Xianxia"], ["22", "Xuanhuan"], ["14", "Yaoi"], ["62", "Yuri"],
];

// Genres rated for adults are recognised by a short hash of their lowercased name, so the
// names don't have to be written out here. They only show when the person allows explicit
// sources, and a novel tagged with one is rated Mature.
const ADULT_KEYS = new Set(["b6517d0f", "90c95ec1", "84f60e52", "34670561", "d7539744"]);
// Genres that are never offered, whatever the setting.
const NEVER_KEYS = new Set(["7fd074c1", "29bba438"]);

function genreKey(name) {
  let h = 0x811c9dc5;
  for (const ch of String(name).trim().toLowerCase()) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
const isAdultGenre = (name) => ADULT_KEYS.has(genreKey(name));

let siteGenres = null;
let genresTried = false;

/** The genre checkboxes from the site's advanced search form, as [id, name]. */
async function genreList() {
  if (siteGenres || genresTried) return siteGenres || GENRES;
  genresTried = true;
  try {
    const html = await get(`${BASE}/search-adv`);
    const found = [];
    for (const label of host.select(html, "label")) {
      const input = host.select(label.outerHTML, "input")[0];
      if (!input || input.attrs.name !== "categories[]" || !/^\d+$/.test(input.attrs.value || "")) continue;
      const name = decode(label.text).trim();
      if (name && !NEVER_KEYS.has(genreKey(name)) && !found.some(([id]) => id === input.attrs.value)) found.push([input.attrs.value, name]);
    }
    if (found.length >= 10) siteGenres = found;
  } catch (_) {
    // Use the built-in list.
  }
  return siteGenres || GENRES;
}

const SORTS = [
  ["rank-top", "Rank"],
  ["date", "Last updated"],
  ["rating-score-top", "Rating"],
  ["review", "Most reviews"],
  ["comment", "Most comments"],
  ["bookmark", "Most bookmarked"],
  ["today-view", "Views today"],
  ["monthly-view", "Views this month"],
  ["total-view", "Views all time"],
  ["chapter-count-most", "Most chapters"],
  ["abc", "Title A to Z"],
  ["cba", "Title Z to A"],
];
const STATUSES = [["-1", "Any status"], ["0", "Ongoing"], ["1", "Completed"]];
const ORIGINS = [["1", "Chinese"], ["3", "Japanese"], ["4", "English"]];
const MIN_RATINGS = [["0", "Any rating"], ["3", "3 stars and up"], ["4", "4 stars and up"], ["5", "5 stars"]];

const LISTINGS = [
  { id: "latest", title: "Freshly updated", subtitle: "Newest chapters first", sort: "date" },
  { id: "today", title: "Trending today", subtitle: "Most read today", sort: "today-view" },
  { id: "month", title: "Popular this month", subtitle: "Most read this month", sort: "monthly-view" },
  { id: "rank", title: "Best of all time", subtitle: "NovelFire's top ranked", sort: "rank-top" },
  { id: "completed", title: "Completed favourites", subtitle: "Finished novels, top ranked first", sort: "rank-top", status: "1" },
];

const opts = (pairs) => pairs.map(([id, label]) => ({ id, label }));

const decode = (s) =>
  String(s ?? "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;|&#x27;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ").trim();

function absolute(href) {
  if (!href || /^data:/.test(href)) return undefined;
  if (/^https?:\/\//.test(href)) return href;
  return BASE + (href.startsWith("/") ? "" : "/") + href;
}

function number(text) {
  const m = String(text ?? "").replace(/,/g, "").match(/\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : undefined;
}

function adultAllowed() {
  return host.settings.get("maxRating") === "explicit";
}

function fullFilters() {
  const kinds = host.filterTypes || [];
  return ["range", "tags"].every((k) => kinds.includes(k));
}

async function get(url) {
  // NovelFire allows roughly 30 pages a minute and answers 429 after that. The app holds
  // this source's next request back after a 429, so asking again simply waits it out.
  // That matters for long novels, whose chapter list is many pages.
  let res;
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await host.fetch({ url, headers: { Referer: BASE + "/" } });
    if (res.status !== 429) break;
  }
  if (res.status === 404) throw new Error("NovelFire doesn't have that page any more.");
  if (res.status === 429) throw new Error("NovelFire asked us to slow down. Try again in a minute.");
  if (res.status < 200 || res.status >= 300) throw new Error(`NovelFire answered ${res.status}.`);
  return res.body;
}

function slugFrom(href) {
  const m = String(href ?? "").match(/\/book\/([^/?#]+)/);
  return m ? m[1] : null;
}

/** One li.novel-item card. Title search and the filter pages lay them out a little differently. */
function card(item) {
  const html = item.outerHTML;
  const link = host.select(html, "a").find((a) => slugFrom(a.attrs.href));
  if (!link) return null;
  const id = slugFrom(link.attrs.href);
  const img = host.select(html, "img")[0];
  const title = link.attrs.title || (host.select(html, "h4.novel-title")[0] || {}).text || (img && img.attrs.alt);
  const stats = host.select(html, ".novel-stats span, .novel-stats strong").map((s) => s.text);
  const chapters = stats.find((s) => /chapters?$/i.test(s));
  const status = host.select(html, ".novel-stats .status")[0];
  return {
    id,
    title: decode(title),
    authors: [],
    coverURL: img ? absolute(img.attrs["data-src"] || img.attrs.src) : undefined,
    format: "novel",
    chapterCount: chapters ? String(number(chapters)) : undefined,
    tags: status ? [decode(status.text)] : undefined,
  };
}

function results(html) {
  const seen = new Set();
  const list = host.select(html, "li.novel-item").map(card).filter((r) => r && !seen.has(r.id) && seen.add(r.id));
  return { results: list, hasMore: host.select(html, "a[rel=next]").length > 0 };
}

/** Tag names to NovelFire's tag IDs, from the same lookup its search form uses. */
async function tagIDs(names) {
  const ids = [];
  for (const name of names) {
    const term = String(name).trim();
    if (!term) continue;
    if (/^\d+$/.test(term)) { ids.push(term); continue; }
    const found = await lookupTags(term);
    const match = found.find((t) => t.name.toLowerCase() === term.toLowerCase()) || found[0];
    if (match) ids.push(String(match.id));
  }
  return ids;
}

async function lookupTags(term) {
  const res = await host.fetch({
    url: `${BASE}/ajax/getTags?term=${encodeURIComponent(term)}`,
    headers: { Accept: "application/json", "X-Requested-With": "XMLHttpRequest", Referer: BASE + "/search-adv" },
  });
  if (res.status < 200 || res.status >= 300) return [];
  let json;
  try { json = JSON.parse(res.body); } catch { return []; }
  return (Array.isArray(json && json.data) ? json.data : [])
    .filter((t) => t && t.id != null && t.name)
    .map((t) => ({ id: t.id, name: decode(t.name) }));
}

async function advancedURL(pageNumber, filters) {
  const f = filters || {};
  const one = (id, fallback) => (f[id] && f[id][0]) || fallback;
  const named = (f.genres || []).concat(f["genres.exclude"] || []).some((v) => !/^\d+$/.test(v));
  const genreID = Object.fromEntries((named ? await genreList() : GENRES).concat(GENRES).map(([id, name]) => [name.toLowerCase(), id]));
  const genre = (v) => (/^\d+$/.test(v) ? v : genreID[String(v).toLowerCase()]);
  const included = (f.genres || []).map(genre).filter(Boolean);
  const excluded = (f["genres.exclude"] || []).map(genre).filter(Boolean);
  // NovelFire matches genres one way at a time: all, any, or none of the chosen ones.
  // When some are included and some left out, the included ones win.
  let mode = one("genreMatch", "and") === "or" ? "or" : "and";
  let genres = included;
  if (!included.length && excluded.length) { mode = "exclude"; genres = excluded; }

  const params = [["ctgcon", mode]];
  for (const id of genres) params.push(["categories[]", id]);
  for (const id of f.origin || []) params.push(["country_id[]", id]);

  const [min, max] = (f.chapters || []).map((v) => (/^\d+$/.test(String(v || "")) ? Number(v) : null));
  let chapters = "0";
  if (min != null || max != null) chapters = `${min ?? 1},${max ?? 1000000}`;
  params.push(["totalchapter", chapters]);
  params.push(["ratcon", "min"], ["rating", one("rating", "0")]);
  params.push(["status", one("status", "-1")]);
  params.push(["sort", one("sort", "rank-top")]);
  params.push(["tagcon", one("tagMatch", "and") === "or" ? "or" : "and"]);
  for (const id of await tagIDs(f.tags || [])) params.push(["tags[]", id]);
  for (const id of await tagIDs(f["tags.exclude"] || [])) params.push(["tags_excluded[]", id]);
  params.push(["page", String(pageNumber || 1)]);
  return `${BASE}/search-adv?` + params.map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v)).join("&");
}

globalThis.source = {
  async getListings() {
    return LISTINGS.map(({ id, title, subtitle }) => ({ id, title, subtitle }));
  },

  async getListing(id, pageNumber) {
    const listing = LISTINGS.find((l) => l.id === id);
    if (!listing) throw new Error("Unknown list: " + id);
    const filters = { sort: [listing.sort] };
    if (listing.status) filters.status = [listing.status];
    return globalThis.source.search("", pageNumber, filters);
  },

  async getFilters() {
    const genres = (await genreList()).filter(([, name]) => adultAllowed() || !isAdultGenre(name));
    const sort = { id: "sort", label: "Sort by", type: "select", default: ["rank-top"], options: opts(SORTS) };
    const status = { id: "status", label: "Status", type: "select", default: ["-1"], options: opts(STATUSES) };
    if (!fullFilters()) {
      // Apps before 0.4 only show select, multi and toggle.
      return [sort, status, { id: "genres", label: "Genres", type: "multi", options: opts(genres) }];
    }
    return [
      { ...sort, group: "Sort" },
      { ...status, group: "Novel" },
      { id: "origin", label: "Original language", type: "multi", group: "Novel", options: opts(ORIGINS) },
      { id: "chapters", label: "Chapters", type: "range", group: "Novel", placeholder: "chapters" },
      { id: "rating", label: "Reader rating", type: "select", default: ["0"], group: "Novel", options: opts(MIN_RATINGS) },
      {
        id: "genres", label: "Genres", type: "tags", group: "Genres", excludable: true, workField: "tags",
        placeholder: "Start typing a genre", options: genres.map(([, name]) => ({ id: name, label: name })),
      },
      {
        id: "genreMatch", label: "Genres to match", type: "select", default: ["and"], group: "Genres",
        options: [{ id: "and", label: "All of them" }, { id: "or", label: "Any of them" }],
      },
      {
        id: "tags", label: "Tags", type: "tags", group: "Tags", excludable: true, suggests: true,
        placeholder: "Start typing a tag, like Reincarnation",
      },
      {
        id: "tagMatch", label: "Tags to match", type: "select", default: ["and"], group: "Tags",
        options: [{ id: "and", label: "All of them" }, { id: "or", label: "Any of them" }],
      },
    ];
  },

  // Tag names as you type, from the lookup NovelFire's own search form uses.
  async suggest(filterID, text) {
    const term = String(text || "").trim();
    if (filterID !== "tags" || term.length < 3) return [];
    const seen = new Set();
    return (await lookupTags(term))
      .filter((t) => !seen.has(t.name.toLowerCase()) && seen.add(t.name.toLowerCase()))
      .slice(0, 20)
      .map((t) => ({ id: t.name, label: t.name }));
  },

  async search(query, pageNumber, filters) {
    const q = String(query ?? "").trim();
    const url = q
      ? `${BASE}/search?keyword=${encodeURIComponent(q)}&page=${pageNumber || 1}`
      : await advancedURL(pageNumber, filters);
    return results(await get(url));
  },

  async getWork(id) {
    const html = await get(`${BASE}/book/${encodeURIComponent(id)}`);
    const title = host.select(html, ".novel-info h1.novel-title, h1.novel-title")[0];
    if (!title) throw new Error("Couldn't read that novel's page on NovelFire.");
    const og = host.select(html, 'meta[property="og:image"]')[0];
    const cover = host.select(html, "figure.cover img, .novel-header figure img")[0];
    const authors = host.select(html, ".novel-info .author a").map((a) => decode(a.attrs.title || a.text)).filter(Boolean);
    const genres = host.select(html, ".novel-info .categories a").map((a) => decode(a.attrs.title || a.text)).filter(Boolean);
    const stats = host.select(html, ".header-stats span");
    const stat = (label) => {
      const s = stats.find((x) => new RegExp(label + "\\s*$", "i").test(x.text));
      return s ? s.text.replace(new RegExp(label + "\\s*$", "i"), "").trim() : undefined;
    };
    const summary = host.select(html, ".summary .content")[0];
    const summaryHTML = summary
      ? summary.html.replace(/<div class="expand">[\s\S]*?<\/div>/i, "").trim()
      : undefined;
    const status = stat("Status");
    return {
      id,
      title: decode(title.text),
      authors,
      coverURL: absolute((og && og.attrs.content) || (cover && (cover.attrs["data-src"] || cover.attrs.src))),
      summaryHTML: summaryHTML || undefined,
      url: `${BASE}/book/${id}`,
      format: "novel",
      rating: genres.some(isAdultGenre) ? "Mature" : undefined,
      tags: genres,
      chapterCount: stat("Chapters"),
      status: status ? status.charAt(0).toUpperCase() + status.slice(1).toLowerCase() : undefined,
      language: "English",
    };
  },

  async getChapters(id) {
    const base = `${BASE}/book/${encodeURIComponent(id)}/chapters`;
    const first = await get(base);
    // The pager lists the first few pages and the last two, so its highest number is the last page.
    const pages = host.select(first, "ul.pagination a")
      .map((a) => Number((String(a.attrs.href || "").match(/[?&]page=(\d+)/) || [])[1]))
      .filter((n) => n > 0);
    const last = Math.min(pages.length ? Math.max(...pages) : 1, 500);
    const htmls = [first];
    for (let p = 2; p <= last; p++) htmls.push(await get(`${base}?page=${p}`));

    const chapters = [];
    const seen = new Set();
    for (const html of htmls) {
      for (const a of host.select(html, "ul.chapter-list li a")) {
        const m = String(a.attrs.href || "").match(/\/book\/[^/]+\/([^/?#]+)/);
        if (!m || seen.has(m[1])) continue;
        seen.add(m[1]);
        const name = decode((host.select(a.outerHTML, ".chapter-title")[0] || {}).text || a.attrs.title || a.text);
        const no = number((host.select(a.outerHTML, ".chapter-no")[0] || {}).text);
        const time = host.select(a.outerHTML, "time")[0];
        const when = time && /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(time.attrs.datetime || "");
        chapters.push({
          id: m[1],
          title: name,
          number: no ?? number((m[1].match(/chapter-(\d+(?:-\d+)?)/) || [])[1]),
          publishedAt: when ? `${when[1]}T${when[2]}Z` : undefined,
        });
      }
    }
    return chapters;
  },

  async getChapterContent(id, chapterId) {
    const html = await get(`${BASE}/book/${encodeURIComponent(id)}/${encodeURIComponent(chapterId)}`);
    const content = host.select(html, "#content")[0];
    if (!content) throw new Error("Couldn't find the chapter text on NovelFire.");
    const body = content.html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<iframe[\s\S]*?<\/iframe>/gi, "")
      .replace(/<ins[\s\S]*?<\/ins>/gi, "")
      .replace(/<div[^>]*class="[^"]*\b(?:nf-ads|ads?)\b[^"]*"[^>]*>[\s\S]*?<\/div>/gi, "")
      .trim();
    if (!body) throw new Error("This chapter is empty on NovelFire.");
    return { type: "text", html: body };
  },

  idFromURL(url) {
    if (!/^https?:\/\/(www\.)?novelfire\.net\//.test(url)) return null;
    return slugFrom(url);
  },
};
