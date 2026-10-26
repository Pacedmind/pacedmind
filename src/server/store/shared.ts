import "server-only";
import { detailedOccurrences } from "@/lib/calendar-sync";
import { createHash } from "node:crypto";
import { addDays } from "date-fns";
import { areaPictureProblem } from "@/lib/area-picture";
import { parseLocal, toDateStr } from "@/lib/dates";
import {
  PREFERENCE_TEXT_MAX, PREFERENCE_TOPIC_MAX, topicOrder,
  type AskKind, type PushSubscriptionInput, type AgentExtras, type AgentLogin, type CalEvent, type Doer, type EventOccurrence, type FolderRequestStatus,
  type FolderTargetKind, type Harness,
  type LaunchRequestKind, type LaunchRequestStatus, type OtherSession, type OtherSessionState, type Preference, type PreferenceSource, type Priority,
  type ReportCriterion, type ReportOutcome, type SessionStatus, type Settings, type Status, type Surface, type AgentId, type ReportDiff, type SessionUsage,
  type TokenCounts,
} from "@/lib/types";

/*
 * What the two stores share: the shapes their functions take, and the rules that don't depend on where the
 * data lives (the account's, in Supabase, or this computer's own, in SQLite).
 */

export interface TaskFilter {
  /** An area's tasks, or with null the tasks without an area. */
  areaId?: string | null;
  /** A project's tasks, or with null the tasks without a project. */
  projectId?: string | null;
}

export interface TaskInput {
  modelSettings?: import("@/lib/agent-models").ModelSelection | null;
  deviceId?: string | null;
  title: string;
  areaId?: string | null;
  projectId?: string | null;
  description?: string;
  status?: Status;
  priority?: Priority;
  dueDate?: string | null;
  plannedDate?: string | null;
  /** "HH:mm" on the planned day; cleared with the planned day. */
  plannedTime?: string | null;
  estimateMin?: number;
  relatedProjectId?: string | null;
  repeat?: import("@/lib/types").Repeat | null;
  labels?: string[];
  doneWhen?: string[];
  needs?: string[];
  agent?: Doer | null;
  runIn?: Surface | null;
}

export type TaskPatch = Partial<TaskInput & {
  reminder: string | null; sortOrder: number;
  deviceId: string | null; folder: string | null;
}>;

export interface SessionFilter {
  taskId?: number;
  status?: SessionStatus[];

  surface?: Surface;
  agent?: AgentId;
  deviceId?: string;
}

export interface LaunchRequestFilter {
  deviceId?: string;
  status?: LaunchRequestStatus[];
  taskId?: number;
  /** Only requests made since then (an ISO timestamp). */
  since?: string;
  /** At most this many, newest first (default 200). */
  limit?: number;
}

/** A request to a computer, as the web app or another computer makes it (the database fills in the rest). */
export interface LaunchRequestInput {
  deviceId: string;
  taskId: number;
  agent: AgentId;
  /** Where it was asked from: "web", "desktop", or "agent" for an agent's start_session (the database sets it for one signed in to PacedMind Cloud). */
  via: string;
  kind?: LaunchRequestKind;
  surface?: Surface | null;
  targetSessionId?: string | null;
  changes?: string | null;
}

/** A folder asked of a computer (folder-requests.ts); the database fills in the rest. */
export interface FolderRequestInput {
  deviceId: string;
  target: { kind: FolderTargetKind; id: string };
  folder: string;
  /** "web" or "desktop"; the database makes an approved agent's "agent" itself. */
  via: "web" | "desktop" | "agent";
}

export interface FolderRequestFilter {
  deviceId?: string;
  status?: FolderRequestStatus[];
  ids?: string[];
}

/** Something a running session's agent waits for you to answer, as its computer asks it (asks.ts). */
export interface AskInput {
  sessionId: string;
  /** The computer the session runs on; null without an account. */
  deviceId: string | null;
  kind: AskKind;
  tool: string | null;
  text: string;
  remoteOk: boolean;
  /** When the agent stops waiting (ISO time). */
  expiresAt: string;
}

/** A browser that asked for notifications, as the account keeps it. */
export interface PushSubscriptionRow extends PushSubscriptionInput {
  createdAt: string;
}

