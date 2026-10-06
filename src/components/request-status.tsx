"use client";
import { useTranslation } from "@/components/language";
import { createTranslator, type Translator } from "@/lib/i18n";

import Link from "next/link";
import { useEffect, useState, useSyncExternalStore } from "react";
import { deviceOnline, type AskView, type Device, type LaunchRequestView } from "@/lib/types";
import { Icon } from "./icons";
import type { RunAsk } from "./remote-start";
import { cx } from "./ui";

/*
 * Requests to the account's computers (start a session, resume one, send one back with changes) and what became of
 * them, for the chips that show it where you asked: "Waiting for X…", "Started on X", "Refused by X". LiveRefresh polls
 * /api/state for the page and hands every answer here, so all chips share its poll, and a request sent from this page
 * shows at once, before the poll brings it. The account's computers come from the "Run on a computer" sheet
 * (remote-start.tsx), which the app's frame gives them to; in the desktop app that's the other computers.
 */

export interface LaunchState {
  /** The last half hour's requests, newest first. */
  requests: LaunchRequestView[];
  /** Until when (ms) a request may go without a two-factor code, since one was entered in this session. A hint: the database decides. */
  codeFreshUntil: number | null;
  computers: Device[];
  /** What running sessions' agents wait for you to answer (AskCard). */
  asks: AskView[];
}

const EMPTY: LaunchState = { requests: [], codeFreshUntil: null, computers: [], asks: [] };
let current = EMPTY;
let polled: LaunchRequestView[] = [];
/** Requests sent from this page that no poll has brought yet, with when they were sent. */
const sent = new Map<string, { view: LaunchRequestView; at: number }>();
const listeners = new Set<() => void>();

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function update(patch: Partial<LaunchState>) {
  current = { ...current, ...patch };
  for (const fn of listeners) fn();
}

const merged = () => [...[...sent.values()].map((s) => s.view).reverse(), ...polled];

/** What /api/state answered (LiveRefresh). */
export function publishLaunchState(state: { requests?: unknown; codeFreshUntil?: unknown; asks?: unknown }) {
  polled = Array.isArray(state.requests) ? (state.requests as LaunchRequestView[]) : [];
  const now = Date.now();
  // Once a poll has it the server's copy counts; one that no poll brought within a minute isn't coming.
  for (const [id, s] of sent) if (polled.some((r) => r.id === id) || now - s.at > 60_000) sent.delete(id);
  update({
    requests: merged(), codeFreshUntil: typeof state.codeFreshUntil === "number" ? state.codeFreshUntil : null,
    asks: Array.isArray(state.asks) ? (state.asks as AskView[]) : [],
  });
}

/** A request this page just sent: it shows as waiting right away, and the page polls for what became of it. */
export function noteSentRequest(view: LaunchRequestView) {
  sent.set(view.id, { view, at: Date.now() });
  update({ requests: merged() });
  pollLaunchState();
}

/** The account's computers, from the app's frame. */
export function publishComputers(computers: Device[]) {
  if (computers !== current.computers) update({ computers });
}

/** LiveRefresh polls /api/state at once when this fires, instead of at its next tick. */
export const POLL_EVENT = "pacedmind:poll-state";
export const pollLaunchState = () => window.dispatchEvent(new Event(POLL_EVENT));

export function useLaunchState(): LaunchState {
  return useSyncExternalStore(subscribe, () => current, () => EMPTY);
}

/** One of the account's computers by id (undefined until the frame said, or when it's gone). */
export function useComputer(id: string | null | undefined): Device | undefined {
  const { computers } = useLaunchState();
  return id ? computers.find((d) => d.id === id) : undefined;
}

/** The time, ticking every `ms`. Chips and the sheet only render in the browser, so the first value can be now. */
export function useClock(ms = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [ms]);
  return now;
}

/** How long a decided request's chip stays where you asked. */
const SHOWN_MS = 10 * 60_000;

/** The event that opens "Run on a computer" (remote-start.tsx) with a RunAsk. */
export const RUN_SHEET = "pacedmind:remote-start";

/**
 * Opens "Run on a computer" for a task whose start request expired on a computer that didn't answer, to send it to
 * another one: one that's online and has what the task needs, when there is one.
 */
export function tryAnotherComputer(r: LaunchRequestView) {
  const ask: RunAsk = { kind: "start", taskId: r.taskId, agent: r.agent, deviceId: null, pinned: false, avoid: r.deviceId };
  window.dispatchEvent(new CustomEvent<RunAsk>(RUN_SHEET, { detail: ask }));
}

/** A request past its time that the computer never answered counts as expired, even before the next poll says so. */
export const statusAt = (r: LaunchRequestView, now: number) => (r.status === "pending" && Date.parse(r.expiresAt) <= now ? "expired" : r.status);

/** Chips someone closed, for the rest of the page's life. */
const dismissed = new Set<string>();
export const dismissRequest = (id: string) => { dismissed.add(id); };

/** Whether a request still has something to say: it's waiting, or was decided in the last ten minutes and not dismissed. */
export function requestShown(r: LaunchRequestView, now: number): boolean {
  if (dismissed.has(r.id)) return false;
  if (statusAt(r, now) === "pending") return true;
  return now - Date.parse(r.decidedAt ?? r.expiresAt) < SHOWN_MS;
}

