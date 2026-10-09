// The one canonical origin, without www and without a trailing slash. The server redirects
// http:// and www.pacedmind.com here (deploy/).
const url = "https://pacedmind.com";
// The source code's repository on GitHub, public under the GNU AGPL (repoUrl in docs/src/lib/shared.ts
// and REPO in deploy/github-stars.mjs; keep the three in step).
const repo = "Pacedmind/pacedmind";

/** Public addresses: the site, its docs, the web app, the source code and the downloads. */
export const SITE = {
  url,
  // The documentation, a separate app served from the same domain.
  docs: "/docs",
  // The web app, where PacedMind Cloud accounts sign in (it sends visitors without a session to its sign-in page).
  app: "https://app.pacedmind.com",
  // Where Cloud's button leads: the web app's sign-in page, open on creating an account.
  createAccount: "https://app.pacedmind.com/login?create=1",
  // PacedMind Cloud's MCP server, which agents connect to and sign in to with the account (cloudMcpUrl() in the app's
  // src/server/supabase-config.ts).
  mcp: "https://app.pacedmind.com/api/mcp",
  // Who runs PacedMind and PacedMind Cloud, for the terms, privacy policy and refunds (app/terms, app/privacy,
  // app/refunds), as the business register (CEIDG) has it.
  operator: {
    name: "NMD Mikołaj Bednarczyk",
    address: "ul. Warszawska 62 lok. 4, 96-500 Sochaczew, Poland",
    nip: "8371874588",
    regon: "523093293",
    email: "mbednarczyk@preseed.tech",
  },
  // When the terms, privacy policy and refund policy last changed.
  legalUpdated: "30 September 2026",
  // Whether Cloud takes subscriptions yet. Until billing launches the page says "Coming soon"; switch it on together
  // with the database's billing switch (supabase/migrations, private.billing_switch).
  cloudOpen: true,
  // The source code: the repository's name as GitHub's API takes it, its page, and the files the page links to.
  repo,
  source: `https://github.com/${repo}`,
  license: `https://github.com/${repo}/blob/master/LICENSE`,
  contributing: `https://github.com/${repo}/blob/master/CONTRIBUTING.md`,
  // The current installers, which `npm run release` uploads (deploy/Caddyfile leads these to them).
  downloads: {
    windows: `${url}/download/windows`,
    mac: `${url}/download/mac`,
  },
  // Search engine ownership tokens, printed as <meta> tags when set. Leave them empty when the
  // domain is verified through DNS, which also covers every subdomain and protocol.
  verification: {
    google: "", // Google Search Console: the content of google-site-verification
    bing: "", // Bing Webmaster Tools: the content of msvalidate.01
  },
  // Umami, cookieless visitor statistics (deploy/umami), shared with the docs (analytics in
  // docs/src/lib/shared.ts): one website counts the whole domain. The tracker comes from this site
  // (the server passes /stats/* through to Umami) and loads only on this host, so local builds count
  // nothing. websiteId is the website's id in the dashboard at stats.pacedmind.com; empty turns it off.
  analytics: {
    websiteId: "dbfe3125-591a-4b12-bd01-56e61aa753d2",
    script: "/stats/script.js",
    hostname: "pacedmind.com",
  },
} as const;

/** The absolute URL of a path on the site, written the way Next writes the page's canonical link. */
export function absoluteUrl(path: string) {
  return path === "/" ? SITE.url : `${SITE.url}${path}`;
}

/** Makes Umami count a click on a download button as a "Download" event, with the system and where the button is. */
export function downloadEvent(os: "windows" | "mac", place: "hero" | "pricing") {
  return { "data-umami-event": "Download", "data-umami-event-os": os, "data-umami-event-place": place };
}

/** Counts a download started from a script, not a link, as the same "Download" event (the command palette's). */
export function trackDownload(os: "windows" | "mac", place: "palette") {
  (window as { umami?: { track: (event: string, data: Record<string, string>) => void } }).umami?.track("Download", { os, place });
}

/** Makes Umami count a click on a link to the web app as a "Sign in" event, with where the link is. */
export function signInEvent(place: "header" | "footer") {
  return { "data-umami-event": "Sign in", "data-umami-event-place": place };
}

/** Makes Umami count a step of connecting an agent as a "Connect" event: which agent, and copying or installing. */
export function connectEvent(agent: string, step: "copy" | "install") {
  return { "data-umami-event": "Connect", "data-umami-event-agent": agent, "data-umami-event-step": step };
}

/** Makes Umami count a click on a link to the source code as a "GitHub" event, with where the link is. */
export function sourceEvent(place: "header" | "open-source" | "footer") {
  return { "data-umami-event": "GitHub", "data-umami-event-place": place };
}
