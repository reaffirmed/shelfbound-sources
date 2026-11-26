// Weeb Central (weebcentral.com). The site renders HTML fragments for its own
// htmx front end, and this source reads the same fragments:
//
//   search    /search/data?text=…&limit=…&offset=…   cards with a /series/<ID>/<slug> link
//   work      /series/<ID>                             h1 title, an info list, a description
//   chapters  /series/<ID>/full-chapter-list           /chapters/<ID> links, newest first
//   pages     /chapters/<ID>/images?…long_strip        one <img> per page
//
// Series and chapter IDs are 26-character ULIDs. Page images come from rotating
// mirror hosts, which is why the manifest allows several wildcard domains.

const BASE = "https://weebcentral.com";
const PAGE_SIZE = 32;
const ID = /[0-9A-HJKMNP-TV-Z]{26}/;
const REFERER = { Referer: BASE + "/" };

const SORTS = [
  ["Best Match", "Best match"],
  ["Popularity", "Popularity"],
  ["Latest Updates", "Latest updates"],
  ["Recently Added", "Recently added"],
  ["Alphabet", "A to Z"],
  ["Subscribers", "Subscribers"],
];
const TYPES = ["Manga", "Manhwa", "Manhua", "OEL"];
const STATUSES = ["Ongoing", "Complete", "Hiatus", "Canceled"];
// The fallback genre list, used when the site's search page can't be read. The search page
// itself has the full list, including genres rated for adults.
const GENRES = [
  "Action", "Adventure", "Comedy", "Doujinshi", "Drama", "Fantasy", "Gender Bender",
  "Historical", "Horror", "Isekai", "Josei", "Martial Arts", "Mecha", "Mystery", "Psychological",
  "Romance", "School Life", "Sci-fi", "Seinen", "Shoujo", "Shoujo Ai", "Shounen", "Shounen Ai",
  "Slice of Life", "Sports", "Supernatural", "Tragedy", "Yaoi", "Yuri",
];

// Genres rated for adults are recognised by a short hash of their lowercased name, so the
// names don't have to be written out here. They only show when the person allows explicit
// sources.
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

let siteGenres = null;
let genresTried = false;

/** The genre checkboxes from the site's search page. Each has a hidden input "tag-<name>-value". */
async function genreList() {
  if (siteGenres || genresTried) return siteGenres || GENRES;
  genresTried = true;
  try {
    const html = await get(`${BASE}/search`);
    const found = [];
    for (const input of host.select(html, "input")) {
      if (!/^tag-.+-value$/.test(input.attrs.id || "")) continue;
      const name = decode(input.attrs.value || "").trim();
      if (name && !NEVER_KEYS.has(genreKey(name)) && !found.includes(name)) found.push(name);
    }
    if (found.length >= 10) siteGenres = found;
  } catch (_) {
    // Use the built-in list.
  }
  return siteGenres || GENRES;
}

const decode = (s) =>
  String(s ?? "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'")
    .replace(/\s+/g, " ").trim();

const escapeHTML = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function seriesID(href) {
  const m = String(href ?? "").match(new RegExp("/series/(" + ID.source + ")"));
  return m ? m[1] : null;
}

async function get(url) {
  const res = await host.fetch({ url, headers: REFERER });
  if (res.status === 404) throw new Error("Weeb Central doesn't have that page any more.");
  if (res.status < 200 || res.status >= 300) throw new Error(`Weeb Central answered ${res.status}.`);
  return res.body;
}

function formatFor(type) {
  switch ((type || "").toLowerCase()) {
    case "manga": return "manga";
    case "manhua": return "manhua";
    case "oel": return "comic";
    case "manhwa": return "manhwa";
    default: return undefined;
  }
}

// Text of a labelled row, e.g. "Status:" -> "Complete". `rows` are host.select results
// whose text starts with the label.
function field(rows, label) {
  const row = rows.find((r) => r.text.toLowerCase().startsWith(label.toLowerCase()));
  return row ? row.text.slice(label.length).replace(/^\s*:?\s*/, "").trim() : null;
}