export interface ReportInput {
  sessionId: string;
  taskId: number;
  outcome: ReportOutcome;
  summary: string;
  details?: string;
  criteria?: ReportCriterion[];
  verify?: string[];
  questions?: string[];
  links?: { label: string; url: string }[];
  followUps?: string[];
  /** Defaults to now. */
  createdAt?: string;
  /** What changed in git since the session started (diff.ts). */
  diff?: ReportDiff | null;
}

/**
 * A Codex cloud environment's label or id. It becomes part of a command line (`codex cloud exec --env …`), so
 * it's held to letters, digits, spaces and . _ / : - (the database checks the same, and the launcher again).
 */
export const CODEX_ENV = /^[A-Za-z0-9][A-Za-z0-9 ._/:-]{0,99}$/;

export function codexEnvProblem(value: string): string | null {
  return CODEX_ENV.test(value) ? null : "Use the environment's label or id: letters, digits, spaces and . _ / : - (up to 100 characters).";
}

/** "Done when" items without blanks or repeats, as many and as long as the database keeps. */
/**
 * A project's repository, the same on every computer (git-remote.ts): its remote as host/path, lowercase, and after
 * "#" the project's folder inside it when that isn't the repository's root. The database holds it to the same shape.
 */
export const REPO = /^[a-z0-9][a-z0-9.-]*(\/[a-z0-9._~-]+)+(#[a-z0-9._ ~-]+(\/[a-z0-9._ ~-]+)*)?$/;
export const repoOf = (v: unknown): string | null => (typeof v === "string" && v.length <= 300 && REPO.test(v) ? v : null);

const HARNESSES = new Set<string>(["claude-cli", "claude-app", "codex-cli", "codex-app"]);
const OTHER_STATES = new Set<string>(["working", "waiting", "idle"]);
/** How many sessions a computer reports that PacedMind didn't start (other-sessions.ts); the database holds it to that too. */
export const OTHER_SESSIONS_MAX = 30;

/** Text on one line, without control characters, at most `max` long. */
export const oneLine = (v: unknown, max: number): string =>
  typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";

const isoOf = (v: unknown): string | null => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);

/**
 * The sessions a computer found that PacedMind didn't start, held to their shape. What's in the cloud another computer
 * wrote, so every reader keeps only these fields, as plain short text.
 */
export function otherSessionsOf(v: unknown): OtherSession[] {
  if (!Array.isArray(v)) return [];
  return v.slice(0, OTHER_SESSIONS_MAX).flatMap((x): OtherSession[] => {
    if (!x || typeof x !== "object") return [];
    const r = x as Record<string, unknown>;
    const ref = typeof r.ref === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(r.ref) ? r.ref : null;
    const startedAt = isoOf(r.startedAt);
    const activeAt = isoOf(r.activeAt);
    if (typeof r.harness !== "string" || !HARNESSES.has(r.harness) || typeof r.state !== "string" || !OTHER_STATES.has(r.state)) return [];
    if (!ref || !startedAt || !activeAt) return [];
    const projectId = typeof r.projectId === "string" && /^[A-Za-z0-9-]{1,80}$/.test(r.projectId) ? r.projectId : null;
    const cli = typeof r.cli === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(r.cli) ? r.cli : null;
    return [{
      harness: r.harness as Harness, ref, ...(cli ? { cli } : {}), title: oneLine(r.title, 100), place: oneLine(r.place, 80), projectId,
      state: r.state as OtherSessionState, startedAt, activeAt,
    }];
  });
}

export const cleanDoneWhen = (items: string[]) =>
  [...new Set(items.map((x) => x.replace(/\s+/g, " ").trim().slice(0, 400)).filter(Boolean))].slice(0, 50);

