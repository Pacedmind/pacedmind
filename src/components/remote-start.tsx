"use client";
import { useTranslation } from "@/components/language";
import { createTranslator, type Translator } from "@/lib/i18n";

import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  requestChangesRemoteAction, requestResumeAction, requestSessionAction, resumeSessionAction, startSessionAction,
} from "@/app/actions";
import {
  AGENT_LABEL, APP_LABEL, CLOUD_LABEL, deviceOnline, isAnswers, mcpReaches, platformName, surfaceOf,
  type AgentId, type AgentTools, type Device, type Doer, type LaunchRequestView, type RemoteStart as Setting, type Surface,
} from "@/lib/types";
import { REMOTE_START_LABEL } from "@/lib/from-elsewhere";
import { deviceWithNeeds, missingOn, needList, toolsOn } from "@/lib/needs";
import { AgentIcon, Icon, SurfaceIcon, type IconName } from "./icons";
import { RUN_SHEET, noteSentRequest, publishComputers, useClock, useLaunchState } from "./request-status";
import { Button, IconButton, cx, toast } from "./ui";

/*
 * "Run on a computer": the web app (also on a phone) has no computer of its own, so every session it starts, resumes
 * or sends back with changes goes to one of the account's computers, as a request with a fresh two-factor code (none
 * for a computer that takes requests without one). The desktop app asks the same way for a task that runs on another
 * computer, or a session that ran on one. The computer then refuses it, asks you there, or acts, as its own setting
 * says (src/server/requests.ts).
 */

/** What the sheet asks a computer to do, and for which task or session. */
export type RunAsk =
  | {
    kind: "start";
    taskId: number;
    /** Who runs it; null when the caller doesn't know, and then you pick (the computer would hand the task to that agent). */
    agent: AgentId | null;
    /** Where the task says it runs (null: it doesn't say); undefined when the caller doesn't know. */
    surface?: Surface | null;
    /** The computer to offer: the task's, else its project's, else the account's default. */
    deviceId: string | null;
    /** The task or its project names that computer: its sessions start only there. */
    pinned: boolean;
    /** Start here found this computer lacks what the task needs (Task.needs), and offers another: here, it can start anyway. */
    missingHere?: string[];
    /** A computer not to offer first: the one a request to it expired on (tryAnotherComputer). */
    avoid?: string | null;
  }
  | {
    kind: "resume" | "changes";
    taskId: number;
    sessionId: string;
    agent: AgentId;
    /** Where the session ran. */
    from: Surface;
    /** resume: "desktop" moves a Claude Code conversation from its terminal into the Claude app; null resumes where it ran. */
    to: Surface | null;
    /** The computer it ran on (or that sent it to the cloud): it goes on only there. */
    deviceId: string | null;
    /** changes: what the sheet starts with, such as your answers to the agent's questions (AnswerForm). */
    text?: string;
  };

const open = (ask: RunAsk) => window.dispatchEvent(new CustomEvent<RunAsk>(RUN_SHEET, { detail: ask }));

/**
 * Starts a session: in the desktop app it opens here, where the task says (or `surface`). The web app can't start
 * anything, and a task that runs on another computer starts there: both open the sheet below, which asks that computer.
 * `surface`: where the task runs, null when it doesn't say, left out when the caller doesn't know.
 */
export async function startSessionOrAsk(taskId: number, agent?: Doer | null, surface?: Surface | null) {
  const wanted = agent === "claude" || agent === "codex" ? agent : null;
  const r = await startSessionAction(taskId, wanted, surface ?? undefined);
  if (!r.remote) return r;
  open({ kind: "start", taskId, agent: wanted, surface, deviceId: r.deviceId ?? null, pinned: !!r.pinned, missingHere: r.missingHere });
  return { ok: true };
}

/** What the sheet needs of a session to resume it or send it back. */
type SessionRef = { id: string; taskId: number; agent: AgentId; surface: Surface; cliSessionId: string | null };

/**
 * Picks a session up again here (`to` "desktop": in the Claude app). In the web app, and for a session that ran on
 * another computer, the sheet asks the computer it ran on instead.
 */
export async function resumeSessionOrAsk(s: SessionRef, to?: Surface) {
  const r = await resumeSessionAction(s.id, to);
  if (!r.remote) return r;
  open({ kind: "resume", taskId: s.taskId, sessionId: s.id, agent: s.agent, from: s.surface, to: to ?? null, deviceId: r.deviceId ?? null });
  return { ok: true };
}

/**
 * Sends a session back with changes through the computer it ran on (TaskContext.changesVia): the sheet takes the text,
 * starting with `text` when given (your answers to its questions).
 */
