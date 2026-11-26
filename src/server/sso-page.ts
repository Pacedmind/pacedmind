import "server-only";
import { NextResponse } from "next/server";
import { getTranslation } from "./i18n";
import type { SsoRefusal } from "./sso-token";

/*
 * The one page a failed sign-in through your organisation shows: that the account can't sign in here, and a short
 * code to pass on to whoever runs the sign-in. Nothing else (no token, no claim, no message from Supabase), no script,
 * no outside resource.
 */
export async function refusalPage(code: SsoRefusal): Promise<NextResponse> {
  const tx = await getTranslation();
  const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const title = escape(tx("Can't sign in here"));
  const body = escape(tx("Your organisation account can't sign in to PacedMind here. If you think it should, tell whoever manages your organisation's sign-in."));
  const label = escape(tx("Code: {0}", [code]));
  return new NextResponse(`<!doctype html>
<html lang="${tx.language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>${title}</title></head>
<body style="font:16px system-ui,sans-serif;background:#111;color:#eee;margin:0;min-height:100vh;display:grid;place-items:center">
<main style="max-width:420px;padding:24px;text-align:center"><h1 style="font-size:20px">${title}</h1>
<p style="line-height:1.6">${body}</p>
<p style="font-size:13px;color:#aaa;font-family:ui-monospace,monospace">${label}</p></main></body></html>`, {
    status: code === "unavailable" ? 503 : 403,
    headers: {
      "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    },
  });
}
