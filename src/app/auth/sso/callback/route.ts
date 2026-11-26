import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { ssoConfig } from "@/server/sso-config";
import { START_COOKIE, FINISH_PATH, acceptCallback, clearCookie, type Outcome, type CookieToSet } from "@/server/sso";
import { accountSteps } from "@/server/sso-admin";
import { refusalPage } from "@/server/sso-page";

/** The issuer's page posts a few short fields; anything bigger isn't from it. */
const MAX_BODY = 16 * 1024;

/**
 * The posted body as text, or null once it passes MAX_BODY. Counted as it arrives rather than trusted from
 * Content-Length, which a chunked post doesn't send: anyone may post here, and nobody gets to fill the server's memory.
 */
async function readBody(request: NextRequest): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Where the issuer's page posts the identity token (src/server/sso.ts, step 2). A cross-site POST, so it carries only
 * the start cookie (SameSite=None), not the session's: the session itself is made by /auth/sso/finish, where the
 * browser goes next. Whatever happens, the start cookie is used up.
 */
export async function POST(request: NextRequest) {
  const config = ssoConfig();
  if (!config) return new NextResponse(null, { status: 404 });
  const store = await cookies();
  const started = store.get(START_COOKIE)?.value;
  const done = clearCookie(START_COOKIE, "none");
  store.set(done.name, done.value, done.options);

  let outcome: Outcome<{ cookie: CookieToSet }>;
  const type = request.headers.get("content-type") ?? "";
  const body = type.toLowerCase().startsWith("application/x-www-form-urlencoded") ? await readBody(request) : null;
  if (body === null) {
    outcome = { ok: false, code: "token" };
  } else {
    const form = new URLSearchParams(body);
    try {
      outcome = await acceptCallback({ id_token: form.get("id_token"), state: form.get("state"), error: form.get("error") }, started, config, accountSteps(config));
    } catch (e) {
      // Our own messages only (sso-admin.ts): never a token, a key or what Supabase answered.
      console.error(`Sign-in through your organisation: ${e instanceof Error ? e.message : "failed"}`);
      outcome = { ok: false, code: "unavailable" };
    }
  }
  if (!outcome.ok) return refusalPage(outcome.code);
  store.set(outcome.cookie.name, outcome.cookie.value, outcome.cookie.options);
  // A path on the address the browser used (see src/app/auth/callback/route.ts); 303 turns the POST into a GET.
  return new NextResponse(null, { status: 303, headers: { Location: FINISH_PATH, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}
