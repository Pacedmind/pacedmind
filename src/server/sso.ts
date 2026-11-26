import "server-only";
import { randomBytes } from "node:crypto";
import { ssoStartHref } from "@/lib/sso";
import { safeNext } from "./auth-flow";
import type { SsoConfig } from "./sso-config";
import { sameSecret, verifyIdentityToken, type Identity, type SsoRefusal } from "./sso-token";

/*
 * Signing in through your organisation, in three steps (the routes under src/app/auth/sso are thin wrappers):
 *
 * 1. GET /auth/sso/start: a random state and nonce go into a short-lived cookie, and the browser goes to the issuer.
 * 2. POST /auth/sso/callback, which the issuer's page sends with the identity token: the state must match the cookie,
 *    the token must verify (sso-token.ts) and never have been used, and the account is found, linked or created. The
 *    result is a one-time sign-in token for that account, which waits in a second short-lived cookie.
 * 3. GET /auth/sso/finish: the browser follows the callback's redirect here. Only now does it send its existing
 *    session cookies (they're SameSite=Lax, so a cross-site POST goes without them), so this step can end the old
 *    session properly, replace it with the new one in the usual cookies, and mark the new one as made through the
 *    issuer (supabase/migrations/*_issuer_sign_in.sql).
 *
 * Both cookies are __Host- cookies (Secure, the whole site, no Domain), so no other site or subdomain can plant one.
 */

/** The state and nonce of a sign-in this browser started, which must survive the issuer's cross-site POST back. */
export const START_COOKIE = "__Host-pacedmind-sso";
/** The verified sign-in, from the callback to /auth/sso/finish. */
export const FINISH_COOKIE = "__Host-pacedmind-sso-finish";

/** How long the browser may take at the issuer (seconds). */
export const START_MAX_AGE = 600;
/** How long the redirect from the callback to the finish may take (seconds). */
export const FINISH_MAX_AGE = 60;

export const CALLBACK_PATH = "/auth/sso/callback";
export const FINISH_PATH = "/auth/sso/finish";

/** Signing in through the issuer, then on to `next` when sign-in may go there (safeNext). */
export function startPath(next: string | null | undefined): string {
  const to = safeNext(next);
  return ssoStartHref(to === "/today" ? undefined : to);
}

/** The hosted app's own address, which the issuer posts back to; null when it isn't set. */
export const publicOrigin = (): string | null => (process.env.ORGANIZER_PUBLIC_ORIGIN ?? "").replace(/\/+$/, "") || null;

export interface CookieToSet {
  name: string;
  value: string;
  options: { httpOnly: true; secure: true; sameSite: "none" | "lax"; path: "/"; maxAge: number };
}