const list = (s) => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : []);

function adultAllowed() {
  return host.settings.get("maxRating") === "explicit";
}

// Browse lists, read from the same search endpoint with an empty query.
const LISTINGS = [
  { id: "latest", title: "Freshly updated", subtitle: "Newest chapters first", sort: "Latest Updates" },
  { id: "popular", title: "Trending", subtitle: "Most popular right now", sort: "Popularity" },
  { id: "subscribers", title: "Best of all time", subtitle: "Most subscribers", sort: "Subscribers" },
  { id: "added", title: "Recently added", subtitle: "New to Weeb Central", sort: "Recently Added" },
];

globalThis.source = {
  async getListings() {
    return LISTINGS.map(({ id, title, subtitle }) => ({ id, title, subtitle }));
  },

  async getListing(id, page) {
    const listing = LISTINGS.find((l) => l.id === id);
    if (!listing) throw new Error("Unknown list: " + id);
    return globalThis.source.search("", page, { sort: [listing.sort] });
  },

  async getFilters() {
    const basic = [
      { id: "sort", label: "Sort by", type: "select", options: SORTS.map(([id, label]) => ({ id, label })), default: ["Best Match"] },
      { id: "type", label: "Type", type: "multi", options: TYPES.map((t) => ({ id: t, label: t })) },
      { id: "status", label: "Status", type: "multi", options: STATUSES.map((s) => ({ id: s, label: s })) },
      { id: "official", label: "Official translations only", type: "toggle" },
    ];
    // Apps before 0.4 only show select, multi and toggle.
    if (!(host.filterTypes || []).includes("tags")) return basic;
    const genres = (await genreList()).filter((g) => adultAllowed() || !ADULT_KEYS.has(genreKey(g)));
    return [
      { ...basic[0], group: "Sort" },
      {
        id: "order", label: "Order", type: "select", default: [""], group: "Sort",
        options: [{ id: "", label: "Usual order" }, { id: "Descending", label: "Descending" }, { id: "Ascending", label: "Ascending" }],
      },
      { ...basic[1], group: "Series" },
      { ...basic[2], group: "Series" },
      { ...basic[3], group: "Series" },
      {
        id: "anime", label: "Anime adaptation", type: "select", default: [""], group: "Series",
        options: [{ id: "", label: "Any" }, { id: "True", label: "Has an anime" }, { id: "False", label: "No anime" }],
      },
      {
        id: "genres", label: "Genres", type: "tags", group: "Genres", excludable: true, workField: "tags",
        placeholder: "Start typing a genre", options: genres.map((g) => ({ id: g, label: g })),
      },
    ];
  },

  async search(query, page, filters) {
    filters = filters || {};
    const q = String(query ?? "").trim();
    const sort = (filters.sort || [])[0] || (q ? "Best Match" : "Popularity");
    const params = [
      ["text", q],
      ["limit", PAGE_SIZE],
      ["offset", ((page || 1) - 1) * PAGE_SIZE],
      ["sort", sort],
      ["order", (filters.order || [])[0] || (sort === "Alphabet" ? "Ascending" : "Descending")],
      ["official", (filters.official || [])[0] === "true" ? "True" : "Any"],
      ["anime", (filters.anime || [])[0] || "Any"],
      ["adult", adultAllowed() ? "Any" : "False"],
      ["display_mode", "Full Display"],
    ];
    for (const t of filters.type || []) params.push(["included_type", t]);
    for (const s of filters.status || []) params.push(["included_status", s]);
    for (const g of filters.genres || []) params.push(["included_tag", g]);
    for (const g of filters["genres.exclude"] || []) params.push(["excluded_tag", g]);
    const qs = params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");

    const html = await get(`${BASE}/search/data?${qs}`);
    const results = [];
    for (const card of host.select(html, "article.bg-base-300")) {
      const links = host.select(card.outerHTML, "a");
      const id = links.map((a) => seriesID(a.attrs.href)).find(Boolean);
      if (!id || results.some((r) => r.id === id)) continue;
      // The second section holds one div per detail: the title, then "Year:", "Status:", "Type:", ...
      const rows = host.select(card.outerHTML, "section > div");
      const titleLink = links.find((a) => seriesID(a.attrs.href) && /\blink-hover\b/.test(a.attrs.class || ""));
      const title = titleLink ? titleLink.text : (host.select(card.outerHTML, "img")[0]?.attrs.alt || "").replace(/ cover$/, "");
      const type = field(rows, "Type");
      results.push({
        id,
        title: decode(title),
        authors: links.filter((a) => /[?&]author=/.test(a.attrs.href || "")).map((a) => decode(a.text)),
        coverURL: `https://temp.compsci88.com/cover/fallback/${id}.jpg`,
        format: formatFor(type),
        tags: list(field(rows, "Tag(s)")),
      });
    }
    return { results, hasMore: results.length >= PAGE_SIZE };
  },

  async getWork(id) {
    const html = await get(`${BASE}/series/${id}`);
    const rows = host.select(html, "section ul li");
    const title = decode((host.select(html, "h1")[0] || {}).text);
    const type = field(rows, "Type");
    const adult = (field(rows, "Adult Content") || "").toLowerCase() === "yes";
    const description = (host.select(html, "li p")[0] || {}).text || "";
    const status = field(rows, "Status");
    const links = host.select(html, "li a");
    return {
      id,
      title,
      authors: links.filter((a) => /[?&]author=/.test(a.attrs.href || "")).map((a) => decode(a.text)),
      coverURL: `https://temp.compsci88.com/cover/fallback/${id}.jpg`,
      summaryHTML: description ? `<p>${escapeHTML(decode(description))}</p>` : null,
      url: `${BASE}/series/${id}`,
      format: formatFor(type),
      rating: adult ? "Mature" : "General Audiences",
      tags: links.filter((a) => /[?&]included_tag=/.test(a.attrs.href || "")).map((a) => decode(a.text)),
      status: status || undefined,
      language: "English",
    };
  },

  async getChapters(id) {
    const html = await get(`${BASE}/series/${id}/full-chapter-list`);
    const chapters = [];
    for (const a of host.select(html, "a")) {
      const m = (a.attrs.href || "").match(new RegExp("/chapters/(" + ID.source + ")"));
      if (!m || chapters.some((c) => c.id === m[1])) continue;
      const name = decode((host.select(a.outerHTML, "span.grow > span")[0] || {}).text) || decode(a.text);
      // "Chapter 12.5", "S2 - Chapter 80", "Episode 3": take the number after the word,
      // falling back to the last number in the name.
      const num = name.match(/(?:chapter|ch\.?|episode|ep\.?|page)\s*(\d+(?:\.\d+)?)/i) || name.match(/(\d+(?:\.\d+)?)(?!.*\d)/);
      const time = host.select(a.outerHTML, "time")[0];
      chapters.push({
        id: m[1],
        title: name,
        number: num ? Number(num[1]) : undefined,
        publishedAt: time ? time.attrs.datetime : undefined,
      });
    }
    return chapters.reverse(); // the site lists newest first
  },

  async getChapterContent(id, chapterId) {
    const html = await get(`${BASE}/chapters/${chapterId}/images?is_prev=False&current_page=1&reading_style=long_strip`);
    const pages = host.select(html, "img")
      .map((img) => img.attrs.src)
      .filter((src) => src && /^https:\/\//.test(src) && !src.includes("/static/"))
      .map((url) => ({ url, headers: REFERER }));
    if (!pages.length) throw new Error("This chapter has no pages on Weeb Central.");
    return { type: "images", pages };
  },

  idFromURL(url) {
    if (!/^https?:\/\/(www\.)?weebcentral\.com\//.test(url)) return null;
    return seriesID(url);
  },
};