export function askForChangesOn(s: SessionRef, deviceId: string, text?: string) {
  open({ kind: "changes", taskId: s.taskId, sessionId: s.id, agent: s.agent, from: s.surface, to: null, deviceId, text });
}

/* ---------- words ---------- */

const AGENTS: AgentId[] = ["claude", "codex"];
const SURFACES: Surface[] = ["terminal", "desktop", "cloud"];
const CLI_NAME = (tx: Translator): Record<AgentId, string> => ({ claude: tx("Claude Code CLI"), codex: tx("Codex CLI") });
const MAKER: Record<AgentId, string> = { claude: "Anthropic", codex: "OpenAI" };
const SETTING_TITLE = (tx: Translator): Record<Setting, string> => ({
  off: tx("Refuses sessions asked for from elsewhere"),
  ask: tx("Asks you at that computer first"),
  auto: tx("Acts right away; anything in the agent's cloud still asks"),
});
const MCP_TEXT = (tx: Translator) => ({ connected: tx("Reports to PacedMind"), old: tx("Reports to PacedMind"), cloud: tx("Reports to PacedMind"), elsewhere: tx("Reports elsewhere"), missing: tx("Not connected") } as const);

function seen(iso: string | null, now: number, tx: Translator = createTranslator("en")): string {
  if (!iso) return tx("Never online");
  const min = Math.round((now - Date.parse(iso)) / 60_000);
  if (min < 60) return tx("Seen {0} min ago", [Math.max(min, 1)]);
  if (min < 48 * 60) return tx("Seen {0} h ago", [Math.round(min / 60)]);
  return tx("Seen {0}", [tx.date(new Date(iso), "d MMM yyyy")]);
}

const capital = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);

/** Why a computer can't run an agent's session that way, or null (also when it hasn't said what it has). Mirrors src/server/launcher.ts. */
function surfaceProblem(agent: AgentId, surface: Surface, device: Device | undefined, tx: Translator = createTranslator("en")): string | null {
  const tools = device?.checkedAt ? device.agents[agent] : undefined;
  if (!device || !tools) return null;
  if (surface === "desktop") return tools.app ? null : tx("The {0} isn't installed on {1}", [tx(APP_LABEL[agent]), device.name]);
  if (!tools.cli) {
    return surface === "cloud"
      ? tx("{0} starts from the {1}, which isn't installed on {2}", [tx(CLOUD_LABEL[agent]), CLI_NAME(tx)[agent], device.name])
      : tx("The {0} isn't installed on {1}", [CLI_NAME(tx)[agent], device.name]);
  }
  if (surface === "cloud" && tools.login.state === "out") return tx("The {0} on {1} isn't signed in, and the cloud starts from it", [CLI_NAME(tx)[agent], device.name]);
  return null;
}

function surfaceText(agent: AgentId, surface: Surface, tools: AgentTools | undefined, tx: Translator = createTranslator("en")): string {
  if (surface === "terminal") return tx("{0}{1} in a new terminal, connected to PacedMind.", [tx(AGENT_LABEL[agent]), tools?.cli ? ` ${tools.cli.version}` : ""]);
  if (surface === "desktop") return tx("A new {0} in the {1} with the first message written. You send it there.", [agent === "claude" ? tx("Code session") : tx("thread"), tx(APP_LABEL[agent])]);
  return tx("Runs on {0}'s servers from the project's repository, even while the computer sleeps.", [MAKER[agent]]);
}

/** The computer picked last in this window, offered again when nothing else says which. */
let lastPicked: string | null = null;
const rememberPick = (id: string) => { lastPicked = id; };

/**
 * The computer the sheet opens with: the one it must go to; else, for a task that needs something, one whose agent has
 * it (online first, the offered or last picked one first); else the offered one, the last picked, one that's online.
 * One a request expired on (`avoid`) comes last.
 */
function firstPick(ask: RunAsk, devices: Device[], needs: string[], runsOn: string | null): string {
  if (ask.kind !== "start" || ask.pinned || runsOn) return runsOn ?? ask.deviceId ?? "";
  const takers = devices.filter((d) => !d.revokedAt && d.remoteStart !== "off" && d.id !== ask.avoid);
  const offered = ask.deviceId ? takers.find((d) => d.id === ask.deviceId) : undefined;
  const last = lastPicked ? takers.find((d) => d.id === lastPicked) : undefined;
  const has = needs.length ? deviceWithNeeds(needs, ask.agent ?? "claude", takers, offered?.id ?? last?.id ?? null) : null;
  const online = takers.find((d) => deviceOnline(d));
  const pick = has ?? (ask.avoid ? online ?? offered ?? last : offered ?? last ?? online) ?? takers[0];
  return pick?.id ?? (ask.avoid && devices.some((d) => d.id === ask.avoid) ? ask.avoid : "");
}

