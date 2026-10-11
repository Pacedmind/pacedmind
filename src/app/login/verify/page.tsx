import { getTranslation } from "@/server/i18n";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { authState } from "@/server/supabase";
import { nextStep, safeNext } from "@/server/auth-flow";
import { AuthShell } from "../shell";
import { VerifyForm } from "../forms";

export async function generateMetadata(): Promise<Metadata> {
  const tx = await getTranslation();
  return { title: tx("Two-factor code · PacedMind") };
}

export default async function VerifyPage(props: PageProps<"/login/verify">) {
  const tx = await getTranslation();
  await connection();
  const state = await authState();
  const step = nextStep(state);
  const sp = await props.searchParams;
  const next = typeof sp.next === "string" ? safeNext(sp.next) : null;
  if (step !== "/login/verify") redirect(step ?? next ?? "/today");
  const factors = state!.factors
    .filter((f) => f.factor_type === "totp")
    .map((f, i) => ({ id: f.id, name: f.friendly_name?.replace(/\s·.*$/, "") || tx("Authenticator {0}", [i + 1]) }));
  return (
    <AuthShell note={<>{tx("Signed in as")}{" "}{state!.user.email}{tx(". Enter the code from your authenticator app.")}</>}>
      <VerifyForm factors={factors} backupCodes={state!.hasRecoveryCodes} next={next} />
    </AuthShell>
  );
}
