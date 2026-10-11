"use client";
import { useTranslation } from "@/components/language";
import { createTranslator, type Translator } from "@/lib/i18n";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

import { checkDeviceAction, connectAgentAction, renameDeviceAction, setDefaultDeviceAction, updateDeviceSettingsAction } from "@/app/actions";
import { revokeDeviceAction } from "@/app/auth/actions";
import { parseLocal, toDateStr } from "@/lib/dates";
import { REMOTE_START_LABEL, REMOTE_START_OPTIONS, fromElsewhereText, remoteCodeLabel } from "@/lib/from-elsewhere";
import {
  AGENT_LABEL, APP_LABEL, CLOUD_LABEL, deviceOnline, mcpReaches, platformName,
  type AgentId, type AgentTools, type Device, type RemoteStart, type ReportOutcome, type SessionStatus, type Surface,
} from "@/lib/types";
import { ConfirmDialog } from "../dialog";
import { InlineName } from "../entity-menu";
import { AgentIcon, Icon, SurfaceIcon, type IconName } from "../icons";
import { ToolIcon } from "../tool-icon";
import { Button, Segmented, Switch, cx, useAction } from "../ui";

/* ---------- data from the server ---------- */

/** A session at work or waiting for you, under the computer it runs on (or that sent it to the agent's cloud). */
export interface ComputerSession {
  id: string;
  status: SessionStatus;
  agent: AgentId;
  surface: Surface;
  /** Its computer. Without an account every session is this computer's. */
  deviceId: string | null;
  key: string | null;
  title: string | null;
  startedAt: string;
  finishedAt: string | null;
  /** How the agent handed the task back, for a session waiting for you. */
  outcome: ReportOutcome | null;
}

/* ---------- words ---------- */

const AGENTS: AgentId[] = ["claude", "codex"];

const MCP_TEXT = (tx: Translator) => ({ connected: tx("Connected"), old: tx("Old name"), cloud: "PacedMind Cloud", elsewhere: tx("Reports elsewhere"), missing: tx("Not connected") } as const);
const MCP_HINT = (tx: Translator) => ({
  connected: tx("Sessions in the agent's desktop app, and those you start yourself, report back to PacedMind."),
  old: tx("Set up under PacedMind's old MCP name, organizer: it works, and Connect sets it up as pacedmind."),
  cloud: tx("Sessions in the agent's desktop app, and those you start yourself, report to PacedMind Cloud's MCP server, signed in with your account."),
  elsewhere: tx("Set up for another PacedMind (a different address or token), so its desktop app's sessions report there."),
  missing: tx("Sessions in the agent's desktop app can't report back until it's connected, in the PacedMind desktop app on that computer."),
} as const);

/** How a CLI signed in, as the few words it says it in. Anything else shows as it came. */
function methodName(m: string | undefined, tx: Translator = createTranslator("en")): string | null {
  if (!m) return null;
  if (/^(claude\.?ai|claude[ _-]ai|oauth)$/.test(m)) return tx("Claude account");
  if (/^(chatgpt|chat[ _-]gpt)$/.test(m)) return "ChatGPT";
  if (/api[ _-]?key|console/.test(m)) return tx("API key");
  if (m === "bedrock") return "Amazon Bedrock";
  if (m === "vertex") return "Google Vertex AI";
  return m;
}

const planName = (p: string | undefined) => (p ? p.charAt(0).toUpperCase() + p.slice(1) : null);

/** "4 min ago", "3 h ago", "yesterday", "5 days ago" or "on 12 Sep". */
function ago(iso: string, now: number, tx: Translator = createTranslator("en")): string {
  const min = Math.floor((now - Date.parse(iso)) / 60_000);
  if (min < 1) return tx("just now");
  if (min < 60) return tx("{0} min ago", [min]);
  const h = Math.floor(min / 60);
  if (h < 24) return tx("{0} h ago", [h]);
  const days = Math.floor(h / 24);
  if (days < 7) return days === 1 ? tx("yesterday") : tx("{0} days ago", [days]);
  return tx("on {0}", [tx.date(new Date(iso), "d MMM")]);
}

