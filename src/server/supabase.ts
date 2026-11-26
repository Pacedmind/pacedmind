import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { cache } from "react";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { createClient, type Factor, type SupabaseClient, type User } from "@supabase/supabase-js";
import { dataDir, deviceConfig, revokeAllSessionTokens, updateDevice } from "./device";
import { clearApprovals } from "./approval-store";
import { readSecureJson, removeFile, writeSecureJson } from "./secure-file";
import { COOKIE_OPTIONS, supabaseConfig } from "./supabase-config";
import { ssoConfig } from "./sso-config";
import { canUsePlanner } from "@/lib/auth-access";

/*
 * PacedMind keeps its data in Supabase. The server talks to it as the signed-in account, with the public
 * publishable key and the account's own session, so row level security decides what it can see. There is
 * no database password or secret key anywhere in the app. RLS permits basic planning before MFA enrollment,
 * requires MFA once enrolled, and separately restricts computer control (supabase/migrations).
 *
 * Two ways to run:
 * - "desktop" (the desktop app, and `npm run dev`): one account per server. Its session lives in an
 *   encrypted file next to the app's data, so everything the server does (the window, MCP calls from agents,
 *   session hooks, the background loop) acts as that account.
 * - "web" (the hosted app, ORGANIZER_MODE=web): every browser has its own session, in HttpOnly cookies. It
 *   never starts agents: sessions it asks for go to a desktop app as requests (launch_requests). Agents reach
 *   its MCP server with an OAuth token of their own (runAsAgent), which the database answers only once you
 *   explicitly approved that sign-in from an eligible human session (supabase/migrations/*_agent_logins.sql).
 */
export const MODE: "desktop" | "web" = process.env.ORGANIZER_MODE === "web" ? "web" : "desktop";

const AUTH_OPTIONS = { flowType: "pkce" as const, experimental: { recoveryCodes: true } };

/* ---------- desktop: one account, session in an encrypted file ---------- */

type Store = Record<string, string>;
const sessionFile = () => path.join(/*turbopackIgnore: true*/ dataDir(), "session.json");

const fileStorage = {
  getItem: (key: string) => readSecureJson<Store>(sessionFile())?.[key] ?? null,
  setItem: (key: string, value: string) => writeSecureJson(sessionFile(), { ...(readSecureJson<Store>(sessionFile()) ?? {}), [key]: value }),
  removeItem: (key: string) => {
    const data = readSecureJson<Store>(sessionFile()) ?? {};
    delete data[key];
    if (Object.keys(data).length) writeSecureJson(sessionFile(), data);
    else removeFile(sessionFile());
  },
};

const g = globalThis as unknown as { __pacedmindDesktop?: SupabaseClient };

/** The desktop server's one client. It refreshes its own session, so nothing else may hold that session. */
function desktopClient(): SupabaseClient {
  if (!g.__pacedmindDesktop) {
    const { url, key } = supabaseConfig();
    g.__pacedmindDesktop = createClient(url, key, {
      auth: { ...AUTH_OPTIONS, storage: fileStorage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    });
    // However the sign-in ends (signing out, a refresh the server refused), the agents lose PacedMind with it.
    g.__pacedmindDesktop.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") {
        revokeAllSessionTokens();
        clearApprovals();
      }
      // However it starts (a password, an email link), "without an account" stops being this computer's
      // choice, so the app asks again once the sign-in ends.
      if (event === "SIGNED_IN" && deviceConfig().withoutAccount) updateDevice({ withoutAccount: false });
    });
  }
  return g.__pacedmindDesktop;
}

/* ---------- web: every browser has its own session, in HttpOnly cookies ---------- */

const requestClient = cache(async (): Promise<SupabaseClient> => {
  const { url, key } = supabaseConfig();
  const store = await cookies();
  return createServerClient(url, key, {
    auth: AUTH_OPTIONS,
    cookieOptions: COOKIE_OPTIONS,
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try {
          for (const { name, value, options } of list) store.set(name, value, { ...options, ...COOKIE_OPTIONS });
        } catch {
          // Called while rendering a Server Component, which can't set cookies. The proxy refreshes the session.
        }
      },
    },
  });
});

/* ---------- web: an agent's MCP request, with its own OAuth token ---------- */

type AgentContext = { token: string; client?: SupabaseClient };
const agentContext = new AsyncLocalStorage<AgentContext>();

/**
 * Runs `fn` as the agent whose OAuth access token this is (the hosted MCP server): every query in it goes to
 * Supabase with that token, so row level security answers as that agent's sign-in, never as a browser's.
 */
export const runAsAgent = <T>(token: string, fn: () => T): T => agentContext.run({ token }, fn);

/** Whether this request is an agent's (the hosted MCP server). */
export const actingAsAgent = (): boolean => agentContext.getStore() !== undefined;

