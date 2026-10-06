import { addDays, differenceInCalendarDays, format, startOfWeek } from "date-fns";
import { createTranslator, formatDate, type Language } from "./i18n";

const pad = (n: number) => String(n).padStart(2, "0");

/** "YYYY-MM-DD" in local time. */
export function toDateStr(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "YYYY-MM-DDTHH:mm" in local time. */
export function toDateTimeStr(d: Date): string {
  return `${toDateStr(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "YYYY-MM-DDTHH:mm:ss" in local time, used for timestamps. */
export function toStamp(d: Date): string {
  return `${toDateTimeStr(d)}:${pad(d.getSeconds())}`;
}

export const nowStamp = () => toStamp(new Date());
export const todayStr = () => toDateStr(new Date());

/** Parses "YYYY-MM-DD" or "YYYY-MM-DDTHH:mm[:ss]" as local time. */
export function parseLocal(s: string): Date {
  const [datePart, timePart] = s.split("T");
  const [y, m, d] = datePart.split("-").map(Number);
  if (!timePart) return new Date(y, m - 1, d);
  const [hh, mm, ss] = timePart.split(":").map(Number);
  return new Date(y, m - 1, d, hh || 0, mm || 0, ss || 0);
}

export const dateOnly = (s: string) => s.slice(0, 10);
export const timeOf = (s: string | null | undefined) => (s && s.length > 10 ? s.slice(11, 16) : null);
export const addDaysStr = (s: string, n: number) => toDateStr(addDays(parseLocal(dateOnly(s)), n));
export const mondayOf = (d: Date) => startOfWeek(d, { weekStartsOn: 1 });

export function dayDiff(from: string, to: string): number {
  return differenceInCalendarDays(parseLocal(dateOnly(to)), parseLocal(dateOnly(from)));
}

/** Minutes since midnight for "HH:mm". */
export function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

export function hhmm(minutes: number): string {
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

/** "HH:mm" from a typed time: "9", "930", "9:30", "9.30", "21", "2130", "9pm", "9:30 am". Null when it isn't one. */
export function parseTime(text: string): string | null {
  const m = text.trim().toLowerCase().match(/^(\d{1,2})(?:[:.h]?(\d{2}))?(?:\s*([ap])\.?m?\.?)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (m[3] === "p" ? 12 : 0);
  }
  return h > 23 || min > 59 ? null : hhmm(h * 60 + min);
}

export type DueTone = "overdue" | "today" | "soon" | "later";

/** Short due label and tone for list chips, relative to today. */
export function dueInfo(due: string | null, now = new Date(), language: Language = "en"): { text: string; tone: DueTone; long: string } | null {
  const tx = createTranslator(language);
  const f = (d: Date, pattern: string) => formatDate(d, pattern, language);
  if (!due) return null;
  const today = toDateStr(now);
  const diff = dayDiff(today, due);
  const t = timeOf(due);
  const d = parseLocal(dateOnly(due));
  if (diff < 0) {
    const text = diff === -1 ? tx("Yesterday") : language === "pl" ? `${-diff} ${diff === -1 ? "dzień" : "dni"} po terminie` : `${-diff}d overdue`;
    return { text, tone: "overdue", long: language === "pl" ? `${f(d, "EEE d MMM")} · ${-diff} ${diff === -1 ? "dzień" : "dni"} po terminie` : `${f(d, "EEE d MMM")} · ${-diff === 1 ? "1 day" : `${-diff} days`} late` };
  }
  if (diff === 0) {
    if (t) {
      const [h, m] = t.split(":").map(Number);
      const left = h * 60 + m - (now.getHours() * 60 + now.getMinutes());
      const long = language === "pl" ? `${tx("Today")}, ${t} · ${left > 0 ? `za ${Math.floor(left / 60)} godz. ${left % 60} min` : "termin minął"}` : left > 0 ? `Today, ${t} · in ${Math.floor(left / 60)}h ${left % 60}m` : `Today, ${t} · passed`;
      return { text: t, tone: left < 0 ? "overdue" : "today", long };
    }
    return { text: tx("Today"), tone: "today", long: tx("Today · by end of day") };
  }
  const label = diff === 1 ? tx("Tomorrow") : diff < 7 ? f(d, "EEE d") : f(d, "d MMM");
  return {
    text: t ? `${label}, ${t}` : label,
    tone: diff <= 2 ? "soon" : "later",
    long: `${f(d, "EEE d MMM")}${t ? `, ${t}` : ""} · ${language === "pl" ? `za ${diff} ${diff === 1 ? "dzień" : "dni"}` : `in ${diff} day${diff === 1 ? "" : "s"}`}`,
  };
}

/**
 * Whether a session's agent checked in over MCP since the session started, or since it went back to work on changes.
 * A session attached from outside PacedMind was at work already: it counts as checked in.
 */
const restartsTerminal = (e: { kind: string; text?: string }) => e.kind === "resumed" && /^Reopened in (a new |a )terminal/.test(e.text ?? "");

export function checkedIn(events: { kind: string; text?: string }[]): boolean {
  const back = events.findLastIndex((e) => e.kind === "changes_requested" || restartsTerminal(e));
  return events.slice(back + 1).some((e) => e.kind === "picked_up" || e.kind === "attached");
}

/**
 * True when a session started, or went back to work on requested changes, a while ago but its agent hasn't
 * checked in over MCP since. Usually the agent is waiting for an answer in its terminal.
 */
export function waitingInTerminal(
  s: { status: string; startedAt: string },
  events: { kind: string; at: string; text?: string }[],
  now = new Date(),
): boolean {
  if (s.status !== "starting" && s.status !== "running") return false;
  if (checkedIn(events)) return false;
  const back = events.findLastIndex((e) => e.kind === "changes_requested" || restartsTerminal(e));
  return now.getTime() - parseLocal(back >= 0 ? events[back].at : s.startedAt).getTime() > 90_000;
}

/**
 * Session events that mean the agent waits for you: its turn ended in its terminal (`waiting`), it asks for your
 * permission there (`permission`) or asks you something there (`input`), it stopped at a usage limit (`limit`), all
 * from the hooks in its terminal (signals.ts); or it asked you a question over MCP (`question`, report_progress).
 */
export const ATTENTION_KINDS = ["waiting", "permission", "input", "question", "limit", "capacity", "locked", "error", "setup", "send_prompt"] as const;
export type AttentionKind = (typeof ATTENTION_KINDS)[number];

export const isAttention = (kind: string): kind is AttentionKind => (ATTENTION_KINDS as readonly string[]).includes(kind);

/** What a session that waits for you shows: "Asks your permission", "Paused: usage limit"… */
export function attentionWords(kind: AttentionKind): string {
  if (kind === "permission") return "Asks your permission";
  if (kind === "waiting") return "Waiting for you";
  if (kind === "limit") return "Paused: usage limit";
  if (kind === "capacity") return "Paused: model at capacity";
  if (kind === "locked") return "Conversation open elsewhere";
  if (kind === "error") return "Paused: agent error";
  if (kind === "setup") return "Check agent startup";
  if (kind === "send_prompt") return "Send the first message";
  return "Has a question";
}

/** Events that say what a session runs with, not what it does: they don't end a wait. */
export const isNeutralEvent = (kind: string) => kind === "connected" || kind === "environment" || kind === "mcp_status";

/** An MCP server a session should have tools from but hasn't, and why, as an `mcp_status` event says it. */
export interface McpProblem {
  name: string;
  why: "auth" | "failed" | "connecting";
  /** The error code Claude Code gave for a failure, such as ENOENT. */
  code?: string | null;
}

const WHY: Record<McpProblem["why"], string> = {
  auth: "needs you to sign in (/mcp in its terminal)",
  failed: "didn't start",
  connecting: "hasn't connected yet",
};

/**
 * An `mcp_status` event: what the session's own records say about its MCP servers (session-mcp.ts), when one is
 * missing, and again once they're all there. The list comes after the colon, so mcpProblemsOf reads it back.
 */
export function mcpStatusText(who: string, problems: McpProblem[]): string {
  if (!problems.length) return `All its MCP servers are available to ${who} now`;
  return `Not available to ${who}: ${problems.map((p) => `${p.name} ${WHY[p.why]}${p.code ? ` (${p.code})` : ""}`).join("; ")}`;
}

/** What a session's latest `mcp_status` event says isn't available to it, as its text lists it; null when nothing. */
export function mcpProblemsOf(events: { kind: string; text: string }[]): string | null {
  const e = events.findLast((x) => x.kind === "mcp_status");
  return e ? (/^Not available to [^:]+: (.+)$/.exec(e.text)?.[1] ?? null) : null;
}

/**
 * What a session waits for you about: its latest event, when that's one of ATTENTION_KINDS. Anything after it (the
 * agent went back to work, called PacedMind, or you resumed it) means it went on. Only counts while it runs.
 */
export function attentionOf<E extends { kind: string }>(events: E[]): (E & { kind: AttentionKind }) | null {
  const last = events.findLast((e) => !isNeutralEvent(e.kind));
  return last && isAttention(last.kind) ? (last as E & { kind: AttentionKind }) : null;
}

/** A step of the plan an agent reports while it works (report_progress). */
export interface PlanStep {
  text: string;
  done: boolean;
}

/** A plan as a `plan` event keeps it: a line per step, "[x] " for done ones and "[ ] " for the rest. */
export const planText = (steps: PlanStep[]) => steps.map((s) => `[${s.done ? "x" : " "}] ${s.text}`).join("\n");

/** An event as a session's history shows it: a plan as how far along it is, the rest as its text. */
export function eventLine(e: { kind: string; text: string }, language: Language = "en"): string {
  const tx = createTranslator(language);
  if (e.kind === "plan") {
    const steps = e.text.split("\n").filter((l) => /^\[[ x]\] /.test(l));
    return tx("Plan: {0} of {1} steps done", [steps.filter((l) => l.startsWith("[x]")).length, steps.length]);
  }
  // These events come from PacedMind itself. Agent reports, questions and requested changes keep their text.
  if (["started", "connected", "mcp_status", "environment", "waiting", "permission", "input", "limit", "resumed", "closed", "ended", "failed", "setup", "send_prompt", "capacity", "locked", "done"].includes(e.kind)) return tx.generated(e.text || e.kind);
  return e.text || e.kind;
}

/** The latest plan a session's agent reported, or null. */
export function planOf(events: { kind: string; text: string; at: string }[]): { steps: PlanStep[]; at: string } | null {
  const e = events.findLast((x) => x.kind === "plan");
  if (!e) return null;
  const steps = e.text.split("\n").flatMap((line) => {
    const m = line.match(/^\[([ x])\] (.+)$/);
    return m ? [{ text: m[2], done: m[1] === "x" }] : [];
  });
  return steps.length ? { steps, at: e.at } : null;
}

export const fmtDay = (s: string, language: Language = "en") => formatDate(parseLocal(dateOnly(s)), "EEE, d MMM", language);
export const fmtShort = (s: string, language: Language = "en") => formatDate(parseLocal(dateOnly(s)), "d MMM", language);
export const fmtTime = (s: string) => format(parseLocal(s), "HH:mm");
