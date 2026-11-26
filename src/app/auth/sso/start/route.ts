import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { ssoConfig } from "@/server/sso-config";
import { startSignIn } from "@/server/sso";

/**
 * Signing in through your organisation starts here (src/server/sso.ts, step 1): the browser goes to the issuer with a
 * fresh state and nonce, which a short-lived cookie keeps. `next` is where to go once signed in, if sign-in may go
 * there (safeNext). `fresh=1` makes the round-trip the fresh check before a sensitive action: the issuer is asked for
 * `max_age`, so it asks for a new code unless one was entered there in the last five minutes. Not found while the
 * feature is off, and always in the desktop app.
 */
export async function GET(request: NextRequest) {
  const config = ssoConfig();
  if (!config) return new NextResponse(null, { status: 404 });
  const query = request.nextUrl.searchParams;
  const { location, cookie } = startSignIn(config, query.get("next"), Date.now(), query.get("fresh") === "1");
  (await cookies()).set(cookie.name, cookie.value, cookie.options);
  return new NextResponse(null, { status: 303, headers: { Location: location, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}
