// Archive of Our Own. Works without an account; when the person signs in to AO3 in the
// app (Settings > Accounts), the app keeps AO3's session cookie and sends it with every
// request, and passes the username as host.settings.get("account"). Signed in, the source
// also reads works restricted to registered users, the person's bookmarks, Marked for
// Later, history and subscriptions, and can mark for later, subscribe and leave kudos.
// AO3 asks bots to go slowly, so the manifest spaces requests three seconds apart and
// the app backs off further when the site answers 429.

const BASE = "https://archiveofourown.org";
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function first(html, selector) {
  return host.select(html, selector)[0] || null;
}
function texts(html, selector) {
  return host.select(html, selector).map((e) => e.text).filter(Boolean);
}
function number(text) {
  if (!text) return undefined;
  const n = Number(String(text).replace(/[^\d]/g, ""));
  return Number.isFinite(n) && String(text).match(/\d/) ? n : undefined;
}
function pad(n) {
  return n < 10 ? "0" + n : String(n);
}
/** "12 Jan 2024" or "2024-01-12" to an ISO date. */
function date(text) {
  if (!text) return undefined;
  let m = /(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (m) return `${m[1]}-${m[2]}-${m[3]}T00:00:00Z`;
  m = /(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})/.exec(text);
  if (m && MONTHS[m[2].toLowerCase()]) return `${m[3]}-${pad(MONTHS[m[2].toLowerCase()])}-${pad(Number(m[1]))}T00:00:00Z`;
  return undefined;
}

function account() {
  return host.settings.get("account") || null;
}

function slowDown(res) {
  return res.status === 429 || (/Retry later/i.test(res.body) && res.body.length < 2000);
}

async function page(url) {
  const res = await host.fetch(url);
  if (slowDown(res)) throw new Error("AO3 asked us to slow down. Try again in a few minutes.");
  if (res.status === 404) throw new Error("That work was deleted or never existed.");
  if (/\/users\/login/.test(res.url) || /This work is only available to registered users/i.test(res.body)) {
    throw new Error(account()
      ? "AO3 signed you out. Sign in again in Settings > Accounts to read this work."
      : "This work is only for logged-in AO3 users. Sign in to AO3 in Settings > Accounts to read it.");
  }
  if (res.status < 200 || res.status >= 300) throw new Error("HTTP " + res.status + " from AO3");
  return res.body;
}

/** The signed-in username from AO3's page header ("Hi, name!"), or null when logged out. */
function signedInAs(html) {
  const greeting = host.select(html, "#greeting a, ul.user.navigation a")
    .find((a) => /^\/users\//.test(a.attrs.href || "") && /^Hi,/.test(a.text));
  const m = greeting && /^\/users\/([^/?#]+)/.exec(greeting.attrs.href || "");
  return m ? decodeURIComponent(m[1]) : null;
}

function requireAccount() {
  const name = account();
  if (!name) throw new Error("Sign in to AO3 in Settings > Accounts first.");
  return name;
}

/** Rails' CSRF token from a page AO3 rendered for this session. */
function csrfToken(html) {
  const meta = first(html, "meta[name=csrf-token]");
  const input = first(html, "input[name=authenticity_token]");
  const token = (meta && meta.attrs.content) || (input && input.attrs.value);
  if (!token) throw new Error("AO3 didn't give a form token. Sign in again in Settings > Accounts.");
  return token;
}

function form(fields) {
  return fields.map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v)).join("&");
}

async function post(url, fields, token, method) {
  const all = [["authenticity_token", token]].concat(method ? [["_method", method]] : []).concat(fields);
  const res = await host.fetch({
    url,
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-CSRF-Token": token,
      "X-Requested-With": "XMLHttpRequest",
      Accept: "application/json, text/javascript, */*",
      Referer: BASE + "/",
    },
    body: form(all),
  });
  if (slowDown(res)) throw new Error("AO3 asked us to slow down. Try again in a few minutes.");
  if (/\/users\/login/.test(res.url)) throw new Error("AO3 signed you out. Sign in again in Settings > Accounts.");
  return res;
}

