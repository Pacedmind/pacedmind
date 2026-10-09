# PacedMind website

The public home page: a static Next.js site, separate from the desktop app. It has its own dependencies, and `npm run build` writes plain files to `out/`. On Windows, `next build` writes the router's prefetch files as nested folders; `scripts/postbuild.mjs`, which `npm run build` runs after it, renames them to the dotted names browsers ask for, as the docs' build does.

```bash
cd site
npm install
npm run dev      # http://127.0.0.1:4330
npm run build    # static files in out/
```

The site runs at https://pacedmind.com, with the docs (`../docs`, also a static export) at `/docs` on the same domain. The server setup and the deploy script for both are in the repository's `deploy/` (see `deploy/Caddyfile`), and `deploy/README.md` here has the steps for Google Search Console and Bing Webmaster Tools. Any static host works if it does what the Caddyfile does: serve `{path}.html` for `{path}`, answer unknown addresses with `404.html` and a 404 status, and redirect `www` and `http://` to `https://pacedmind.com`. The download buttons point at `/download/windows` and `/download/mac`, which lead to the installers that `npm run release` (in the repository's root) builds and uploads.

## Prices

There are two plans. One device is free and needs no account. Cloud costs the same as Spotify Premium Individual in each country (in India, where that plan is called Premium Standard) and starts with 7 days free. The prices are in `prices.json`. Visitors see the prices for their country, guessed from their time zone and then their browser language, and can pick another country. Anyone else sees the US price. The page itself never names Spotify: it says "a music subscription".

Check the prices regularly:

```bash
npm run prices              # compares prices.json with spotify.com; exits with 1 if a price changed
npm run prices -- --write   # also saves the new prices and today's date
```

A change of more than 40% is never saved, because it more likely means the page was misread: check that country by hand. To add a country, add it to `prices.json` with `"amount": 0` and run with `--write`.

A year of Cloud costs `yearlyMonths` (in `prices.json`) times the monthly price. The payments use the same numbers: `npm run stripe:prices` in the repository's root makes the payment provider's prices match `prices.json`, so run it after saving new prices. Until billing launches, `SITE.cloudOpen` in `lib/site.ts` is off and the Cloud card says "Coming soon"; switched on, it links to creating an account (`SITE.createAccount`) and the copy stops saying Cloud is coming.

`/subscribed` is where the payment and billing pages send someone from the desktop app back to (its own server only answers its window). It isn't in the sitemap, and tells search engines not to index it.

## Search and answer engines

- The page's words live in `lib/content.ts`, which the page, `/llms.txt`, `/llms-full.txt` and the structured data all read, so they can't drift apart (the hero and the pricing heading are still written out in `app/page.tsx` too). The FAQ there is shown on the page and repeated in its FAQPage data word for word; never add a question to one without the other. The entity is always "PacedMind".
- The FAQ's price question and llms.txt say what the pricing section says (`COST` in `lib/content.ts`). In the JSON-LD, the SoftwareApplication offers One device at a price of 0. Cloud gets no Offer: its price differs by country, and one Offer can't state that.
- Every page that should be found gets its canonical URL, link preview and robots tag from `pageMetadata()` in `lib/seo.ts`. URLs have no trailing slash, and `SITE.url` in `lib/site.ts` is the one origin.
- `lib/seo.ts` also builds the JSON-LD: Organization and WebSite on every page, SoftwareApplication, SoftwareSourceCode and FAQPage on the home page, joined by stable `@id`s. The docs point at the same ids (`https://pacedmind.com/#organization`, `#website`, `#software`) rather than describe PacedMind again.
- `app/sitemap.ts` lists this site's pages, dated by the last commit that changed them (build from a checkout with its history). `app/robots.ts` is the only robots.txt crawlers read for the whole domain: it names both sitemaps, and repeats any rule the docs app adds, with the `/docs` prefix. The docs disallow nothing: assistants read `/docs/llms.mdx/` and link previews fetch `/docs/og/`, and the server sends `X-Robots-Tag: noindex` for the Markdown copies instead.
- `/llms.txt` introduces PacedMind for assistants and links the docs' `/docs/llms.txt` and `/docs/llms-full.txt`; `/llms-full.txt` has the page as text, with Cloud's planned price in every country.
- Performance: only Jost's Latin file is preloaded, the CSS is inlined into the HTML (`next.config.mjs`), and the page's images are imported, so their URLs carry a content hash and can be cached for a year.