function agentClient(ctx: AgentContext): SupabaseClient {
  if (!ctx.client) {
    const { url, key } = supabaseConfig();
    ctx.client = createClient(url, key, {
      global: { headers: { Authorization: `Bearer ${ctx.token}` } },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
  }
  return ctx.client;
}

/** The Supabase client acting as the signed-in account (in the desktop app, the one account). */
export async function supabase(): Promise<SupabaseClient> {
  if (MODE === "desktop") return desktopClient();
  const agent = agentContext.getStore();
  return agent ? agentClient(agent) : requestClient();
}

/* ---------- who is signed in ---------- */

export type Aal = "aal1" | "aal2";

export interface AuthState {
  user: User;
  /**
   * aal2 once a second factor was verified in this session, or when the session was made through your organisation's
   * sign-in (`issuer`), whose own two-factor check stands in for the account's.
   */
  aal: Aal;
  /** The auth session (the JWT's session_id), which a device registration points at. */
  sessionId: string | null;
  /** Verified authenticator apps (TOTP) and passkeys. */
  factors: Factor[];
  /** Whether backup codes exist for this account. */
  hasRecoveryCodes: boolean;
  /** Any verified factor, including factors this UI cannot enroll, enforces MFA on sign-in. */
  mfaEnabled: boolean;
  /** How this session signed in and when (the JWT's amr claim, newest first). */
  amr: { method: string; timestamp: number }[];
  /** The OAuth client of an agent's sign-in (the hosted MCP server), null for a person's session. */
  clientId: string | null;
  /**
   * Set when this session was made through your organisation's sign-in (src/server/sso.ts), as the database records
   * it: `verifiedAt` (ms) is when the issuer last checked the person, which counts as a fresh code for a few minutes
   * (CODE_REUSE_MS in step-up.ts; five in the database).
   */
  issuer: { verifiedAt: number } | null;
}

/**
 * Whether the database marked this session as made through your organisation's sign-in, and when the issuer checked
 * (ms). Only the database's own record counts, which only the hosted app's sign-in writes; asked only of a person's
 * session that hasn't verified a code of its own, and only while the feature is on. Fails closed.
 */
async function issuerCheck(client: SupabaseClient, claims: Record<string, unknown>): Promise<{ verifiedAt: number } | null> {
  if (MODE !== "web" || !ssoConfig() || claims.aal === "aal2" || claims.client_id || typeof claims.session_id !== "string") return null;
  const { data, error } = await client.rpc("issuer_session");
  if (error || typeof data !== "string") return null;
  const at = Date.parse(data);
  return Number.isFinite(at) ? { verifiedAt: at } : null;
}

/**
 * The signed-in account and how far it got, or null. The web app verifies the session's token (getClaims)
 * and asks Auth for the user (which also notices a revoked session), a browser's from its cookies or an
 * agent's from its bearer token; the desktop app's session is its own encrypted file.
 */
export async function readAuthState(): Promise<AuthState | null> {
  const client = await supabase();
  let user: User | null = null;
  let claims: Record<string, unknown> | null = null;
  if (MODE === "desktop") {
    // getSession refreshes an expired token first.
    const { data, error } = await client.auth.getSession();
    // null means the local, no-account store throughout the server. A failed refresh or a
    // temporarily unreachable Auth server must never switch a Cloud account into that mode.
    if (error) throw new NotSignedIn("Couldn't verify your PacedMind sign-in. Try again in a moment, or sign out.");
    if (!data.session) return null;
    claims = decodeClaims(data.session.access_token);
    if (!claims || typeof claims.sub !== "string" || typeof claims.session_id !== "string" || !claims.session_id) {
      throw new NotSignedIn("Your PacedMind sign-in could not be read. Sign out and sign in again.");
    }
    // Fetch the live factors for this exact token, rather than its persisted user snapshot
    // or a different session that might have replaced it while Auth was being contacted.
    const verified = await client.auth.getUser(data.session.access_token);
    if (verified.error || !verified.data.user || verified.data.user.id !== claims.sub) {
      throw new NotSignedIn("Couldn't verify your PacedMind sign-in. Try again in a moment, or sign out.");
    }
    user = verified.data.user;
  } else {
    const token = agentContext.getStore()?.token;
    const { data } = await client.auth.getClaims(token);
    if (data?.claims) {
      claims = data.claims as Record<string, unknown>;
      user = (await client.auth.getUser(token)).data.user ?? null;
    }
  }
  if (!user || !claims) return null;
  const all = user.factors ?? [];
  const issuer = agentContext.getStore() ? null : await issuerCheck(client, claims);
  return {
    user,
    aal: claims.aal === "aal2" || issuer ? "aal2" : "aal1",
    sessionId: typeof claims.session_id === "string" ? claims.session_id : null,
    factors: all.filter((f) => f.status === "verified" && (f.factor_type === "totp" || f.factor_type === "webauthn")),
    hasRecoveryCodes: all.some((f) => f.status === "verified" && (f.factor_type as string) === "recovery_code"),
    mfaEnabled: all.some((f) => f.status === "verified"),
    amr: Array.isArray(claims.amr) ? (claims.amr as { method: string; timestamp: number }[]) : [],
    clientId: typeof claims.client_id === "string" && claims.client_id ? claims.client_id : null,
    issuer,
  };
}

/** readAuthState, once per request. After signing in or verifying a code, call readAuthState itself. */
export const authState = cache(readAuthState);

/** The payload of our own session's access token (desktop only: the token came from our own file). */
function decodeClaims(token: string): Record<string, unknown> | null {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

export async function currentUser(): Promise<User | null> {
  return (await authState())?.user ?? null;
}

export class NotSignedIn extends Error {
  constructor(message = "Sign in to PacedMind first.") {
    super(message);
  }
}

/** Basic account access. Enrolled accounts still have to finish their second factor. */
export async function requirePlannerAccess(): Promise<AuthState> {
  const state = await authState();
  if (!canUsePlanner(state)) throw new NotSignedIn(state ? "Finish signing in with your two-factor code first." : undefined);
  return state!;
}

/** The signed-in account after two-factor authentication; throws NotSignedIn otherwise. */
export async function requireAal2(): Promise<AuthState> {
  const state = await authState();
  if (!state) throw new NotSignedIn();
  if (state.clientId || state.aal !== "aal2") throw new NotSignedIn("Finish signing in with your two-factor code first.");
  return state;
}