/** The order the computers are listed in: the default, then those online, then the rest; ones that refuse last. */
function listOrder(devices: Device[]): string[] {
  const rank = (d: Device) => (d.remoteStart === "off" ? 3 : d.isDefault ? 0 : deviceOnline(d) ? 1 : 2);
  return devices.filter((d) => !d.revokedAt).sort((a, b) => rank(a) - rank(b)).map((d) => d.id);
}

/* ---------- the sheet ---------- */

/**
 * The sheet, for the whole app: the frame gives it the account's computers (in the desktop app, the other ones) and the
 * tasks, and it opens when startSessionOrAsk, resumeSessionOrAsk or askForChangesOn need a computer. `hereId`, when
 * given, marks this computer in the list.
 */
export function RemoteStart({ devices, tasks, hereId = null }: {
  devices: Device[];
  /** `needs`: what its agent needs from the computer (Task.needs); `runsOn`: the computer it or its project names. */
  tasks: SheetTask[];
  hereId?: string | null;
}) {
  const [ask, setAsk] = useState<{ n: number; ask: RunAsk } | null>(null);
  // Other parts of the page name computers too ("Resume on X", the request chips): they read the list from here.
  useLayoutEffect(() => publishComputers(devices), [devices]);
  useEffect(() => {
    let n = 0;
    const on = (e: Event) => setAsk({ n: ++n, ask: (e as CustomEvent<RunAsk>).detail });
    window.addEventListener(RUN_SHEET, on);
    return () => window.removeEventListener(RUN_SHEET, on);
  }, []);
  if (!ask) return null;
  return (
    <RunSheet key={ask.n} ask={ask.ask} devices={devices} task={tasks.find((t) => t.id === ask.ask.taskId)} hereId={hereId}
      onClose={() => setAsk(null)} />
  );
}

/** A task as the sheet needs it. */
type SheetTask = { id: number; key: string; title: string; needs: string[]; runsOn: string | null };

