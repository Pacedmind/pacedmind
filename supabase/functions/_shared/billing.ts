// What the billing functions share: Stripe, who is asking, the prices, and where people come back to.
//
// No secret reaches the app: these functions run in Supabase with STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET
// (`npx supabase secrets set`). Checkout and the portal act for the caller's own session, which reads its billing
// row through row level security (a two-factor session that still exists, private.session_ok()); only the webhook
// writes, with the service role, and only the billing table.
import Stripe from "npm:stripe@22.6.2";
import { env, userDb } from "./supabase.ts";

export { Stripe };
export { serviceDb } from "./supabase.ts";

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

let client: Stripe | null = null;
export function stripe(): Stripe {
  client ??= new Stripe(env("STRIPE_SECRET_KEY"), { httpClient: Stripe.createFetchHttpClient() });
  return client;
}

export type BillingRow = {
  user_id: string;
  trial_ends_at: string;
  comped: boolean;
  customer_id: string | null;
  subscription_id: string | null;
  status: string;
  market: string | null;
  period: "month" | "year" | null;
  currency: string | null;
  amount: number | null;
  period_end: string | null;
  cancel_at_period_end: boolean;
};

/**
 * Who is asking: their own billing row, read with their own token, so the database decides. A token without a
 * second factor, a signed-out session or none at all reads no row.
 */
export async function caller(req: Request): Promise<{ row: BillingRow; email: string | null }> {
  const auth = req.headers.get("Authorization") ?? "";
  if (!/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/.test(auth)) throw new HttpError(401, "Sign in again.");
  const db = userDb(auth);
  const { data, error } = await db.from("billing").select("*").maybeSingle();
  if (error || !data) throw new HttpError(401, "Sign in again.");
  const { data: user } = await db.auth.getUser(auth.slice("Bearer ".length));
  return { row: data as BillingRow, email: user.user?.email ?? null };
}

/** A subscription that still runs or may still be paid: a second one would charge twice. */
export const RUNNING = new Set(["active", "trialing", "past_due", "unpaid", "paused"]);

export type Period = "month" | "year";

/** Each country's price has a lookup key, made by scripts/stripe-prices.mjs from site/prices.json. */
export function lookupKey(market: string, period: Period): string {
  return `cloud_${period === "year" ? "yearly" : "monthly"}_${market}`;
}

export function parseLookupKey(key: string | null | undefined): { market: string; period: Period } | null {
  const m = /^cloud_(monthly|yearly)_([A-Z]{2})$/.exec(key ?? "");
  return m ? { market: m[2], period: m[1] === "yearly" ? "year" : "month" } : null;
}

/** The price for a country, or the US one for a country without its own. */
export async function priceFor(market: string, period: Period): Promise<Stripe.Price> {
  const keys = [lookupKey(market, period), lookupKey("US", period)];
  const { data } = await stripe().prices.list({ lookup_keys: keys, active: true, limit: 2 });
  const price = data.find((p) => p.lookup_key === keys[0]) ?? data.find((p) => p.lookup_key === keys[1]);
  if (!price) throw new Error(`No price with the lookup key ${keys[0]} or ${keys[1]}: run npm run stripe:prices -- --write.`);
  return price;
}

/**
 * Where Stripe's pages send people back: the web app's settings, or for the desktop app a page on the site that
 * says to go back to the app (the desktop app's own server only answers its own window).
 */
export function returnUrls(surface: "web" | "desktop"): { done: string; back: string } {
  if (surface === "web") {
    const app = Deno.env.get("BILLING_APP_ORIGIN") ?? "https://app.pacedmind.com";
    return { done: `${app}/settings?billing=done`, back: `${app}/settings` };
  }
  const site = Deno.env.get("BILLING_SITE_ORIGIN") ?? "https://pacedmind.com";
  return { done: `${site}/subscribed`, back: `${site}/subscribed` };
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export function failure(e: unknown): Response {
  if (e instanceof HttpError) return json({ error: e.message }, e.status);
  console.error(e);
  return json({ error: "Something went wrong with billing. Try again in a moment." }, 500);
}

export async function readBody(req: Request): Promise<Record<string, unknown>> {
  if (req.method !== "POST") throw new HttpError(405, "Use POST.");
  const body = await req.json().catch(() => null);
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}
