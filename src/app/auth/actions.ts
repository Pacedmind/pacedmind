"use server";

import { redirect } from "next/navigation";
import { refresh } from "next/cache";
import { headers } from "next/headers";
import { createClient } from "@supabase/supabase-js";
import { isNativeCompanion } from "@/lib/native-client";
import { MODE, readAuthState, requireAal2, requirePlannerAccess, supabase } from "@/server/supabase";
import { supabaseConfig } from "@/server/supabase-config";
import { nextStep, safeNext, takeNext, withNext } from "@/server/auth-flow";
import { ISSUER_MANAGED, STEP_UP_REFUSED, codeFreshUntil, issuerStepUp, refusedStepUp, verifyCode } from "@/server/step-up";
import { ssoLabel } from "@/server/sso-config";
import { requireDesktopWindow } from "@/server/window";
import { deviceConfig, updateDevice } from "@/server/device";
import { cutOffAgents } from "@/server/requests";
import * as repo from "@/server/repo";

/*
 * Signing in, optional MFA enrollment and security settings. Once enrolled, sign-in requires a code.
 * Computer control independently requires established MFA. Sensitive actions use MFA when enrolled;
 * an unenrolled account can delete itself after fresh password/recovery authentication.
 */

type AuthResult = { ok: boolean; error?: string; message?: string };

const clean = (email: string) => email.trim().toLowerCase();
const looksLikeEmail = (email: string) => /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{2,}$/.test(email) && email.length <= 254;
const CODE = /^\d{6}$/;

/** Passwords: 12 characters or more. bcrypt reads only the first 72 bytes, so longer ones add nothing. */
function passwordProblem(password: string): string | null {
  if (password.length < 12) return "Use a password of at least 12 characters.";
  if (Buffer.byteLength(password, "utf8") > 72) return "Use a password of at most 72 characters.";
  if (/^(.)\1+$/.test(password)) return "Use a password that isn't one character repeated.";
  return null;
}

/** Supabase's messages, in the app's voice where they're common. Never says whether an account exists. */
function explain(message: string): string {
  if (/invalid login credentials/i.test(message)) return "That email and password don't match an account.";
  if (/email not confirmed/i.test(message)) return "Confirm your email first: open the link we sent you.";
  if (/rate limit|too many|over_request/i.test(message)) return "Too many tries in a short time. Wait a few minutes and try again.";
  if (/pwned|leaked|compromised|known to be weak/i.test(message)) return "That password appears in known data breaches. Choose another one.";
  if (/weak|password should/i.test(message)) return "Choose a stronger password: at least 12 characters, not a common one.";
  if (/invalid totp|invalid code|expired|challenge/i.test(message)) return "That code didn't work. Codes change every 30 seconds; enter the current one.";
  if (/insufficient_aal|aal2/i.test(message)) return "Enter your two-factor code first.";
  if (/same.*password|different from the old/i.test(message)) return "Choose a password you haven't used here before.";
  return message;
}

/**
 * Where email links and Google land: this server's own address (desktop), or the hosted app's (web). `via` tells
 * the callback it's Google coming back, not an email link.
 */
async function callbackUrl(next: string, via?: "google"): Promise<string> {
  const base = MODE === "desktop"
    ? `http://127.0.0.1:${Number(process.env.PORT) || 4319}`
    : (process.env.ORGANIZER_PUBLIC_ORIGIN ?? "").replace(/\/+$/, "");
  if (!base) throw new Error("Set ORGANIZER_PUBLIC_ORIGIN for the hosted app (see .env.example).");
  const native = MODE === "web" && isNativeCompanion((await headers()).get("user-agent"));
  return `${base}/auth/callback?next=${encodeURIComponent(next)}${via ? `&via=${via}` : ""}${native ? "&native=1" : ""}`;
}

/** The desktop app's sign-in pages live in its window only. */
async function guard() {
  if (MODE === "desktop") await requireDesktopWindow();
}

async function goNext(nextParam?: string | null): Promise<never> {
  refresh();
  // Read again, not from this request's cache: signing in just changed it.
  const state = await readAuthState();
  const step = nextStep(state);
  if (step) redirect(MODE === "desktop" ? step : withNext(step, nextParam));
  redirect(MODE === "desktop" ? takeNext() : safeNext(nextParam));
}

/* ---------- signing in ---------- */

/**
 * Signing in with Google, which also makes the account the first time. Answers Google's page, which the sign-in page
 * opens: in the desktop app that's the browser (its window sends pages from elsewhere there), and Google comes back to
 * /auth/callback on this server, which alone holds the PKCE verifier to finish it. The authenticator's code is asked
 * next, as after a password: Google only stands in for the password.
 */