function RunSheet({ ask, devices, task, hereId, onClose }: {
  ask: RunAsk;
  devices: Device[];
  task: SheetTask | undefined;
  hereId: string | null;
  onClose: () => void;
}) {
  const tx = useTranslation();
  const titleId = useId();
  const { codeFreshUntil } = useLaunchState();
  const now = useClock(10_000);
  const needs = ask.kind === "start" ? task?.needs ?? [] : [];
  const runsOn = ask.kind === "start" ? task?.runsOn ?? null : null;
  const pinned = ask.kind !== "start" || ask.pinned || !!runsOn;
  const [deviceId, setDeviceId] = useState(() => firstPick(ask, devices, needs, runsOn));
  const [order] = useState(() => listOrder(devices));
  const [agent, setAgent] = useState<AgentId | null>(ask.agent);
  const [picked, setPicked] = useState<Surface | null>(ask.kind === "start" ? ask.surface ?? null : null);
  const [code, setCode] = useState("");
  const [needCode, setNeedCode] = useState(false);
  const [text, setText] = useState(() => (ask.kind === "changes" ? ask.text ?? "" : ""));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // With a mouse and keyboard the field to type in takes the focus; on a phone its keyboard would cover the choices.
  const [fine] = useState(() => window.matchMedia("(pointer: fine)").matches);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // The keyboard starts in the sheet (a field may have taken the focus already), not on the page behind it.
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (!formRef.current?.contains(document.activeElement)) formRef.current?.focus({ preventScroll: true });
  }, []);

  // Why it didn't go shows at the end of a list that may be scrolled; a code it asks for gets the cursor.
  const errorRef = useRef<HTMLParagraphElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!error) return;
    errorRef.current?.scrollIntoView({ block: "nearest" });
    if (needCode && fine) codeRef.current?.focus();
  }, [error, needCode, fine]);

  const listed = [...order, ...devices.filter((d) => !d.revokedAt && !order.includes(d.id)).map((d) => d.id)]
    .map((id) => devices.find((d) => d.id === id && !d.revokedAt)).filter((d): d is Device => !!d);
  const device = devices.find((d) => d.id === deviceId && !d.revokedAt);
  const who = ask.kind === "start" ? agent : ask.agent;
  const tools = device?.checkedAt && who ? device.agents[who] : undefined;
  const name = device?.name ?? tx("its computer");
  // Where it runs. A start the caller knew nothing about (undefined) goes where the task says; one whose task doesn't
  // say goes where the computer would put it, which the sheet can tell once the computer said what it has.
  const surface: Surface | null = ask.kind === "start" ? picked ?? (ask.surface === null && tools ? surfaceOf(null, tools) : null)
    : ask.kind === "changes" ? "terminal" : ask.to ?? ask.from;
  // What that computer can't do: a start shows it on the place it can't run; a session going on there needs its CLI
  // (the Claude app, to move into it), or it would open a terminal that can't find the agent.
  const blocked = !who ? null
    : ask.kind === "start" ? (surface ? surfaceProblem(who, surface, device, tx) : null)
      : surfaceProblem(who, ask.kind === "resume" && ask.to === "desktop" ? "desktop" : "terminal", device, tx);
  const refuses = device?.remoteStart === "off";
  // The computer's setting decides, except that anything in the agent's cloud always waits for you there.
  const asks = !device || device.remoteStart !== "auto" || surface === "cloud";
  const fresh = !!codeFreshUntil && codeFreshUntil > now + 5_000;
  // A computer that takes requests without a code gets none, unless it asked for one again since this page read it.
  const codeFree = !!device && !device.remoteCode;
  const showCode = needCode || (!fresh && !codeFree);
  const usable = !!device && !refuses && !(ask.kind !== "start" && blocked);
  const ready = usable && !blocked && !busy && !!who && (!showCode || code.length === 6) && (ask.kind !== "changes" || !!text.trim());
  const agentName = who ? tx(AGENT_LABEL[who]) : tx("the agent");
  const lacks = device && who && needs.length ? missingOn(needs, device, who) : [];
  const hereLacks = ask.kind === "start" ? ask.missingHere ?? [] : [];
  const [startingHere, setStartingHere] = useState(false);
  const startHere = async () => {
    if (ask.kind !== "start") return;
    setStartingHere(true);
    const r: { ok: boolean; error?: string; message?: string } = await startSessionAction(ask.taskId, who, surface ?? undefined, true)
      .catch(() => ({ ok: false, error: tx("That didn't go through. Try again.") }));
    setStartingHere(false);
    if (!r.ok) {
      setError(r.error ?? tx("That didn't go through. Try again."));
      return;
    }
    toast(r.message ?? tx("Session started"));
    onClose();
  };

  const title = ask.kind === "start" ? tx("Run on a computer")
    : ask.kind === "changes" ? tx("Send {0} to {1}", [isAnswers(text) ? "answers" : "changes", name])
      : ask.to === "desktop" ? tx("Continue in the {0} on {1}", [tx(APP_LABEL[ask.agent]), name])
        : ask.from === "cloud" ? tx("Pull into a terminal on {0}", [name]) : tx("Resume on {0}", [name]);
  const action = ask.kind === "start" ? tx("Send to {0}", [name])
    : ask.kind === "changes" ? tx("Send {0}", [isAnswers(text) ? "answers" : "changes"])
      : ask.to === "desktop" ? tx("Open in the {0}", [tx(APP_LABEL[ask.agent])]) : ask.from === "cloud" ? tx("Pull it in") : tx("Resume");

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!ready || !device || !who) return;
    setBusy(true);
    setError(null);
    const given = showCode ? code : "";
    let r: Awaited<ReturnType<typeof requestSessionAction>>;
    try {
      r = ask.kind === "start" ? await requestSessionAction(ask.taskId, who, device.id, given, surface)
        : ask.kind === "resume" ? await requestResumeAction(ask.sessionId, given, ask.to)
          : await requestChangesRemoteAction(ask.sessionId, text, given);
    } catch (err) {
      r = { ok: false, error: err instanceof Error ? err.message : tx("That didn't go through. Try again.") };
    }
    setBusy(false);
    if (!r.ok) {
      setError(r.error ?? tx("That didn't go through. Try again."));
      if (r.needCode) {
        setNeedCode(true);
        setCode("");
      }
      return;
    }
    if (ask.kind === "start" && !pinned) rememberPick(device.id);
    if (r.requestId) noteSentRequest(sentView(r.requestId, ask, device, task?.key ?? null));
    toast(r.message ?? tx("Sent to {0}", [device.name]));
    onClose();
  };

  // What will happen, in plain words: who has to be there, and what waits for whom.
  const hints: { icon: IconName; text: string }[] = [];
  // What the task needs from the computer (Task.needs): whether this one and the picked one have it.
  const key = task?.key ?? tx("the task");
  if (hereLacks.length) hints.push({ icon: "help", text: tx("{0} on this computer doesn't have {1}, which {2} needs.", [agentName, needList(hereLacks), key]) });
  if (device && who && needs.length) {
    const said = !!toolsOn(device, who);
    hints.push({
      icon: said && !lacks.length ? "check" : "help",
      text: !said ? tx("{0} hasn't said which MCP servers {1} has there.", [device.name, agentName])
        : lacks.length ? tx("{0}'s {1} doesn't have {2}{3}.", [device.name, agentName, needList(lacks), hereLacks.length ? tx(" either") : tx(", which {0} needs", [key])])
          : tx("{0}'s {1} has what {2} needs: {3}.", [device.name, agentName, key, needList(needs)]),
    });
  }
  if (usable) {
    if (!deviceOnline(device, now)) {
      hints.push({ icon: "clock", text: tx("{0} isn't online ({1}). The request waits there for 10 minutes.", [device.name, seen(device.lastSeenAt, now, tx).toLowerCase()]) });
    }
    if (asks) {
      hints.push({
        icon: "user",
        text: device.remoteStart === "auto"
          ? tx("Anything in the agent's cloud waits for you at {0}, whatever its setting: allow it in PacedMind there.", [device.name])
          : tx("It waits for you at {0}: allow it in PacedMind there.", [device.name]),
      });
    } else {
      hints.push({
        icon: "play",
        text: ask.kind === "start" ? tx("{0} starts it within seconds.", [device.name])
          : ask.kind === "resume" ? tx("{0} reopens it within seconds.", [device.name]) : tx("{0} sends it back to {1} within seconds.", [device.name, tx(AGENT_LABEL[ask.agent])]),
      });
    }
    if (ask.kind === "changes") {
      hints.push({
        icon: "pen",
        text: tx("{0} starts again in a new terminal with its last report, and reads your note as you wrote it.", [tx(AGENT_LABEL[ask.agent])]),
      });
    } else if (ask.kind === "resume" && ask.from === "cloud") {
      hints.push({ icon: "terminal", text: tx("A terminal on {0} pulls the cloud session and its branch in (claude --teleport).", [device.name]) });
    } else if (surface === "desktop" && who) {
      hints.push({
        icon: "appWindow",
        text: ask.kind === "resume" ? tx("The conversation opens in the {0} on {1}. Nothing runs until you write there.", [tx(APP_LABEL[who]), device.name])
          : tx("The {0} opens with the first message written. Nothing runs until you send it there.", [tx(APP_LABEL[who])]),
      });
    }
    if (surface === "terminal" && !(ask.kind === "resume" && ask.from === "cloud")) {
      hints.push({ icon: "terminal", text: tx("If {0} stops for a permission in its terminal, it waits for someone at {1}.", [agentName, device.name]) });
      if (who && tools?.login.state === "out") {
        hints.push({ icon: "user", text: tx("The {0} there isn't signed in: it asks for that in its terminal, at the computer.", [CLI_NAME(tx)[who]]) });
      }
    }
    if (!device.checkedAt) hints.push({ icon: "help", text: tx("{0} hasn't said yet what it has installed.", [device.name]) });
  }

  // Why nothing can be sent, when that's so.
  let stop: string | null = null;
  if (!pinned && !listed.length) {
    stop = tx("No computer is signed in to your account yet. Install the PacedMind desktop app on a computer and sign in there.");
  } else if (!pinned && listed.every((d) => d.remoteStart === "off")) {
    stop = tx("None of your computers takes sessions from elsewhere. At a computer, choose Ask me or Start under Settings → This computer.");
  } else if (!device) {
    stop = !pinned ? tx("Pick a computer.")
      : ask.kind === "start" ? tx("{0} runs on a computer that isn't signed in to PacedMind anymore. Pick another one in its details.", [task?.key ?? tx("This task")])
        : tx("The computer it ran on isn't signed in to PacedMind anymore, and a conversation only goes on where it is.");
  } else if (refuses) {
    stop = tx("{0} refuses sessions from elsewhere. At that computer, choose Ask me or Start under Settings → This computer.", [device.name]);
  } else if (ask.kind !== "start" && blocked) {
    stop = tx("{0}, so it can't go on there.", [blocked]);
  }

  return createPortal(
    // A dialog on a computer; on a phone a sheet from the bottom that grows to the screen's height and scrolls inside.
    <div className="fixed inset-0 z-[70] flex items-start justify-center bg-overlay pt-[7vh] max-md:items-end max-md:pt-3"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <form ref={formRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={titleId} onSubmit={submit}
        className={cx("flex max-h-[86dvh] w-[520px] max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-xl border border-line2 bg-raised shadow-[var(--shadow-popover)] outline-none",
          "max-md:max-h-full max-md:w-full max-md:max-w-none max-md:rounded-b-none max-md:rounded-t-2xl max-md:border-x-0 max-md:border-b-0")}>
        <div className="flex shrink-0 items-start gap-2 border-b border-line py-3.5 pl-5 pr-3 max-md:pl-4">
          <div className="flex min-w-0 flex-1 flex-col gap-1 pt-0.5">
            <h2 id={titleId} className="text-[15px] font-semibold leading-snug text-strong">{title}</h2>
            <p className="text-[12.5px] leading-relaxed text-mut">
              {task ? <><span className="font-mono text-[11.5px] text-fg2">{task.key}</span> {task.title}</> : tx("This task")}
              {ask.kind !== "start" && <span className="text-mut2"> · {tx(AGENT_LABEL[ask.agent])}</span>}
            </p>
          </div>
          <IconButton type="button" label={tx("Close")} onClick={onClose} className="pointer-coarse:h-9 pointer-coarse:w-9"><Icon name="x" size={15} /></IconButton>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-5 py-4 max-md:px-4">
          {ask.kind === "changes" && (
            <label className="flex flex-col gap-1.5">
              <span className="text-[12px] text-mut">{tx("What should change")}</span>
              <textarea value={text} onChange={(e) => setText(e.target.value)} autoFocus={fine} maxLength={20000} rows={5}
                placeholder={tx("Be as specific as you'd be with a colleague.")}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void submit(); }
                  // Escape leaves the note first, so a long one isn't lost to a stray key.
                  if (e.key === "Escape" && text.trim()) { e.stopPropagation(); e.currentTarget.blur(); }
                }}
                className="min-h-[112px] resize-y rounded-md border border-line2 bg-input px-2.5 py-2 text-[13px] leading-[1.55] text-fg2 outline-none placeholder:text-mut2 focus:border-line-strong max-md:text-[16px]" />
            </label>
          )}

          <Part title={tx("Computer")}>
            {pinned ? (
              device ? <DeviceInfo device={device} agent={who} now={now} here={device.id === hereId} needs={needs} boxed /> : null
            ) : (
              <div role="radiogroup" aria-label={tx("Computer")} className="flex flex-col gap-1.5">
                {listed.map((d) => {
                  // A computer that refuses requests from elsewhere is listed, so you see why, but can't be picked.
                  const off = d.remoteStart === "off";
                  return (
                    <button key={d.id} type="button" role="radio" aria-checked={d.id === deviceId} aria-disabled={off || undefined}
                      onClick={() => { if (!off) setDeviceId(d.id); }}
                      className={cx("flex w-full items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left",
                        d.id === deviceId ? "border-accent/55 bg-accent/5" : "border-line2", off ? "cursor-default opacity-60" : d.id !== deviceId && "hover:bg-hover")}>
                      <Radio on={d.id === deviceId} dim={off} />
                      <DeviceInfo device={d} agent={who} now={now} here={d.id === hereId} needs={needs} />
                    </button>
                  );
                })}
              </div>
            )}
            {pinned && device && (
              <p className="text-[12px] leading-relaxed text-mut2">
                {ask.kind === "start"
                  ? tx("{0} runs only on {1}, as it or its project says.{2}", [task?.key ?? tx("This task"), device.name, ask.avoid === device.id ? tx(" Send it there again, or pick another computer in its details.") : ""])
                  : tx("The conversation is on {0}, so it goes on there.", [device.name])}
              </p>
            )}
          </Part>

          {stop && <p className="rounded-md border border-line2 px-3 py-2 text-[12.5px] leading-relaxed text-fg3">{stop}</p>}

          {ask.kind === "start" && !stop && (
            <>
              <Part title={tx("Agent")}>
                <div role="radiogroup" aria-label={tx("Agent")} className="grid grid-cols-2 gap-1.5">
                  {AGENTS.map((a) => (
                    <button key={a} type="button" role="radio" aria-checked={agent === a} onClick={() => setAgent(a)}
                      className={cx("flex h-8 items-center justify-center gap-2 rounded-lg border text-[12.5px] max-md:h-10",
                        agent === a ? "border-accent/55 bg-accent/5 text-strong" : "border-line2 text-fg3 hover:bg-hover")}>
                      <AgentIcon agent={a} size={13} />{tx(AGENT_LABEL[a])}
                    </button>
                  ))}
                </div>
                {!agent && <p className="text-[12px] leading-relaxed text-mut2">{tx("Pick who runs")}{" "}{task?.key ?? "it"}{tx(": the task goes to that agent.")}</p>}
              </Part>
              {agent && (
                <Part title={tx("Where it runs")}>
                  <div role="radiogroup" aria-label={tx("Where it runs")} className="flex flex-col gap-1.5">
                    {SURFACES.map((s) => (
                      <SurfaceChoice key={s} surface={s} agent={agent} on={surface === s} problem={surfaceProblem(agent, s, device, tx)}
                        text={surfaceText(agent, s, tools, tx)} onPick={() => setPicked(s)} />
                    ))}
                  </div>
                  {!surface && (
                    <p className="text-[12px] leading-relaxed text-mut2">
                      {ask.surface === null
                        ? tx("In a terminal if {0} has the {1}, else in the {2}, unless you pick one here.", [name, CLI_NAME(tx)[agent], tx(APP_LABEL[agent])])
                        : tx("Where {0} says, unless you pick one here.", [task?.key ?? tx("the task")])}
                    </p>
                  )}
                </Part>
              )}
            </>
          )}

          {hints.length > 0 && (
            <ul className="flex flex-col gap-1.5 text-[12px] leading-[1.5] text-mut">
              {hints.map((h) => (
                <li key={h.text} className="flex gap-2">
                  <Icon name={h.icon} size={13} strokeWidth={2} className="mt-[2px] shrink-0 text-mut2" />
                  <span>{h.text}</span>
                </li>
              ))}
            </ul>
          )}

          {usable && (showCode ? (
            <label className="flex flex-col gap-1.5">
              <span className="text-[12px] text-mut">{tx("Two-factor code")}</span>
              {/* A start's choices come first (and would scroll away), so only a resume puts the cursor here. */}
              <input ref={codeRef} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} autoFocus={fine && ask.kind === "resume"}
                inputMode="numeric" autoComplete="one-time-code" enterKeyHint="send" placeholder="000000" aria-describedby={`${titleId}-code`}
                className="h-10 w-full rounded-md border border-line2 bg-input px-2.5 text-center font-mono text-[18px] tracking-[0.35em] text-fg outline-none placeholder:text-dim focus:border-line-strong" />
              <span id={`${titleId}-code`} className="text-[11.5px] leading-relaxed text-mut2">
                {tx("Asking a computer to run an agent takes a current code from your authenticator app.")}</span>
            </label>
          ) : (
            <p className="flex items-center gap-2 text-[12px] text-mut2">
              <Icon name="check" size={12} strokeWidth={2.2} className="shrink-0" />
              {codeFree ? tx("No code needed: {0} takes requests without one.", [name]) : tx("No code needed: you entered one in the last few minutes.")}
            </p>
          ))}

          {error && <p ref={errorRef} role="alert" className="rounded-md border border-line-strong px-3 py-2 text-[12.5px] leading-relaxed text-fg">{tx.generated(error)}</p>}
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-5 py-3 max-md:px-4 max-md:pb-[max(12px,env(safe-area-inset-bottom))]">
          <Button type="button" variant="ghost" onClick={onClose} className="max-md:h-10 max-md:flex-1 max-md:justify-center">{tx("Cancel")}</Button>
          {hereLacks.length > 0 && (
            <Button type="button" disabled={startingHere || busy} onClick={() => void startHere()} className="max-md:h-10 max-md:flex-1 max-md:justify-center">
              {startingHere ? tx("Starting…") : tx("Start here anyway")}
            </Button>
          )}
          {!stop && (
            <Button type="submit" variant="primary" disabled={!ready} className="min-w-0 max-md:h-10 max-md:flex-[2] max-md:justify-center">
              <span className="truncate">{busy ? tx("Sending…") : action}</span>
            </Button>
          )}
        </div>
      </form>
    </div>,
    document.body,
  );
}

