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
  const params = [
    ["work_search[query]", query],
    ["work_search[sort_column]", one("sort") || "_score"],
    ["work_search[sort_direction]", "desc"],
    ["work_search[complete]", one("complete")],
    ["work_search[rating_ids]", one("rating")],
    ["work_search[language_id]", f.language ? one("language") : "en"],
    ["work_search[excluded_tag_names]", (f.exclude || []).join(",")],
    ["work_search[crossover]", f.nocrossovers && f.nocrossovers.length ? "F" : ""],
    ["work_search[revised_at]", (extra && extra.revised) || ""],
    ["page", String(pageNumber || 1)],
    ["commit", "Search"],
  ];
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
    return FILTERS;
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