const RANDOM = /^[A-Za-z0-9_-]{43}$/;
const HASHED_TOKEN = /^[A-Za-z0-9_-]{16,200}$/;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const encode = (value: object) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
function decode(value: string | undefined): Record<string, unknown> | null {
  if (!value || value.length > 2048) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export const clearCookie = (name: string, sameSite: "none" | "lax"): CookieToSet =>
  ({ name, value: "", options: { httpOnly: true, secure: true, sameSite, path: "/", maxAge: 0 } });

/** Step 1: where to send the browser, and the cookie that remembers what it was sent with. */
export function startSignIn(config: SsoConfig, origin: string, next: string | null | undefined, now = Date.now()): { location: string; cookie: CookieToSet } {
  const state = randomBytes(32).toString("base64url");
  const nonce = randomBytes(32).toString("base64url");
  const url = new URL(config.authorizeUrl);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", `${origin}${CALLBACK_PATH}`);
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("response_mode", "form_post");
  return {
    location: url.toString(),
    cookie: {
      name: START_COOKIE,
      value: encode({ state, nonce, next: safeNext(next), at: now }),
      // SameSite=None: the issuer's page posts back from its own site, and the cookie has to come along.
      options: { httpOnly: true, secure: true, sameSite: "none", path: "/", maxAge: START_MAX_AGE },
    },
  };
}

type Started = { state: string; nonce: string; next: string };

function readStarted(value: string | undefined, now: number): Started | null {
  const v = decode(value);
  if (!v || typeof v.state !== "string" || typeof v.nonce !== "string" || typeof v.next !== "string" || typeof v.at !== "number") return null;
  if (!RANDOM.test(v.state) || !RANDOM.test(v.nonce)) return null;
  if (now - v.at > START_MAX_AGE * 1000 || v.at > now + 60_000) return null;
  return { state: v.state, nonce: v.nonce, next: safeNext(v.next) };
}

/** What the callback hands to the finish: a one-time sign-in for one account, and who the issuer said it is. */
export interface Handoff {
  hashedToken: string;
  userId: string;
  issuer: string;
  subject: string;
  /** When the issuer issued the token (seconds). */
  verifiedAt: number;
  next: string;
}

export type LinkAnswer = { userId: string } | { userId: null } | { refused: "account_linked" | "account_unconfirmed" | "account_ambiguous" };

/** What the callback needs from Supabase, with the project's secret key (sso-admin.ts). */
export interface AccountSteps {
  /** Uses up the token: false when it was seen before. */
  claimToken(tokenId: string, expiresAt: number): Promise<boolean>;
  linkAccount(identity: Identity): Promise<LinkAnswer>;
  /** A new account with this confirmed email. Resolves even when another request created it first. */
  createAccount(identity: Identity): Promise<void>;
  /** A one-time sign-in token (a magic link's hashed token) for the account, made without sending any email. */
  signInToken(userId: string): Promise<string>;
}

export type Outcome<T> = ({ ok: true } & T) | { ok: false; code: SsoRefusal };

/** The form fields the issuer's page posts: id_token and state, or error and state. */
export interface CallbackForm {
  id_token?: string | null;
  state?: string | null;
  error?: string | null;
}

/** Step 2. `startCookie` is this browser's START_COOKIE; `now` is in milliseconds. */
export async function acceptCallback(
  form: CallbackForm, startCookie: string | undefined, config: SsoConfig, steps: AccountSteps, now = Date.now(),
): Promise<Outcome<{ cookie: CookieToSet }>> {
  const started = readStarted(startCookie, now);
  // A post this browser didn't start (or started too long ago) is refused before anything in it is looked at: that is
  // what stops someone else's token from signing this browser in to their account.
  if (!started || typeof form.state !== "string" || !sameSecret(form.state, started.state)) return { ok: false, code: "state" };
  if (form.error) return { ok: false, code: form.error === "access_denied" ? "access_denied" : "unavailable" };
  if (typeof form.id_token !== "string") return { ok: false, code: "token" };
  const verified = await verifyIdentityToken(form.id_token, config, started.nonce, Math.floor(now / 1000));
  if (!verified.ok) return verified;
  const identity = verified.identity;
  if (!(await steps.claimToken(identity.tokenId, identity.expiresAt))) return { ok: false, code: "replayed" };
  let link = await steps.linkAccount(identity);
  if ("refused" in link) return { ok: false, code: link.refused };
  if (!link.userId) {
    await steps.createAccount(identity);
    link = await steps.linkAccount(identity);
    if ("refused" in link) return { ok: false, code: link.refused };
    if (!link.userId) return { ok: false, code: "unavailable" };
  }
  const handoff: Handoff = {
    hashedToken: await steps.signInToken(link.userId), userId: link.userId, issuer: identity.issuer, subject: identity.subject,
    verifiedAt: identity.issuedAt, next: started.next,
  };
  return {
    ok: true,
    // Lax: the redirect that follows is a top-level GET, which carries Lax cookies, and nothing else needs it.
    cookie: { name: FINISH_COOKIE, value: encode({ ...handoff, at: now }), options: { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: FINISH_MAX_AGE } },
  };
}

function readHandoff(value: string | undefined, now: number): Handoff | null {
  const v = decode(value);
  if (!v || typeof v.hashedToken !== "string" || typeof v.userId !== "string" || typeof v.issuer !== "string"
    || typeof v.subject !== "string" || typeof v.verifiedAt !== "number" || typeof v.next !== "string" || typeof v.at !== "number") return null;
  if (!HASHED_TOKEN.test(v.hashedToken) || !ID.test(v.userId) || now - v.at > FINISH_MAX_AGE * 1000 || v.at > now + 60_000) return null;
  return { hashedToken: v.hashedToken, userId: v.userId, issuer: v.issuer, subject: v.subject, verifiedAt: v.verifiedAt, next: safeNext(v.next) };
}

/** What the finish needs: this browser's own session cookies, and the secret key for the mark. */
export interface SessionSteps {
  /** Ends this browser's current session, if any, and starts the account's with the one-time token. Its session id. */
  replaceSession(hashedToken: string, userId: string): Promise<string>;
  markSession(sessionId: string, handoff: Handoff): Promise<void>;
  /** Ends the session just made, when it couldn't be marked. */
  endSession(): Promise<void>;
}

/** Step 3. */
export async function finishSignIn(finishCookie: string | undefined, steps: SessionSteps, now = Date.now()): Promise<Outcome<{ next: string }>> {
  const handoff = readHandoff(finishCookie, now);
  if (!handoff) return { ok: false, code: "state" };
  const sessionId = await steps.replaceSession(handoff.hashedToken, handoff.userId);
  try {
    await steps.markSession(sessionId, handoff);
  } catch (e) {
    // Without its mark the session would be an ordinary one that never asked for a second factor: don't keep it.
    await steps.endSession();
    throw e;
  }
  return { ok: true, next: handoff.next };
}
