import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { ssoConfig } from "@/server/sso-config";
import { START_COOKIE, FINISH_PATH, acceptCallback, clearCookie, type Outcome, type CookieToSet } from "@/server/sso";
import { accountSteps } from "@/server/sso-admin";
import { refusalPage } from "@/server/sso-page";

/** The issuer's page posts a few short fields; anything bigger isn't from it. */
const MAX_BODY = 16 * 1024;

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
  const length = Number(request.headers.get("content-length") ?? "0");
  if (!type.toLowerCase().startsWith("application/x-www-form-urlencoded") || length > MAX_BODY) {
    outcome = { ok: false, code: "token" };
  } else {
    const body = await request.text();
    const form = new URLSearchParams(body.length > MAX_BODY ? "" : body);
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
