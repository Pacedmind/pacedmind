import { getTranslation } from "@/server/i18n";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { authState } from "@/server/supabase";
import { nextStep, safeNext, withNext } from "@/server/auth-flow";
import { AuthShell } from "../shell";
import { SetupForm } from "../forms";

export async function generateMetadata(): Promise<Metadata> {
  const tx = await getTranslation();
  return { title: tx("Two-factor sign-in · PacedMind") };
}

/** The first authenticator (required before anything else), or another one (?add=1, after signing in). */
export default async function SetupPage(props: PageProps<"/login/setup">) {
  const tx = await getTranslation();
  await connection();
  const state = await authState();
  const step = nextStep(state);
  const sp = await props.searchParams;
  const adding = sp.add === "1";
  // The hosted app: where sign-in continues once the authenticator is set up (approving an agent's sign-in).
  const next = typeof sp.next === "string" && safeNext(sp.next) !== "/today" ? safeNext(sp.next) : null;
  if (!state) redirect(withNext("/login", next));
  if (step === "/login/verify") redirect(withNext("/login/verify", next));
  const first = !state.mfaEnabled;
  if (!first && !adding) redirect(next ?? "/settings/security");
  return (
    <AuthShell note={first
      ? <>{tx("Protect")}{" "}{state.user.email} {" "}{tx("and unlock sessions on your computers. You can keep using the planner and MCP and set this up later.")}</>
      : tx("A second authenticator keeps you in if you lose the first one.")}>
      <SetupForm key={first ? "first" : "another"} first={first} email={state.user.email ?? ""} next={next} />
    </AuthShell>
  );
}
