import { env, serviceDb, userDb } from "../_shared/supabase.ts";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const unavailable = "Couldn't send the verification code. Try again in a moment.";
const error = (message: string, status: number) => Response.json({ error: message }, { status });

/** Only the authenticated planner user can request a code. The service credential sets its hash. */
export async function sendWorkEmailCode(request: Request): Promise<Response> {
  if (request.method !== "POST") return error("Use POST.", 405);
  const authorization = request.headers.get("Authorization") ?? "";
  if (!/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/.test(authorization)) return error("Sign in to manage your work email.", 401);
  const body = await request.json().catch(() => null);
  if (typeof body?.email !== "string" || body.email.length > 254 || !body.email.trim()) {
    return error("Enter a valid work email address.", 400);
  }

  try {
    // PostgREST validates the token and the RPC checks the live human session, including MFA when enrolled.
    const caller = await userDb(authorization).rpc("get_work_email");
    if (caller.error?.code === "42501" || caller.status === 401) return error("Sign in to manage your work email.", 401);
    if (caller.error || typeof caller.data?.user_id !== "string") return error(unavailable, 503);
    const apiKey = env("WORK_EMAIL_RESEND_API_KEY");
    const from = env("WORK_EMAIL_FROM");
    const code = Array.from(crypto.getRandomValues(new Uint8Array(10)), (byte) => ALPHABET[byte & 31]).join("");
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code));
    const codeDigest = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const issued = await serviceDb().rpc("issue_work_email_code", {
      account: caller.data.user_id, target_email: body.email, code_digest: codeDigest,
    });
    if (issued.error?.code === "PT429") return error("Too many codes requested. Try again later.", 429);
    if (issued.error?.code === "22023") return error(issued.error.message, 400);
    if (issued.error || typeof issued.data !== "string") return error(unavailable, 503);

    const display = code.slice(0, 5) + "-" + code.slice(5);
    const polish = body.language === "pl";
    const delivery = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        from, to: [issued.data],
        subject: polish ? "Potwierdź służbowy adres w PacedMind" : "Confirm your PacedMind work email",
        text: polish
          ? "Twój kod PacedMind to " + display + ".\n\nWpisz go w aplikacji w ciągu 15 minut."
          : "Your PacedMind code is " + display + ".\n\nEnter it in the app within 15 minutes.",
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!delivery.ok) {
      console.error("Work email delivery failed", delivery.status);
      return error(unavailable, 502);
    }
    return Response.json({ sent: true });
  } catch {
    console.error("Work email verification request failed");
    return error(unavailable, 503);
  }
}
