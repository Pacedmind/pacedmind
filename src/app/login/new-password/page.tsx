import { getTranslation } from "@/server/i18n";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { authState } from "@/server/supabase";
import { nextStep } from "@/server/auth-flow";
import { AuthShell } from "../shell";
import { NewPasswordForm } from "../forms";

export async function generateMetadata(): Promise<Metadata> {
  const tx = await getTranslation();
  return { title: tx("New password · PacedMind") };
}

/** After a password-reset link and the two-factor code (changing a password needs both). */
export default async function NewPasswordPage() {
  const tx = await getTranslation();
  await connection();
  const state = await authState();
  const step = nextStep(state);
  if (step) redirect(step === "/login" ? "/login" : `${step}?next=/login/new-password`);
  return (
    <AuthShell note={<>{tx("Signed in as")}{" "}{state!.user.email}.</>}>
      <NewPasswordForm />
    </AuthShell>
  );
}