/** The request as the chips show it until the next poll brings it (request-status.tsx). */
function sentView(id: string, ask: RunAsk, device: Device, taskKey: string | null): LaunchRequestView {
  const at = Date.now();
  return {
    id, kind: ask.kind, taskId: ask.taskId, agent: ask.agent ?? "claude", taskKey, targetSessionId: ask.kind === "start" ? null : ask.sessionId, sessionId: null,
    deviceId: device.id, deviceName: device.name, status: "pending", note: null,
    createdAt: new Date(at).toISOString(), expiresAt: new Date(at + 10 * 60_000).toISOString(), decidedAt: null,
  };
}

/* ---------- parts ---------- */

function Part({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="text-[12px] text-mut">{title}</div>
      {children}
    </div>
  );
}

function Radio({ on, dim }: { on: boolean; dim?: boolean }) {
  return (
    <span aria-hidden="true" className={cx("mt-[3px] flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border-[1.5px]",
      on ? "border-accent" : dim ? "border-faint" : "border-line-strong")}>
      {on && <span className="h-1.5 w-1.5 rounded-full bg-accent" />}
    </span>
  );
}

function Tag({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span title={title} className="inline-flex h-[18px] shrink-0 items-center rounded-full border border-ctl px-1.5 text-[10.5px] leading-none text-mut">
      {children}
    </span>
  );
}