export async function signInWithGoogleAction(next?: string | null): Promise<AuthResult & { url?: string }> {
  await guard();
  const db = await supabase();
  const { data, error } = await db.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: await callbackUrl(MODE === "desktop" ? "/today" : safeNext(next), "google"),
      skipBrowserRedirect: true,
      // Pick the Google account each time, rather than the browser's current one without asking.
      queryParams: { prompt: "select_account" },
    },
  });
  // Supabase's own page, which goes on to Google's.
  if (error || !data?.url?.startsWith(`${supabaseConfig().url}/auth/v1/authorize?`)) {
    return { ok: false, error: error ? explain(error.message) : "Google sign-in isn't available right now." };
  }
  return {
    ok: true,
    url: data.url,
    message: MODE === "desktop" ? "Finish signing in with Google in your browser; PacedMind continues here once you have." : undefined,
  };
}

/** `next`: the hosted app's page to continue to once signed in (approving an agent's sign-in). */
export async function signInAction(email: string, password: string, next?: string | null): Promise<AuthResult> {
  await guard();
  if (!looksLikeEmail(clean(email)) || !password) return { ok: false, error: "Enter your email and password." };
  const db = await supabase();
  const { error } = await db.auth.signInWithPassword({ email: clean(email), password });
  if (error) return { ok: false, error: explain(error.message) };
  return goNext(next);
}

/**
 * `next`, as for signing in: an account made while an agent waits to be allowed goes on to that page once its email
 * is confirmed and its two-factor sign-in set up (the email's link carries it, checked again by the callback).
 */
export async function signUpAction(email: string, password: string, next?: string | null): Promise<AuthResult> {
  await guard();
  if (!looksLikeEmail(clean(email))) return { ok: false, error: "Enter your email address." };
  const problem = passwordProblem(password);
  if (problem) return { ok: false, error: problem };
  const db = await supabase();
  const after = MODE === "desktop" ? "/today" : safeNext(next);
  const { data, error } = await db.auth.signUp({ email: clean(email), password, options: { emailRedirectTo: await callbackUrl(after) } });
  if (error) return { ok: false, error: explain(error.message) };
  // Only when the project doesn't ask to confirm emails (it should).
  if (data.session) return goNext(next);
  return { ok: true, message: `If ${clean(email)} can get an account, we sent it a link. Open it to confirm your email and start planning. You can set up two-factor sign-in later in Settings.` };
}

export async function sendResetAction(email: string): Promise<AuthResult> {
  await guard();
  if (!looksLikeEmail(clean(email))) return { ok: false, error: "Enter your email address." };
  const db = await supabase();
  const { error } = await db.auth.resetPasswordForEmail(clean(email), { redirectTo: await callbackUrl("/login/new-password") });
  if (error && /rate limit|too many/i.test(error.message)) return { ok: false, error: explain(error.message) };
  return { ok: true, message: `If an account uses ${clean(email)}, we sent it a link to choose a new password.` };
}

/**
 * The sign-in screen's other way in (desktop only): this computer's own data, without an account. The app
 * remembers the choice and opens with that data until someone signs in.
 */
export async function continueWithoutAccountAction(): Promise<void> {
  if (MODE !== "desktop") redirect("/login");
  await guard();
  const state = await readAuthState();
  if (state) redirect(nextStep(state) ?? "/today");
  if (!deviceConfig().withoutAccount) updateDevice({ withoutAccount: true });
  refresh();
  redirect("/today");
}

/* ---------- the second factor ---------- */

export async function verifyAction(code: string, factorId?: string | null, next?: string | null): Promise<AuthResult> {
  await guard();
  const db = await supabase();
  const problem = await verifyCode(db, code, factorId);
  if (problem) return { ok: false, error: problem };
  return goNext(next);
}

/** A backup code instead of the app (only when the project offers backup codes). */
export async function recoveryCodeAction(code: string, next?: string | null): Promise<AuthResult> {
  await guard();
  const db = await supabase();
  const trimmed = code.trim();
  if (trimmed.length < 8 || trimmed.length > 40) return { ok: false, error: "Enter one of your backup codes." };
  const { error } = await db.auth.mfa.recoveryCodes.verify({ code: trimmed });
  if (error) return { ok: false, error: /locked/i.test(error.message) ? "Too many wrong backup codes. Wait a while and try again." : "That backup code didn't work." };
  return goNext(next);
}

