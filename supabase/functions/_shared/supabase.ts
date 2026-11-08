import { createClient } from "npm:@supabase/supabase-js@2.117.2";

export function env(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(name + " isn't set in the Edge Function environment.");
  return value;
}

/** Prefer the project's new key maps, with the legacy JWT keys as a fallback. */
function key(kind: "publishable" | "secret"): string {
  const map = Deno.env.get(kind === "publishable" ? "SUPABASE_PUBLISHABLE_KEYS" : "SUPABASE_SECRET_KEYS");
  if (map) {
    try {
      const keys = JSON.parse(map) as Record<string, unknown>;
      const value = keys.default ?? Object.values(keys)[0];
      if (typeof value === "string" && value) return value;
    } catch {
      // Fall back to the project's legacy key.
    }
  }
  return env(kind === "publishable" ? "SUPABASE_ANON_KEY" : "SUPABASE_SERVICE_ROLE_KEY");
}

const auth = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false };

export function userDb(authorization: string) {
  return createClient(env("SUPABASE_URL"), key("publishable"), {
    auth, global: { headers: { Authorization: authorization } },
  });
}

/** Use for a function's own privileged writes. */
export function serviceDb() {
  return createClient(env("SUPABASE_URL"), key("secret"), { auth });
}