/** The newest request `match` picks, if it still has something to say. */
export function latestRequest(requests: LaunchRequestView[], match: (r: LaunchRequestView) => boolean, now: number): LaunchRequestView | null {
  const r = requests.find(match);
  return r && requestShown(r, now) ? r : null;
}

/** "12:04" for a timestamp. */
const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** What a request's chip says, by its kind and what became of it. */
export function requestText(r: LaunchRequestView, now: number, computer?: Device, tx: Translator = createTranslator("en")): { text: string; title: string } {
  const on = r.deviceName ?? tx("your computer");
  const asked = tx("Asked {0}", [clock(r.createdAt)]);
  switch (statusAt(r, now)) {
    case "pending": {
      const what = r.kind === "resume" ? tx(" to resume it") : r.kind === "changes" ? tx(" to take your changes") : "";
      const away = computer && !deviceOnline(computer, now) ? tx(" (offline)") : "";
      return { text: tx("Waiting for {0}{1}…{2}", [on, what, away]), title: tx("{0}. It waits there until {1}.", [asked, clock(r.expiresAt)]) };
    }
    case "launched":
      return {
        text: r.kind === "resume" ? tx("Resumed on {0}", [on]) : r.kind === "changes" ? tx("Changes sent to {0}", [on]) : tx("Started on {0}", [on]),
        title: tx("{0}, done {1}.", [asked, clock(r.decidedAt ?? r.createdAt)]),
      };
    case "denied":
      return { text: tx("Refused by {0}", [on]), title: r.note ? tx.generated(r.note) : tx("Refused on the computer") };
    case "expired":
      return { text: tx("Expired: {0} didn't answer", [on]), title: tx("{0}. A request waits 10 minutes.", [asked]) };
    case "canceled":
      return { text: tx("Canceled: {0} was signed out", [on]), title: asked };
    default:
      return { text: tx("Failed: {0}", [r.note ?? tx("unknown error")]), title: asked };
  }
}

/**
 * The newest request `match` picks, as a chip: "Waiting for X…", "Started on X" (with a link to the session unless
 * `link` is false), "Refused by X", "Expired", "Failed: why". Nothing when there's none, or it's old news.
 */
export function RequestStatus({ match, link = true, className }: {
  match: (r: LaunchRequestView) => boolean;
  link?: boolean;
  className?: string;
}) {
  const { requests, computers } = useLaunchState();
  const now = useClock();
  const [, setClosed] = useState(0);
  const r = latestRequest(requests, match, now);
  if (!r) return null;
  return (
    <RequestChip request={r} now={now} computer={computers.find((d) => d.id === r.deviceId)} link={link} className={className}
      onClose={() => { dismissRequest(r.id); setClosed((n) => n + 1); }} />
  );
}

/** What became of a request, as a mark in a circle (the chip's own ✕ closes it): refused, failed or canceled. */
const MARK = {
  denied: "M5.6 5.6l12.8 12.8",
  failed: "M12 7.5v5.5 M12 16.5h.01",
  canceled: "M8 12h8",
} as const;

function StatusMark({ status }: { status: LaunchRequestView["status"] }) {
  if (status === "launched") return <Icon name="check" size={12} strokeWidth={2.2} className="shrink-0 text-mut2" />;
  if (status === "expired") return <Icon name="clock" size={12} strokeWidth={2.2} className="shrink-0 text-mut2" />;
  const mark = status === "denied" || status === "canceled" ? MARK[status] : MARK.failed;
  return (
    <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round"
      aria-hidden="true" className="shrink-0 text-mut2">
      <path d={`M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0 ${mark}`} />
    </svg>
  );
}

export function RequestChip({ request: r, now, computer, link = true, className, onClose }: {
  request: LaunchRequestView;
  now: number;
  computer?: Device;
  link?: boolean;
  className?: string;
  onClose?: () => void;
}) {
  const tx = useTranslation();
  const status = statusAt(r, now);
  const { text, title } = requestText(r, now, computer, tx);
  return (
    // role=status: a screen reader hears it change from waiting to what the computer did.
    <div role="status" title={title}
      className={cx("inline-flex min-h-6 max-w-full items-center gap-2 self-start rounded-xl border border-line2 py-[3px] pl-2.5 text-[12px] leading-snug text-fg3",
        onClose && status !== "pending" ? "pr-1" : "pr-2.5", className)}>
      {status === "pending"
        ? <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 animate-spin rounded-full border-[1.5px] border-mut2 border-t-transparent motion-reduce:animate-none" />
        : <StatusMark status={status} />}
      <span className="min-w-0 wrap-break-word">{text}</span>
      {status === "expired" && r.kind === "start" && (
        <button type="button" onClick={() => tryAnotherComputer(r)}
          className="shrink-0 text-fg2 underline decoration-line-strong underline-offset-2 hover:text-strong">
          {tx("Try another computer")}</button>
      )}
      {status === "launched" && link && r.sessionId && (
        <Link href={`/sessions?s=${r.sessionId}`} className="shrink-0 text-fg2 underline decoration-line-strong underline-offset-2 hover:text-strong">
          {tx("Open session")}</Link>
      )}
      {onClose && status !== "pending" && (
        <button type="button" aria-label={tx("Dismiss")} onClick={onClose}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-mut2 hover:bg-hover hover:text-fg2 pointer-coarse:h-7 pointer-coarse:w-7">
          <Icon name="x" size={11} strokeWidth={2.2} />
        </button>
      )}
    </div>
  );
}
