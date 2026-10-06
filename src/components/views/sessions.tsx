"use client";
import { useTranslation } from "@/components/language";
import { createTranslator, type Translator } from "@/lib/i18n";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Fragment, useEffect, useState, type ReactNode } from "react";

import { attachSessionAction, closeSessionAction, finishSessionAction, markSessionDoneAction, reopenSessionAction, requestChangesAction } from "@/app/actions";
import { useExecution } from "@/components/execution-context";
import { Popover, PopoverItem, anchorOf, type Anchor } from "@/components/popover";
import { askForChangesOn, resumeSessionOrAsk, startSessionOrAsk } from "@/components/remote-start";
import { AskCard } from "@/components/ask-card";
import { RequestChip, RequestStatus, dismissRequest, requestShown, statusAt, useClock, useLaunchState } from "@/components/request-status";
import { AgentIcon, Icon, SurfaceIcon } from "@/components/icons";
import { AnswerForm, Gallery, RequestChangesForm, SessionPlan, SessionReport } from "@/components/report";
import { Button, Menu, cx, useAction } from "@/components/ui";
import { attentionOf, attentionWords, checkedIn, eventLine, parseLocal, planOf, toDateStr, toDateTimeStr, mcpProblemsOf, waitingInTerminal } from "@/lib/dates";
import { desktopStartText } from "@/lib/session-health";
import { fmtSpan, sessionTokens, tokenTotal, tokensLine } from "@/lib/usage";
import {
  AGENT_LABEL, APP_LABEL, CLOUD_LABEL, isAnswers, HARNESS_LABEL, REOPEN_CONFIRM, TRUST_WAITING, harnessAgent,
  type AgentId, type Attachment, type OtherSession, type OtherSessionState, type Report, type SessionEvent, type SessionStatus, type SessionUsage, type Surface,
} from "@/lib/types";

/* ---------- data from the server ---------- */

export interface SessionItem {
  id: string;
  status: SessionStatus;
  agent: AgentId;
  /** Where it runs: a terminal or the desktop app on `device`, or the agent's cloud. */
  surface: Surface;
  device: string | null;
  /** Where to follow it, e.g. its Codex cloud task. */
  url: string | null;
  folder: string | null;
  branch: string | null;
  startedAt: string;
  finishedAt: string | null;
  endedAt: string | null;
  /** When it stopped needing anything (marked done, closed, failed); null while running or waiting. */
  endAt: string | null;
  note: string | null;
  cliSessionId: string | null;
  /** What its agent used, as it reported it; null when it couldn't (the apps, the cloud) or hasn't yet. */
  usage: SessionUsage | null;
  origin: "organizer" | "outside";
  task: { id: number; key: string; title: string } | null;
  project: { id: string; name: string } | null;
  /** Where the task opens in the app. */
  href: string | null;
  events: SessionEvent[];
  /** What the agent handed back, newest first. A resumed session can hand back more than once. */
  reports: Report[];
  /** Images attached while it works, before it hands the task back. */
  pending: Attachment[];
  /** Whether its agent can take changes from here now (changesProblem on the server). */
  canRequestChanges: boolean;
  /**
   * The computer to send changes to when they can't go from here (the web app, another computer's session):
   * requestChangesRemoteAction. Null when they go from here, or nowhere.
   */
  changesVia?: string | null;
  /** The computer it ran on (or that sent it to the cloud); null for this computer's own data without an account. */
  deviceId?: string | null;
  /** Running in a terminal here in a folder Claude Code doesn't trust yet: until the agent checks in, it's asking you. */
  asksTrust?: boolean;
  /** A task that waits for this one (a dependency), to start next. */
  next: { id: number; key: string; title: string; href: string; canStart: boolean } | null;
}

export interface SessionGroup {
  id: "finished" | "attention" | "starting" | "running" | "today" | "earlier";
  name: string;
  items: SessionItem[];
}

export interface StartableTask {
  id: number;
  key: string;
  title: string;
  agent: AgentId;
}

/** A task a session PacedMind didn't start can be attached to; `busy` when it has a running session. */
export interface AttachableTask {
  id: number;
  key: string;
  title: string;
  projectId: string | null;
  busy: boolean;
}

/** A session PacedMind didn't start, with its project's name. */
export type OtherItem = OtherSession & { project: string | null };

/** The sessions PacedMind didn't start on one computer: this one's as found now, another's as it last said. */
export interface OtherGroup {
  id: string;
  computer: string;
  here: boolean;
  online: boolean;
  sessions: OtherItem[];
}

/* ---------- helpers ---------- */

const ACCENT = "var(--color-accent)";
const DOT: Record<SessionStatus, { fill: string; ring: string }> = {
  finished: { fill: ACCENT, ring: ACCENT },
  starting: { fill: "var(--color-fg3)", ring: "var(--color-fg3)" },
  running: { fill: "var(--color-fg3)", ring: "var(--color-fg3)" },
  done: { fill: "var(--color-faint)", ring: "var(--color-faint)" },
  closed: { fill: "transparent", ring: "var(--color-dim)" },
  failed: { fill: "transparent", ring: "var(--color-dim)" },
};

const isActive = (s: SessionItem) => s.status === "starting" || s.status === "running";
const agentShort = (a: AgentId) => (a === "claude" ? "Claude" : "Codex");
const sameDay = (a: Date, b: Date) => toDateStr(a) === toDateStr(b);
const dayBefore = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1);
const ms = (stamp: string) => parseLocal(stamp).getTime();