/** A link the app may show for a session: https only, as the database keeps it. */
export const SESSION_URL = /^https:\/\/[^\s<>"']{1,1000}$/;

/** "Work" becomes WRK, "Health" HLT, "Dev" DEV; unique among the keys already `taken`. */
export function deriveKey(name: string, taken: Set<string>): string {
  const letters = name.toUpperCase().replace(/[^A-Z]/g, "");
  const consonants = letters.slice(1).replace(/[AEIOUY]/g, "");
  let base = letters.length <= 3 ? letters : letters[0] + consonants.slice(0, 2);
  if (base.length < 3) base = letters.slice(0, 3);
  if (base.length < 3) base = (base + "XXX").slice(0, 3);
  let key = base;
  for (let i = 2; taken.has(key); i++) key = `${base.slice(0, 2)}${i}`;
  return key;
}

/**
 * The key of an area renamed to `name`: its `current` one while that is still what the name makes (WR2 stays for
 * "Work"), else a new one, unique among the other areas' keys (`taken`). Its tasks keep their keys.
 */
export function renamedKey(name: string, current: string, taken: Set<string>): string {
  const base = deriveKey(name, new Set());
  if (current === base || new RegExp(`^${base.slice(0, 2)}\\d+$`).test(current)) return current;
  return deriveKey(name, taken);
}

/* ---------- calendar ---------- */

const stampMin = (d: Date) => `${toDateStr(d)}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

/** Expands events (including weekly ones) into occurrences between from and to (inclusive dates). */
export function expandOccurrences(events: CalEvent[], from: string, to: string): EventOccurrence[] {
  const out: EventOccurrence[] = [];
  const start = parseLocal(from);
  const end = parseLocal(to);
  for (const e of events) {
    if (e.calendar) { out.push(...detailedOccurrences(e, from, to)); continue; }
    const first = parseLocal(e.start);
    const durMs = parseLocal(e.end).getTime() - first.getTime();
    if (e.recurrence === "weekly") {
      for (let d = new Date(start); d <= end; d = addDays(d, 1)) {
        if (d.getDay() !== first.getDay() || toDateStr(d) < e.start.slice(0, 10)) continue;
        const st = new Date(d.getFullYear(), d.getMonth(), d.getDate(), first.getHours(), first.getMinutes());
        const en = new Date(st.getTime() + durMs);
        out.push({ eventId: e.id, title: e.title, areaId: e.areaId, start: stampMin(st), end: stampMin(en), weekly: true, done: e.doneOn.includes(toDateStr(d)) });
      }
    } else {
      const day = e.start.slice(0, 10);
      if (day >= from.slice(0, 10) && day <= to.slice(0, 10)) {
        out.push({ eventId: e.id, title: e.title, areaId: e.areaId, start: e.start, end: e.end, weekly: false, done: e.doneOn.includes(day) });
      }
    }
  }
  return out.sort((a, b) => a.start.localeCompare(b.start));
}

/** The days an activity was marked done, as stored: only real dates, each once, at most a few years' worth. */
export const doneDaysOf = (v: unknown): string[] =>
  [...new Set(strings(Array.isArray(v) ? v : parseJson(v)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)))].sort().slice(-2000);

function parseJson(v: unknown): unknown {
  try { return typeof v === "string" ? JSON.parse(v) : null; } catch { return null; }
}

/** The days after marking one done or not done. */
export const withDoneDay = (days: string[], day: string, done: boolean) =>
  doneDaysOf(done ? [...days, day] : days.filter((d) => d !== day));

/* ---------- reports ---------- */

/*
 * A report's lists come from wherever the report was stored; in the cloud, any browser or computer signed in
 * to the account can write them. Keep only the shapes the app shows, and only http and https links.
 */
export const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const VERDICTS = new Set<string>(["met", "partly", "not_met"]);

export function criteriaOf(v: unknown): ReportCriterion[] {
  if (!Array.isArray(v)) return [];
  return v.filter((c): c is Record<string, unknown> => !!c && typeof c === "object" && typeof (c as Record<string, unknown>).text === "string").map((c) => ({
    text: String(c.text),
    verdict: VERDICTS.has(String(c.verdict)) ? (c.verdict as ReportCriterion["verdict"]) : null,
    note: typeof c.note === "string" ? c.note : "",
  }));
}

export function linksOf(v: unknown): { label: string; url: string }[] {
  if (!Array.isArray(v)) return [];
  return v.filter((l): l is Record<string, unknown> => !!l && typeof l === "object" && typeof (l as Record<string, unknown>).url === "string"
    && /^https?:\/\//i.test(String((l as Record<string, unknown>).url)))
    .map((l) => ({ label: typeof l.label === "string" && l.label.trim() ? l.label : String(l.url), url: String(l.url) }));
}

/* ---------- computers ---------- */

/**
 * A computer's name as the account keeps it: plain text on one line, at most 80 characters (the database refuses
 * control characters). Any session of the account can rename a computer, and the computer takes the name over.
 */
/** An area's picture as stored (base64 PNG), or null when there's none or it isn't one (area-picture.ts). */
export const areaPictureOf = (v: unknown): string | null => (typeof v === "string" && v && !areaPictureProblem(v) ? v : null);

/** What Area.picture carries: a short hash of the stored picture, which keeps its URL cacheable. */
export const pictureHash = (v: unknown): string | null => {
  const picture = areaPictureOf(v);
  return picture ? createHash("sha256").update(picture).digest("hex").slice(0, 16) : null;
};

export const cleanDeviceName = (name: string) => name.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);

/** PacedMind's version as a computer reports it, in the shape the database keeps (supabase/migrations). */
export const APP_VERSION = /^[0-9]{1,6}(\.[0-9]{1,6}){0,3}([-+][0-9A-Za-z.+-]{1,32})?$/;
export const appVersionOk = (v: string) => v.length <= 40 && APP_VERSION.test(v);

/**
 * A word from an agent's sign-in status (its method or plan), or undefined: lower case, short, and without @, slashes or
 * anything else an email, a path or a key would need, so none of those can travel with it.
 */
export function loginWord(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const w = v.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9 ._-]{0,23}$/.test(w) ? w : undefined;
}

/** An agent's sign-in status from wherever it was stored (the cloud's copy can be written by any session of the account). */
export function loginOf(v: unknown): AgentLogin {
  const l = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const state = l.state === "in" || l.state === "out" ? l.state : "unknown";
  const method = loginWord(l.method);
  const plan = loginWord(l.plan);
  return { state, ...(method ? { method } : {}), ...(plan ? { plan } : {}) };
}

/**
 * What a computer says its agent has besides PacedMind (extras.ts), checked the way it's read back from the cloud:
 * lists of plain names, and a count. Undefined when there's nothing usable.
 */
export function extrasOf(v: unknown, max = 12): AgentExtras | undefined {
  if (!v || typeof v !== "object") return undefined;
  const h = v as Record<string, unknown>;
  const list = (x: unknown, shape: RegExp) => strings(x).filter((n) => shape.test(n)).slice(0, max);
  const skills = typeof h.skills === "number" && Number.isInteger(h.skills) && h.skills >= 0 ? Math.min(h.skills, 9999) : 0;
  const account = list(h.account, /^[\w .@:+-]{1,48}$/);
  const accountAt = typeof h.accountAt === "string" && /^\d{4}-\d\d-\d\dT[\d:.]{8,12}Z$/.test(h.accountAt) ? h.accountAt : null;
  return {
    mcp: list(h.mcp, /^[\w.@:+-]{1,48}$/), plugins: list(h.plugins, /^[\w.@:+-]{1,48}$/), skills, hooks: list(h.hooks, /^[A-Za-z]{1,40}$/),
    ...(accountAt ? { account, accountAt } : {}),
  };
}

/** A session's usage as a store keeps it (JSON), checked: plain numbers, plain model names, at most 20 conversations. */
export function usageOf(v: unknown): SessionUsage | null {
  const o = typeof v === "string" ? (() => { try { return JSON.parse(v) as unknown; } catch { return null; } })() : v;
  if (!o || typeof o !== "object") return null;
  const u = o as Record<string, unknown>;
  const count = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? Math.min(Math.round(x), 1e13) : 0);
  const conversations: Record<string, TokenCounts> = {};
  if (u.conversations && typeof u.conversations === "object") {
    for (const [id, t] of Object.entries(u.conversations as Record<string, unknown>).slice(0, 20)) {
      if (!/^[\w-]{1,64}$/.test(id) || !t || typeof t !== "object") continue;
      const c = t as Record<string, unknown>;
      conversations[id] = { input: count(c.input), cacheRead: count(c.cacheRead), cacheWrite: count(c.cacheWrite), output: count(c.output) };
    }
  }
  const models = strings(u.models).filter((m) => /^[\w.:@/-]{1,80}$/.test(m)).slice(0, 5);
  const at = typeof u.at === "string" && /^\d{4}-\d\d-\d\dT[\d:.]{8,12}Z$/.test(u.at) ? u.at : null;
  const amount = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? Math.min(x, 1e9) : 0);
  return at ? { conversations, costUsd: amount(u.costUsd), activeSeconds: amount(u.activeSeconds), models, at } : null;
}

const DIFF_STATUSES = ["added", "modified", "deleted", "renamed", "untracked"] as const;
const SHORT_SHA = /^[0-9a-f]{4,64}$/;

/**
 * A report's diff as a store keeps it (JSON, maybe from the cloud), checked: abbreviated commits, plain texts cut to
 * length, whole counts, at most 30 commits and 200 files, and a patch id in the shape diff.ts makes them.
 */
export function diffOf(v: unknown): ReportDiff | null {
  const o = typeof v === "string" ? (() => { try { return JSON.parse(v) as unknown; } catch { return null; } })() : v;
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  const d = o as Record<string, unknown>;
  const count = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? Math.min(Math.round(x), 1e9) : 0);
  const lines = (x: unknown) => (x === null ? null : count(x));
  const text = (x: unknown, max: number) => (typeof x === "string" ? x.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max) : "");
  const skipped = d.skipped === "asks" || d.skipped === "git" ? d.skipped : null;
  const sha = (x: unknown) => (typeof x === "string" && SHORT_SHA.test(x) ? x : "");
  const commits = (Array.isArray(d.commits) ? d.commits : []).slice(0, 30).flatMap((c) => {
    const x = c && typeof c === "object" ? (c as Record<string, unknown>) : null;
    return x && sha(x.sha) ? [{ sha: sha(x.sha), subject: text(x.subject, 200) }] : [];
  });
  const files = (Array.isArray(d.files) ? d.files : []).slice(0, 200).flatMap((f) => {
    const x = f && typeof f === "object" ? (f as Record<string, unknown>) : null;
    const status = DIFF_STATUSES.find((st) => st === x?.status);
    const path = x ? text(x.path, 500) : "";
    if (!x || !status || !path) return [];
    const from = text(x.from, 500);
    return [{ path, status, added: lines(x.added), removed: lines(x.removed), ...(from ? { from } : {}) }];
  });
  if (!skipped && !sha(d.base)) return null;
  return {
    base: sha(d.base), head: sha(d.head), commits, moreCommits: count(d.moreCommits), files, moreFiles: count(d.moreFiles),
    added: count(d.added), removed: count(d.removed), dirtyAtStart: d.dirtyAtStart === true,
    patchId: typeof d.patchId === "string" && /^[0-9a-f]{16}$/.test(d.patchId) ? d.patchId : null,
    truncated: d.truncated === true, skipped,
  };
}

/* ---------- settings ---------- */

/** Planning settings, which follow the account (or stay on this computer). How sessions start is device.ts's. */
export const DEFAULT_SETTINGS: Settings = {
  workStart: "09:00", workEnd: "17:00", lunchStart: "12:30", lunchEnd: "13:30", workDays: [1, 2, 3, 4, 5],
};
export const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[];

/* ---------- preferences ---------- */

/** A preference's text as it's kept: one line of plain characters (the database checks it too). */
export const cleanPreference = (text: string) => oneLine(text, PREFERENCE_TEXT_MAX).trim();

/** A topic as it's kept: any short name, on one line. */
export const cleanTopic = (text: string) => oneLine(text, PREFERENCE_TOPIC_MAX).trim();

/** A stored preference, or null when a row isn't one (the account's rows are read as they are). */
export function preferenceOf(r: Record<string, unknown>): Preference | null {
  const text = typeof r.text === "string" ? cleanPreference(r.text) : "";
  const topic = typeof r.topic === "string" ? cleanTopic(r.topic) : "";
  if (!topic || !text) return null;
  return { id: Number(r.id), topic, text, source: r.source === "agent" ? "agent" : "you", updatedAt: String(r.updated_at ?? "") };
}

export interface PreferenceInput {
  topic: string;
  text: string;
  source: PreferenceSource;
}

export interface PreferencePatch {
  topic?: string;
  text?: string;
  source: PreferenceSource;
}

/** In their topics' order, then as they were added. */
export const byTopic = (a: Preference, b: Preference) => topicOrder(a.topic, b.topic) || a.id - b.id;
