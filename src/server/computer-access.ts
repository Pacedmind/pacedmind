import "server-only";
import { cache } from "react";
import { COMPUTER_MFA_REQUIRED } from "@/lib/auth-access";
import { MODE, authState, supabase } from "./supabase";

/** Authoritative check, including revoked sessions and factors added after this sign-in. */
export const computerAccessProblem = cache(async (): Promise<string | null> => {
  const state = await authState();
  if (!state) return MODE === "desktop" ? null : "Sign in to PacedMind first.";
  // A session made through your organisation's sign-in had the issuer's two-factor check instead.
  if (!state.clientId && !state.mfaEnabled && !state.issuer) return COMPUTER_MFA_REQUIRED;
  if (!state.clientId && state.aal !== "aal2") return "Finish signing in with your two-factor code first.";
  const { data, error } = await (await supabase()).rpc("can_control_computers");
  if (error) return "Couldn't verify access to computers. Try again in a moment.";
  if (data === true) return null;
  return state.clientId
    ? "This connection has planner access only. Set up two-factor sign-in, sign in again, then reconnect it to control computers."
    : "To control computers after setting up two-factor sign-in, sign out and sign in again with your code.";
});