/** "12:22", "yesterday 12:22" or "Mon 21 Sep" (short, for list rows). */
function clock(stamp: string, now: number, tx: Translator = createTranslator("en")): string {
  const d = parseLocal(stamp);
  const today = new Date(now);
  if (sameDay(d, today)) return tx.date(d, "HH:mm");
  if (sameDay(d, dayBefore(today))) return tx("yesterday {0}", [tx.date(d, "HH:mm")]);
  return tx.date(d, "EEE d MMM");
}

/** "12:22" today, otherwise with the day: "Mon 21 Sep, 12:22". */
function clockLong(stamp: string, now: number, tx: Translator = createTranslator("en")): string {
  const d = parseLocal(stamp);
  return sameDay(d, new Date(now)) ? tx.date(d, "HH:mm") : tx.date(d, "EEE d MMM, HH:mm");
}

function duration(span: number, tx: Translator = createTranslator("en")): string {
  const m = Math.max(0, Math.round(span / 60_000));
  if (m < 1) return tx("under a minute");
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? tx("{0} h {1} min", [h, m % 60]) : tx("{0} h", [h]);
  return tx("{0} d {1} h", [Math.floor(h / 24), h % 24]);
}

/** A session on a device whose agent hasn't checked in: waiting in its terminal, or for you to send it in the app. */
const unheard = (s: SessionItem, now: number) => s.surface !== "cloud" && waitingInTerminal(s, s.events, new Date(now));
/** What a running session's agent waits for you about, as its terminal's hooks or the agent said (attentionOf). */
const waitsFor = (s: SessionItem) => (isActive(s) ? attentionOf(s.events) : null);
/** Claude Code asking in its terminal whether you trust the folder, from the start. */
const askingTrust = (s: SessionItem) => !!s.asksTrust && isActive(s) && s.surface === "terminal" && !checkedIn(s.events);

/** "a terminal on mikolaj_pc", "the Claude app on mikolaj_pc" or "Claude Code on the web". */
function place(s: SessionItem, tx: Translator = createTranslator("en")): string {
  if (s.surface === "cloud") return tx(CLOUD_LABEL[s.agent]);
  const on = s.device ? tx(" on {0}", [s.device]) : "";
  return s.surface === "desktop" ? tx("the {0}{1}", [tx(APP_LABEL[s.agent]), on]) : tx("a terminal{0}", [on]);
}

/** "Terminal on mikolaj_pc", "Claude app on mikolaj_pc" or "Claude Code on the web". */
function placeTitle(s: SessionItem, tx: Translator = createTranslator("en")): string {
  if (s.surface === "cloud") return tx(CLOUD_LABEL[s.agent]);
  return `${s.surface === "desktop" ? tx(APP_LABEL[s.agent]) : tx("Terminal")}${s.device ? tx(" on {0}", [s.device]) : ""}`;
}

function meta(s: SessionItem, now: number, tx: Translator = createTranslator("en")): string {
  switch (s.status) {
    case "finished": {
      const outcome = s.reports[0]?.outcome;
      return `${outcome === "blocked" ? tx("stuck") : outcome === "partial" ? tx("partly done") : tx("finished")} ${clock(s.finishedAt ?? s.startedAt, now, tx)}`;
    }
    case "starting":
    case "running": {
      const waits = waitsFor(s);
      if (waits) return tx(attentionWords(waits.kind)).toLowerCase();
      if (s.status === "starting") return s.surface === "desktop" ? tx("send the first message") : tx("starting · waiting for check-in");
      if (askingTrust(s) || unheard(s, now)) return s.surface === "desktop" ? tx("waiting in the {0}", [tx(APP_LABEL[s.agent])]) : tx("waiting in its terminal");
      const asked = s.reports[0]?.changes ? s.reports[0].changesAt : null;
      if (asked) return tx("{0} since {1}", [isAnswers(s.reports[0].changes ?? "") ? tx("answers") : tx("changes"), clock(asked, now, tx)]);
      return tx("{0}since {1}", [s.surface === "cloud" ? tx("in the cloud ") : "", clock(s.startedAt, now, tx)]);
    }
    case "done":
      return tx("done {0}", [clock(s.endAt ?? s.startedAt, now, tx)]);
    case "closed":
      return tx("closed before finishing");
    default:
      return tx("couldn't start");
  }
}

function headline(s: SessionItem, now: number, tx: Translator = createTranslator("en")): string {
  const who = tx(AGENT_LABEL[s.agent]);
  const waits = waitsFor(s);
  if (waits) return waits.text;
  if (s.status === "starting" && s.surface === "desktop") return desktopStartText(s.agent);
  if (askingTrust(s)) return TRUST_WAITING;
  if (unheard(s, now)) {
    return s.surface === "desktop"
      ? tx("Opened in the {0}. Send the first message there to start.", [tx(APP_LABEL[s.agent])])
      : tx("{0} hasn't checked in yet. It may be waiting for you in its terminal.", [who]);
  }
  switch (s.status) {
    case "starting":
      return s.surface === "cloud" ? tx("Sending to {0} since {1}", [tx(CLOUD_LABEL[s.agent]), clockLong(s.startedAt, now, tx)]) : tx("Starting {0} since {1}", [who, clockLong(s.startedAt, now, tx)]);
    case "running": {
      const asked = s.reports[0]?.changes ? s.reports[0].changesAt : null;
      if (asked) return tx("{0} is working {1} since {2}", [who, isAnswers(s.reports[0].changes ?? "") ? tx("with your answers") : tx("on your changes"), clockLong(asked, now, tx)]);
      return s.surface === "terminal" ? tx("Running in {0} since {1}", [who, clockLong(s.startedAt, now, tx)]) : tx("Running in {0} since {1}", [place(s, tx), clockLong(s.startedAt, now, tx)]);
    }
    case "finished": {
      const at = clockLong(s.finishedAt ?? s.startedAt, now, tx);
      const outcome = s.reports[0]?.outcome;
      if (outcome === "blocked") return tx("{0} got stuck at {1} · needs you", [who, at]);
      if (outcome === "partial") return tx("{0} handed back part of it at {1} · waiting for you", [who, at]);
      return tx("{0} finished at {1} · waiting for you", [who, at]);
    }
    case "done":
      return s.finishedAt ? tx("Done · {0} finished at {1}", [who, clockLong(s.finishedAt, now, tx)]) : tx("Done");
    case "closed":
      return tx("Closed before the agent finished");
    default:
      return tx("Couldn't start: {0}", [s.note ?? tx("unknown error")]);
  }
}

