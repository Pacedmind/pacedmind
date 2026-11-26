/*
 * Embed mode: a host application shows PacedMind's pages in a browser view of its own (top level, never a frame) and
 * draws their navigation itself. The host switches it on with a cookie for PacedMind's address; the root and (app)
 * layouts read it on the server (src/server/embed.ts), so the page comes without its title bar and sidebar from the
 * first paint. The sidebar stays in the page, hidden, with the names below, which are the same in and out of embed
 * mode. docs/content/docs/accounts-and-cloud/embedding.mdx is what hosts read.
 */

export const EMBED_COOKIE = "pacedmind-embed";

/** Only `pacedmind-embed=1` switches it on. */
export const isEmbedCookie = (value: string | undefined) => value === "1";

/** What a sidebar link opens: a view (Inbox, Today…), an area, an area's to-dos, a project, or Settings. */
export type NavKind = "view" | "area" | "todos" | "project" | "settings";

/**
 * The attributes a host reads a sidebar link by: `data-pm="nav-link"`, its kind, its label, the count shown next to it
 * (only while one is) and, on an area shared with a team workspace, `data-pm-shared`.
 */
export function navLink(kind: NavKind, label: string, { count, shared }: { count?: number; shared?: boolean } = {}) {
  return {
    "data-pm": "nav-link",
    "data-pm-kind": kind,
    "data-pm-label": label,
    ...(count ? { "data-pm-count": String(count) } : {}),
    ...(shared ? { "data-pm-shared": "" } : {}),
  };
}
