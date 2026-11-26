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
 *    With `fresh=1` it is the fresh check before a sensitive action: the issuer is asked for `max_age` (FRESH_MAX_AGE),
 *    so it signs only once the person entered a code there that recently, and says when in `auth_time`. A plain
 *    sign-in asks for no `max_age`.
 * 2. POST /auth/sso/callback, which the issuer's page sends with the identity token: the state must match the cookie,
 *    the token must verify (sso-token.ts) and never have been used, a fresh check's `auth_time` must be within
 *    FRESH_MAX_AGE, and the account is found, linked or created. The
 *    database then keeps the verified sign-in (issuer_begin_handoff), and the browser gets only a random id for it in
 *    a second short-lived cookie.
 * 3. GET /auth/sso/finish: the browser follows the callback's redirect here. Only now does it send its existing
 *    session cookies (they're SameSite=Lax, so a cross-site POST goes without them), so this step can confirm a link
 *    from the account's own two-factor session, end the old session properly, make the new one in the usual cookies,
 *    and have the database mark it as made through the issuer (supabase/migrations/*_issuer_sign_in.sql).
 *
 * Nothing the finish acts on comes from the browser: the id only finds what the callback kept, the account and the
 * person come from there, and the one-time sign-in token for the session is made here, on the server, at that moment.
 * Both cookies are __Host- cookies (Secure, the whole site, no Domain), so no other site or subdomain can plant one.
 */

/** The state and nonce of a sign-in this browser started, which must survive the issuer's cross-site POST back. */
export const START_COOKIE = "__Host-pacedmind-sso";
/** The id of the verified sign-in the database keeps, from the callback to /auth/sso/finish. */
export const FINISH_COOKIE = "__Host-pacedmind-sso-finish";

/** How long the browser may take at the issuer (seconds). */
export const START_MAX_AGE = 600;
/** How long the redirect from the callback to the finish may take (seconds). */
export const FINISH_MAX_AGE = 60;

/**
 * How recent the issuer's check must be for a fresh check (seconds): the `max_age` a fresh round-trip asks for, and the
 * most `now - auth_time` its token may show. The same five minutes the database gives a fresh code (private.recent_mfa).
 */
export const FRESH_MAX_AGE = 300;

export const CALLBACK_PATH = "/auth/sso/callback";
export const FINISH_PATH = "/auth/sso/finish";

/** Signing in through the issuer, then on to `next` when sign-in may go there (safeNext). */
export function startPath(next: string | null | undefined): string {
  const to = safeNext(next);
  return ssoStartHref(to === "/today" ? undefined : to);
}

export interface CookieToSet {
  name: string;
  value: string;
  options: { httpOnly: true; secure: true; sameSite: "none" | "lax"; path: "/"; maxAge: number };
}

/** 32 random bytes in base64url: the state, the nonce and the sign-in's id. */
const RANDOM = /^[A-Za-z0-9_-]{43}$/;
const random = () => randomBytes(32).toString("base64url");

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

/**
 * Step 1: where to send the browser, and the cookie that remembers what it was sent with. `fresh` makes it the fresh
 * check: the issuer is asked for `max_age`, and the callback takes only a token whose `auth_time` is that recent.
 */
export function startSignIn(
  config: SsoConfig, next: string | null | undefined, now = Date.now(), fresh = false,
): { location: string; cookie: CookieToSet } {
  const state = random();
  const nonce = random();
  const url = new URL(config.authorizeUrl);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", `${config.publicOrigin}${CALLBACK_PATH}`);
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("response_mode", "form_post");
  if (fresh) url.searchParams.set("max_age", String(FRESH_MAX_AGE));
  return {
    location: url.toString(),
    cookie: {
      name: START_COOKIE,
      value: encode({ state, nonce, next: safeNext(next), at: now, fresh }),
      // SameSite=None: the issuer's page posts back from its own site, and the cookie has to come along.
      options: { httpOnly: true, secure: true, sameSite: "none", path: "/", maxAge: START_MAX_AGE },
    },
  };
}

type Started = { state: string; nonce: string; next: string; fresh: boolean };

function readStarted(value: string | undefined, now: number): Started | null {
  const v = decode(value);
  if (!v || typeof v.state !== "string" || typeof v.nonce !== "string" || typeof v.next !== "string" || typeof v.at !== "number"
    || typeof v.fresh !== "boolean") return null;
  if (!RANDOM.test(v.state) || !RANDOM.test(v.nonce)) return null;
  if (now - v.at > START_MAX_AGE * 1000 || v.at > now + 60_000) return null;
  return { state: v.state, nonce: v.nonce, next: safeNext(v.next), fresh: v.fresh };
}

export type LinkAnswer = { userId: string } | { userId: null } | { refused: "account_linked" | "account_unconfirmed" | "account_ambiguous" };

/** What the callback needs from Supabase, with the project's secret key (sso-admin.ts). */
export interface AccountSteps {
  /** Uses up the token: false when it was seen before. */
  claimToken(tokenId: string, expiresAt: number): Promise<boolean>;
  linkAccount(identity: Identity): Promise<LinkAnswer>;
  /** A new account with this confirmed email. Resolves even when another request created it first. */
  createAccount(identity: Identity): Promise<void>;
  /**
   * Has the database keep the verified sign-in under `handoffId` for the finish, tied to the token it used up. `fresh`:
   * the round-trip asked for `max_age`, so `identity.authTime` is a code entered that recently, which makes the session
   * a fresh check until it is FRESH_MAX_AGE old.
   */
  beginHandoff(handoffId: string, identity: Identity, userId: string, next: string, fresh: boolean): Promise<void>;
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
  // The fresh check asked the issuer for a code within FRESH_MAX_AGE: a token showing an older one isn't that check.
  if (started.fresh && Math.floor(now / 1000) - identity.authTime > FRESH_MAX_AGE) return { ok: false, code: "stale" };
  if (!(await steps.claimToken(identity.tokenId, identity.expiresAt))) return { ok: false, code: "replayed" };
  let link = await steps.linkAccount(identity);
  if ("refused" in link) return { ok: false, code: link.refused };
  if (!link.userId) {
    await steps.createAccount(identity);
    link = await steps.linkAccount(identity);
    if ("refused" in link) return { ok: false, code: link.refused };
    if (!link.userId) return { ok: false, code: "unavailable" };
  }
  const handoffId = random();
  await steps.beginHandoff(handoffId, identity, link.userId, started.next, started.fresh);
  return {
    ok: true,
    // Lax: the redirect that follows is a top-level GET, which carries Lax cookies, and nothing else needs it.
    cookie: { name: FINISH_COOKIE, value: handoffId, options: { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: FINISH_MAX_AGE } },
  };
}

/** The sign-in the callback kept, as the finish opens it (once). */
export interface OpenedHandoff {
  userId: string;
  /** Whether the issuer's person is linked to the account; an account with its own authenticator waits for its owner. */
  linked: boolean;
  next: string;
}

/** What the finish needs: this browser's own session cookies, and the secret key for the rest. */
export interface SessionSteps {
  /** The sign-in kept under this id, opened for the first and only time; null when none is waiting. */
  openHandoff(handoffId: string): Promise<OpenedHandoff | null>;
  /** Links the person to the account from this browser's current session, if it is the account's own two-factor one. */
  confirmLink(handoffId: string): Promise<boolean>;
  /** Ends this browser's current session, if any, and starts one for the account. Its session id. */
  replaceSession(userId: string): Promise<string>;
  /** Marks that session as made through the issuer, using up the kept sign-in. */
  markSession(sessionId: string, handoffId: string): Promise<void>;
  /** Whether the pages will see this browser's new session as made through the issuer, for this account. */
  sessionMarked(userId: string): Promise<boolean>;
  /** Ends the session just made. */
  endSession(): Promise<void>;
}

/** Step 3. `finishCookie` is this browser's FINISH_COOKIE. */
export async function finishSignIn(finishCookie: string | undefined, steps: SessionSteps): Promise<Outcome<{ next: string }>> {
  if (!finishCookie || !RANDOM.test(finishCookie)) return { ok: false, code: "state" };
  const opened = await steps.openHandoff(finishCookie);
  if (!opened) return { ok: false, code: "state" };
  // The account has an authenticator of its own: the address alone doesn't stand in for it. Only its owner, signed in
  // here with it, can let the issuer sign in to it from now on; anyone else keeps the session they had.
  if (!opened.linked && !(await steps.confirmLink(finishCookie))) return { ok: false, code: "account_protected" };
  const sessionId = await steps.replaceSession(opened.userId);
  try {
    await steps.markSession(sessionId, finishCookie);
  } catch (e) {
    // Without its mark the session would be an ordinary one that never asked for a second factor: don't keep it.
    await steps.endSession();
    throw e;
  }
  // The pages decide by what they read back. If they can't see the mark (the database not answering), they would ask
  // for PacedMind's code, which in a host application means another round-trip through the issuer, and another: stop
  // here instead, signed out, on a page that says so.
  if (!(await steps.sessionMarked(opened.userId))) {
    await steps.endSession();
    return { ok: false, code: "unavailable" };
  }
  return { ok: true, next: safeNext(opened.next) };
}