/**
 * A computer: its name and markers, whether it's online, its setting, what it has of the agent (once there's one), and
 * whether that agent has what the task needs.
 */
function DeviceInfo({ device, agent, now, here, boxed, needs = [] }: {
  device: Device; agent: AgentId | null; now: number; here: boolean; boxed?: boolean; needs?: string[];
}) {
  const tx = useTranslation();
  const has = agent ? toolsOn(device, agent) : null;
  const lacks = agent ? missingOn(needs, device, agent) : [];
  const online = deviceOnline(device, now);
  return (
    <span className={cx("flex min-w-0 flex-1 flex-col gap-1", boxed && "rounded-lg border border-line2 px-3 py-2.5")}>
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="min-w-0 truncate text-[13px] font-medium text-strong">{device.name}</span>
        {here && <Tag>{tx("This computer")}</Tag>}
        {device.isDefault && <Tag>{tx("Default")}</Tag>}
        <span className="flex-1" />
        {!device.remoteCode && device.remoteStart !== "off" && <Tag title={tx("Asking it for a session needs no two-factor code")}>{tx("No code")}</Tag>}
        <Tag title={tx(SETTING_TITLE(tx)[device.remoteStart])}>{tx(REMOTE_START_LABEL[device.remoteStart])}</Tag>
      </span>
      <span className="flex items-center gap-1.5 text-[12px] text-mut2">
        <span aria-hidden="true" className={cx("h-[7px] w-[7px] shrink-0 rounded-full", online ? "bg-fg2" : "border border-dim")} />
        {online ? tx("Online") : seen(device.lastSeenAt, now, tx)} · {platformName(device.platform)}
      </span>
      {agent && <Tools agent={agent} tools={device.checkedAt ? device.agents[agent] : undefined} />}
      {agent && needs.length > 0 && (
        <span className={cx("text-[12px]", has && !lacks.length ? "text-fg3" : "text-dim")}>
          {!has ? tx("Hasn't said which MCP servers it has") : lacks.length ? tx("Doesn't have {0}", [needList(lacks)]) : tx("Has {0}", [needList(needs)])}
        </span>
      )}
    </span>
  );
}

