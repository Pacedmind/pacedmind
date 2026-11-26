import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { ssoConfig } from "@/server/sso-config";
import { FINISH_COOKIE, clearCookie, finishSignIn, type Outcome } from "@/server/sso";
import { sessionSteps } from "@/server/sso-admin";
import { refusalPage } from "@/server/sso-page";

/**
 * The last step of signing in through your organisation (src/server/sso.ts, step 3): the verified sign-in the callback
 * left in a cookie becomes this browser's session, replacing whichever it had, and the browser goes on to `next`.
 */
export async function GET() {
  const config = ssoConfig();
  if (!config) return new NextResponse(null, { status: 404 });
  const store = await cookies();
  const handoff = store.get(FINISH_COOKIE)?.value;
  const done = clearCookie(FINISH_COOKIE, "lax");
  store.set(done.name, done.value, done.options);
  let outcome: Outcome<{ next: string }>;
  try {
    outcome = await finishSignIn(handoff, sessionSteps(config));
  } catch (e) {
    console.error(`Sign-in through your organisation: ${e instanceof Error ? e.message : "failed"}`);
    outcome = { ok: false, code: "unavailable" };
  }
  if (!outcome.ok) return refusalPage(outcome.code);
  return new NextResponse(null, { status: 303, headers: { Location: outcome.next, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}
