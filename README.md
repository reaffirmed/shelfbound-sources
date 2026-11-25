# Shelfbound Sources

My source repo for Shelfbound. Add it in the app under **Browse → Add repository** with:

```
https://reaffirmed.github.io/shelfbound-sources/
```

| Source | Kind | Rating | Notes |
| --- | --- | --- | --- |
| Weeb Central | Manga, manhwa, manhua | Mature | Adult series only show when Settings → Show sources rated up to is Explicit |
| Archive of Our Own | Fic | Explicit | Needs Settings → Show sources rated up to set to Explicit. One request every 3 seconds. Sign in under Settings → Accounts for restricted works, your bookmarks, Marked for Later, history and subscriptions, and Mark for Later, Subscribe and Kudos on a work's page |

## How publishing works

Every push to `main` runs `.github/workflows/publish.yml`: it runs the offline tests, builds and signs
`dist/` with the key in the `SHELF_SIGNING_KEY` secret, and publishes it to GitHub Pages. The app
checks the repo when you open Browse and offers **Update** for any source whose version went up.

To change a source: edit `sources/<name>/main.js`, bump `version` in its `manifest.json`, push.

To add a source: add `sources/<name>/manifest.json` and `main.js` (see
`examples/repo-template/README.md` in the app repo for the API), plus tests in `test/`.

## Local commands

```sh
npm install
npm test                                                     # offline, against test/fixtures/
npm run run-source -- sources/weebcentral search "solo leveling" 1   # live
npm run build                                                # needs signing.key or $SHELF_SIGNING_KEY
```

`tools/shelf-repo` is a copy of the app repo's `sdk/shelf-repo`.

## The signing key

The app pins the repo's public key the first time you add it. Keep `signing.key` out of git
(it's in `.gitignore`) and only in the `SHELF_SIGNING_KEY` secret. If the key changes, the app
refuses the repo until you remove it and add it again.

## Weeb Central notes

The source reads the HTML fragments the site's own front end loads:
`/search/data`, `/series/<ID>`, `/series/<ID>/full-chapter-list` and
`/chapters/<ID>/images?reading_style=long_strip`. Page images come from rotating mirror hosts
(`*.planeptune.us`, `*.lastation.us`, `*.lowee.us`, `*.leanbox.us`, `*.compsci88.com`). If chapters
stop loading because a new mirror appears, add its domain to `sources/weebcentral/manifest.json`
and bump the version.
