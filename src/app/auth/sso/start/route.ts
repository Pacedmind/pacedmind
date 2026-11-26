import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { ssoConfig } from "@/server/sso-config";
import { startSignIn } from "@/server/sso";

/**
 * Signing in through your organisation starts here (src/server/sso.ts, step 1): the browser goes to the issuer with a
 * fresh state and nonce, which a short-lived cookie keeps. `next` is where to go once signed in, if sign-in may go
 * there (safeNext). Not found while the feature is off, and always in the desktop app.
 */
export async function GET(request: NextRequest) {
  const config = ssoConfig();
  if (!config) return new NextResponse(null, { status: 404 });
  const { location, cookie } = startSignIn(config, request.nextUrl.searchParams.get("next"));
  (await cookies()).set(cookie.name, cookie.value, cookie.options);
  return new NextResponse(null, { status: 303, headers: { Location: location, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}
