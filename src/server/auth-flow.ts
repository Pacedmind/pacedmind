import "server-only";
import { supabaseConfig } from "./supabase-config";
import type { AuthState } from "./supabase";

/*
 * Sign-in asks for MFA only after enrollment. Unenrolled accounts go straight to the planner;
 * computer control has a separate established-MFA check. RLS independently enforces both rules.
 */

export type AuthStep = "/login" | "/login/setup" | "/login/verify";

export function nextStep(state: AuthState | null): AuthStep | null {
  if (!state) return "/login";
  if (state.clientId) return "/login";
  if (state.mfaEnabled && state.aal !== "aal2") return "/login/verify";
  return null;
}

/**
 * Pages sign-in may continue to: where an email link pointed, or the page approving an agent's sign-in (the hosted
 * app), which sends you to sign in first. Anything else goes to Today.
 */
const CONTINUE_TO = new Set(["/today", "/login/new-password", "/settings/security", "/settings/account"]);
const CONSENT = /^\/oauth\/consent\?authorization_id=[A-Za-z0-9_-]{1,200}$/;
/** A team workspace's invitation link, which sends you to sign in or create an account first. */
export const JOIN = /^\/join\/[0-9a-f]{64}$/;

export const safeNext = (next: string | null | undefined): string =>
  (next && (CONTINUE_TO.has(next) || CONSENT.test(next) || JOIN.test(next)) ? next : "/today");

/** A sign-in step, keeping where to continue afterwards when that isn't Today. */
export const withNext = (step: AuthStep, next: string | null | undefined): string => {
  const to = safeNext(next);
  return to === "/today" ? step : `${step}?next=${encodeURIComponent(to)}`;
};

/*
 * The desktop app finishes email links (sign-up confirmation, password reset) in whichever browser opens
 * them, while you continue in the app's window. The link's destination waits here for the window.
 */
const g = globalThis as unknown as { __pacedmindAfterSignIn?: { next: string; at: number } };

export function rememberNext(next: string) {
  g.__pacedmindAfterSignIn = { next: safeNext(next), at: Date.now() };
}

/** Where to go once signed in with two factors: where an email link pointed (within 30 minutes), else Today. */
export function takeNext(): string {
  const saved = g.__pacedmindAfterSignIn;
  g.__pacedmindAfterSignIn = undefined;
  return saved && Date.now() - saved.at < 30 * 60_000 ? saved.next : "/today";
}

/*
 * Signing in with Google, when the project has it switched on (Authentication → Sign In / Providers in Supabase). The
 * sign-in page asks Supabase, so the button appears once Google is set up there and not before: a button that led to
 * "provider is not enabled" would be worse than none.
 */
const providers = globalThis as unknown as { __pacedmindGoogle?: { on: boolean; at: number } };

export async function googleSignIn(): Promise<boolean> {
  const cached = providers.__pacedmindGoogle;
  if (cached && Date.now() - cached.at < 5 * 60_000) return cached.on;
  let on = false;
  try {
    const { url, key } = supabaseConfig();
    const res = await fetch(`${url}/auth/v1/settings`, { headers: { apikey: key }, signal: AbortSignal.timeout(4000) });
    on = res.ok && (await res.json())?.external?.google === true;
  } catch {
    // Unreachable for now: no button this time, and ask again next time.
    return false;
  }
  providers.__pacedmindGoogle = { on, at: Date.now() };
  return on;
}
