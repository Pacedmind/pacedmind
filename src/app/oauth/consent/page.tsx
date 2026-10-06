import { getTranslation } from "@/server/i18n";
import { createTranslator, type Translator } from "@/lib/i18n";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { MODE, authState, supabase } from "@/server/supabase";
import { cloudMcpUrl } from "@/server/supabase-config";
import { nextStep, withNext } from "@/server/auth-flow";
import { computerAccessProblem } from "@/server/computer-access";
import { AuthShell } from "@/app/login/shell";
import { ConsentForm } from "./consent-form";
import { isLoopbackCallback } from "@/lib/oauth-callback";

export async function generateMetadata(): Promise<Metadata> {
  const tx = await getTranslation();
  return { title: tx("Connect an agent · PacedMind") };
}

const REQUEST = /^[A-Za-z0-9_-]{1,200}$/;

/** Where the agent's sign-in goes back to, for the page: its host, and whether that's this computer. */
function destination(uri: string, tx: Translator = createTranslator("en")): { host: string; local: boolean } {
  try {
    const u = new URL(uri);
    return { host: u.host || u.protocol.replace(/:$/, ""), local: isLoopbackCallback(uri) };
  } catch {
    return { host: tx("an unknown address"), local: false };
  }
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-4 rounded-xl border border-line bg-panel p-6">
      <h1 className="text-[15px] font-semibold text-strong">{title}</h1>
      {children}
    </div>
  );
}

/**
 * Supabase Auth's OAuth server sends an agent's sign-in here (PacedMind Cloud's MCP server, the hosted app): you
 * sign in with your second factor if you haven't, see which agent asks, and allow or deny it.
 */
export default async function ConsentPage(props: PageProps<"/oauth/consent">) {
  const tx = await getTranslation();
  await connection();
  if (MODE !== "web") notFound();
  const sp = await props.searchParams;
  const id = typeof sp.authorization_id === "string" && REQUEST.test(sp.authorization_id) ? sp.authorization_id : null;
  if (!id) {
    return (
      <AuthShell note={tx("Connect an agent to PacedMind.")}>
        <Card title={tx("That link isn't complete")}>
          <p className="text-[13px] leading-relaxed text-fg3">{tx("Start connecting the agent again from Claude Code, Codex or the app you use.")}</p>
        </Card>
      </AuthShell>
    );
  }
  const state = await authState();
  const step = nextStep(state);
  if (step) redirect(withNext(step, `/oauth/consent?authorization_id=${id}`));

  // Supabase remembers agents you allowed before and approves them again by itself; its answer then is where to
  // send the agent, which waits here until you choose.
  const db = await supabase();
  const { data, error } = await db.auth.oauth.getAuthorizationDetails(id);
  if (error || !data) {
    return (
      <AuthShell note={tx("Connect an agent to PacedMind.")}>
        <Card title={tx("This request has expired")}>
          <p className="text-[13px] leading-relaxed text-fg3">
            {tx("It was already used, or it waited too long. Start connecting the agent again: in Claude Code,")}<span className="font-mono">/mcp</span>; in Codex, <span className="font-mono">codex mcp login pacedmind</span>.
          </p>
        </Card>
      </AuthShell>
    );
  }
  const details = "authorization_id" in data ? data : null;
  const held = "redirect_url" in data ? data.redirect_url : null;
  const name = details?.client.name?.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 100).trim() || null;
  const to = destination(details?.redirect_uri ?? held ?? "", tx);
  // The MCP server the agent gets: this app's own. Where the sign-in goes back to (`to`) is the agent's, not the server.
  const server = new URL(cloudMcpUrl()).host;
  const computerAccess = !(await computerAccessProblem());

  return (
    // Re-reading a consumed authorization would replace the completion screen with an expired-request error.
    <AuthShell note={<>{tx("Signed in as")}{" "}{state!.user.email}.</>} liveRefresh={false}>
      <ConsentForm id={id} held={held} name={name} local={to.local}>
        <h1 className="text-[15px] font-semibold text-strong">{name ? tx("Allow {0} to use PacedMind?", [name]) : tx("Allow this agent to use PacedMind again?")}</h1>
        <p className="text-[13px] leading-relaxed text-fg3">
          {tx("It will act as you in PacedMind Cloud: read and change your areas, projects, tasks and calendar, and report on agent sessions. It can't answer for you, change your computers or delete your account.")}</p>
        <p className="text-[13px] leading-relaxed text-fg3">{computerAccess
          ? tx("It may ask computers that accept requests without a fresh code to start sessions or use folders. Each computer's own settings and approvals still apply.")
          : tx("This connection has planner access only. To let it request sessions or folders on computers later, set up two-factor sign-in, sign in again and reconnect it.")}</p>
        <div className="flex flex-col gap-1.5 rounded-md border border-line2 px-3 py-2.5 text-[12.5px] text-fg3">
          <span>{tx("Connects to")}{" "}<span className="font-mono text-fg2">{server}</span> {" "}{tx("(PacedMind Cloud)")}</span>
          <span>
            {to.local ? tx("Hands the sign-in back to the agent on this computer") : tx("Hands the sign-in back to")}
            {" "}<span className="font-mono text-fg2">{to.host}</span>
            {to.local ? tx(", where it waits for it only while it signs in") : ""}
          </span>
          {!to.local && <span className="text-fg">{tx("Only allow an agent that returns somewhere you recognize.")}</span>}
        </div>
        <p className="text-[12px] leading-relaxed text-mut2">
          {tx("Only allow this if you just connected an agent yourself. You can disconnect it any time in Settings.")}</p>
      </ConsentForm>
    </AuthShell>
  );
}