export interface Enrollment {
  factorId: string;
  /** An SVG image (data URI) of the QR code. */
  qr: string;
  secret: string;
  /** The same as an otpauth:// link, which opens an authenticator app on a phone (it can't scan its own screen). */
  uri: string;
}

/**
 * Starts adding an authenticator app: returns the QR code and secret to scan or type in. The first one is how
 * a new account gets to two factors; another one needs a current code from one it already has.
 */
export async function startEnrollAction(code?: string): Promise<AuthResult & { enrollment?: Enrollment }> {
  await guard();
  const db = await supabase();
  const state = await readAuthState();
  if (!state) return { ok: false, error: "Sign in first." };
  if (state.issuer) return { ok: false, error: ISSUER_MANAGED };
  if (state.factors.length) {
    if (state.aal !== "aal2") return { ok: false, error: "Enter your two-factor code first." };
    const wrong = await verifyCode(db, code ?? "");
    if (wrong) return { ok: false, error: wrong };
  }
  // Unfinished attempts would block a new one with the same name (and count toward the limit of ten).
  const { data: listed } = await db.auth.mfa.listFactors();
  for (const f of listed?.all ?? []) if (f.status === "unverified") await db.auth.mfa.unenroll({ factorId: f.id });
  const n = (listed?.totp.length ?? 0) + 1;
  const { data, error } = await db.auth.mfa.enroll({
    factorType: "totp", issuer: "PacedMind", friendlyName: `Authenticator ${n} · ${new Date().toISOString().slice(0, 10)} ${Date.now() % 10000}`,
  });
  if (error || !data) return { ok: false, error: explain(error?.message ?? "Couldn't start setting up the app.") };
  return { ok: true, enrollment: { factorId: data.id, qr: data.totp.qr_code, secret: data.totp.secret, uri: data.totp.uri } };
}

/** Finishes adding an authenticator with its first code; the session is then two-factor. */
export async function confirmEnrollAction(factorId: string, code: string): Promise<AuthResult> {
  await guard();
  const digits = code.replace(/\s+/g, "");
  if (!CODE.test(digits)) return { ok: false, error: "Enter the 6-digit code the app shows now." };
  if ((await readAuthState())?.issuer) return { ok: false, error: ISSUER_MANAGED };
  const db = await supabase();
  const { error } = await db.auth.mfa.challengeAndVerify({ factorId, code: digits });
  if (error) return { ok: false, error: explain(error.message) };
  // No refresh here: the page shows what's next (a second authenticator, or on to the app) and moves on itself.
  return { ok: true };
}

/* ---------- the account's security (Settings) ---------- */

/** A new password after a reset link, and only then: the link's session knows it came from your email. */
export async function setNewPasswordAction(password: string): Promise<AuthResult> {
  await guard();
  const state = await requirePlannerAccess();
  const fromLink = state.amr.some((a) => a.method === "recovery" && Date.now() / 1000 - a.timestamp < 60 * 60);
  if (!fromLink) return { ok: false, error: "Change your password in Settings, or ask for a new reset link." };
  const problem = passwordProblem(password);
  if (problem) return { ok: false, error: problem };
  const db = await supabase();
  const { error } = await db.auth.updateUser({ password });
  if (error) return { ok: false, error: explain(error.message) };
  refresh();
  redirect("/today");
}

/**
 * Needs the current password and a current code. The project also asks Supabase itself for the current
 * password (SECURITY.md), so a stolen session can't change it by calling Supabase directly.
 */
export async function changePasswordAction(current: string, password: string, code: string): Promise<AuthResult> {
  await guard();
  const state = await requirePlannerAccess();
  if (state.issuer) return { ok: false, error: ISSUER_MANAGED };
  if (!current) return { ok: false, error: "Enter your current password." };
  const problem = passwordProblem(password);
  if (problem) return { ok: false, error: problem };
  const db = await supabase();
  if (state.mfaEnabled) {
    const wrong = await verifyCode(db, code);
    if (wrong) return { ok: false, error: wrong };
  }
  const { error } = await db.auth.updateUser({ password, current_password: current });
  if (error) return { ok: false, error: explain(error.message) };
  refresh();
  return { ok: true, message: "Password changed. Other devices were signed out." };
}

