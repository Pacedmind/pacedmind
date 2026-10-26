import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { COOKIE_OPTIONS, supabaseConfig } from "@/server/supabase-config";
import { UI_COOKIE, UI_HEADER, isUiKey, startedByApp, uiKey } from "@/server/ui-key";

const WEB = process.env.ORGANIZER_MODE === "web";
const DEV = process.env.NODE_ENV === "development";
const LOCAL = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Desktop routes that work without the window key, because each checks its own credentials. */
const DESKTOP_OPEN = [
  /^\/api\/google-calendar\/callback$/, // single-use OAuth state + PKCE; no window cookie in an external browser
  /^\/api\/mcp\/?$/, // agents, with an MCP token (src/server/auth.ts)
  /^\/api\/sessions\/[0-9a-f]{16}\/ended$/, // a session's SessionEnd hook, with that session's token
  /^\/api\/sessions\/[0-9a-f]{16}\/signal$/, // the hooks that say it waits for you or went on, with that session's token
  /^\/api\/sessions\/[0-9a-f]{16}\/permission$/, // Claude Code's PermissionRequest hook, with that session's token
  /^\/api\/sessions\/[0-9a-f]{16}\/usage$/, // Claude Code's usage metrics for that session, with its token
  /^\/api\/health$/, // "is the server up", for the desktop app starting it; no data
  /^\/auth\/callback$/, // email links, which open in any browser; only this server can finish them (PKCE)
  /^\/auth\/done$/,
];
/** Web routes that work without signing in. */
const WEB_PUBLIC = [
  /^\/login(\/|$)/, /^\/auth\//, /^\/api\/health$/,
  /^\/api\/mcp\/?$/, // agents, with their own OAuth token (src/server/auth.ts)
  /^\/\.well-known\/oauth-(protected-resource|authorization-server)(\/|$)/, // where agents sign in; public
  /^\/\.well-known\/openai-apps-challenge$/, // public domain-ownership proof for connector submission
  /^\/oauth\/consent$/, // approving an agent's sign-in; sends you to sign in first, keeping the request
];

const LOCKED = `<!doctype html><meta charset="utf-8"><title>PacedMind</title>
<body style="font:14px system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#111;color:#bbb">
<p style="max-width:420px;text-align:center;line-height:1.6">PacedMind only opens in its own window.<br>${
  DEV ? "Open the link <code>npm run dev</code> printed in its terminal." : "Open it from the Start Menu or the tray icon."
}</p></body>`;

function contentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${DEV ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self'${DEV ? " ws: wss:" : ""}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(WEB && !DEV ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}

function withHeaders(res: NextResponse, csp: string): NextResponse {
  res.headers.set("Content-Security-Policy", csp);
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("X-Frame-Options", "DENY");
  // Sign-in links carry one-time codes; never send the URL on.
  res.headers.set("Referrer-Policy", "no-referrer");
  res.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()");
  res.headers.set("Cross-Origin-Opener-Policy", "same-origin");
  res.headers.set("Cross-Origin-Resource-Policy", "same-origin");
  if (WEB && !DEV) res.headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
  return res;
}

/**
 * Runs before every page, Server Action and API route:
 * - Every response gets a strict Content Security Policy (with a nonce per request, see the root layout)
 *   and the usual hardening headers. Task titles and descriptions come from the cloud, and in the desktop
 *   app a page that ran foreign script could start sessions.
 * - The desktop app (and `npm run dev`) only answers requests addressed to this computer (a page could point
 *   its own domain at 127.0.0.1: DNS rebinding), and only its own window may use pages and Server Actions
 *   (src/server/ui-key.ts). Agents, hooks and email links use the few routes that check their own
 *   credentials.
 * - The hosted app (ORGANIZER_MODE=web) refreshes the browser's Supabase session, since Server Components
 *   can't write cookies, and sends visitors without one to the sign-in page. The real checks are the
 *   database's (row level security with two-factor sessions) and each page's (the (app) layout).
 */
export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = contentSecurityPolicy(nonce);
  const forward = () => {
    const headers = new Headers(request.headers);
    headers.set("x-nonce", nonce);
    headers.set("Content-Security-Policy", csp);
    return headers;
  };

  if (!WEB) {
    const host = (request.headers.get("host") ?? "").replace(/:\d+$/, "").toLowerCase();
    if (!LOCAL.has(host)) return withHeaders(new NextResponse("PacedMind only answers on 127.0.0.1", { status: 403 }), csp);

    // `npm run dev`: the link it printed sets the window cookie in your browser.
    if (path === "/unlock" && !startedByApp()) {
      if (!isUiKey(request.nextUrl.searchParams.get("key"))) return withHeaders(new NextResponse("That link isn't current.", { status: 403 }), csp);
      const res = NextResponse.redirect(new URL("/today", request.url));
      res.cookies.set(UI_COOKIE, uiKey(), { httpOnly: true, sameSite: "strict", path: "/" });
      return withHeaders(res, csp);
    }

    const key = request.cookies.get(UI_COOKIE)?.value ?? request.headers.get(UI_HEADER);
    if (!DESKTOP_OPEN.some((p) => p.test(path)) && !isUiKey(key)) {
      return withHeaders(new NextResponse(LOCKED, { status: 401, headers: { "Content-Type": "text/html; charset=utf-8" } }), csp);
    }
    return withHeaders(NextResponse.next({ request: { headers: forward() } }), csp);
  }

  // The hosted app answers only on its own address, if it knows it (links in emails are built from it).
  const origin = process.env.ORGANIZER_PUBLIC_ORIGIN;
  if (origin && request.headers.get("host") !== new URL(origin).host) {
    return withHeaders(new NextResponse("Unknown host", { status: 421 }), csp);
  }

  let response = NextResponse.next({ request: { headers: forward() } });
  const { url, key } = supabaseConfig();
  const supabase = createServerClient(url, key, {
    cookieOptions: COOKIE_OPTIONS,
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (list, headers) => {
        for (const { name, value } of list) request.cookies.set(name, value);
        response = NextResponse.next({ request: { headers: forward() } });
        for (const { name, value, options } of list) response.cookies.set(name, value, { ...options, ...COOKIE_OPTIONS });
        for (const [k, v] of Object.entries(headers)) response.headers.set(k, v);
      },
    },
  });
  // Nothing may run between creating the client and this call, or sessions can end at random.
  const { data } = await supabase.auth.getClaims();
  if (!data?.claims && !WEB_PUBLIC.some((p) => p.test(path))) {
    if (path.startsWith("/api/")) return withHeaders(NextResponse.json({ error: "Sign in first" }, { status: 401 }), csp);
    const login = request.nextUrl.clone();
    login.pathname = "/login";
    login.search = "";
    return withHeaders(NextResponse.redirect(login), csp);
  }
  const result = withHeaders(response, csp);
  // Only the hosted consent page keeps a handle to the local agent's callback window so it can close it after
  // the database confirms sign-in. Other pages retain full opener isolation. No callback is fetched by the server.
  if (path === "/oauth/consent") result.headers.set("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
  return result;
}

export const config = {
  // Everything but build output and static files (the service worker and the manifest hold nothing private, and a
  // browser fetches the manifest without cookies).
  matcher: ["/((?!_next/static|_next/image|favicon.ico|brand/|sw\\.js$|manifest\\.webmanifest$).*)"],
};