/** How long the agent worked: until now while it runs, else until it finished or its terminal closed. */
function workedFor(s: SessionItem, now: number, tx: Translator = createTranslator("en")): string | null {
  if (s.status === "failed") return null;
  const end = isActive(s) ? now : s.finishedAt ?? s.endedAt ?? s.endAt;
  if (end === null) return null;
  return duration((typeof end === "number" ? end : ms(end)) - ms(s.startedAt), tx);
}

function eventText(e: SessionEvent, agent: AgentId, tx: Translator = createTranslator("en")): string {
  if (e.kind === "finished") return tx("{0} marked it finished", [agentShort(agent)]);
  return eventLine(e, tx.language);
}

/** Current time, starting from the server's clock (no hydration mismatch) and ticking every 30 s. */
function useNow(initial: string): number {
  const [now, setNow] = useState(() => parseLocal(initial).getTime());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

/* ---------- the view ---------- */

export function SessionsView({ groups, others, initialId, startable, attachable, now: serverNow }: {
  groups: SessionGroup[];
  others: OtherGroup[];
  initialId: string | null;
  startable: StartableTask[];
  attachable: AttachableTask[];
  now: string;
}) {
  const tx = useTranslation();
  const now = useNow(serverNow);
  const router = useRouter();
  const params = useSearchParams();
  // This computer's other sessions change without anything in PacedMind changing: look again now and then.
  const watching = others.length > 0;
  useEffect(() => {
    if (!watching) return;
    const id = window.setInterval(() => router.refresh(), 30_000);
    return () => window.clearInterval(id);
  }, [watching, router]);
  const { run, pending } = useAction();
  const all = groups.flatMap((g) => g.items);
  // The selection lives in the URL (?s=), so links from tasks open the right session and refreshes keep it.
  const fromUrl = params.get("s");
  const sel = fromUrl && all.some((s) => s.id === fromUrl) ? fromUrl : initialId;
  const selected = all.find((s) => s.id === sel) ?? null;
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => ({
    earlier: !groups.find((g) => g.id === "earlier")?.items.some((s) => s.id === initialId),
  }));
  const select = (id: string) => window.history.replaceState(null, "", `?s=${id}`);
  // On a phone the details cover the list, so they open only for a session you chose (or a link named), not
  // for the one picked for you; closing them goes back to the list.
  const chosen = !!fromUrl && fromUrl === sel;
  const backToList = () => window.history.replaceState(null, "", window.location.pathname);

  return (
    <div className="flex min-w-0 flex-1">
      <section aria-label={tx("Sessions")} className="@container flex min-w-0 flex-1 flex-col">
        <div className="flex h-[52px] shrink-0 items-center gap-2.5 border-b border-line pl-5 pr-4">
          <Icon name="terminal" className="shrink-0 text-mut" />
          <h1 className="text-[14px] font-semibold text-strong">{tx("Sessions")}</h1>
          <span className="min-w-0 truncate text-mut2">
            {others.length ? tx("Claude Code and Codex sessions on your computers") : tx("Claude Code and Codex sessions started from PacedMind")}
          </span>
          <span className="flex-1" />
          {startable.length > 0 && (
            <Menu align="right" width={340}
              trigger={<Button disabled={pending}><Icon name="plus" size={13} />{tx("Start session")}</Button>}
              items={startable.map((t) => ({
                value: t.id,
                label: <><span className="mr-2 font-mono text-[11px] text-mut2">{t.key}</span>{t.title}</>,
                hint: agentShort(t.agent),
              }))}
              onSelect={(id) => run(() => startSessionOrAsk(id, startable.find((t) => t.id === id)?.agent))} />
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <Asked tasks={[...startable, ...all.flatMap((s) => (s.task ? [s.task] : []))]} />
          {groups.map((g) => (
            <div key={g.id}>
              <GroupHeader name={tx(g.name)} count={g.items.length} collapsed={!!collapsed[g.id]}
                onToggle={() => setCollapsed((c) => ({ ...c, [g.id]: !c[g.id] }))} />
              {!collapsed[g.id] && g.items.map((s) => (
                <Row key={s.id} s={s} now={now} selected={s.id === sel} onSelect={() => select(s.id)} />
              ))}
            </div>
          ))}
          {others.map((g) => {
            const key = `other:${g.id}`;
            return (
              <div key={key}>
                <GroupHeader name={tx("Not from PacedMind, on {0}{1}", [g.here ? tx("this computer ({0})", [g.computer]) : g.computer, g.online ? "" : tx(" · offline")])}
                  count={g.sessions.length} collapsed={!!collapsed[key]} onToggle={() => setCollapsed((c) => ({ ...c, [key]: !c[key] }))} />
                {!collapsed[key] && g.sessions.map((s) => (
                  <OtherRow key={`${s.harness}:${s.ref}`} s={s} now={now} computer={g.here ? "here" : g.id} tasks={attachable}
                    onAttached={(id) => router.push(`/sessions?s=${id}`)} />
                ))}
              </div>
            );
          })}
          {!all.length && !others.length && (
            <div className="flex flex-col items-center gap-3 px-8 py-24 text-center">
              <div className="text-[14px] text-fg2">{tx("No sessions yet")}</div>
              <div className="max-w-sm text-[12.5px] leading-relaxed text-mut2">
                {tx("Sessions appear here when you start one from a task. Open a task and choose Start with Claude Code or Codex, or ask an agent in a chat to start one.")}</div>
            </div>
          )}
        </div>
      </section>
      {selected && (
        <Detail key={selected.id} s={selected} now={now} chosen={chosen} onClose={backToList}
          agentFor={(id) => startable.find((t) => t.id === id)?.agent} />
      )}
    </div>
  );
}

function GroupHeader({ name, count, collapsed, onToggle }: { name: string; count: number; collapsed: boolean; onToggle: () => void }) {
  return (
    <div className="flex h-[34px] items-center gap-2 border-b border-line bg-raised pl-5 pr-4 text-[12.5px] font-medium text-fg2">
      <button type="button" onClick={onToggle} className="flex items-center gap-2" aria-expanded={!collapsed}>
        <Icon name={collapsed ? "chevronRight" : "chevronDown"} size={12} strokeWidth={2.4} className="text-mut2" />
        <span>{name}</span>
        <span className="font-normal text-mut2">{count}</span>
      </button>
    </div>
  );
}

/**
 * Sessions asked of the account's computers that haven't become sessions here yet: waiting for the computer, or
 * refused, expired or failed in the last ten minutes. One that started shows as a session instead.
 */
function Asked({ tasks }: { tasks: { id: number; key: string; title: string }[] }) {
  const tx = useTranslation();
  const { requests, computers } = useLaunchState();
  const now = useClock();
  const [, setClosed] = useState(0);
  const rows = requests.filter((r) => r.kind === "start" && statusAt(r, now) !== "launched" && requestShown(r, now));
  if (!rows.length) return null;
  return (
    <div>
      <div className="flex h-[34px] items-center gap-2 border-b border-line bg-raised pl-5 pr-4 text-[12.5px] font-medium text-fg2">
        <span className="w-3" />
        <span>{tx("Sent to your computers")}</span>
        <span className="font-normal text-mut2">{rows.length}</span>
      </div>
      {rows.map((r) => {
        const task = tasks.find((t) => t.id === r.taskId);
        return (
          // On a phone the chip goes under the task, which has the width to itself.
          <div key={r.id} className="flex min-h-[42px] items-center gap-3 border-b border-hover px-5 py-1.5 @max-md:flex-wrap @max-md:gap-x-2 @max-md:gap-y-1 @max-md:py-2">
            <span className="w-3.5 shrink-0 @max-md:hidden" />
            <span className="w-[50px] shrink-0 font-mono text-[11.5px] text-mut2 @max-md:w-auto">{r.taskKey ?? "—"}</span>
            <span className="min-w-0 flex-1 truncate text-fg3">{task?.title ?? tx("Deleted task")}</span>
            <span className="flex min-w-0 max-w-full @max-md:basis-full">
              <RequestChip request={r} now={now} computer={computers.find((d) => d.id === r.deviceId)} link={false}
                onClose={() => { dismissRequest(r.id); setClosed((n) => n + 1); }} />
            </span>
          </div>
        );
      })}
    </div>
  );
}

const OTHER_DOT: Record<OtherSessionState, { fill: string; ring: string }> = {
  working: DOT.running,
  waiting: DOT.finished,
  idle: DOT.closed,
};

/** When a session PacedMind didn't start last did something, and what it's doing. */
function otherMeta(s: OtherItem, now: number, tx: Translator = createTranslator("en")): string {
  if (s.state === "working") return tx("Working now");
  const at = clock(toDateTimeStr(new Date(s.activeAt)), now, tx);
  return s.state === "waiting" ? tx("Waiting for you · {0}", [at]) : tx("Idle since {0}", [at]);
}

/**
 * Attaching a session PacedMind didn't start to a task (attach.ts): a new task made from its title, in its project,
 * or one of the open tasks, its project's first. One at work can't join a task that has a running session.
 */
function AttachPicker({ s, computer, tasks, anchor, onClose, onAttached }: {
  s: OtherItem;
  computer: string;
  tasks: AttachableTask[];
  anchor: Anchor;
  onClose: () => void;
  onAttached: (sessionId: string) => void;
}) {
  const tx = useTranslation();
  const [query, setQuery] = useState("");
  const { run, pending } = useAction();
  const q = query.trim().toLowerCase();
  const live = s.state !== "idle";
  const list = tasks
    .filter((t) => !(live && t.busy) && (!q || t.key.toLowerCase().includes(q) || t.title.toLowerCase().includes(q)))
    .sort((a, b) => Number(b.projectId === s.projectId && !!s.projectId) - Number(a.projectId === s.projectId && !!s.projectId))
    .slice(0, 60);
  const attach = (taskId: number | null) => {
    if (pending) return;
    run(async () => {
      const r = await attachSessionAction({ computer, harness: s.harness, ref: s.ref, taskId, title: s.title, projectId: s.projectId });
      if (r.ok) {
        onClose();
        if (r.sessionId) onAttached(r.sessionId);
      }
      return r;
    });
  };
  return (
    <Popover anchor={anchor} onClose={onClose} width={360}>
      <div className="flex flex-col gap-1">
        <div className="px-2 pb-0.5 pt-1.5 text-[12px] font-medium text-fg3">{tx("Attach to a task")}</div>
        <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} aria-label={tx("Search tasks")} placeholder={tx("Search tasks")}
          className="mx-1 h-[30px] rounded-md border border-line2 bg-input px-2.5 text-[12.5px] text-fg2 outline-none placeholder:text-dim focus:border-ctl" />
        {!q && (
          <PopoverItem icon={<Icon name="plus" size={13} />} onClick={() => attach(null)} hint={s.project ?? tx("Inbox")}>
            {tx("New task:")}{s.title || tx("Untitled session")}
          </PopoverItem>
        )}
        {list.map((t) => (
          <PopoverItem key={t.id} onClick={() => attach(t.id)}>
            <span className="mr-2 font-mono text-[11px] text-mut2">{t.key}</span>{t.title}
          </PopoverItem>
        ))}
        {!list.length && q && <p className="px-2 py-1.5 text-[12px] text-mut2">{tx("No open tasks match.")}</p>}
        {live && <p className="px-2 pb-1 pt-0.5 text-[11.5px] leading-[1.45] text-mut2">{tx("It's still going, so tasks with a running session aren't offered.")}</p>}
      </div>
    </Popover>
  );
}

/**
 * A session PacedMind didn't start, as its computer found it: it lives in its own terminal or app. Its title, its
 * project (or folder's name), where it runs and what it's doing, and a button that attaches it to a task.
 */
function OtherRow({ s, now, computer, tasks, onAttached }: {
  s: OtherItem;
  now: number;
  computer: string;
  tasks: AttachableTask[];
  onAttached: (sessionId: string) => void;
}) {
  const tx = useTranslation();
  const d = OTHER_DOT[s.state];
  const where = `${tx(HARNESS_LABEL[s.harness])}${s.project ? ` · ${s.project}` : ""} · ${s.place}`;
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  return (
    <div title={`${s.title || tx("Untitled session")}\n${where}`} className="group flex h-[42px] w-full items-center gap-3 border-b border-hover px-5">
      <span className="flex w-3.5 shrink-0 justify-center">
        <span className="inline-block h-[7px] w-[7px] shrink-0 rounded-full border" style={{ background: d.fill, borderColor: d.ring }} />
      </span>
      <span className="w-[50px] shrink-0 @max-md:hidden" />
      <span className={cx("min-w-0 flex-1 truncate", s.state === "idle" ? "text-mut2" : "text-fg")}>{s.title || tx("Untitled session")}</span>
      <span className="hidden w-[110px] shrink-0 truncate text-[12px] text-mut2 @xl:block">{s.project ?? s.place}</span>
      <span className="hidden w-[110px] shrink-0 items-center gap-1.5 truncate text-[12px] text-mut2 @2xl:flex">
        <AgentIcon agent={harnessAgent(s.harness)} size={12} className="text-mut" />{tx(HARNESS_LABEL[s.harness])}
      </span>
      <span className="flex w-9 shrink-0 justify-center @max-md:w-auto">
        <button type="button" aria-label={tx("Attach to a task")} title={tx("Attach to a task")} onClick={(e) => setAnchor(anchorOf(e.currentTarget))}
          className={cx("flex h-6 w-6 items-center justify-center rounded-md text-mut2 hover:bg-hover hover:text-fg2 focus-visible:opacity-100 pointer-coarse:opacity-100",
            anchor ? "opacity-100" : "opacity-0 group-hover:opacity-100")}>
          <Icon name="link" size={13} />
        </button>
      </span>
      <span className={cx("w-[150px] shrink-0 truncate text-right text-[12px] @max-md:w-[108px]", s.state === "waiting" ? "text-fg2" : "text-mut2")}>
        {otherMeta(s, now, tx)}
      </span>
      {anchor && <AttachPicker s={s} computer={computer} tasks={tasks} anchor={anchor} onClose={() => setAnchor(null)} onAttached={onAttached} />}
    </div>
  );
}

/** A session's state; `waits` when its agent waits for you while it runs, which counts like a finished one. */
function StateDot({ status, waits }: { status: SessionStatus; waits?: boolean }) {
  const d = DOT[waits ? "finished" : status];
  return <span className="inline-block h-[7px] w-[7px] shrink-0 rounded-full border" style={{ background: d.fill, borderColor: d.ring }} />;
}

function Row({ s, now, selected, onSelect }: { s: SessionItem; now: number; selected: boolean; onSelect: () => void }) {
  const tx = useTranslation();
  const live = s.status === "finished" || isActive(s);
  const waits = !!waitsFor(s);
  const images = (s.reports[0]?.images.length ?? 0) + s.pending.length;
  return (
    <button type="button" onClick={onSelect} aria-current={selected ? "true" : undefined}
      className={cx("flex h-[42px] w-full items-center gap-3 border-b border-hover px-5 text-left", selected ? "bg-sel" : "hover:bg-hover")}>
      <span className="flex w-3.5 shrink-0 justify-center"><StateDot status={s.status} waits={waits} /></span>
      <span className="w-[50px] shrink-0 font-mono text-[11.5px] text-mut2 @max-md:hidden">{s.task?.key ?? "—"}</span>
      <span className={cx("min-w-0 flex-1 truncate", live ? "text-fg" : "text-mut2")}>{s.task?.title ?? tx("Deleted task")}</span>
      <span className="hidden w-[110px] shrink-0 truncate text-[12px] text-mut2 @xl:block">{s.project?.name ?? tx("No project")}</span>
      <span title={tx("{0} in {1}", [tx(AGENT_LABEL[s.agent]), place(s, tx)])} className="hidden w-[110px] shrink-0 items-center gap-1.5 text-[12px] text-mut2 @2xl:flex">
        <AgentIcon agent={s.agent} size={12} className="text-mut" />{tx(AGENT_LABEL[s.agent])}
        <SurfaceIcon surface={s.surface} size={11} className="text-dim" />
      </span>
      <span title={images ? tx("{0} image{1}", [images, images === 1 ? "" : "s"]) : undefined} className="flex w-9 shrink-0 items-center gap-1 text-[11.5px] text-mut2 @max-md:w-auto">
        {images > 0 && <><Icon name="image" size={13} />{images}</>}
      </span>
      <span className={cx("w-[150px] shrink-0 truncate text-right text-[12px] @max-md:w-[108px]", s.status === "finished" || waits ? "text-fg2" : "text-mut2")}>
        {meta(s, now, tx)}
      </span>
    </button>
  );
}

function Detail({ s, now, chosen, onClose, agentFor }: {
  s: SessionItem; now: number; chosen: boolean; onClose: () => void;
  /** Who runs a task, when the page knows (for starting the next one on a computer). */
  agentFor: (taskId: number) => AgentId | undefined;
}) {
  const tx = useTranslation();
  const { run, pending } = useAction();
  const active = isActive(s);
  const [viewing, setViewing] = useState(0);
  const report = s.reports[Math.min(viewing, s.reports.length - 1)] ?? null;
  const [asking, setAsking] = useState(false);
  // The questions of the agent's latest hand-back: answering them sends the session back with the answers, like changes.
  const [answering, setAnswering] = useState(false);
  const questions = s.status === "finished" || s.status === "done" ? s.reports[0]?.questions ?? [] : [];
  // Only where the server would take them: a terminal on this computer, the task's latest report, not your own task.
  const canAsk = s.canRequestChanges;
  // A session goes on where it ran. The frame lists the account's computers other than this one (the web app has
  // none of its own), so one of those is elsewhere: its buttons ask it through the "Run on a computer" sheet.
  const { computers } = useLaunchState();
  const elsewhere = !!s.deviceId && computers.some((d) => d.id === s.deviceId);
  const { desktop } = useExecution();
  const on = s.device ?? tx("its computer");
  const ref = { id: s.id, taskId: s.task?.id ?? 0, agent: s.agent, surface: s.surface, cliSessionId: s.cliSessionId };
  const worked = workedFor(s, now, tx);
  // What the agent plans to do, while it works (report_progress).
  const plan = active ? planOf(s.events) : null;
  const allToday = s.events.every((e) => sameDay(parseLocal(e.at), new Date(now)));
  const started = `${clockLong(s.startedAt, now, tx)} ${
    s.origin === "outside" ? tx("outside PacedMind") : tx("from PacedMind")
  }`;
  const props: [string, ReactNode, boolean][] = [
    [tx("Agent"), <span key="a" className="flex items-center gap-1.5"><AgentIcon agent={s.agent} size={12} className="text-fg3" />{tx(AGENT_LABEL[s.agent])}</span>, false],
    [tx("Runs in"), <span key="r" className="flex items-center gap-1.5"><SurfaceIcon surface={s.surface} size={12} className="text-mut" />{placeTitle(s, tx)}</span>, false],
    [tx("Folder"), s.folder ?? "—", true],
    [tx("Branch"), s.branch ?? "—", true],
    [tx("Started"), started, false],
  ];
  if (worked) props.push([tx("Duration"), worked, false]);
  // What its agent used, as its usage metrics said (usage-metrics.ts).
  if (s.usage) {
    const tokens = sessionTokens(s.usage);
    if (s.usage.activeSeconds) props.push([tx("Working"), fmtSpan(s.usage.activeSeconds * 1000), false]);
    if (tokenTotal(tokens)) props.push([tx("Tokens"), tokensLine(tokens, tx.language), false]);
    if (s.usage.models[0]) props.push([tx("Model"), s.usage.models.join(", "), true]);
  }
  // What it runs in, as its MCP client said when it connected, and what the agent says it runs with (start_task).
  const client = s.events.findLast((e) => e.kind === "connected");
  if (client) props.push([tx("Client"), client.text.replace(/^Connected from /, ""), false]);
  const env = s.events.findLast((e) => e.kind === "environment");
  if (env) props.push([tx("Agent says"), env.text.replace(/^.+? says it /, ""), false]);
  // MCP servers it should have tools from but hasn't, as Claude Code's own record of the session says (session-mcp.ts).
  const missing = mcpProblemsOf(s.events);
  if (missing) props.push([tx("Not available"), missing, false]);
  props.push([tx("Session"), s.id, true]);
  if (s.cliSessionId) props.push([s.agent === "codex" ? tx("Codex session") : tx("Claude session"), s.cliSessionId, true]);

  return (
    <aside aria-label={tx("Session details")} className={cx("flex w-[420px] shrink-0 flex-col border-l border-line",
      "max-md:fixed max-md:inset-0 max-md:z-30 max-md:w-auto max-md:border-l-0 max-md:bg-panel", !chosen && "max-md:hidden")}>
      <div className="flex h-[52px] shrink-0 items-center gap-2 border-b border-line pl-6 pr-4 text-[12.5px] text-mut max-md:pl-5 max-md:pr-3">
        <span className="truncate">{s.project?.name ?? tx("No project")}</span>
        <span className="text-faint">›</span>
        <span className="font-mono text-[11.5px] text-mut2">{s.task?.key}</span>
        <span className="flex-1" />
        {s.href && (
          <Link href={s.href} className="inline-flex h-7 shrink-0 items-center rounded-md px-2.5 text-fg3 hover:bg-hover">{tx("Open task")}</Link>
        )}
        <button type="button" aria-label={tx("Back to sessions")} onClick={onClose}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-mut hover:bg-hover hover:text-fg2 md:hidden">
          <Icon name="x" size={15} />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 py-[22px]">
        <div className="flex flex-col gap-2.5">
          <h2 className="text-[20px] font-semibold leading-snug tracking-[-0.01em] text-strong">{s.task?.title ?? tx("Deleted task")}</h2>
          <div className="flex items-center gap-2 text-[12.5px] text-fg2">
            <StateDot status={s.status} waits={!!waitsFor(s)} />
            <span className="min-w-0 flex-1">{headline(s, now, tx)}</span>
            {s.reports.length > 1 && (
              <span className="flex shrink-0 items-center gap-0.5 text-[11.5px] text-mut2">
                <button type="button" aria-label={tx("Older report")} disabled={viewing >= s.reports.length - 1} onClick={() => setViewing((v) => v + 1)}
                  className="flex h-5 w-5 items-center justify-center rounded hover:bg-hover disabled:opacity-30">
                  <Icon name="chevronLeft" size={12} strokeWidth={2.2} />
                </button>
                <span className="tabular-nums">{tx("Report")}{" "}{s.reports.length - viewing} {" "}{tx("of")}{" "}{s.reports.length}</span>
                <button type="button" aria-label={tx("Newer report")} disabled={viewing === 0} onClick={() => setViewing((v) => v - 1)}
                  className="flex h-5 w-5 items-center justify-center rounded hover:bg-hover disabled:opacity-30">
                  <Icon name="chevronRight" size={12} strokeWidth={2.2} />
                </button>
              </span>
            )}
          </div>
          {!report && s.note && s.status !== "failed" && <p className="text-[13px] leading-[1.6] text-mut">“{s.note}”</p>}
        </div>

        {active && <AskCard sessionId={s.id} agent={s.agent} />}

        {report && <SessionReport key={report.id} report={report} criteria={report.criteria} working={active} />}

        {plan && <SessionPlan plan={plan} />}

        {s.pending.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <div className="text-[12px] font-medium text-fg3">{tx("Images so far")}</div>
            <Gallery images={s.pending} />
          </div>
        )}

        <dl className="grid grid-cols-[96px_minmax(0,1fr)] gap-x-2 gap-y-2.5 text-[12.5px]">
          {props.map(([label, value, mono]) => (
            <Fragment key={label}>
              <dt className="text-mut2">{label}</dt>
              <dd title={typeof value === "string" ? value : undefined}
                className={cx("truncate text-fg2", mono && "font-mono text-[11.5px] leading-[19px]")}>{value}</dd>
            </Fragment>
          ))}
        </dl>

        <div className="flex flex-col gap-2 border-t border-line pt-4">
          <div className="text-[12.5px] text-fg2">{tx("What PacedMind heard")}</div>
          {s.events.length ? s.events.map((e) => (
            <div key={e.id} className="flex items-baseline gap-3 text-[12.5px]">
              <span className={cx("shrink-0 font-mono text-[11px] text-dim", allToday ? "w-[38px]" : "w-[92px]")}>
                {tx.date(parseLocal(e.at), allToday ? "HH:mm" : "d MMM HH:mm")}
              </span>
              <span className="text-mut">{eventText(e, s.agent, tx)}</span>
            </div>
          )) : <p className="text-[12.5px] text-mut2">{tx("Nothing yet.")}</p>}
        </div>
      </div>

      <div className="flex shrink-0 flex-col gap-3 border-t border-line pb-4 pl-6 pr-4 pt-3.5">
        {answering && questions.length > 0 && (canAsk || s.changesVia) && (
          <AnswerForm agent={s.agent} questions={questions} pending={pending}
            onCancel={() => setAnswering(false)}
            onSend={(text) => {
              if (!canAsk) { askForChangesOn(ref, s.changesVia!, text); setAnswering(false); return; }
              run(async () => {
                const r = await requestChangesAction(s.id, text);
                if (r.ok) setAnswering(false);
                return r;
              });
            }} />
        )}
        {asking && canAsk && !answering && (
          <RequestChangesForm agent={s.agent} pending={pending}
            onCancel={() => setAsking(false)}
            onSend={(changes) => run(async () => {
              const r = await requestChangesAction(s.id, changes);
              if (r.ok) setAsking(false);
              return r;
            })} />
        )}
        <div className={cx("flex flex-wrap items-center gap-2", ((asking && canAsk) || answering) && "hidden")}>
          {!active && s.status !== "failed" && s.surface === "terminal" && (
            <Button disabled={pending} onClick={() => run(() => resumeSessionOrAsk(ref))} className="min-w-0 max-w-full">
              <Icon name="terminal" size={13} strokeWidth={2} className="shrink-0" />
              <span className="truncate">{elsewhere ? tx("Resume on {0}", [on]) : tx("Resume in terminal")}</span>
            </Button>
          )}
          {/* Its terminal is gone (or its agent lost PacedMind and you closed it): the conversation goes on in a new one. */}
          {active && s.surface === "terminal" && desktop && !elsewhere && (
            <Button disabled={pending} title={tx("When its terminal is gone: the conversation goes on in a new one")}
              onClick={() => confirm(tx(REOPEN_CONFIRM)) && run(() => reopenSessionAction(s.id))} className="min-w-0 max-w-full">
              <Icon name="terminal" size={13} strokeWidth={2} className="shrink-0" /><span className="truncate">{tx("Reopen in terminal")}</span>
            </Button>
          )}
          {s.surface === "terminal" && s.agent === "claude" && s.cliSessionId && s.status !== "failed" && (
            <Button disabled={pending} title={tx("Moves this Claude Code conversation into the Claude app")} onClick={() => run(() => resumeSessionOrAsk(ref, "desktop"))}
              className="min-w-0 max-w-full">
              <Icon name="appWindow" size={13} strokeWidth={2} className="shrink-0" />
              <span className="truncate">{elsewhere ? tx("Continue in {0} on {1}", [tx(APP_LABEL.claude), on]) : tx("Continue in {0}", [tx(APP_LABEL.claude)])}</span>
            </Button>
          )}
          {/* Showing an app's window only helps at that computer. */}
          {s.surface === "desktop" && s.status !== "failed" && !elsewhere && (
            <Button disabled={pending} onClick={() => run(() => resumeSessionOrAsk(ref))}>
              <Icon name="appWindow" size={13} strokeWidth={2} />{tx("Open the")}{" "}{tx(APP_LABEL[s.agent])}
            </Button>
          )}
          {s.surface === "cloud" && s.url && (
            <a href={s.url} target="_blank" rel="noreferrer"
              className="inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-md border border-ctl px-2.5 text-[12.5px] text-fg2 hover:bg-hover">
              <Icon name="cloud" size={13} strokeWidth={2} />{s.url.includes("/tasks/") ? tx("Open the task") : tx("Open {0}", [tx(CLOUD_LABEL[s.agent])])}
            </a>
          )}
          {/* The desktop app pulls it in here; the web app asks the computer that sent it. */}
          {s.surface === "cloud" && s.agent === "claude" && s.status !== "failed" && (
            <Button disabled={pending} title={tx("Pulls the cloud session and its branch into a terminal (claude --teleport)")} onClick={() => run(() => resumeSessionOrAsk(ref))}>
              <Icon name="terminal" size={13} strokeWidth={2} />{tx("Pull into terminal")}</Button>
          )}
          {active && s.surface !== "terminal" && (
            <Button disabled={pending} title={tx("The session can't always tell PacedMind itself. The task waits for your check.")}
              onClick={() => run(() => finishSessionAction(s.id))}>
              <Icon name="check" size={13} strokeWidth={2.2} />{tx("Mark finished")}</Button>
          )}
          {questions.length > 0 && (canAsk || s.changesVia) && (
            <Button disabled={pending} onClick={() => setAnswering(true)}>
              <Icon name="help" size={13} strokeWidth={2} />{questions.length === 1 ? tx("Answer its question") : tx("Answer its questions")}
            </Button>
          )}
          {(canAsk || s.changesVia) && (
            <Button disabled={pending} onClick={() => (canAsk ? setAsking(true) : askForChangesOn(ref, s.changesVia!))}>
              <Icon name="pen" size={13} strokeWidth={2} />{tx("Request changes")}</Button>
          )}
          {active && (
            <Button disabled={pending} onClick={() => confirm(tx("Close this session in PacedMind? {0}", [s.surface === "terminal" ? tx("The terminal stays open.") : tx("It keeps running where it is.")])) && run(() => closeSessionAction(s.id))}>
              {tx("Close session")}</Button>
          )}
          <span className="flex-1" />
          {s.status === "finished" && (
            <Button variant="primary" disabled={pending} onClick={() => run(() => markSessionDoneAction(s.id))}>{tx("Mark done")}</Button>
          )}
        </div>
        {/* A request to resume this session or send it back, and what became of it. */}
        <RequestStatus match={(r) => r.targetSessionId === s.id} link={false} />
        {s.next && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2 text-[12px] text-mut2">
              <span className="min-w-0 flex-1 truncate">
                {tx("Waits for it:")}{" "}
                <Link href={s.next.href} className="text-fg3 hover:text-strong">
                  <span className="font-mono text-[11px]">{s.next.key}</span> {s.next.title}
                </Link>
              </span>
              {s.next.canStart && (
                <Button size="sm" disabled={pending} onClick={() => run(() => startSessionOrAsk(s.next!.id, agentFor(s.next!.id)))}>{tx("Start session")}</Button>
              )}
            </div>
            <RequestStatus match={(r) => r.kind === "start" && r.taskId === s.next!.id} />
          </div>
        )}
      </div>
    </aside>
  );
}
