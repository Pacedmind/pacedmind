import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import { supabaseConfig } from "./supabase-config";
import type { SsoConfig } from "./sso-config";
import type { AccountSteps, Handoff, SessionSteps } from "./sso";

/*
 * The Supabase side of signing in through your organisation. Starting a session for an account without its password
 * and without sending an email takes the project's secret key: Auth's admin API makes a magic link's one-time token,
 * which the browser's own client then verifies like any email link, so the session lands in the usual cookies. The
 * key is used here and nowhere else, only by the sign-in routes, and only after the identity token verified. The
 * session's mark and the links between the issuer's people and accounts are written by database functions only that
 * key may call (supabase/migrations/*_issuer_sign_in.sql).
 */

function adminClient(config: SsoConfig): SupabaseClient {
  return createClient(supabaseConfig().url, config.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

/** What Supabase said, without anything that could carry a token or a key. */
const failed = (what: string, error: { message?: string; code?: string } | null | undefined) =>
  new Error(`${what} failed${error?.code ? ` (${error.code})` : ""}.`);

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
    async signInToken(userId) {
      const found = await admin.auth.admin.getUserById(userId);
      const email = found.data.user?.email;
      if (found.error || !email) throw failed("Reading the account", found.error);
      // generateLink only makes the link; it sends nothing.
      const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email });
      if (error || data.user?.id !== userId || !data.properties?.hashed_token) throw failed("Making the sign-in", error);
      return data.properties.hashed_token;
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
  return {
    async replaceSession(hashedToken, userId) {
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
    async markSession(sessionId: string, handoff: Handoff) {
      const { error } = await adminClient(config).rpc("issuer_mark_session", {
        session: sessionId, account: handoff.userId, issuer: handoff.issuer, subject: handoff.subject,
        verified_at: new Date(handoff.verifiedAt * 1000).toISOString(),
      });
      if (error) throw failed("Marking the session", error);
    },
    async endSession() {
      await (await supabase()).auth.signOut({ scope: "local" });
    },
  };
}
