import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { nextStep } from "./auth-flow";
import { readAuthState, supabase } from "./supabase";
import { supabaseConfig } from "./supabase-config";
import type { SsoConfig } from "./sso-config";
import type { AccountSteps, SessionSteps } from "./sso";

/*
 * The Supabase side of signing in through your organisation. Starting a session for an account without its password
 * and without sending an email takes the project's secret key: Auth's admin API makes a magic link's one-time token,
 * which the browser's own client then verifies like any email link, so the session lands in the usual cookies. The
 * key is used here and nowhere else, only by the sign-in routes, and only after the identity token verified. The
 * session's mark, the sign-in kept between the callback and the finish, and the links between the issuer's people and
 * accounts are written by database functions only that key may call (supabase/migrations/*_issuer_sign_in.sql); the
 * one exception, confirming a link, runs with the browser's own session, since that session is the proof it needs.
 */

function adminClient(config: SsoConfig): SupabaseClient {
  return createClient(supabaseConfig().url, config.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

/** What Supabase said, without anything that could carry a token or a key. */
const failed = (what: string, error: { message?: string; code?: string } | null | undefined) =>
  new Error(`${what} failed${error?.code ? ` (${error.code})` : ""}.`);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function accountSteps(config: SsoConfig): AccountSteps {
  const admin = adminClient(config);
  return {
    async claimToken(tokenId, expiresAt) {
      const { data, error } = await admin.rpc("issuer_claim_token", { token_id: tokenId, expires_at: new Date(expiresAt * 1000).toISOString() });
      if (error || typeof data !== "boolean") throw failed("Using up the identity token", error);
      return data;
    },
    async linkAccount(identity) {
      const { data, error } = await admin.rpc("issuer_link_account", { issuer: identity.issuer, subject: identity.subject, email: identity.email });
      if (error || !data || typeof data !== "object") throw failed("Finding the account", error);
      const answer = data as { user_id?: unknown; refused?: unknown };
      if (answer.refused === "account_linked" || answer.refused === "account_unconfirmed" || answer.refused === "account_ambiguous") {
        return { refused: answer.refused };
      }
      if (answer.user_id === null) return { userId: null };
      if (typeof answer.user_id === "string") return { userId: answer.user_id };
      throw failed("Finding the account", null);
    },
    async createAccount(identity) {
      const { error } = await admin.auth.admin.createUser({
        email: identity.email,
        // The issuer verified the address (email_verified), and only verified addresses get here.
        email_confirm: true,
        ...(identity.name.trim() ? { user_metadata: { full_name: identity.name.trim() } } : {}),
      });
      // Another sign-in of the same person may have created it a moment ago: linking again finds it.
      if (error && error.code !== "email_exists" && error.code !== "user_already_exists") throw failed("Creating the account", error);
    },
    async beginHandoff(handoffId, identity, userId, next) {
      const { error } = await admin.rpc("issuer_begin_handoff", {
        handoff: handoffId, token_id: identity.tokenId, issuer: identity.issuer, subject: identity.subject, account: userId,
        verified_at: new Date(identity.issuedAt * 1000).toISOString(), next,
      });
      if (error) throw failed("Keeping the sign-in", error);
    },
  };
}

/** The session id in an access token Supabase just handed this server. */
function sessionIdOf(accessToken: string): string | null {
  try {
    const claims = JSON.parse(Buffer.from(accessToken.split(".")[1] ?? "", "base64url").toString("utf8"));
    return typeof claims?.session_id === "string" ? claims.session_id : null;
  } catch {
    return null;
  }
}

export function sessionSteps(config: SsoConfig): SessionSteps {
  const admin = adminClient(config);
  return {
    async openHandoff(handoffId) {
      const { data, error } = await admin.rpc("issuer_open_handoff", { handoff: handoffId });
      if (error) throw failed("Opening the sign-in", error);
      if (data === null) return null;
      const v = data as { user_id?: unknown; linked?: unknown; next?: unknown };
      if (typeof v.user_id !== "string" || !UUID.test(v.user_id) || typeof v.linked !== "boolean" || typeof v.next !== "string") {
        throw failed("Opening the sign-in", null);
      }
      return { userId: v.user_id, linked: v.linked, next: v.next };
    },
    async confirmLink(handoffId) {
      const db = await supabase();
      // Signed out (or signed in only to the sign-in page's own cookies): nothing here can confirm anything.
      const { data: claims } = await db.auth.getClaims();
      if (!claims?.claims) return false;
      const { data, error } = await db.rpc("issuer_confirm_link", { handoff: handoffId });
      if (error) throw failed("Confirming the link", error);
      return data === true;
    },
    async replaceSession(userId) {
      const found = await admin.auth.admin.getUserById(userId);
      const email = found.data.user?.email;
      if (found.error || !email) throw failed("Reading the account", found.error);
      // generateLink only makes the link; it sends nothing. Its token is used at once, below, and never leaves here.
      const link = await admin.auth.admin.generateLink({ type: "magiclink", email });
      const hashedToken = link.data.properties?.hashed_token;
      if (link.error || link.data.user?.id !== userId || !hashedToken) throw failed("Making the sign-in", link.error);
      const db = await supabase();
      // Whoever was signed in here before stops being: their session ends on the server too, not just in this browser.
      await db.auth.signOut({ scope: "local" });
      const { data, error } = await db.auth.verifyOtp({ type: "magiclink", token_hash: hashedToken });
      const sessionId = data.session ? sessionIdOf(data.session.access_token) : null;
      if (error || data.user?.id !== userId || !sessionId) {
        if (data.session) await db.auth.signOut({ scope: "local" });
        throw failed("Starting the session", error);
      }
      return sessionId;
    },
    async markSession(sessionId, handoffId) {
      const { error } = await admin.rpc("issuer_mark_session", { session: sessionId, handoff: handoffId });
      if (error) throw failed("Marking the session", error);
    },
    async sessionMarked(userId) {
      // The same reading every page makes (readAuthState, issuer_session()), so what it accepts here they accept too.
      const state = await readAuthState();
      return !!state?.issuer && state.user.id === userId && nextStep(state) === null;
    },
    async endSession() {
      await (await supabase()).auth.signOut({ scope: "local" });
    },
  };
}