/** What a computer has of one agent: its CLI, its desktop app and whether that reaches PacedMind, and the CLI's sign-in. */
function Tools({ agent, tools }: { agent: AgentId; tools: AgentTools | undefined }) {
  const tx = useTranslation();
  if (!tools) return <span className="text-[12px] text-dim">{tx("Hasn't said what it has installed yet")}</span>;
  const login = tools.login.state === "in"
    ? tx("Signed in{0}", [tools.login.plan ? `, ${capital(tools.login.plan)}` : tools.login.method ? ` (${tools.login.method})` : ""])
    : tools.login.state === "out" ? tx("Signed out") : null;
  // Whether each is there, and what it says. The app's MCP link only matters with an app.
  const parts: [boolean, string][] = [
    [!!tools.cli, tools.cli ? `CLI ${tools.cli.version}` : tx("No CLI")],
    [!!tools.app, tools.app ? tx(APP_LABEL[agent]) : tx("No {0}", [tx(APP_LABEL[agent])])],
    ...(tools.app ? [[mcpReaches(tools.mcp), MCP_TEXT(tx)[tools.mcp]] as [boolean, string]] : []),
    ...(login ? [[tools.login.state === "in", login] as [boolean, string]] : []),
  ];
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12px]">
      <AgentIcon agent={agent} size={11} className="text-mut2" />
      {parts.map(([on, text], i) => (
        // Each part keeps the dot before it, so a line that wraps doesn't end on one.
        <span key={text} className="flex items-center gap-1.5 whitespace-nowrap">
          {i > 0 && <span className="text-faint">·</span>}
          <span className={on ? "text-fg3" : "text-dim"}>{text}</span>
        </span>
      ))}
    </span>
  );
}

