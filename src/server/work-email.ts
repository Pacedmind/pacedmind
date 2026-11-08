import "server-only";
import type { Language } from "@/lib/i18n";
import { supabase } from "./supabase";

export interface WorkEmailState {
  email: string | null;
  pendingEmail: string | null;
}

export async function getWorkEmail(): Promise<WorkEmailState> {
  const { data, error } = await (await supabase()).rpc("get_work_email");
  if (error) throw new Error(error.message);
  return {
    email: typeof data?.email === "string" ? data.email : null,
    pendingEmail: typeof data?.pending_email === "string" ? data.pending_email : null,
  };
}

export async function requestWorkEmail(email: string, language: Language): Promise<void> {
  const { data, error } = await (await supabase()).functions.invoke("work-email", { body: { email, language } });
  if (!error && data?.sent === true) return;
  if (error?.context instanceof Response) {
    const body = await error.context.json().catch(() => null);
    if (typeof body?.error === "string") throw new Error(body.error);
  }
  throw new Error("Couldn't send the verification code. Try again in a moment.");
}

export async function confirmWorkEmail(email: string, code: string): Promise<void> {
  const { data, error } = await (await supabase()).rpc("confirm_work_email", { target_email: email, code });
  if (error) throw new Error(error.message);
  if (data === "verified") return;
  if (data === "wrong") throw new Error("That verification code is incorrect.");
  if (data === "in_use") throw new Error("This address is already confirmed on a PacedMind account.");
  throw new Error("Request a new verification code.");
}

export async function removeWorkEmail(): Promise<void> {
  const { error } = await (await supabase()).rpc("remove_work_email");
  if (error) throw new Error(error.message);
}
