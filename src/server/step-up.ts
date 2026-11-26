import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ssoLabel } from "./sso-config";
import { readAuthState, supabase, type AuthState } from "./supabase";

/*
 * A fresh two-factor code for actions that weaken the account or reach a computer from afar. Verifying it
 * gives the session a new "second factor just now" timestamp (the amr claim), which the database checks
 * for requests to start sessions and for deleting the account (private.recent_mfa).
 */

const CODE = /^\d{6}$/;

export function explainAuthError(message: string): string {
  if (/invalid totp|invalid code|expired|challenge/i.test(message)) return "That code didn't work. Codes change every 30 seconds; enter the current one.";
  if (/rate limit|too many|over_request/i.test(message)) return "Too many tries in a short time. Wait a few minutes and try again.";
  if (/insufficient_aal|aal2/i.test(message)) return "Enter your two-factor code first.";
  return message;
}

/**
 * What to say when the database refused a step-up anyway: the code came from an authenticator added after
 * this sign-in, which doesn't count (supabase/migrations: private.recent_mfa).
 */
export const STEP_UP_REFUSED =
  "That needs a code from an authenticator you had before this sign-in. If you added one just now, sign out and in again, then try again.";

export const refusedStepUp = (message: string) => /row-level security|two-factor code first/i.test(message);

/**
 * How long a code entered in this session lets the app skip asking for another before a request to a computer: four
 * minutes, a minute short of the five the database allows (private.recent_mfa), so a request sent near the end still
 * gets there in time.
 */
export const CODE_REUSE_MS = 4 * 60_000;

/**
 * Until when (ms since the epoch) the app may send a request to a computer without asking for a code again: the last
 * time this session verified an authenticator, plus CODE_REUSE_MS. Null without one. A hint only: the database checks
 * the code's time itself, and that it came from an authenticator the account had before this sign-in.
 *
 * A session made through your organisation's sign-in never asks for PacedMind's code: its check is the issuer's, as
 * recent as the round-trip through it that made the session (`issuer.verifiedAt`, which the database also checks).
 */
export function codeFreshUntil(state: AuthState | null): number | null {
  if (state?.issuer) return state.issuer.verifiedAt + CODE_REUSE_MS;
  const at = (state?.amr ?? [])
    .filter((a) => ["totp", "mfa/totp", "webauthn", "mfa/webauthn"].includes(a.method) && Number.isFinite(a.timestamp))
    .reduce((max, a) => Math.max(max, a.timestamp), 0);
  return at ? at * 1000 + CODE_REUSE_MS : null;
}

/**
 * What a session made through your organisation's sign-in hears instead of "enter a code": a new round-trip through the
 * issuer is its fresh check. `label` is the organisation's name (SSO_LABEL).
 */
export const issuerStepUp = (label: string | null) =>
  `Confirm with ${label ?? "your organisation"} again first, then try again within four minutes.`;

/** Why a session made through your organisation's sign-in can't change PacedMind's own authenticators or password. */
export const ISSUER_MANAGED =
  "You signed in through your organisation. Authenticators and the password are changed from a sign-in with your PacedMind password.";

/**
 * Verifies `code` against the given authenticator, or against each of the account's (oldest first: the one
 * that counts for a step-up is one the account had before this sign-in) until one takes it. Returns why
 * not, or null.
 */
export async function verifyCode(db: SupabaseClient, code: string, factorId?: string | null): Promise<string | null> {
  const digits = code.replace(/\s+/g, "");
  if (!CODE.test(digits)) return "Enter the 6-digit code from your authenticator app.";
  const state = await readAuthState();
  // Such a session's second factor is the issuer's; PacedMind's own code is never asked for in it.
  if (state?.issuer) return ISSUER_MANAGED;
  const totp = (state?.factors.filter((f) => f.factor_type === "totp") ?? []).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const candidates = factorId ? totp.filter((f) => f.id === factorId) : totp;
  if (!candidates.length) return "Set up an authenticator app first.";
  let problem = "That code didn't work.";
  for (const factor of candidates) {
    const { error } = await db.auth.mfa.challengeAndVerify({ factorId: factor.id, code: digits });
    if (!error) return null;
    problem = explainAuthError(error.message);
    if (/too many/i.test(problem)) break;
  }
  return problem;
}

/**
 * Why a request to a computer (or an answer from elsewhere) can't go yet for want of a fresh check, or null: `code` when
 * given, else one this session entered in the last four minutes. A session made through your organisation's sign-in
 * never uses PacedMind's code: its check is a round-trip through the issuer in the last four minutes. The database checks
 * the time and the authenticator either way (private.recent_mfa).
 */
export async function freshCheckProblem(code: string | null | undefined): Promise<string | null> {
  const state = await readAuthState();
  if (state?.issuer) {
    const until = codeFreshUntil(state);
    return until && until > Date.now() ? null : issuerStepUp(ssoLabel());
  }
  if (code?.trim()) return verifyCode(await supabase(), code);
  const until = codeFreshUntil(state);
  return until && until > Date.now() ? null : "Enter a current two-factor code.";
}

/** What to say when the database found the fresh check too old after all: `fallback`, or the issuer's round-trip. */
export async function staleCheck(fallback: string): Promise<string> {
  return (await readAuthState())?.issuer ? issuerStepUp(ssoLabel()) : fallback;
}