## Visitor statistics

Umami counts visits without cookies (the repository's `deploy/README.md`, step 5). `components/analytics.tsx` loads its tracker from `/stats/script.js` on pacedmind.com only, so `npm run dev` and local builds count nothing, and only once `SITE.analytics.websiteId` in `lib/site.ts` is set. The docs use the same website id. A link with `downloadEvent()`'s attributes is also counted as a `Download` event when clicked: give any new download button one.

## Open source

The header links to the repository on GitHub, and so does the open-source section (`#open-source`, words in `OPEN_SOURCE` in `lib/content.ts`), with the commands that build the app. The hero's "Open source." leads there. The repository's name is `SITE.repo` in `lib/site.ts`.

The site does not display or fetch the repository's star count. Phones show the GitHub mark without the word.

## Design

- The page is set in Jost, a geometric face that matches the wordmark; the app's pieces drawn on the page (the day strip, the command palette's results) and the commands to copy use the app's own Geist. The accent is the app's navy, only on the primary download button. Light and dark follow the visitor's system.
- The hero's screens are screenshots of the app's Today, week calendar and Timeline, in light and dark (`screens/`, WebP): `npm run screenshots -- site` in the repository's root takes them again from the app's sample data at 10:40 today. Retake them when the app's look changes. `components/screens/parts.tsx` has the app's icons and colors for the drawn pieces.
- `#connect`, right under the hero, and `/connect` connect an agent to PacedMind Cloud's MCP server: a tab per agent (`CONNECT` in `lib/content.ts`) with its commands to copy, its install button (Cursor's and VS Code's links) or the server's address, and what happens next. The hero's links to one agent land on its tab (`#connect-<id>`). Keep the commands the same as the app's Settings → Connect your agents (`src/server/connect.ts`) and the docs (`docs/content/docs/mcp/connect-cloud.mdx`).
- Between the hero and the pricing, the page tells one day, and the widgets share its tasks and times (listed in `lib/content.ts` above `DAY`): the day strip (`#day`) plays it, the departures board (`#agents`) shows its sessions, and the command palette (`#try`) shows what its commands do in it. Change the day in all of them together. Nothing in it starts by itself, as in the app: you start every session, from its task or by asking an agent in a chat, and a task that waits for another comes after it. Each widget plays only while it's on screen and the tab is visible, and shows a still frame with reduced motion or without scripts.
- `components/day-strip.tsx` plays the day as a score: your line on top, a line per agent, a playhead, and the checks PacedMind books flying onto your line as sessions finish. A fermata holds over a task that's ready until you start it. It plays once when first seen; the pace, the play button and the hours (drag them, or use the arrow keys) are the visitor's.
- `components/departures-board.tsx` is a split-flap board of the day's sessions: where each runs and what's next. One session moves on every few seconds; the Pause button stops it. It stays black in both themes.
- `components/screen-deck.tsx` shows the screens in 3D, one in front and the other behind it (more would spread evenly between the two). Each holds the front for six seconds (the line under its tab shows the time left), then steps back as the next comes forward. Hovering pauses it, picking a tab stops it, and the arrow keys move between tabs. With reduced motion it neither cycles nor animates.

## Brand assets

- `public/brand/wordmark.png` is the approved wordmark (the app's `public/brand/pacedmind-wordmark.png`), cropped to the letters with the ink as alpha, so the page can draw it in any color. `lib/brand.ts` has the letter bounds and the intro timing: the page opens on the pd emblem, then the last d travels right and the letters appear as it passes them.
- `public/brand/emblem.svg`, `app/icon.svg`, `app/favicon.ico` and `app/apple-icon.png` are the pd emblem. So are `public/icon-192.png` and `public/icon-512.png`, for the web manifest and the Organization logo, rendered by the app's `scripts/make-icons.mjs` (the 512 is the app's `public/brand/pacedmind-emblem.png`).
- `app/opengraph-image.png` is the link preview: the wordmark and "Find your pace." in Jost Light, 1200×630.