/** "14:02" today, else "24 Sep". Session times are local stamps. */
const clock = (stamp: string, now: number, tx: Translator = createTranslator("en")) => {
  const d = parseLocal(stamp);
  return toDateStr(d) === toDateStr(new Date(now)) ? tx.date(d, "HH:mm") : tx.date(d, "d MMM");
};

function sessionMeta(s: ComputerSession, now: number, tx: Translator = createTranslator("en")): string {
  if (s.status === "finished") return s.outcome === "blocked" ? tx("stuck, needs you") : s.outcome === "partial" ? tx("partly done, waiting") : tx("waiting for you");
  return s.status === "starting" ? tx("starting") : tx("since {0}", [clock(s.startedAt, now, tx)]);
}

const where = (s: ComputerSession, tx: Translator = createTranslator("en")) => (s.surface === "cloud" ? tx(CLOUD_LABEL[s.agent]) : s.surface === "desktop" ? tx("the {0}", [tx(APP_LABEL[s.agent])]) : tx("a terminal"));

const SESSIONS_SHOWN = 6;

/* ---------- the view ---------- */

export function ComputersView({ devices, hereId, account, registering, sessions, mcpUrl, now: serverNow }: {
  /** The account's signed-in computers, this one first; without an account, just this one. */
  devices: Device[];
  /** This computer's id among them (the desktop app; "" without an account); null in the web app. */
  hereId: string | null;
  /** Signed in to PacedMind Cloud (the web app always is). */
  account: boolean;
  /** Signed in in the desktop app, but this computer hasn't joined the account's list yet (it does within seconds). */
  registering: boolean;
  sessions: ComputerSession[];
  /** This computer's MCP address, for connecting its agents; null in the web app. */
  mcpUrl: string | null;
  /** The server's clock (ms), so the first render matches it. */
  now: number;
}) {
  const tx = useTranslation();
  const router = useRouter();
  const { run, pending } = useAction();
  const [ticked, setTicked] = useState(serverNow);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [leaving, setLeaving] = useState<Device | null>(null);
  const now = Math.max(ticked, serverNow);
  const others = devices.some((d) => d.id !== hereId);

  // "Last seen" moves on by itself. A computer says it's there every minute, which changes nothing else, so no other
  // page refreshes for it: this one does, while it's in view, to keep the online dots true.
  useEffect(() => {
    const tick = window.setInterval(() => setTicked(Date.now()), 30_000);
    const reload = account && others
      ? window.setInterval(() => { if (document.visibilityState === "visible") router.refresh(); }, 60_000)
      : undefined;
    return () => {
      window.clearInterval(tick);
      window.clearInterval(reload);
    };
  }, [account, others, router]);

  const online = (d: Device) => d.id === hereId || deviceOnline(d, now);
  const onlineCount = devices.filter(online).length;
  const subtitle = !account ? tx("This computer")
    : devices.length ? tx("{0} signed in · {1} online", [devices.length, onlineCount]) : registering ? tx("Adding this computer") : tx("None signed in yet");

  const connect = (agent: AgentId) => {
    const what = agent === "claude" ? tx("Claude Code, for all projects") : tx("Codex's config.toml");
    if (confirm(tx("Add PacedMind ({0}) to {1}, with your token? Sessions you start yourself, and those in the {2}, will report to this PacedMind.", [mcpUrl ?? tx("this computer"), what, tx(APP_LABEL[agent])]))) {
      run(() => connectAgentAction(agent));
    }
  };

  return (
    <section aria-label={tx("Computers")} className="@container flex min-w-0 flex-col gap-5 max-md:gap-4">
      <p title={account ? tx("What runs on a computer is decided there, in its desktop app. It's online when it checked in during the last two minutes.") : undefined}
        className="text-[12.5px] text-mut2">{subtitle}</p>
      {registering && (
        <div className="flex items-center gap-3 rounded-lg border border-line2 px-4 py-3.5 text-[12.5px] text-mut">
          <Icon name="laptop" size={16} className="shrink-0 text-mut2" />
          {tx("Adding this computer to your account…")}</div>
      )}

      {devices.map((d) => (
        <Computer key={d.id} d={d} here={d.id === hereId} desktop={hereId !== null} account={account} online={online(d)} now={now}
          sessions={sessions.filter((s) => (account ? s.deviceId === d.id : d.id === hereId))}
          renaming={renaming === d.id} pending={pending}
          onRename={() => setRenaming(d.id)} onRenamed={() => setRenaming(null)}
          onSave={(name) => { setRenaming(null); run(() => renameDeviceAction(d.id, name)); }}
          onDefault={() => run(() => setDefaultDeviceAction(d.id))}
          onCheck={() => run(() => checkDeviceAction())}
          onConnect={connect}
          onRemote={(patch) => run(() => updateDeviceSettingsAction(patch))}
          onSignOut={() => setLeaving(d)} />
      ))}

      {account && !devices.length && !registering && (
        <div className="flex flex-col items-center gap-3 px-6 py-20 text-center max-md:py-14">
          <Icon name="laptop" size={22} className="text-mut2" />
          <div className="text-[14px] text-fg2">{tx("No computers yet")}</div>
          <p className="max-w-md text-[12.5px] leading-relaxed text-mut2">
            {tx("Claude Code and Codex sessions run on your computers. Install the PacedMind desktop app on one where you use them, and sign in there with this account: it shows up here within a minute.")}</p>
          <div className="flex flex-wrap justify-center gap-2 pt-1">
            <a href="https://pacedmind.com/download/windows" target="_blank" rel="noreferrer"
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-ctl px-3 text-[12.5px] text-fg2 hover:bg-hover">
              <Icon name="download" size={13} />{tx("Download for Windows")}</a>
            <a href="https://pacedmind.com/download/mac" target="_blank" rel="noreferrer"
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-ctl px-3 text-[12.5px] text-fg2 hover:bg-hover">
              <Icon name="download" size={13} />{tx("Download for macOS")}</a>
          </div>
        </div>
      )}

      {!account && (
        <div className="flex items-start gap-3 rounded-lg border border-dashed border-line2 px-4 py-3.5 max-md:px-3.5">
          <Icon name="cloud" size={16} className="mt-0.5 shrink-0 text-mut2" />
          <p className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-mut">
            {tx("With PacedMind Cloud your computers work together: each one shows up here with what it has and runs, and you can start a session on one from another, or from your phone.")}</p>
          <Link href="/login" className="inline-flex h-7 shrink-0 items-center rounded-md border border-ctl px-2.5 text-[12.5px] text-fg2 hover:bg-hover">
            {tx("Sign in")}</Link>
        </div>
      )}

      {leaving && (
        <ConfirmDialog title={leaving.id === hereId ? tx("Sign this computer out?") : tx("Sign {0} out?", [leaving.name])} confirmLabel={tx("Sign out")} danger
          onCancel={() => setLeaving(null)}
          onConfirm={() => { const id = leaving.id; setLeaving(null); run(() => revokeDeviceAction(id)); }}>
          {leaving.id === hereId
            ? tx("Your sign-in here ends at once, this computer's agents lose access to PacedMind, and requests waiting for it are canceled. PacedMind goes on here with this computer's own data until you sign in again.")
            : tx("Its session ends at once: it can't read or change anything in your account from now on, and requests waiting for it are canceled. Within a minute it notices, and its agents lose access to PacedMind.{0} To use it again, sign in there.", [leaving.isDefault ? tx(" It stops being your default computer.") : ""])}
        </ConfirmDialog>
      )}
    </section>
  );
}