export async function removeFactorAction(factorId: string, code: string): Promise<AuthResult> {
  await guard();
  const state = await requireAal2();
  if (state.issuer) return { ok: false, error: ISSUER_MANAGED };
  const totp = state.factors.filter((f) => f.factor_type === "totp");
  if (!totp.some((f) => f.id === factorId)) return { ok: false, error: "That authenticator isn't on your account." };
  if (totp.length < 2) return { ok: false, error: "Keep one authenticator to protect your account and computer access. Add a replacement before removing this one." };
  const db = await supabase();
  // The code has to come from an authenticator that stays.
  const wrong = await verifyCode(db, code, totp.find((f) => f.id !== factorId)!.id);
  if (wrong) return { ok: false, error: wrong };
  const { error } = await db.auth.mfa.unenroll({ factorId });
  if (error) return { ok: false, error: explain(error.message) };
  refresh();
  return { ok: true, message: "Authenticator removed." };
}

export async function signOutAction(): Promise<void> {
  await guard();
  if (MODE === "desktop") cutOffAgents();
  const db = await supabase();
  await db.auth.signOut({ scope: "local" });
  refresh();
  // The sign-in screen, where the desktop app also offers this computer's own data.
  redirect("/login");
}

/** Signs out every browser and computer, this one included. */
export async function signOutEverywhereAction(): Promise<void> {
  await guard();
  const db = await supabase();
  if (MODE === "desktop") cutOffAgents();
  await db.auth.signOut({ scope: "global" });
  refresh();
  redirect("/login");
}

/** Signs a computer out of the account: its session ends at once and its agents lose access. */
export async function revokeDeviceAction(deviceId: string): Promise<AuthResult> {
  await guard();
  await requireAal2();
  try {
    await repo.revokeDevice(deviceId);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  if (MODE === "desktop" && deviceConfig().deviceId === deviceId) {
    cutOffAgents();
    await (await supabase()).auth.signOut({ scope: "local" });
    refresh();
    redirect("/login");
  }
  refresh();
  return { ok: true, message: "Signed out that computer." };
}

/** An email confirmation path for accounts without a password (for example Google sign-in). */
export async function sendDeletionLinkAction(): Promise<AuthResult> {
  await guard();
  const state = await requirePlannerAccess();
  if (state.issuer) return { ok: false, error: issuerStepUp(ssoLabel()) };
  if (state.mfaEnabled) return { ok: false, error: "Use your authenticator code to confirm account deletion." };
  if (!state.user.email) return { ok: false, error: "Your account has no email address." };
  const { error } = await (await supabase()).auth.resetPasswordForEmail(state.user.email, {
    redirectTo: await callbackUrl("/settings/account"),
  });
  if (error) return { ok: false, error: explain(error.message) };
  return { ok: true, message: "Open the confirmation link in your email, then return to Delete account within five minutes. You don't need to change your password." };
}

export async function deleteAccountAction(proof: string, confirmEmail: string): Promise<AuthResult> {
  await guard();
  const state = await requirePlannerAccess();
  if (clean(confirmEmail) !== clean(state.user.email ?? "")) return { ok: false, error: "Type your account's email to confirm." };
  const db = await supabase();
  let deletionClient = db;
  if (state.issuer) {
    // Signed in through your organisation: its fresh round-trip (a code entered there in the last few minutes, asked
    // for with max_age) confirms, never a code or a password of PacedMind's. The database checks the same
    // (private.recent_mfa).
    const until = codeFreshUntil(state);
    if (!until || until <= Date.now()) return { ok: false, error: issuerStepUp(ssoLabel()) };
  } else if (state.mfaEnabled) {
    const wrong = await verifyCode(db, proof);
    if (wrong) return { ok: false, error: wrong };
  } else if (proof) {
    // Reauthenticate without replacing this window's session or its PKCE verifier.
    const { url, key } = supabaseConfig();
    deletionClient = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
    const { data, error } = await deletionClient.auth.signInWithPassword({ email: state.user.email!, password: proof });
    if (error || data.user?.id !== state.user.id) {
      await deletionClient.auth.signOut({ scope: "local" });
      return { ok: false, error: "That password didn't work. You can confirm by email instead." };
    }
  }
  try {
    const { error } = await deletionClient.rpc("delete_account");
    if (error) return { ok: false, error: refusedStepUp(error.message) || /fresh|recent|authentication/i.test(error.message)
      ? state.issuer ? issuerStepUp(ssoLabel()) : state.mfaEnabled ? STEP_UP_REFUSED : "Confirm with your current password or a new email confirmation link, then try again within five minutes."
      : explain(error.message) };
  } finally {
    if (deletionClient !== db) await deletionClient.auth.signOut({ scope: "local" });
  }
  if (MODE === "desktop") cutOffAgents();
  await db.auth.signOut({ scope: "local" });
  refresh();
  redirect("/login");
}
