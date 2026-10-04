import "server-only";
import { nextStep } from "./auth-flow";
import { deviceConfig } from "./device";
import { MODE, type AuthState } from "./supabase";

/** A note stays with the store it was opened from, even when another account has the same task id. */
export function floatingTaskScope(state: AuthState | null): string | null {
  if (MODE !== "desktop") return null;
  if (state) return nextStep(state) ? null : state.user.id;
  return deviceConfig().withoutAccount ? "local" : null;
}