/** One place a session can run, or why the computer can't run it there. */
function SurfaceChoice({ surface, agent, on, problem, text, onPick }: {
  surface: Surface; agent: AgentId; on: boolean; problem: string | null; text: string; onPick: () => void;
}) {
  const tx = useTranslation();
  const label = surface === "terminal" ? tx("Terminal") : surface === "desktop" ? tx(APP_LABEL[agent]) : tx(CLOUD_LABEL[agent]);
  return (
    <button type="button" role="radio" aria-checked={on} aria-disabled={problem ? true : undefined} onClick={() => { if (!problem) onPick(); }}
      className={cx("flex w-full items-start gap-2.5 rounded-lg border px-3 py-2 text-left",
        on ? "border-accent/55 bg-accent/5" : "border-line2", problem ? "cursor-default" : !on && "hover:bg-hover")}>
      <Radio on={on} dim={!!problem} />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className={cx("flex items-center gap-1.5 text-[13px]", problem ? "text-mut" : "text-fg")}>
          <SurfaceIcon surface={surface} size={13} className="shrink-0 text-mut" />{label}
        </span>
        <span className={cx("text-[12px] leading-[1.45]", problem ? "text-dim" : "text-mut2")}>{problem ?? text}</span>
      </span>
    </button>
  );
}