/* ---------- one computer ---------- */

function Computer({ d, here, desktop, account, online, now, sessions, renaming, pending, onRename, onRenamed, onSave, onDefault, onCheck, onConnect, onRemote, onSignOut }: {
  d: Device; here: boolean;
  /** Seen in the desktop app (which has a computer of its own), not the web app. */
  desktop: boolean;
  account: boolean; online: boolean; now: number;
  sessions: ComputerSession[];
  renaming: boolean; pending: boolean;
  onRename: () => void; onRenamed: () => void; onSave: (name: string) => void;
  onDefault: () => void; onCheck: () => void; onConnect: (agent: AgentId) => void;
  /** Changes this computer's settings for sessions asked for from elsewhere (its own window only). */
  onRemote: (patch: { remoteStart?: RemoteStart; remoteCode?: boolean }) => void;
  onSignOut: () => void;
}) {
  const tx = useTranslation();
  // Waiting for you first, then what runs, oldest first.
  const list = [...sessions].sort((a, b) =>
    Number(b.status === "finished") - Number(a.status === "finished") || a.startedAt.localeCompare(b.startedAt));
  const status = here ? (account ? tx("Online") : null) : online ? tx("Online") : d.lastSeenAt ? tx("Last seen {0}", [ago(d.lastSeenAt, now, tx)]) : tx("Not seen yet");

  return (
    // Relative, so the screen-reader labels (absolutely placed) scroll with the card instead of stretching the page.
    <article aria-label={d.name} className="relative overflow-hidden rounded-lg border border-line2">
      <header className="flex flex-wrap items-start gap-x-4 gap-y-3 px-4 py-3.5 max-md:px-3.5">
        <div className="flex min-w-[min(100%,260px)] flex-1 items-start gap-3">
          <Icon name="laptop" size={18} className="mt-[5px] shrink-0 text-mut" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="flex min-h-7 min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              {renaming ? (
                <InlineName initial={d.name} placeholder={tx("Computer name")} onSave={onSave} onCancel={onRenamed} className="max-w-[280px]" />
              ) : (
                <>
                  <h3 className="min-w-0 truncate text-[14px] font-semibold text-strong">{d.name}</h3>
                  <button type="button" aria-label={tx("Rename {0}", [d.name])} title={tx("Rename")} onClick={onRename}
                    className="-ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-mut hover:bg-hover hover:text-fg2 pointer-coarse:h-8 pointer-coarse:w-8">
                    <Icon name="pen" size={12} />
                  </button>
                </>
              )}
              {here && <Badge>{tx("This computer")}</Badge>}
              {account && d.isDefault && (
                <Badge title={tx("Sessions go to the default computer when neither the task nor its project names one.")}>
                  <Icon name="check" size={11} strokeWidth={2.4} />{tx("Default")}</Badge>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-mut2">
              {status && (
                <span className="inline-flex items-center gap-1.5">
                  <span aria-hidden className={cx("h-[7px] w-[7px] shrink-0 rounded-full", online ? "bg-fg2" : "border border-dim")} />
                  <span className={online ? "text-fg3" : undefined} suppressHydrationWarning>{status}</span>
                </span>
              )}
              {status && <Sep />}
              <span>{platformName(d.platform)}</span>
              <Sep />
              <span>{d.appVersion ? `PacedMind ${d.appVersion}` : tx("PacedMind version unknown")}</span>
              {d.checkedAt && (
                <>
                  <Sep />
                  <span title={tx("When it last looked for Claude Code and Codex: when it starts and every half hour")} suppressHydrationWarning>
                    {tx("checked")}{ago(d.checkedAt, now, tx)}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2 @max-xl:w-full @max-xl:pl-[30px]">
          {here && (
            <Button disabled={pending} onClick={onCheck} title={tx("Looks for Claude Code and Codex on this computer again")}>
              <Icon name="refresh" size={12} />{tx("Check again")}</Button>
          )}
          {account && !d.isDefault && (
            <Button disabled={pending} onClick={onDefault} title={tx("Sessions go to the default computer when neither the task nor its project names one.")}>
              {tx("Make default")}</Button>
          )}
          {account && <Button disabled={pending} onClick={onSignOut}>{tx("Sign out")}</Button>}
        </div>
      </header>

      <Agents d={d} here={here && desktop} pending={pending} onConnect={onConnect} />

      <div className="flex flex-col gap-3 border-t border-line px-4 py-3.5 max-md:px-3.5">
        {account && (
          <Line label={tx("From elsewhere")} title={tx("Sessions asked for from the web app or another computer. Each computer sets this itself, in its desktop app.")}>
            <FromElsewhere d={d} editable={here && desktop} onChange={onRemote} />
          </Line>
        )}
        <Line label={tx("Sessions")}>
          {list.length ? (
            <div className="flex min-w-0 flex-col">
              {list.slice(0, SESSIONS_SHOWN).map((s) => <SessionRow key={s.id} s={s} now={now} />)}
              {list.length > SESSIONS_SHOWN && (
                <Link href="/sessions" className="flex h-7 items-center text-[12px] text-mut2 hover:text-fg2">
                  {list.length - SESSIONS_SHOWN} {tx("more in Sessions")}</Link>
              )}
            </div>
          ) : (
            <p className="flex min-h-8 items-center text-[12.5px] text-mut2 @max-xl:min-h-0">{tx("Nothing running or waiting")}</p>
          )}
        </Line>
      </div>
    </article>
  );
}

const Sep = () => <span aria-hidden className="text-faint">·</span>;

function Badge({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <span title={title} className="inline-flex h-5 shrink-0 items-center gap-1 rounded border border-line2 px-1.5 text-[11px] text-mut">{children}</span>
  );
}

/**
 * What the computer does with sessions asked for from the web app or another computer, and whether asking needs a
 * two-factor code. It decides both itself, so only its own window changes them: there they can be changed here too.
 */
function FromElsewhere({ d, editable, onChange }: {
  d: Device; editable: boolean; onChange: (patch: { remoteStart?: RemoteStart; remoteCode?: boolean }) => void;
}) {
  const tx = useTranslation();
  if (!editable) {
    return (
      <p title={tx("{0} It's set in PacedMind on that computer.", [fromElsewhereText(d.remoteStart, d.remoteCode, "there", tx.language)])}
        className="flex min-h-8 flex-wrap items-center gap-x-1.5 text-[12.5px] text-fg2 @max-xl:min-h-0">
        {tx(REMOTE_START_LABEL[d.remoteStart])}
        {d.remoteStart !== "off" && <><span aria-hidden className="text-faint">·</span><span className="text-mut">{tx(remoteCodeLabel(d.remoteCode))}</span></>}
      </p>
    );
  }
  return (
    <div title={fromElsewhereText(d.remoteStart, d.remoteCode, "here", tx.language)} className="flex min-h-8 flex-wrap items-center gap-x-4 gap-y-2">
      <Segmented value={d.remoteStart} options={REMOTE_START_OPTIONS.map((o) => ({ ...o, label: tx(o.label) }))} onChange={(v) => onChange({ remoteStart: v })} />
      <label className="flex items-center gap-2 text-[12.5px] text-fg3">
        <Switch on={d.remoteCode} label={tx("Ask for a two-factor code")} onChange={(v) => onChange({ remoteCode: v })} />
        {tx("Two-factor code")}</label>
    </div>
  );
}

/** A label and what it names, both on 32 px lines so they align; on a narrow card the label goes above. */
function Line({ label, title, children }: { label: string; title?: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 gap-3 @max-xl:flex-col @max-xl:gap-1">
      <span title={title} className="flex h-8 w-[132px] shrink-0 items-center text-[12px] text-mut2 @max-xl:h-auto @max-xl:w-auto">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function SessionRow({ s, now }: { s: ComputerSession; now: number }) {
  const tx = useTranslation();
  const waiting = s.status === "finished";
  return (
    <Link href={`/sessions?s=${s.id}`} title={tx("{0} in {1}", [tx(AGENT_LABEL[s.agent]), where(s, tx)])}
      className="-mx-2 flex h-8 min-w-0 items-center gap-2.5 rounded-md px-2 hover:bg-hover pointer-coarse:h-9">
      {/* The navy accent means "finished, waiting for you"; what runs is gray. */}
      <span aria-hidden className={cx("h-[7px] w-[7px] shrink-0 rounded-full border",
        waiting ? "border-accent bg-accent" : s.status === "starting" ? "border-fg3" : "border-fg3 bg-fg3")} />
      {s.key && <span className="shrink-0 font-mono text-[11.5px] text-mut2">{s.key}</span>}
      <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg2">{s.title ?? tx("Deleted task")}</span>
      <span className="flex shrink-0 items-center gap-1 text-mut">
        <AgentIcon agent={s.agent} size={12} />
        <SurfaceIcon surface={s.surface} size={11} className="text-dim" />
      </span>
      <span className={cx("shrink-0 text-right text-[12px]", waiting ? "text-fg3" : "text-mut2")} suppressHydrationWarning>{sessionMeta(s, now, tx)}</span>
    </Link>
  );
}

/* ---------- its agents ---------- */

/** What a computer found of each agent: a column per agent, side by side; a narrow card stacks them. */
function Agents({ d, here, pending, onConnect }: {
  d: Device;
  /** This computer, in its own desktop app: its agents can be connected from here. */
  here: boolean;
  pending: boolean; onConnect: (agent: AgentId) => void;
}) {
  const tx = useTranslation();
  if (!d.checkedAt) {
    return (
      <p className="border-t border-line px-4 py-3 text-[12.5px] text-mut2 max-md:px-3.5">
        {here ? tx("Looking for Claude Code and Codex…") : tx("It hasn't looked for Claude Code and Codex yet.")}
      </p>
    );
  }
  return (
    <div className="grid grid-cols-2 border-t border-line @max-xl:grid-cols-1">
      {AGENTS.map((a, i) => (
        <AgentColumn key={a} agent={a} t={d.agents[a]} first={i === 0} pending={pending} onConnect={onConnect}
          // Connecting writes this computer's agent config, so only its own window offers it.
          connectable={here && d.agents[a].mcp !== "connected" && (!!d.agents[a].cli || !!d.agents[a].app || a === "codex")} />
      ))}
    </div>
  );
}

function AgentColumn({ agent, t, first, connectable, pending, onConnect }: {
  agent: AgentId; t: AgentTools; first: boolean; connectable: boolean; pending: boolean; onConnect: (agent: AgentId) => void;
}) {
  const tx = useTranslation();
  const x = t.extras;
  const cloud = tx(CLOUD_LABEL[agent]);
  const signIn = t.login.state === "in"
    ? [methodName(t.login.method, tx), planName(t.login.plan)].filter(Boolean).join(" · ") || tx("Signed in")
    : t.login.state === "out" ? tx("Signed out") : null;
  // Plugins, skills and hooks as counts; their names are in the tooltips.
  const more = x ? [
    x.plugins.length ? { text: tx.count(x.plugins.length, "plugin"), title: x.plugins.join(", ") } : null,
    x.skills ? { text: tx.count(x.skills, "skill"), title: undefined } : null,
    x.hooks.length ? { text: tx.count(x.hooks.length, "hook"), title: tx("On {0}", [x.hooks.join(", ")]) } : null,
  ].filter((m) => m !== null) : [];

  return (
    <div className={cx("flex min-w-0 flex-col gap-3 px-4 py-3.5 max-md:px-3.5", !first && "border-l border-line @max-xl:border-l-0 @max-xl:border-t")}>
      <div className="flex min-h-6 min-w-0 items-center gap-2">
        <AgentIcon agent={agent} size={15} className="shrink-0 text-fg2" />
        <h4 className="shrink-0 text-[13px] font-medium text-strong">{tx(AGENT_LABEL[agent])}</h4>
        <span className="flex-1" />
        {signIn && (
          <span title={tx("Its CLI: {0}", [t.login.state === "in" ? tx("signed in") : tx("signed out")])}
            className={cx("min-w-0 truncate text-[12px]", t.login.state === "in" ? "text-mut" : "text-dim")}>{signIn}</span>
        )}
      </div>

      {!t.cli && !t.app ? <p className="text-[12.5px] text-dim">{tx("Not installed")}</p> : (
        <>
          <div className="flex flex-wrap items-center gap-1.5">
            <Chip icon="terminal" on={!!t.cli} title={t.cli ? `CLI ${t.cli.version}` : tx("No CLI")}>CLI</Chip>
            <Chip icon="appWindow" on={!!t.app} title={t.app ? `${tx(APP_LABEL[agent])}${t.app.version ? ` ${t.app.version}` : ""}` : tx("No {0}", [tx(APP_LABEL[agent])])}>{tx("App")}</Chip>
            <Chip icon="cloud" on={!!t.cli && t.login.state !== "out"}
              title={!t.cli ? tx("{0} sessions start from the {1} CLI", [cloud, tx(AGENT_LABEL[agent])]) : t.login.state === "out" ? tx("Sign the CLI in to send sessions to {0}", [cloud]) : tx("Sessions can go to {0}", [cloud])}>
              {tx("Cloud")}</Chip>
            <Chip icon="plug" on={mcpReaches(t.mcp)} title={tx(MCP_HINT(tx)[t.mcp])}>
              {t.mcp === "connected" ? "PacedMind" : `PacedMind: ${MCP_TEXT(tx)[t.mcp].toLowerCase()}`}
            </Chip>
            {connectable && (
              <Button size="sm" disabled={pending} onClick={() => onConnect(agent)}
                title={agent === "claude"
                  ? tx("Adds PacedMind's MCP server to Claude Code for all projects, with your token, so the Claude app's sessions can report back")
                  : tx("Adds PacedMind's MCP server to ~/.codex/config.toml (kept as config.toml.pacedmind-backup), so the Codex app's sessions can report back")}>
                {tx("Connect")}</Button>
            )}
          </div>

          {x && <Tools label={tx("MCP servers")} names={x.mcp}
            title={tx("Read from its own settings on that computer. A project's folder can add more: see Settings → Projects.")} />}
          {x?.account?.length ? (
            <Tools label={agent === "claude" ? tx("claude.ai connectors") : tx("Connectors")} names={x.account}
              title={tx("From the account its CLI is signed in to, as the last session PacedMind started there said.")} />
          ) : null}
          {more.length > 0 && (
            <p className="text-[12px] text-mut2">
              {more.map((m, i) => <span key={m.text} title={m.title}>{i > 0 && <span aria-hidden className="text-faint"> · </span>}{m.text}</span>)}
            </p>
          )}
        </>
      )}
    </div>
  );
}

/** A thing an agent has there or not: gray when it has it, dashed and dim when it doesn't. */
function Chip({ icon, on, title, children }: { icon: IconName; on: boolean; title?: string; children: ReactNode }) {
  return (
    <span title={title} className={cx("inline-flex h-6 max-w-full items-center gap-1.5 rounded-md border px-2 text-[12px]",
      on ? "border-line2 text-fg2" : "border-dashed border-line2 text-dim")}>
      <Icon name={icon} size={12} className="shrink-0" />
      <span className="truncate">{children}</span>
    </span>
  );
}

/** MCP servers or connectors, one per line with its brand's mark. */
function Tools({ label, names, title }: { label: string; names: string[]; title: string }) {
  const tx = useTranslation();
  return (
    <div className="flex min-w-0 flex-col">
      <span title={title} className="pb-0.5 text-[11.5px] text-mut2">
        {label}{names.length > 0 && <span className="text-dim"> {names.length}</span>}
      </span>
      {names.length ? names.map((n) => (
        <span key={n} className="flex h-7 min-w-0 items-center gap-2 text-[12.5px] text-fg2">
          <ToolIcon name={n} size={14} className="text-fg3" />
          <span className="truncate">{n.replace(/^claude[._ ]?ai[ _]/i, "")}</span>
        </span>
      )) : <span className="text-[12.5px] text-dim">{tx("None")}</span>}
    </div>
  );
}