/** What the signed-in person has done with a work, read from the work page. */
function workState(html, name) {
  if (!name) return undefined;
  const mark = first(html, "ul.work.navigation li.mark a");
  const subscribe = first(html, "ul.work.navigation li.subscribe input[type=submit], ul.work.navigation li.subscribe button");
  // The kudos list names everyone who left kudos, sometimes cut short; a missing name is unknown.
  const kudosNames = host.select(html, "#kudos a").map((a) => /^\/users\/([^/?#]+)/.exec(a.attrs.href || "")).filter(Boolean).map((m) => m[1]);
  const state = {};
  if (mark) state.markedForLater = /Mark as Read/i.test(mark.text);
  if (subscribe) state.subscribed = /Unsubscribe/i.test(subscribe.attrs.value || subscribe.text);
  if (kudosNames.includes(encodeURIComponent(name)) || kudosNames.includes(name)) state.kudos = true;
  return state;
}

// The person's own lists on AO3. All are public on AO3 except Marked for Later and history.
const ACCOUNT_LISTS = [
  { id: "bookmarks", title: "Bookmarks", subtitle: "Works you bookmarked on AO3", importable: true,
    path: (u) => `/users/${u}/bookmarks`, item: "ol.bookmark.index.group > li.bookmark.blurb" },
  { id: "later", title: "Marked for Later", subtitle: "Your reading list on AO3", importable: true,
    path: (u) => `/users/${u}/readings?show=to-read`, item: "ol.reading.index.group > li.reading.blurb" },
  { id: "history", title: "History", subtitle: "Works you opened on AO3, newest first",
    path: (u) => `/users/${u}/readings`, item: "ol.reading.index.group > li.reading.blurb" },
  { id: "subscriptions", title: "Subscriptions", subtitle: "Works you get update emails for", importable: true,
    path: (u) => `/users/${u}/subscriptions?type=works` },
];

function withPage(path, pageNumber) {
  return path + (path.includes("?") ? "&" : "?") + "page=" + (pageNumber || 1);
}

function subscriptionItems(html) {
  // Subscriptions are a plain list: "<a href=/works/1>Title</a> by <a>author</a>".
  return host.select(html, "dl.subscription.index.group dt").map((dt) => {
    const link = host.select(dt.html, "a").find((a) => /^\/works\/\d+/.test(a.attrs.href || ""));
    if (!link) return null;
    return {
      id: /^\/works\/(\d+)/.exec(link.attrs.href)[1],
      title: link.text,
      authors: host.select(dt.html, "a[rel=author]").map((a) => a.text),
      format: "fic",
    };
  }).filter(Boolean);
}

const FILTERS = [
  {
    id: "sort", label: "Sort", type: "select", default: ["_score"],
    options: [
      { id: "_score", label: "Best match" },
      { id: "kudos_count", label: "Kudos" },
      { id: "revised_at", label: "Updated" },
      { id: "created_at", label: "Posted" },
      { id: "word_count", label: "Words" },
      { id: "hits", label: "Hits" },
      { id: "bookmarks_count", label: "Bookmarks" },
    ],
  },
  {
    id: "complete", label: "Status", type: "select", default: [""],
    options: [
      { id: "", label: "Any status" },
      { id: "T", label: "Complete" },
      { id: "F", label: "In progress" },
    ],
  },
  {
    id: "rating", label: "Rating", type: "select", default: [""],
    options: [
      { id: "", label: "Any rating" },
      { id: "10", label: "General" },
      { id: "11", label: "Teen" },
      { id: "12", label: "Mature" },
      { id: "13", label: "Explicit" },
      { id: "9", label: "Not rated" },
    ],
  },
  {
    id: "language", label: "Language", type: "select", default: ["en"],
    options: [
      { id: "", label: "Any language" },
      { id: "en", label: "English" },
      { id: "es", label: "Español" },
      { id: "fr", label: "Français" },
      { id: "de", label: "Deutsch" },
      { id: "ptBR", label: "Português (BR)" },
      { id: "ru", label: "Русский" },
      { id: "zh", label: "中文" },
      { id: "ja", label: "日本語" },
    ],
  },
  {
    id: "exclude", label: "Hide warnings", type: "multi", default: [],
    options: [
      { id: "Major Character Death", label: "Major character death" },
      { id: "Graphic Depictions Of Violence", label: "Graphic violence" },
      { id: "Rape/Non-Con", label: "Non-con" },
      { id: "Underage Sex", label: "Underage" },
      { id: "Creator Chose Not To Use Archive Warnings", label: "Unwarned" },
    ],
  },
  { id: "nocrossovers", label: "No crossovers", type: "toggle" },
];

// The full set, for apps that can show text, number range and tag filters (0.4 and
// later). Labels of rating, warning, category and language options match how AO3 prints
// them on a work's page, so tapping one of those there searches by it.
const RATINGS = [
  ["10", "General Audiences"], ["11", "Teen And Up Audiences"], ["12", "Mature"], ["13", "Explicit"], ["9", "Not Rated"],
];
const WARNINGS = [
  ["14", "Creator Chose Not To Use Archive Warnings"], ["16", "No Archive Warnings Apply"],
  ["17", "Graphic Depictions Of Violence"], ["18", "Major Character Death"],
  ["19", "Rape/Non-Con"], ["20", "Underage Sex"],
];
const CATEGORIES = [["116", "F/F"], ["22", "F/M"], ["21", "Gen"], ["23", "M/M"], ["2246", "Multi"], ["24", "Other"]];
const LANGUAGES = [
  ["en", "English"], ["es", "Español"], ["fr", "Français"], ["de", "Deutsch"], ["it", "Italiano"],
  ["ptBR", "Português brasileiro"], ["ptPT", "Português europeu"], ["ru", "Русский"], ["uk", "Українська"],
  ["pl", "Polski"], ["cs", "Čeština"], ["hu", "Magyar"], ["nl", "Nederlands"], ["sv", "Svenska"], ["fi", "suomi"],
  ["ca", "Català"], ["tr", "Türkçe"], ["ar", "العربية"], ["zh", "中文-普通话 國語"], ["ja", "日本語"], ["ko", "한국어"],
  ["th", "ไทย"], ["vi", "Tiếng Việt"], ["id", "Bahasa Indonesia"],
];
// Tag fields: filter ID, label, AO3 search field, autocomplete endpoint, work field.
const TAG_FIELDS = [
  ["fandoms", "Fandoms", "fandom_names", "fandom", "fandoms"],
  ["characters", "Characters", "character_names", "character", "characters"],
  ["relationships", "Relationships", "relationship_names", "relationship", "relationships"],
  ["freeforms", "Additional tags", "freeform_names", "freeform", "tags"],
];
// Number ranges: filter ID, label, AO3 search field, unit.
const RANGES = [
  ["words", "Words", "word_count", "words"],
  ["kudos", "Kudos", "kudos_count", ""],
  ["hits", "Hits", "hits", ""],
  ["bookmarks", "Bookmarks", "bookmarks_count", ""],
  ["comments", "Comments", "comments_count", ""],
];
const UPDATED = [
  ["", "Any time"], ["< 1 week", "Past week"], ["< 1 month", "Past month"],
  ["< 6 months", "Past 6 months"], ["< 1 year", "Past year"], ["> 1 year", "Over a year ago"],
];
const opts = (pairs) => pairs.map(([id, label]) => ({ id, label }));

const FULL_FILTERS = [
  { ...FILTERS[0], group: "Sort" },
  {
    id: "direction", label: "Order", type: "select", default: ["desc"], group: "Sort",
    options: [{ id: "desc", label: "Highest or newest first" }, { id: "asc", label: "Lowest or oldest first" }],
  },
  { ...FILTERS[1], group: "Work" },
  {
    id: "rating", label: "Rating", type: "select", default: [""], group: "Work", workField: "rating",
    options: [{ id: "", label: "Any rating" }].concat(opts(RATINGS)),
  },
  {
    id: "crossover", label: "Crossovers", type: "select", default: [""], group: "Work",
    options: [{ id: "", label: "Include crossovers" }, { id: "F", label: "No crossovers" }, { id: "T", label: "Only crossovers" }],
  },
  { id: "oneshot", label: "Single chapter only", type: "toggle", group: "Work" },
  {
    id: "language", label: "Language", type: "select", default: ["en"], group: "Work", workField: "language",
    options: [{ id: "", label: "Any language" }].concat(opts(LANGUAGES)),
  },
  {
    id: "updated", label: "Updated", type: "select", default: [""], group: "Work",
    options: opts(UPDATED),
  },
  ...TAG_FIELDS.map(([id, label, , , workField]) => ({
    id, label, type: "tags", group: "Tags", excludable: true, suggests: true, workField,
    placeholder: "Start typing a " + (id === "freeforms" ? "tag" : label.toLowerCase().replace(/s$/, "")),
  })),
  {
    id: "warnings", label: "Warnings", type: "tags", group: "Tags", excludable: true, workField: "warnings",
    options: opts(WARNINGS.map(([, name]) => [name, name])),
  },
  { id: "categories", label: "Categories", type: "multi", group: "Tags", workField: "categories", options: opts(CATEGORIES) },
  { id: "othertags", label: "Any other tag", type: "tags", group: "Tags", excludable: true, suggests: true,
    placeholder: "Any AO3 tag" },
  ...RANGES.map(([id, label, , unit]) => ({ id, label, type: "range", group: "Stats", placeholder: unit || undefined })),
  { id: "title", label: "Title", type: "text", group: "More", placeholder: "Words in the title" },
  { id: "creators", label: "Author", type: "text", group: "More", placeholder: "Pseud or username" },
];

// Date ranges, for apps that can show them (0.5.6 and later): filter ID, label, AO3's
// search field. AO3's search box takes Elasticsearch ranges like
// revised_at:[2024-01-01 TO 2024-06-30], with * for an open end.
const DATES = [
  ["updatedBetween", "Updated", "revised_at"],
  ["postedBetween", "Posted", "created_at"],
];
const DATE_FILTERS = DATES.map(([id, label]) => ({ id, label, type: "date", group: "Dates", placeholder: label.toLowerCase() }));

/** True when the app can show the full set of filters. */
function fullFilters() {
  const kinds = host.filterTypes || [];
  return ["text", "range", "tags"].every((k) => kinds.includes(k));
}

function dateFilters() {
  return (host.filterTypes || []).includes("date");
}

/** ["2024-01-01", ""] to "revised_at:[2024-01-01 TO *]", or "" with no dates. */
function dateQuery(field, pair) {
  const [from, to] = (pair || []).map((v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : ""));
  if (!from && !to) return "";
  const [a, b] = from && to && from > to ? [to, from] : [from, to];
  return `${field}:[${a || "*"} TO ${b || "*"}]`;
}

/** "1000"-"5000" to "1000-5000", "1000"-"" to ">999", ""-"5000" to "<5001". */
function rangeQuery(pair) {
  const [min, max] = (pair || []).map((v) => (/^\d+$/.test(String(v || "")) ? Number(v) : null));
  if (min != null && max != null) return `${Math.min(min, max)}-${Math.max(min, max)}`;
  if (min != null) return `>${Math.max(min - 1, 0)}`;
  if (max != null) return `<${max + 1}`;
  return "";
}

// Browse lists. AO3 has no trending page, so "Popular this week" is the most kudos
// among works updated in the last week.
const LISTINGS = [
  { id: "updated", title: "Freshly updated", subtitle: "Newest chapters first", sort: "revised_at" },
  { id: "week", title: "Popular this week", subtitle: "Most kudos, updated in the last 7 days", sort: "kudos_count", revised: "< 1 week" },
  { id: "kudos", title: "Best of all time", subtitle: "Most kudos ever", sort: "kudos_count" },
  { id: "new", title: "Just posted", subtitle: "Brand-new works", sort: "created_at" },
];

function searchURL(query, pageNumber, filters, extra) {
  const f = filters || {};
  const one = (id) => (f[id] && f[id][0]) || "";
  const all = (id) => (f[id] || []).map((v) => String(v).trim()).filter(Boolean);
  // Tag names can hold commas only rarely; AO3 takes a comma-separated list.
  const names = (id) => all(id).join(",");

  const excluded = all("exclude");
  for (const [id] of TAG_FIELDS) excluded.push(...all(id + ".exclude"));
  excluded.push(...all("warnings.exclude"), ...all("othertags.exclude"));
  const warningID = Object.fromEntries(WARNINGS.map(([id, name]) => [name, id]));

  const dateTerms = DATES.map(([id, , field]) => dateQuery(field, f[id])).filter(Boolean);
  const params = [
    ["work_search[query]", [String(query || "").trim()].concat(dateTerms).filter(Boolean).join(" ")],
    ["work_search[title]", one("title")],
    ["work_search[creators]", one("creators")],
    ["work_search[sort_column]", one("sort") || "_score"],
    ["work_search[sort_direction]", one("direction") === "asc" ? "asc" : "desc"],
    ["work_search[complete]", one("complete")],
    ["work_search[rating_ids]", one("rating")],
    ["work_search[language_id]", f.language ? one("language") : "en"],
    ["work_search[crossover]", f.nocrossovers && f.nocrossovers.length ? "F" : one("crossover")],
    ["work_search[single_chapter]", f.oneshot && f.oneshot.length ? "1" : ""],
    ["work_search[revised_at]", (extra && extra.revised) || one("updated")],
  ];
  for (const [id, , field] of TAG_FIELDS) params.push([`work_search[${field}]`, names(id)]);
  params.push(["work_search[other_tag_names]", names("othertags")]);
  params.push(["work_search[excluded_tag_names]", [...new Set(excluded)].join(",")]);
  for (const name of all("warnings")) {
    if (warningID[name]) params.push(["work_search[archive_warning_ids][]", warningID[name]]);
  }
  for (const id of all("categories")) params.push(["work_search[category_ids][]", id]);
  for (const [id, , field] of RANGES) params.push([`work_search[${field}]`, rangeQuery(f[id])]);
  params.push(["page", String(pageNumber || 1)], ["commit", "Search"]);
  return `${BASE}/works/search?` + params.map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v)).join("&");
}

function blurb(item) {
  const html = item.html;
  const title = first(html, "h4.heading a");
  const m = title && /\/works\/(\d+)/.exec(title.attrs.href || "");
  if (!m) return null;
  const rating = first(html, "ul.required-tags span.rating");
  const summary = first(html, "blockquote.userstuff.summary");
  return {
    id: m[1],
    title: title.text,
    authors: texts(html, "h4.heading a[rel=author]"),
    blurb: summary ? summary.text : undefined,
    format: "fic",
    fandoms: texts(html, "h5.fandoms a.tag"),
    rating: rating ? rating.attrs.title || rating.text : undefined,
    tags: texts(html, "ul.tags li.relationships a.tag").concat(texts(html, "ul.tags li.freeforms a.tag")).slice(0, 8),
    wordCount: number((first(html, "dl.stats dd.words") || {}).text),
    chapterCount: (first(html, "dl.stats dd.chapters") || {}).text,
    kudos: number((first(html, "dl.stats dd.kudos") || {}).text),
    updatedAt: date((first(html, "p.datetime") || {}).text),
  };
}

function seriesParts(html) {
  return host.select(html, "dd.series span.position").map((pos) => {
    const link = first(pos.html, "a");
    const part = /Part\s+(\d+)/i.exec(pos.text);
    const id = link && /\/series\/(\d+)/.exec(link.attrs.href || "");
    return {
      title: link ? link.text : pos.text,
      part: part ? Number(part[1]) : undefined,
      id: id ? id[1] : undefined,
      url: id ? `${BASE}/series/${id[1]}` : undefined,
    };
  });
}

globalThis.source = {
  // For importing links: https://archiveofourown.org/works/123/chapters/456 → "123".
  async idFromURL(url) {
    const m = /archiveofourown\.org\/works\/(\d+)/.exec(url);
    return m ? m[1] : null;
  },

  async getFilters() {
    if (!fullFilters()) return FILTERS;
    return dateFilters() ? FULL_FILTERS.concat(DATE_FILTERS) : FULL_FILTERS;
  },

  // Tag names as you type, from AO3's own autocomplete.
  async suggest(filterID, text) {
    const field = TAG_FIELDS.find(([id]) => id === filterID);
    const kind = field ? field[3] : filterID === "othertags" ? "tag" : null;
    const term = String(text || "").trim();
    if (!kind || term.length < 2) return [];
    const res = await host.fetch({
      url: `${BASE}/autocomplete/${kind}?term=${encodeURIComponent(term)}`,
      headers: { Accept: "application/json", "X-Requested-With": "XMLHttpRequest" },
    });
    if (slowDown(res) || res.status < 200 || res.status >= 300) return [];
    let list;
    try { list = JSON.parse(res.body); } catch { return []; }
    return (Array.isArray(list) ? list : [])
      .map((t) => (t && (t.name || t.id) ? { id: String(t.name || t.id), label: String(t.name || t.id) } : null))
      .filter(Boolean)
      .slice(0, 20);
  },

  async getListings() {
    return LISTINGS.map(({ id, title, subtitle }) => ({ id, title, subtitle }));
  },

  async getListing(id, pageNumber) {
    const listing = LISTINGS.find((l) => l.id === id);
    if (!listing) throw new Error("Unknown list: " + id);
    return globalThis.source.search("", pageNumber, { sort: [listing.sort] }, { revised: listing.revised });
  },

  async search(query, pageNumber, filters, extra) {
    const html = await page(searchURL(query, pageNumber, filters, extra));
    const results = host.select(html, "ol.work.index.group > li.work.blurb, ol.index.group > li.blurb.work").map(blurb).filter(Boolean);
    const seen = new Set();
    return {
      results: results.filter((r) => !seen.has(r.id) && seen.add(r.id)),
      hasMore: host.select(html, "ol.pagination li.next a").length > 0,
    };
  },

  async getWork(id) {
    const html = await page(`${BASE}/works/${encodeURIComponent(id)}?view_adult=true`);
    const title = first(html, "h2.title.heading");
    if (!title) throw new Error("Couldn't read that work's page.");
    const summary = first(html, ".preface .summary blockquote.userstuff");
    const updated = first(html, "dl.stats dd.status");
    const chapters = (first(html, "dl.stats dd.chapters") || {}).text;
    const downloads = {};
    for (const a of host.select(html, "li.download ul a")) {
      const href = a.attrs.href || "";
      if (a.text && href) downloads[a.text] = href.startsWith("/") ? BASE + href : href;
    }
    return {
      id,
      title: title.text,
      authors: texts(html, "h3.byline a[rel=author]"),
      summaryHTML: summary ? summary.html : undefined,
      url: `${BASE}/works/${id}`,
      format: "fic",
      rating: texts(html, "dd.rating.tags a.tag")[0],
      warnings: texts(html, "dd.warning.tags a.tag"),
      categories: texts(html, "dd.category.tags a.tag"),
      fandoms: texts(html, "dd.fandom.tags a.tag"),
      relationships: texts(html, "dd.relationship.tags a.tag"),
      characters: texts(html, "dd.character.tags a.tag"),
      tags: texts(html, "dd.freeform.tags a.tag"),
      language: (first(html, "dd.language") || {}).text,
      wordCount: number((first(html, "dl.stats dd.words") || {}).text),
      chapterCount: chapters,
      status: chapters && /^(\d+)\/\1$/.test(chapters.replace(/[\s,]/g, "")) ? "Complete" : "In progress",
      kudos: number((first(html, "dl.stats dd.kudos") || {}).text),
      bookmarks: number((first(html, "dl.stats dd.bookmarks") || {}).text),
      hits: number((first(html, "dl.stats dd.hits") || {}).text),
      publishedAt: date((first(html, "dl.stats dd.published") || {}).text),
      updatedAt: date((updated || {}).text) || date((first(html, "dl.stats dd.published") || {}).text),
      series: seriesParts(html),
      downloads: Object.keys(downloads).length ? downloads : undefined,
      account: workState(html, account()),
    };
  },

  // Signed-in account, from AO3's header. Null when the session cookie is missing or expired.
  async getAccount() {
    const res = await host.fetch(`${BASE}/`);
    if (slowDown(res)) throw new Error("AO3 asked us to slow down. Try again in a few minutes.");
    const name = signedInAs(res.body);
    return name ? { username: name, url: `${BASE}/users/${encodeURIComponent(name)}` } : null;
  },

  async getAccountLists() {
    return ACCOUNT_LISTS.map(({ id, title, subtitle, importable }) => ({ id, title, subtitle, importable: Boolean(importable) }));
  },

  async getAccountList(id, pageNumber) {
    const list = ACCOUNT_LISTS.find((l) => l.id === id);
    if (!list) throw new Error("Unknown list: " + id);
    const name = encodeURIComponent(requireAccount());
    const html = await page(BASE + withPage(list.path(name), pageNumber));
    if (!signedInAs(html)) throw new Error("AO3 signed you out. Sign in again in Settings > Accounts.");
    const results = list.item ? host.select(html, list.item).map(blurb).filter(Boolean) : subscriptionItems(html);
    const seen = new Set();
    return {
      results: results.filter((r) => !seen.has(r.id) && seen.add(r.id)),
      hasMore: host.select(html, "ol.pagination li.next a").length > 0,
    };
  },

  // Marks for later, subscribes or leaves kudos. Only ever called from a tap on the work's
  // page, never from a sync, so the app can't remove anything on AO3 by itself.
  async setWorkState(id, key, value) {
    const name = requireAccount();
    const workURL = `${BASE}/works/${encodeURIComponent(id)}?view_adult=true`;
    const html = await page(workURL);
    const before = workState(html, name) || {};
    if (key === "markedForLater") {
      if (Boolean(before.markedForLater) !== Boolean(value)) {
        await page(`${BASE}/works/${encodeURIComponent(id)}/${value ? "mark_for_later" : "mark_as_read"}`);
      }
    } else if (key === "subscribed") {
      if (Boolean(before.subscribed) !== Boolean(value)) {
        const token = csrfToken(html);
        if (value) {
          const res = await post(`${BASE}/users/${encodeURIComponent(name)}/subscriptions`, [
            ["subscription[subscribable_id]", id], ["subscription[subscribable_type]", "Work"],
          ], token);
          if (res.status >= 400) throw new Error("AO3 didn't subscribe you (HTTP " + res.status + ").");
        } else {
          const action = first(html, "ul.work.navigation li.subscribe form");
          const sub = action && /\/subscriptions\/(\d+)/.exec(action.attrs.action || "");
          if (!sub) throw new Error("Couldn't find your subscription on AO3.");
          const res = await post(`${BASE}/users/${encodeURIComponent(name)}/subscriptions/${sub[1]}`, [], token, "delete");
          if (res.status >= 400) throw new Error("AO3 didn't unsubscribe you (HTTP " + res.status + ").");
        }
      }
    } else if (key === "kudos") {
      if (!value) throw new Error("AO3 doesn't let you take kudos back.");
      if (!before.kudos) {
        const res = await post(`${BASE}/kudos`, [
          ["kudo[commentable_id]", id], ["kudo[commentable_type]", "Work"],
        ], csrfToken(html));
        // 422 means you already left kudos, which is the state we wanted.
        if (res.status >= 400 && res.status !== 422) throw new Error("AO3 didn't take the kudos (HTTP " + res.status + ").");
      }
      return Object.assign({}, before, { kudos: true });
    } else {
      throw new Error("Unknown work action: " + key);
    }
    const after = workState(await page(workURL), name) || {};
    return after;
  },

  async getChapters(id) {
    const html = await page(`${BASE}/works/${encodeURIComponent(id)}/navigate?view_adult=true`);
    const items = host.select(html, "ol.chapter.index.group li");
    const chapters = items.map((li, i) => {
      const a = first(li.html, "a");
      const m = a && /\/chapters\/(\d+)/.exec(a.attrs.href || "");
      if (!m) return null;
      const when = first(li.html, "span.datetime");
      return {
        id: m[1],
        title: a.text.replace(/^\d+\.\s*/, "") || `Chapter ${i + 1}`,
        number: i + 1,
        publishedAt: date(when && when.text),
      };
    });
    return chapters.filter(Boolean);
  },

  async getChapterContent(workID, chapterID) {
    const html = await page(`${BASE}/works/${encodeURIComponent(workID)}/chapters/${encodeURIComponent(chapterID)}?view_adult=true`);
    const text =
      first(html, "#chapters .chapter div.userstuff[role=article]") ||
      first(html, "#chapters > div.userstuff") ||
      first(html, "#chapters div.userstuff");
    if (!text) throw new Error("Couldn't find the chapter text.");
    const body = text.html.replace(/<h3[^>]*class="[^"]*landmark[^"]*"[^>]*>[\s\S]*?<\/h3>/gi, "");
    // Chapter notes, plus the work's own notes on the first chapter.
    const before = host.select(html, "#chapters .chapter .preface .notes blockquote.userstuff, .preface.group > .notes blockquote.userstuff")
      .map((n) => n.html).join("<hr>");
    const after = host.select(html, "#chapters .chapter .end.notes blockquote.userstuff, #work_endnotes blockquote.userstuff")
      .map((n) => n.html).join("<hr>");
    return { type: "text", html: body, notesBefore: before || undefined, notesAfter: after || undefined };
  },
};
