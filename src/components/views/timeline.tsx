"use client";
import { useTranslation } from "@/components/language";
import { createTranslator, type Translator } from "@/lib/i18n";

import { useRouter } from "next/navigation";
import {
  useEffect, useLayoutEffect, useOptimistic, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent, type ReactNode,
} from "react";
import { getDaysInMonth } from "date-fns";
import { deleteEdgeAction, linkTasksAction, updateTaskAction } from "@/app/actions";
import { projectColor } from "@/lib/colors";
import { addDaysStr, dateOnly, dayDiff, fmtDay, fmtShort, minutesOf, parseLocal, timeOf, toStamp } from "@/lib/dates";
import {
  AGENT_LABEL, type Area, type Dependency, type Project, type Session, type SessionStatus, type Task, type TaskContext,
} from "@/lib/types";
import type { DayLoad, TaskState } from "@/server/timeline";
import { TIMELINE_DAYS, TIMELINE_ZOOMS, type TimelineZoom } from "@/lib/timeline";
import { AreaMark, Diamond, Icon, ProgressRing } from "@/components/icons";
import { Popover, PopoverItem, PopoverLabel, type Anchor } from "@/components/popover";
import type { QuickAddDefaults } from "@/components/quick-add";
import { TaskDetail } from "@/components/task-detail";
import { Segmented, cx, toast, useAction } from "@/components/ui";
import { useAddOnClick } from "./calendar-parts";

/* ---------- small helpers, also used by the roadmap ---------- */

/** A color at the given opacity, for area-colored bars and outlines. */
export const tint = (color: string, pct: number) => `color-mix(in srgb, ${color} ${pct}%, transparent)`;

/** Fractional days from `from` (local midnight) to a date or timestamp. */
export function dayPos(from: string, stamp: string): number {
  const t = timeOf(stamp);
  return dayDiff(from, stamp) + (t ? minutesOf(t) / 1440 : 0);
}

/** An element's width, kept up to date. `fallback` is used until it has been measured. */
export function useWidth<T extends HTMLElement>(fallback: number) {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

/** Below Tailwind's md breakpoint, where the `max-md:` styles apply: a phone. */
const PHONE = "(width < 48rem)";

function onPhoneChange(notify: () => void) {
  const query = window.matchMedia(PHONE);
  query.addEventListener("change", notify);
  return () => query.removeEventListener("change", notify);
}

/** Whether the window is phone-sized. The server renders the computer's layout. */
function usePhone() {
  return useSyncExternalStore(onPhoneChange, () => window.matchMedia(PHONE).matches, () => false);
}

/* ---------- layout ---------- */

/** The zoom buttons fit this many days in view; the wheel (with Ctrl, or over the days) zooms anywhere between. */
const ZOOM = (tx: Translator): Record<TimelineZoom, { label: string; days: number; minDay: number }> => ({
  day: { label: tx("Day"), days: 1, minDay: 480 },
  week: { label: tx("Week"), days: 7, minDay: 72 },
  month: { label: tx("Month"), days: 28, minDay: 18 },
  quarter: { label: tx("Quarter"), days: 91, minDay: 5 },
});

type Layer = "tasks" | "sessions" | "blocks" | "deadlines" | "deps";

const LAYERS = (tx: Translator): { id: Layer; label: string }[] => ([
  { id: "tasks", label: tx("Tasks") },
  { id: "sessions", label: tx("Sessions") },
  { id: "blocks", label: tx("Time blocks") },
  { id: "deadlines", label: tx("Deadlines") },
  { id: "deps", label: tx("Dependencies") },
]);

/** Pixels per day, from a whole quarter in view to a day whose hours are 200 px wide. */
const MIN_DAY_W = 4;
const MAX_DAY_W = 4800;
/** From this width a day shows its hours. */
const HOURS_FROM = 160;
/** How far from either end of the range the next range is asked for, in days. */
const EDGE = 14;

const TREE = 260;
/** On a phone the names get a narrow column, so the days keep most of the screen. */
const TREE_PHONE = 148;
/** Where the names start: areas (and "Your time"), projects and the tasks beside them, tasks in a project. */
const INDENT = { area: 20, proj: 26, task: 26, nested: 44 };
const INDENT_PHONE = { area: 12, proj: 16, task: 16, nested: 30 };
const ROW_H = { cap: 40, area: 30, proj: 32, task: 28 };
/** Task bars sit at the top of their row; agent sessions run in a thin lane below them. */
const BAR_TOP = 4;
const BAR_H = 18;
const BAR_MID = BAR_TOP + BAR_H / 2;
const LANE_TOP = 24;
/** The zone beside each end of a bar that holds its connection dot. */
const DOT_ZONE = 14;
const NAV = "inline-flex h-7 w-7 items-center justify-center rounded-md text-mut hover:bg-hover hover:text-fg2";
const ACCENT_LINE = "color-mix(in srgb, var(--color-accent) 70%, transparent)";

interface Span {
  s: number;
  e: number;
}

interface TaskSpan extends Span {
  due: number | null;
}

interface Scale {
  from: string;
  days: number;
  dayW: number;
  gridW: number;
  X: (d: number) => number;
  now: string;
  nowPos: number;
  today: string;
}

type AreaRow = { kind: "area"; id: string; y: number; h: number; areaId: string; name: string; area: Area | null; open: boolean };
type ProjectRow = {
  kind: "proj"; id: string; y: number; h: number; project: Project; color: string; open: boolean;
  done: number; total: number; started: boolean; span: Span | null;
};
type TaskRow = { kind: "task"; id: string; y: number; h: number; task: Task; color: string; nested: boolean; span: TaskSpan; sessions: Session[] };
type Row = { kind: "cap"; id: string; y: number; h: number } | AreaRow | ProjectRow | TaskRow;

const isActive = (x: Session) => x.status === "running" || x.status === "starting";
const isOpenTask = (t: Task) => t.status !== "done" && t.status !== "canceled";

/**
 * Start: the planned day, else the day its first session started, else the day it was created; a task that
 * hasn't started and has neither waits for the tasks it depends on. End: the deadline, or the estimate in 8-hour days.
 */
function taskSpans(tasks: Task[], sessionsOf: Map<number, Session[]>, edges: Dependency[], from: string): Map<number, TaskSpan> {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const sources = new Map<number, number[]>();
  for (const e of edges) sources.set(e.toTaskId, [...(sources.get(e.toTaskId) ?? []), e.fromTaskId]);
  const out = new Map<number, TaskSpan>();
  const visiting = new Set<number>();
  const spanOf = (t: Task): TaskSpan => {
    const known = out.get(t.id);
    if (known) return known;
    visiting.add(t.id);
    const first = sessionsOf.get(t.id)?.[0];
    let s = dayDiff(from, t.plannedDate ?? dateOnly(first?.startedAt ?? t.createdAt));
    if (!t.plannedDate && !first && (t.status === "todo" || t.status === "backlog")) {
      for (const id of sources.get(t.id) ?? []) {
        const src = byId.get(id);
        if (src && !visiting.has(id)) s = Math.max(s, Math.ceil(spanOf(src).e));
      }
    }
    const due = t.dueDate ? (timeOf(t.dueDate) ? dayPos(from, t.dueDate) : dayDiff(from, t.dueDate) + 1) : null;
    const span = { s, e: due !== null && due > s ? due : s + Math.max(1, Math.ceil(t.estimateMin / 480)), due };
    visiting.delete(t.id);
    out.set(t.id, span);
    return span;
  };
  for (const t of tasks) spanOf(t);
  return out;
}

function sessionSpan(x: Session, from: string, now: string): Span {
  return { s: dayPos(from, x.startedAt), e: dayPos(from, isActive(x) ? now : x.finishedAt ?? x.endedAt ?? x.startedAt) };
}

/** Where a bar sits in its lane: clamped to the days in view, at least 6px wide. */
function barBox(sp: Span, sc: Scale) {
  const clampX = (d: number) => sc.X(Math.max(0, Math.min(sc.days, d)));
  const left = clampX(sp.s) + 1;
  return { left, width: Math.max(6, clampX(sp.e) - 1 - left) };
}

function buildRows(input: {
  areas: Area[]; projects: Project[]; tasks: Task[]; sessionsOf: Map<number, Session[]>; spans: Map<number, TaskSpan>;
  sc: Scale; expanded: Record<string, boolean>; collapsed: Record<string, boolean>;
}, tx: Translator = createTranslator("en")): { rows: Row[]; height: number } {
  const { areas, projects, tasks, sessionsOf, spans, sc, expanded, collapsed } = input;
  const inRange = (sp: Span) => sp.e > 0 && sp.s < sc.days;
  // Open tasks always get a row; finished ones only while their bar or a session is in view.
  const shown = (t: Task) =>
    t.status !== "canceled" &&
    (isOpenTask(t) || inRange(spans.get(t.id)!) || (sessionsOf.get(t.id) ?? []).some((x) => inRange(sessionSpan(x, sc.from, sc.now))));
  const byStart = (a: Task, b: Task) => spans.get(a.id)!.s - spans.get(b.id)!.s || a.id - b.id;
  const areaIds = new Set(areas.map((a) => a.id));
  const projectIds = new Set(projects.map((p) => p.id));

  const rows: Row[] = [];
  let y = 0;
  const add = (r: Row) => {
    rows.push(r);
    y += r.h;
  };
  const taskRow = (t: Task, nested: boolean, color: string): TaskRow => ({
    kind: "task", id: `t${t.id}`, y, h: ROW_H.task, task: t, color, nested, span: spans.get(t.id)!, sessions: sessionsOf.get(t.id) ?? [],
  });

  add({ kind: "cap", id: "cap", y, h: ROW_H.cap });
  const groups = [...areas.map((a) => ({ id: a.id, name: a.name, area: a })), { id: "", name: tx("Inbox"), area: null }];
  for (const g of groups) {
    const own = projects.filter((p) => (g.id ? p.areaId === g.id : !areaIds.has(p.areaId)));
    const loose = tasks
      .filter((t) => (!t.projectId || !projectIds.has(t.projectId)) && (g.id ? t.areaId === g.id : !t.areaId || !areaIds.has(t.areaId)))
      .filter(shown)
      .sort(byStart);
    if (!g.id && !own.length && !loose.length) continue;
    const open = !collapsed[g.id];
    add({ kind: "area", id: `a-${g.id}`, y, h: ROW_H.area, areaId: g.id, name: g.name, area: g.area, open });
    if (!open) continue;
    const color = g.area?.color ?? "var(--color-mut2)";
    for (const p of own) {
      const pc = projectColor(p, areas);
      const pts = tasks.filter((t) => t.projectId === p.id && t.status !== "canceled");
      const dated = pts.some((t) => t.plannedDate || t.dueDate || sessionsOf.has(t.id));
      const isOpen = pts.length > 0 && (expanded[p.id] ?? dated);
      const s = p.startDate ? dayDiff(sc.from, p.startDate) : pts.length ? Math.min(...pts.map((t) => spans.get(t.id)!.s)) : null;
      const e = p.targetDate ? dayDiff(sc.from, p.targetDate) + 1 : pts.length ? Math.max(...pts.map((t) => spans.get(t.id)!.e)) : null;
      add({
        kind: "proj", id: `p-${p.id}`, y, h: ROW_H.proj, project: p, color: pc, open: isOpen,
        done: pts.filter((t) => t.status === "done").length, total: pts.length,
        started: pts.some((t) => t.status === "progress" || t.status === "review" || t.status === "done"),
        span: s !== null && e !== null && e > s ? { s, e } : null,
      });
      if (isOpen) {
        for (const t of pts.filter(shown).sort((a, b) => a.sortOrder - b.sortOrder || byStart(a, b))) add(taskRow(t, true, pc));
      }
    }
    for (const t of loose) add(taskRow(t, false, color));
  }
  return { rows, height: y };
}

/* ---------- dragging bars and drawing dependencies ---------- */

type DatePatch = { dueDate?: string | null; plannedDate?: string | null };
/** What is being dragged: the bar's start, its end, or the whole bar. */
type BarPart = "start" | "end" | "move";
type BarDrag = { taskId: number; part: BarPart; days: number };
/** From a bar's end to a task that waits for it, from its start to a task it waits for. */
type LinkSide = "start" | "end";
/** A dependency being drawn; x and y are the pointer in grid coordinates. */
type LinkDrag = { taskId: number; side: LinkSide; x: number; y: number; target: number | null; problem: string | null };

/** The deadline sets where a bar ends; without one (or with one before the start), the estimate does. */
const endsOnDue = (sp: TaskSpan) => sp.due !== null && sp.e === sp.due;

/** How many whole days a bar's part can move by: a bar never gets shorter than a day. */
function clampDays(sp: TaskSpan, part: BarPart, days: number): number {
  const last = Math.ceil(sp.e) - 1;
  if (part === "start") return Math.min(days, last - sp.s);
  if (part === "end") return Math.max(days, sp.s - last);
  return days;
}

/** Where a bar is drawn while it's dragged. */
function draggedSpan(sp: TaskSpan, part: BarPart, days: number): TaskSpan {
  if (part === "start") return { s: sp.s + days, e: sp.e, due: endsOnDue(sp) ? sp.due : sp.e };
  if (part === "end") return { s: sp.s, e: sp.e + days, due: sp.e + days };
  return { s: sp.s + days, e: sp.e + days, due: sp.due === null ? null : sp.due + days };
}

/**
 * The dates a dragged bar saves: its start is the planned day and its end the deadline, which keeps its time.
 * A bar without a deadline ends where its estimate runs out, so moving its start makes that end the deadline.
 */
function dragPatch(t: Task, sp: TaskSpan, part: BarPart, days: number, from: string): DatePatch {
  const day = (n: number) => addDaysStr(from, n);
  const last = Math.ceil(sp.e) - 1;
  const shiftDue = () => {
    const time = timeOf(t.dueDate);
    const d = addDaysStr(t.dueDate!, days);
    return time ? `${d}T${time}` : d;
  };
  if (part === "start") return endsOnDue(sp) ? { plannedDate: day(sp.s + days) } : { plannedDate: day(sp.s + days), dueDate: day(last) };
  if (part === "end") return { dueDate: endsOnDue(sp) ? shiftDue() : day(last + days) };
  return t.dueDate ? { plannedDate: day(sp.s + days), dueDate: shiftDue() } : { plannedDate: day(sp.s + days) };
}

/** What a bar says about its new dates while it's dragged. */
function dragLabel(sp: TaskSpan, part: BarPart, from: string, tx: Translator = createTranslator("en")): string {
  const first = addDaysStr(from, Math.floor(sp.s));
  const last = addDaysStr(from, Math.ceil(sp.e) - 1);
  if (part === "start") return tx("Starts {0}", [fmtDay(first, tx.language)]);
  if (part === "end") return tx("Due {0}", [fmtDay(last, tx.language)]);
  return first === last ? fmtDay(first, tx.language) : tx("{0} to {1}", [fmtShort(first, tx.language), fmtShort(last, tx.language)]);
}

function dragMessage(t: Task, patch: DatePatch, part: BarPart, tx: Translator = createTranslator("en")): string {
  if (part === "end") return tx("{0} is now due {1}", [t.key, fmtDay(patch.dueDate!, tx.language)]);
  if (part === "start") return tx("{0} now starts {1}{2}", [t.key, fmtDay(patch.plannedDate!, tx.language), patch.dueDate ? tx(" and is due {0}", [fmtDay(patch.dueDate, tx.language)]) : ""]);
  return tx("Moved {0} to {1}", [t.key, fmtDay(patch.plannedDate!, tx.language)]);
}

/** Why `to` can't wait for `from`, or null when it can: within one project, never a loop. */
function linkProblem(from: Task, to: Task, edges: Dependency[], tx: Translator = createTranslator("en")): string | null {
  if (edges.some((e) => e.fromTaskId === from.id && e.toTaskId === to.id)) return tx("{0} already waits for {1}", [to.key, from.key]);
  if (!isOpenTask(to)) return tx("{0} is {1} already", [to.key, to.status === "done" ? "done" : "canceled"]);
  if (from.projectId !== to.projectId) return tx("{0} and {1} are in different projects. Dependencies stay within one project.", [from.key, to.key]);
  const seen = new Set<number>();
  const stack = [to.id];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === from.id) return tx("{0} already waits for {1}, so this would make a loop", [from.key, to.key]);
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of edges) if (e.fromTaskId === id) stack.push(e.toTaskId);
  }
  return null;
}

/** While something is dragged, its cursor holds over everything and no text gets selected (see globals.css). */
function holdCursor(cursor: string) {
  const html = document.documentElement;
  html.style.setProperty("--drag-cursor", cursor);
  html.dataset.dragging = "";
}

function releaseCursor() {
  delete document.documentElement.dataset.dragging;
}

/** Stops the click that ends a drag, so dropping a bar or a connection doesn't also open the task under it. */
function swallowClick() {
  const stop = (e: Event) => {
    e.stopPropagation();
    e.preventDefault();
  };
  window.addEventListener("click", stop, { capture: true, once: true });
  setTimeout(() => window.removeEventListener("click", stop, { capture: true }), 0);
}

/* ---------- bar looks: color is the area, state is fill, outline and opacity ---------- */

interface Look {
  bg: string;
  bd: string;
  fg: string;
  dashed?: boolean;
  check?: boolean;
  dot?: boolean;
}

function barLook(t: Task, latest: Session | undefined, color: string): Look {
  if (!isOpenTask(t)) return { bg: tint(color, 10), bd: tint(color, 22), fg: "text-mut2", check: t.status === "done" };
  if (latest?.status === "finished") return { bg: tint(color, 20), bd: "color-mix(in srgb, var(--color-accent) 70%, transparent)", fg: "text-fg2", dot: true };
  if ((latest && isActive(latest)) || t.status === "progress" || t.status === "review") {
    return { bg: tint(color, 34), bd: tint(color, 62), fg: "text-strong" };
  }
  if (t.status === "backlog") return { bg: "transparent", bd: tint(color, 34), fg: "text-mut2", dashed: true };
  return { bg: tint(color, 5), bd: tint(color, 50), fg: "text-mut", dashed: true };
}

function sessionColor(x: Session, color: string): string {
  if (isActive(x)) return color;
  if (x.status === "finished") return "var(--color-accent)";
  if (x.status === "done") return tint(color, 50);
  return "var(--color-line-strong)";
}

const SESSION_STATE = (tx: Translator): Record<SessionStatus, string> => ({
  starting: tx("starting"), running: tx("running"), finished: tx("finished, waiting for you"), done: tx("done"), closed: tx("closed"), failed: tx("couldn't start"),
});

function sessionTitle(x: Session, tx: Translator = createTranslator("en")): string {
  const end = x.finishedAt ?? x.endedAt;
  const start = tx.date(parseLocal(x.startedAt), "EEE d MMM, HH:mm");
  const until = isActive(x) || !end ? tx("now") : tx.date(parseLocal(end), dateOnly(end) === dateOnly(x.startedAt) ? "HH:mm" : "EEE d MMM, HH:mm");
  return tx("{0} session · {1} to {2} · {3}", [tx(AGENT_LABEL[x.agent]), start, until, SESSION_STATE(tx)[x.status]]);
}

/**
 * What comes right after a task's bar: the deadline flag (when the bar runs up to it), then the "waiting for you"
 * dot. `after` is where the next thing (the label, or the connection dot) can start.
 */
function barTail(row: TaskRow, sc: Scale, layers: Record<Layer, boolean>) {
  const { left, width } = barBox(row.span, sc);
  const due = row.span.due;
  const flag = layers.deadlines && due !== null && due >= 0 && due <= sc.days;
  const flagX = due === null ? 0 : sc.X(due) + 2;
  let after = left + width + 4;
  if (flag && due! > row.span.s) after = Math.max(after, flagX + 14);
  const dotX = after;
  if (barLook(row.task, row.sessions[row.sessions.length - 1], row.color).dot) after += 11;
  return { flag, flagX, dotX, after };
}

const hours = (min: number) => (min < 60 ? `${min}m` : `${Math.round(min / 6) / 10}h`);

/** Rough width of an 11px label, to decide whether it fits inside a bar. */
const textWidth = (s: string) => s.length * 6;

/** A small date hint at the edge for bars that are outside the visible range. */
function EdgeHint({ span, sc }: { span: Span; sc: Scale }) {
  const tx = useTranslation();
  if (span.e > 0 && span.s < sc.days) return null;
  const before = span.e <= 0;
  const day = addDaysStr(sc.from, before ? Math.ceil(span.e) - 1 : Math.floor(span.s));
  return (
    <span className={cx("absolute top-1/2 -translate-y-1/2 whitespace-nowrap text-[11px] text-dim", before ? "left-1.5" : "right-1.5")}>
      {before ? `‹ ${fmtShort(day, tx.language)}` : `${fmtShort(day, tx.language)} ›`}
    </span>
  );
}

/* ---------- lanes ---------- */

function CapLane({ loads, dayMinutes, sc, lo, hi }: { loads: Record<string, DayLoad>; dayMinutes: number; sc: Scale; lo: number; hi: number }) {
  const tx = useTranslation();
  const w = Math.max(3, Math.min(28, sc.dayW * 0.52));
  return Array.from({ length: hi - lo }, (_, k) => {
    const i = lo + k;
    const day = addDaysStr(sc.from, i);
    const past = day < sc.today;
    const min = (past ? loads[day]?.done : loads[day]?.planned) ?? 0;
    const x0 = sc.X(i);
    const cw = sc.X(i + 1) - x0;
    const label = `${tx.date(parseLocal(day), "EEE d MMM")} · ${min ? `${hours(min)} ${tx(past ? "done" : "planned")}` : past ? tx("nothing done") : tx("nothing planned")}`;
    return (
      <span key={day} title={label} className="absolute inset-y-0" style={{ left: x0, width: cw }}>
        <span className="absolute bottom-1.5 rounded-[2px]"
          style={{ left: (cw - w) / 2, width: w, height: Math.max(2, Math.round(Math.min(1, min / dayMinutes) * 26)), background: day === sc.today ? "var(--color-mut)" : past ? "var(--color-ctl)" : "var(--color-line-strong)" }} />
        {sc.dayW >= 60 && min > 0 && (
          <span className="absolute bottom-1 text-[11px] text-mut2" style={{ left: (cw + w) / 2 + 6 }}>{hours(min)}</span>
        )}
      </span>
    );
  });
}

function ProjectLane({ row, sc }: { row: ProjectRow; sc: Scale }) {
  const tx = useTranslation();
  const { project: p, color, span } = row;
  if (!span) return null;
  const visible = span.e > 0 && span.s < sc.days;
  const { left, width } = barBox(span, sc);
  const later = !row.started && !!p.startDate && p.startDate > sc.today;
  const pct = row.total ? Math.round((row.done / row.total) * 100) : 0;
  const text = later ? tx("Starts {0}", [fmtShort(p.startDate!, tx.language)]) : `${pct}%`;
  const inside = width >= textWidth(text) + 16;
  const target = p.targetDate ? dayDiff(sc.from, p.targetDate) + 0.5 : null;
  const showTarget = target !== null && target >= 0 && target < sc.days;
  return (
    <>
      {visible && (
        <div className="absolute flex items-center overflow-hidden rounded"
          style={{ top: 7, height: 16, left, width, background: later ? "transparent" : tint(color, 13), border: `1px ${later ? "dashed" : "solid"} ${tint(color, later ? 40 : 34)}` }}>
          {!later && <span className="absolute inset-y-0 left-0" style={{ width: `${pct}%`, background: tint(color, 36) }} />}
          {inside && <span className="relative px-1.5 text-[11px] leading-[14px] text-fg2">{text}</span>}
        </div>
      )}
      {visible && !inside && (
        <span className="absolute whitespace-nowrap text-[11px] leading-4 text-mut2" style={{ top: 7, left: left + width + (showTarget ? 14 : 6) }}>
          {text}
        </span>
      )}
      {showTarget && (
        <span title={tx("Target date · {0}", [fmtDay(p.targetDate!, tx.language)])} className="absolute flex" style={{ left: sc.X(target!) - 5.5, top: 10 }}>
          <Diamond color={color} hollow />
        </span>
      )}
      <EdgeHint span={span} sc={sc} />
    </>
  );
}

function TaskLane({ row, state, sc, layers, dragText, linkTarget, onGrab, onLink }: {
  row: TaskRow;
  state: TaskState | undefined;
  sc: Scale;
  layers: Record<Layer, boolean>;
  /** Said instead of the state while the bar is dragged, e.g. "Due Fri, 26 Sep". */
  dragText: string | null;
  /** The dependency being drawn would end on this task. */
  linkTarget: boolean;
  /** Set when the bar can be moved, and stretched by its ends. */
  onGrab: ((e: ReactPointerEvent, part: BarPart) => void) | null;
  /** Set when dependencies can be drawn from the bar. */
  onLink: ((e: ReactPointerEvent, side: LinkSide) => void) | null;
}) {
  const tx = useTranslation();
  const { task: t, color, span, sessions } = row;
  const look = barLook(t, sessions[sessions.length - 1], color);
  const clampX = (d: number) => sc.X(Math.max(0, Math.min(sc.days, d)));
  const bar = layers.tasks && span.e > 0 && span.s < sc.days;
  const { left, width } = barBox(span, sc);
  const text = dragText ?? state?.short ?? "";
  const inside = width >= textWidth(text) + (look.check ? 30 : 16);

  const due = span.due;
  const overdue = isOpenTask(t) && due !== null && due < sc.nowPos;
  const { flag, flagX, dotX, after } = barTail(row, sc, layers);
  const outRight = after + 2 + textWidth(text) <= sc.gridW || left < textWidth(text) + 12;
  // The connection dots: before the bar, and after everything that follows it. Each zone reaches the bar, so the
  // pointer can go from the bar to a dot without leaving them.
  const links = bar && onLink
    ? [{ side: "start" as const, left: left - DOT_ZONE, width: DOT_ZONE }, { side: "end" as const, left: left + width, width: after - 4 - left - width + DOT_ZONE }]
    : [];

  return (
    <>
      {/* Above the dependency lines. Hovering the bar shows the grips at its ends and its connection dots. */}
      <div className="group/bar pointer-events-none absolute inset-0 z-[1]">
        {bar && (
          <div title={`${t.key} · ${state?.text ?? ""}`} onPointerDown={onGrab ? (e) => onGrab(e, "move") : undefined}
            className={cx("pointer-events-auto absolute flex items-center gap-[5px] overflow-hidden whitespace-nowrap rounded px-1.5 text-[11px]", look.fg,
              onGrab && "cursor-grab", linkTarget && "ring-1 ring-accent")}
            style={{ top: BAR_TOP, height: BAR_H, left, width, background: look.bg, border: `1px ${look.dashed ? "dashed" : "solid"} ${look.bd}` }}>
            {look.check && <Icon name="check" size={10} strokeWidth={2.8} className="shrink-0" />}
            {inside && <span className="truncate">{text}</span>}
            {onGrab && (["start", "end"] as const).map((part) => (
              <span key={part} onPointerDown={(e) => onGrab(e, part)}
                title={part === "start" ? tx("Drag to change when it starts") : tx("Drag to change when it's due")}
                className={cx("absolute inset-y-0 flex w-2 cursor-ew-resize items-center justify-center", part === "start" ? "left-0" : "right-0")}>
                <span className="h-2.5 w-0.5 rounded-full bg-current opacity-0 group-hover/bar:opacity-50" />
              </span>
            ))}
          </div>
        )}
        {links.map((z) => (
          <span key={z.side} onPointerDown={(e) => onLink!(e, z.side)}
            title={z.side === "end" ? tx("Drag to a task that waits for this one") : tx("Drag to a task this one waits for")}
            className={cx("group/dot pointer-events-auto absolute flex cursor-crosshair items-center", z.side === "end" ? "justify-end" : "justify-start")}
            style={{ top: BAR_TOP, height: BAR_H, left: z.left, width: z.width }}>
            <span className="flex w-3.5 justify-center">
              <span className="h-2 w-2 rounded-full border-[1.5px] border-line-strong bg-panel opacity-0 transition group-hover/bar:opacity-100 group-hover/dot:scale-125 group-hover/dot:border-mut" />
            </span>
          </span>
        ))}
        {flag && (
          <span title={`${overdue ? tx("Overdue, was due") : tx("Due")} ${fmtDay(t.dueDate ?? addDaysStr(sc.from, Math.ceil(due!) - 1), tx.language)}${timeOf(t.dueDate) ? `, ${timeOf(t.dueDate)}` : ""}`}
            className={cx("pointer-events-auto absolute flex", !isOpenTask(t) ? "text-dim" : overdue ? "text-danger" : "text-mut")} style={{ left: flagX, top: BAR_MID - 6 }}>
            <Icon name="flag" size={11} strokeWidth={2.4} />
          </span>
        )}
        {/* The label steps aside while the dots are out. */}
        {bar && !inside && text && (
          <span className={cx("absolute whitespace-nowrap text-[11px] leading-4", dragText ? "text-fg2" : "text-mut2",
            links.length > 0 && cx("transition-transform motion-reduce:transition-none", outRight ? "group-hover/bar:translate-x-2.5" : "group-hover/bar:-translate-x-2.5"))}
            style={outRight ? { top: BAR_TOP + 1, left: after + 2 } : { top: BAR_TOP + 1, right: sc.gridW - left + 6 }}>
            {text}
          </span>
        )}
      </div>
      {bar && look.dot && <span className="absolute h-[7px] w-[7px] rounded-full bg-accent" style={{ left: dotX, top: BAR_MID - 3 }} />}
      {layers.tasks && isOpenTask(t) && <EdgeHint span={span} sc={sc} />}
      {layers.sessions && sessions.map((x) => {
        const sp = sessionSpan(x, sc.from, sc.now);
        if (sp.e < 0 || sp.s > sc.days) return null;
        const l = clampX(sp.s);
        return (
          <span key={x.id} title={sessionTitle(x, tx)} className="absolute flex h-[9px] items-center" style={{ top: LANE_TOP - 3, left: l, width: Math.max(6, clampX(sp.e) - l) }}>
            <span className="h-[3px] w-full rounded-full" style={{ background: sessionColor(x, color) }} />
          </span>
        );
      })}
    </>
  );
}

/* ---------- header with months and days ---------- */

/** Hours between labels, so they stay about 44 px apart. */
const hourStep = (dayW: number) => [1, 2, 3, 4, 6, 12].find((h) => (h * dayW) / 24 >= 44) ?? 24;

/** Only the days in view (`lo` to `hi`) are drawn; `left` is where the view starts, so a day's name stays in sight. */
function DayHeader({ sc, lo, hi, left }: { sc: Scale; lo: number; hi: number; left: number }) {
  const tx = useTranslation();
  const out: ReactNode[] = [];
  const pill = (day: string, d: Date, i: number) => {
    const isToday = day === sc.today;
    const weekend = i % 7 >= 5;
    return (
      <span className={cx("inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-[3px] text-[11px]",
        isToday ? "bg-accent text-bg" : weekend ? "text-dim" : day < sc.today ? "text-mut2" : "text-fg3")}>
        {d.getDate()}
      </span>
    );
  };
  for (let i = lo; i < hi; i++) {
    const day = addDaysStr(sc.from, i);
    const d = parseLocal(day);
    const x0 = sc.X(i);
    const cw = sc.X(i + 1) - x0;
    if (sc.dayW >= HOURS_FROM) {
      // The day's name on top, held at the left of the view while its hours scroll by; the hours below.
      const name = tx.date(d, cw >= 260 ? "EEEE, d MMMM" : "EEE d MMM");
      const nameX = Math.max(x0, Math.min(left, x0 + cw - textWidth(name) - 16));
      out.push(
        <span key={`n${i}`} className={cx("absolute top-[5px] flex items-center gap-1.5 whitespace-nowrap pl-1.5 text-[11px]", day === sc.today ? "text-fg2" : "text-mut")} style={{ left: nameX }}>
          {day === sc.today && <span className="h-1.5 w-1.5 rounded-full bg-accent" />}{name}
        </span>,
      );
      out.push(<span key={`b${i}`} className="absolute bottom-0 top-0 w-px bg-line" style={{ left: x0 }} />);
      const step = hourStep(sc.dayW);
      for (let h = step; h < 24; h += step) {
        out.push(
          <span key={`h${i}-${h}`} className="absolute top-[22px] -translate-x-1/2 font-mono text-[10.5px] leading-[18px] text-mut2" style={{ left: x0 + (h * cw) / 24 }}>
            {String(h).padStart(2, "0")}:00
          </span>,
        );
      }
      continue;
    }
    if (sc.dayW < 10) {
      // Months on top, Mondays below (today's week shows today's number instead). The range starts on a Monday.
      if (d.getDate() === 1 || (i === lo && d.getDate() < 22)) {
        // The first month is shortened when the next one starts too soon for its full name (days are narrow on a phone).
        const room = (getDaysInMonth(d) - d.getDate() + 1) * sc.dayW;
        const name = tx.date(d, room < textWidth(tx.date(d, "MMMM")) + 12 ? "MMM" : "MMMM");
        out.push(<span key={`m${i}`} className="absolute top-[5px] whitespace-nowrap pl-1.5 text-[11px] text-mut" style={{ left: i === lo ? Math.max(x0, left) : x0 }}>{name}</span>);
      }
      const thisWeek = dayDiff(day, sc.today) >= 0 && dayDiff(day, sc.today) < 7;
      if (i % 7 === 0 && !thisWeek) {
        out.push(<span key={`w${i}`} className={cx("absolute top-[22px] pl-0.5 text-[11px] leading-[18px]", day < sc.today ? "text-mut2" : "text-fg3")} style={{ left: x0 }}>{d.getDate()}</span>);
      }
      if (day === sc.today) {
        out.push(<span key="today" className="absolute top-[22px] -translate-x-1/2" style={{ left: x0 + cw / 2 }}>{pill(day, d, i)}</span>);
      }
      continue;
    }
    if (d.getDate() === 1 || (i === lo && d.getDate() < 25)) {
      out.push(
        <span key={`m${i}`} className="absolute top-[5px] whitespace-nowrap pl-1.5 text-[11px] text-mut" style={{ left: i === lo ? Math.max(x0, left) : x0 }}>
          {tx.date(d, "MMMM")}
        </span>,
      );
    }
    out.push(
      <span key={`d${i}`} className="absolute top-[22px] flex h-[18px] items-center justify-center gap-1" style={{ left: x0, width: cw }}>
        {sc.dayW >= 40 && <span className={cx("text-[11px]", i % 7 >= 5 ? "text-dim" : "text-mut2")}>{tx.date(d, "EEE")}</span>}
        {pill(day, d, i)}
      </span>,
    );
  }
  return out;
}

/* ---------- the view ---------- */

/** What a click on a row's day adds: a task planned for it, in the row's project or area ("Your time": in neither). */
function addFor(r: Row, day: string): QuickAddDefaults | null {
  if (r.kind === "proj") return { plannedDate: day, projectId: r.project.id };
  if (r.kind === "area") return { plannedDate: day, areaId: r.areaId || null };
  return r.kind === "cap" ? { plannedDate: day } : null;
}

function rangeLabel(from: string, days: number, short = false, tx: Translator = createTranslator("en")) {
  if (days <= 1) return tx.date(parseLocal(from), short ? "EEE d MMM" : "EEEE, d MMMM yyyy");
  if (short) return tx("{0} to {1}", [fmtShort(from, tx.language), fmtShort(addDaysStr(from, days - 1), tx.language)]);
  const a = parseLocal(from);
  const b = parseLocal(addDaysStr(from, days - 1));
  return tx("{0} to {1}", [tx.date(a, a.getFullYear() === b.getFullYear() ? "d MMM" : "d MMM yyyy"), tx.date(b, "d MMM yyyy")]);
}

export function Timeline(props: {
  /** Monday the range starts on, "YYYY-MM-DD": TIMELINE_DAYS days, which scroll. */
  from: string;
  /** The day it opens on, from the address; null opens on today. */
  focus: string | null;
  /** Pixels per day from the address (a zoom of the wheel's); null takes the zoom's. */
  dayWidth: number | null;
  /** Server time, "YYYY-MM-DDTHH:mm:ss". */
  now: string;
  zoom: TimelineZoom;
  areas: Area[];
  projects: Project[];
  tasks: Task[];
  sessions: Session[];
  edges: Dependency[];
  states: Record<number, TaskState>;
  loads: Record<string, DayLoad>;
  /** Focus minutes in a full working day, the height of a full "Your time" bar. */
  dayMinutes: number;
  ctx: TaskContext;
  initialKey: string | null;
}) {
  const tx = useTranslation();
  const { from, areas, projects, sessions, states, loads, dayMinutes, ctx } = props;
  const { run } = useAction();
  const [tasks, patchTask] = useOptimistic(props.tasks, (state, p: { id: number; patch: DatePatch }) =>
    state.map((t) => (t.id === p.id ? { ...t, ...p.patch } : t)));
  const [edges, editEdges] = useOptimistic(props.edges, (state, op: { add: Dependency } | { remove: number }) =>
    "add" in op ? [...state, op.add] : state.filter((e) => e.id !== op.remove));
  const router = useRouter();
  // A zoom button's, or null after the wheel set `custom` pixels per day.
  const [zoom, setZoom] = useState<TimelineZoom | null>(props.dayWidth ? null : props.zoom);
  const [custom, setCustom] = useState(props.dayWidth ?? 0);
  // Where the view is scrolled to, across the days: which days to draw, and what the header says.
  const [scrollX, setScrollX] = useState(0);
  const [layers, setLayers] = useState<Record<Layer, boolean>>({ tasks: true, sessions: true, blocks: true, deadlines: true, deps: true });
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [sel, setSel] = useState<string | null>(props.initialKey);
  const [tick, setTick] = useState<string | null>(null);
  const [drag, setDrag] = useState<BarDrag | null>(null);
  const [link, setLink] = useState<LinkDrag | null>(null);
  const [depMenu, setDepMenu] = useState<{ edge: Dependency; from: string; to: string; anchor: Anchor } | null>(null);
  // The day under the mouse in a row that a click adds a task to.
  const [spot, setSpot] = useState<{ row: string; i: number } | null>(null);
  const addOnClick = useAddOnClick();
  const [scrollRef, width] = useWidth<HTMLDivElement>(TREE + 924);
  const gridRef = useRef<HTMLDivElement>(null);
  const phone = usePhone();
  const tree = phone ? TREE_PHONE : TREE;
  const indent = phone ? INDENT_PHONE : INDENT;

  useEffect(() => {
    const id = setInterval(() => setTick(toStamp(new Date())), 60_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !(e.target as HTMLElement).closest("input, textarea, [contenteditable=true], [role=dialog]")) setSel(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const now = tick && tick > props.now ? tick : props.now;
  const days = TIMELINE_DAYS;
  const viewW = Math.max(1, width - tree);
  // Never so narrow that the days don't fill the view.
  const floorW = Math.max(MIN_DAY_W, viewW / days);
  const presetW = (z: TimelineZoom) => Math.max(ZOOM(tx)[z].minDay, viewW / ZOOM(tx)[z].days);
  const dayW = Math.min(MAX_DAY_W, Math.max(floorW, zoom ? presetW(zoom) : custom));
  const X = (d: number) => Math.round(d * dayW);
  const sc: Scale = { from, days, dayW, gridW: X(days), X, now, nowPos: dayPos(from, now), today: dateOnly(now) };
  /** Which day of the range the pointer is over in a row's lane. */
  const dayAt = (e: { clientX: number; currentTarget: HTMLElement }) =>
    Math.max(0, Math.min(days - 1, Math.floor((e.clientX - e.currentTarget.getBoundingClientRect().left) / dayW)));
  // The days in view, and one on each side, are drawn.
  const lo = Math.max(0, Math.floor(scrollX / dayW) - 1);
  const hi = Math.min(days, Math.ceil((scrollX + viewW) / dayW) + 1);
  const firstShown = addDaysStr(from, Math.max(0, Math.floor(scrollX / dayW + 0.02)));
  const shownDays = Math.max(1, Math.round(viewW / dayW));
  // Where "Today" and the first view put today: a quarter of the way in, or in the Day zoom, now at a third.
  const todayPos = () => (dayW >= HOURS_FROM ? dayPos(from, now) : dayDiff(from, dateOnly(now)));
  const todayAt = () => (dayW >= HOURS_FROM ? viewW / 3 : Math.min(viewW / 4, dayW));

  /*
   * Where the view goes when it's laid out next: a day position (in days from `from`) held at a point of the view
   * (px from its left). Zooming holds the day under the pointer; a new range holds the days that were in view.
   */
  const hold = useRef<{ pos: number; at: number } | null>(null);
  const lastFrom = useRef(from);
  const opened = useRef(false);
  const asked = useRef(false);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || width <= tree + 1) return;
    if (lastFrom.current !== from) {
      const shift = dayDiff(from, lastFrom.current);
      lastFrom.current = from;
      asked.current = false;
      if (opened.current && !hold.current) hold.current = { pos: el.scrollLeft / dayW + shift, at: 0 };
    }
    // Only once the width is measured: until then the days have the fallback's width.
    if (!opened.current && el.clientWidth === width) {
      opened.current = true;
      hold.current = props.focus ? { pos: dayDiff(from, props.focus), at: Math.min(viewW / 4, dayW) } : { pos: todayPos(), at: todayAt() };
    }
    if (hold.current) {
      // The scroll event that follows updates what's drawn.
      el.scrollLeft = Math.max(0, hold.current.pos * dayW - hold.current.at);
      hold.current = null;
    }
  });

  /** What's drawn follows the scroll; near either end of the range, the next one is asked for, around the days in view. */
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    setScrollX(el.scrollLeft);
    if (asked.current || !opened.current || hold.current) return;
    const first = el.scrollLeft / dayW;
    const last = (el.scrollLeft + viewW) / dayW;
    if (first > EDGE && last < days - EDGE) return;
    asked.current = true;
    const q = new URLSearchParams(window.location.search);
    q.set("at", addDaysStr(from, Math.floor((first + last) / 2)));
    q.delete("from");
    router.replace(`/timeline?${q}`, { scroll: false });
  };

  /** The zoom goes in the address, without asking the server again. */
  const remember = (z: TimelineZoom | null, w: number) => {
    const q = new URLSearchParams(window.location.search);
    q.delete("zoom");
    q.delete("dw");
    if (z && z !== "month") q.set("zoom", z);
    if (!z) q.set("dw", String(Math.round(w * 10) / 10));
    const s = q.toString();
    window.history.replaceState(window.history.state, "", s ? `?${s}` : window.location.pathname);
  };
  /** Zooms to `w` pixels per day, or to a zoom button's, holding the day at `at` px into the view (its middle by default). */
  const zoomTo = (w: number | TimelineZoom, at = viewW / 2) => {
    const el = scrollRef.current;
    if (!el) return;
    hold.current = { pos: (el.scrollLeft + at) / dayW, at };
    if (typeof w === "string") {
      setZoom(w);
      remember(w, 0);
      return;
    }
    const next = Math.min(MAX_DAY_W, Math.max(floorW, w));
    setZoom(null);
    setCustom(next);
    remember(null, next);
  };

  // The wheel zooms with Ctrl or ⌘ (a touchpad's pinch sends that too), or over the days at the top; otherwise it scrolls.
  const wheel = useRef({ zoomTo, dayW });
  useEffect(() => { wheel.current = { zoomTo, dayW }; });
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const overDays = !!(e.target as Element).closest?.("[data-days]");
      const pinch = e.ctrlKey || e.metaKey;
      if (!pinch && (!overDays || Math.abs(e.deltaX) > Math.abs(e.deltaY))) return;
      e.preventDefault();
      const delta = e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1);
      const at = Math.max(0, e.clientX - el.getBoundingClientRect().left - tree);
      wheel.current.zoomTo(wheel.current.dayW * Math.exp(-delta * 0.0025), at);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [scrollRef, tree]);

  /**
   * A mouse dragged across the days (anywhere but a bar or its dots, which have their own drags, and the names)
   * moves the view in any direction. A press without a drag stays a click.
   */
  const pan = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = scrollRef.current;
    if (!el || e.pointerType !== "mouse" || (e.button !== 0 && e.button !== 1)) return;
    if ((e.target as Element).closest("[data-names], button, a, input")) return;
    if (e.button === 1) e.preventDefault();
    const x0 = e.clientX, y0 = e.clientY, l0 = el.scrollLeft, t0 = el.scrollTop;
    let moved = false;
    const onMove = (ev: PointerEvent) => {
      if (!moved) {
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;
        moved = true;
        holdCursor("grabbing");
        setSpot(null);
      }
      el.scrollLeft = l0 - (ev.clientX - x0);
      el.scrollTop = t0 - (ev.clientY - y0);
    };
    const finish = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      if (!moved) return;
      releaseCursor();
      swallowClick();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };

  /** The arrows move the view by most of its width; "Today" brings today back (from another range, it asks for today's). */
  const scrollBy = (share: number) => scrollRef.current?.scrollBy({ left: share * viewW, behavior: "smooth" });
  const toToday = () => {
    const pos = todayPos();
    if (pos < EDGE || pos > days - EDGE) {
      opened.current = false;
      const q = new URLSearchParams(window.location.search);
      q.delete("at");
      q.delete("from");
      const s = q.toString();
      router.replace(s ? `/timeline?${s}` : "/timeline", { scroll: false });
      return;
    }
    scrollRef.current?.scrollTo({ left: Math.max(0, pos * dayW - todayAt()), behavior: "smooth" });
  };

  const sessionsOf = new Map<number, Session[]>();
  for (const x of [...sessions].sort((a, b) => a.startedAt.localeCompare(b.startedAt))) {
    sessionsOf.set(x.taskId, [...(sessionsOf.get(x.taskId) ?? []), x]);
  }
  const spans = taskSpans(tasks, sessionsOf, edges, from);
  const built = buildRows({ areas, projects, tasks, sessionsOf, spans, sc, expanded, collapsed }, tx);
  // The rows keep their order while a bar is dragged; only the dragged bar moves.
  const rows = drag
    ? built.rows.map((r) => (r.kind === "task" && r.task.id === drag.taskId ? { ...r, span: draggedSpan(r.span, drag.part, drag.days) } : r))
    : built.rows;
  const height = built.height;

  const taskRows = new Map(rows.filter((r): r is TaskRow => r.kind === "task").map((r) => [r.task.id, r]));
  const deps = layers.deps && layers.tasks
    ? edges.flatMap((e) => {
      const a = taskRows.get(e.fromTaskId);
      const b = taskRows.get(e.toTaskId);
      if (!a || !b) return [];
      // Leaves from under the end of the earlier bar, so it never runs through that bar's label.
      const down = b.y > a.y;
      const x1 = Math.max(X(a.span.s) + 3, X(a.span.e) - 5);
      const y1 = a.y + (down ? BAR_TOP + BAR_H : BAR_TOP);
      const x2 = X(b.span.s);
      const y2 = b.y + BAR_MID;
      const ym = down ? b.y : b.y + b.h;
      return [{
        edge: e,
        from: a.task.key,
        to: b.task.key,
        d: `M${x1} ${y1} V${ym} H${x2 - 6} V${y2} H${x2 - 1}`,
        head: `M${x2 - 5} ${y2 - 3} L${x2 - 1} ${y2} L${x2 - 5} ${y2 + 3}`,
      }];
    })
    : [];

  const selected = sel ? tasks.find((t) => t.key === sel) ?? null : null;
  const select = (t: Task) => setSel((s) => (s === t.key ? null : t.key));

  /**
   * Drags a bar by whole days, then saves its dates. A press without a drag still opens the task. A finger scrolls
   * the timeline instead, since the browser keeps a touch for scrolling; a tap still opens the task.
   */
  const grabBar = (e: ReactPointerEvent, row: TaskRow, part: BarPart) => {
    if (e.button !== 0 || e.pointerType === "touch") return;
    e.stopPropagation();
    const { task: t, span: sp } = row;
    const x0 = e.clientX;
    let moved = false;
    let days = 0;
    const daysAt = (ev: PointerEvent) => clampDays(sp, part, Math.round((ev.clientX - x0) / dayW));
    const onMove = (ev: PointerEvent) => {
      if (!moved) {
        if (Math.abs(ev.clientX - x0) < 4) return;
        moved = true;
        holdCursor(part === "move" ? "grabbing" : "ew-resize");
        setDrag({ taskId: t.id, part, days });
      }
      const next = daysAt(ev);
      if (next === days) return;
      days = next;
      setDrag({ taskId: t.id, part, days });
    };
    const finish = (ev: PointerEvent | null) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      if (!moved) return;
      releaseCursor();
      setDrag(null);
      if (!ev) return;
      swallowClick();
      days = daysAt(ev);
      if (!days) return;
      const patch = dragPatch(t, sp, part, days, from);
      run(() => {
        patchTask({ id: t.id, patch });
        return updateTaskAction(t.id, patch);
      }, dragMessage(t, patch, part, tx));
    };
    const onUp = (ev: PointerEvent) => finish(ev);
    const onCancel = () => finish(null);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  };

  /** Draws a dependency from one end of a bar to the task row it's dropped on. Like moving bars, only with a mouse or pen. */
  const grabLink = (e: ReactPointerEvent, row: TaskRow, side: LinkSide) => {
    const grid = gridRef.current;
    if (e.button !== 0 || e.pointerType === "touch" || !grid) return;
    e.stopPropagation();
    const source = row.task;
    const targets = rows.filter((r): r is TaskRow => r.kind === "task" && r.task.id !== source.id);
    const at = (ev: { clientX: number; clientY: number }): LinkDrag => {
      const box = grid.getBoundingClientRect();
      const x = ev.clientX - box.left - tree;
      const y = ev.clientY - box.top;
      const hit = targets.find((r) => y >= r.y && y < r.y + r.h)?.task;
      const problem = !hit ? null : side === "end" ? linkProblem(source, hit, edges, tx) : linkProblem(hit, source, edges, tx);
      return { taskId: source.id, side, x, y, target: hit?.id ?? null, problem };
    };
    holdCursor("crosshair");
    setLink(at(e));
    const onMove = (ev: PointerEvent) => setLink(at(ev));
    const finish = (ev: PointerEvent | null) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      releaseCursor();
      setLink(null);
      if (!ev) return;
      swallowClick();
      const l = at(ev);
      if (l.target === null) return;
      if (l.problem) {
        toast(l.problem, "error");
        return;
      }
      const [fromId, toId] = side === "end" ? [source.id, l.target] : [l.target, source.id];
      run(() => {
        editEdges({ add: { id: -Date.now(), fromTaskId: fromId, toTaskId: toId } });
        return linkTasksAction(fromId, toId);
      });
    };
    const onUp = (ev: PointerEvent) => finish(ev);
    const onCancel = () => finish(null);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  };

  const unlink = (edge: Dependency, fromKey: string, toKey: string) => {
    setDepMenu(null);
    run(() => {
      editEdges({ remove: edge.id });
      return deleteEdgeAction(edge.id);
    }, tx("{0} no longer waits for {1}", [toKey, fromKey]));
  };

  // The dependency being drawn: from the dot it started at to the task it would end on, or to the pointer.
  const linkLine = (() => {
    const src = link && taskRows.get(link.taskId);
    if (!link || !src) return null;
    const a = barBox(src.span, sc);
    // The centers of the dots in TaskLane.
    const x1 = link.side === "end" ? barTail(src, sc, layers).after - 4 + DOT_ZONE / 2 : a.left - DOT_ZONE / 2;
    const y1 = src.y + BAR_MID;
    const dst = link.target !== null && !link.problem ? taskRows.get(link.target) : undefined;
    const b = dst && barBox(dst.span, sc);
    const x2 = b ? (link.side === "end" ? b.left - 1 : b.left + b.width + 1) : link.x;
    const y2 = dst ? dst.y + BAR_MID : link.y;
    const k = link.side === "end" ? 36 : -36;
    return { x1, y1, d: `M${x1} ${y1} C${x1 + k} ${y1} ${x2 - k} ${y2} ${x2} ${y2}`, ok: !link.problem };
  })();

  // A zoom button, from the wheel's zoom too: it keeps the day in the middle of the view there.
  const pickZoom = (z: TimelineZoom) => zoomTo(z);
  const zoomOptions = TIMELINE_ZOOMS.map((z) => ({ value: z, label: ZOOM(tx)[z].label }));
  // After the wheel zoomed, no button is pressed.
  const zoomValue = (zoom ?? "") as TimelineZoom;

  return (
    <div className="flex min-w-0 flex-1">
      <section aria-label={tx("Timeline")} className="flex min-w-0 flex-1 flex-col">
        {/* On a phone the range is shorter, the buttons go to the right, and the zoom moves to the bar below. */}
        <div className="flex h-[52px] shrink-0 items-center gap-2.5 border-b border-line pl-5 pr-4">
          <Icon name="timeline" className="text-mut" />
          <h1 className="text-[14px] font-semibold text-strong">{tx("Timeline")}</h1>
          <span className="text-mut2 max-md:hidden">{rangeLabel(firstShown, shownDays, undefined, tx)}</span>
          <span className="min-w-0 truncate text-mut2 md:hidden">{rangeLabel(firstShown, shownDays, true, tx)}</span>
          <div className="ml-1.5 flex items-center gap-0.5 max-md:ml-auto">
            <button type="button" onClick={() => scrollBy(-0.8)} aria-label={tx("Earlier")} title={tx("Earlier")} className={NAV}>
              <Icon name="chevronLeft" size={14} strokeWidth={2} />
            </button>
            <button type="button" onClick={() => scrollBy(0.8)} aria-label={tx("Later")} title={tx("Later")} className={NAV}>
              <Icon name="chevronRight" size={14} strokeWidth={2} />
            </button>
            <button type="button" onClick={toToday} className="ml-0.5 inline-flex h-[26px] items-center rounded-md border border-line2 px-2 text-[12.5px] text-fg3 hover:bg-hover">
              {tx("Today")}</button>
          </div>
          <span className="flex-1 max-md:hidden" />
          <div className="contents max-md:hidden">
            <Segmented value={zoomValue} onChange={pickZoom} options={zoomOptions} />
          </div>
        </div>

        {/* On a phone the zoom comes first and the filters scroll sideways. */}
        <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-line px-5 text-[12px] max-md:overflow-x-auto">
          <div className="mr-1.5 shrink-0 md:hidden">
            <Segmented value={zoomValue} onChange={pickZoom} options={zoomOptions} />
          </div>
          <span className="mr-1 text-mut2">{tx("Show")}</span>
          {LAYERS(tx).map((l) => (
            <button key={l.id} type="button" aria-pressed={layers[l.id]} onClick={() => setLayers((v) => ({ ...v, [l.id]: !v[l.id] }))}
              className={cx("flex h-[26px] items-center gap-1.5 rounded-full border px-2.5 hover:bg-hover max-md:shrink-0", layers[l.id] ? "border-ctl text-fg2" : "border-line text-dim")}>
              <span className={cx("h-1.5 w-1.5 rounded-full", layers[l.id] ? "bg-mut" : "bg-ctl")} />
              {l.label}
            </button>
          ))}
          <span className="flex-1" />
          <span className="text-mut2 max-md:hidden">{tx("Grouped by area")}</span>
        </div>

        {/* On a phone it scrolls both ways by touch, with the names and the days held in place. It stays hidden there
            until the page knows it's on a phone, rather than first showing the computer's layout. */}
        {/* Scrolls both ways; a mouse can also drag the days, and the wheel zooms over the days at the top or with Ctrl. */}
        <div ref={scrollRef} onScroll={onScroll} onPointerDown={pan}
          className={cx("min-h-0 flex-1 overflow-auto overscroll-x-contain", !phone && "max-md:invisible")}>
          <div style={{ width: tree + sc.gridW }}>
            <div className="sticky top-0 z-20 flex h-11 border-b border-line bg-panel">
              <div data-names className="sticky left-0 z-10 flex shrink-0 items-center border-r border-line bg-panel pl-5 pr-4 text-[11.5px] text-mut2 max-md:pl-3 max-md:pr-2 max-md:leading-4"
                style={{ width: tree }}>
                {tx("Areas, projects and tasks")}</div>
              {/* A click on a day adds a task planned for it. The day a row's lane points at is lit here too. */}
              <div data-days title={tx("Scroll here to zoom")} className="relative shrink-0 overflow-hidden" style={{ width: sc.gridW }}>
                {Array.from({ length: hi - lo }, (_, k) => {
                  const i = lo + k;
                  const day = addDaysStr(from, i);
                  return (
                    <span key={day} title={tx("New task on {0}", [fmtDay(day, tx.language)])} {...addOnClick(() => ({ plannedDate: day }))}
                      className={cx("absolute inset-y-0 hover:bg-hover", spot?.i === i && "bg-hover")} style={{ left: X(i), width: X(i + 1) - X(i) }} />
                  );
                })}
                <div className="pointer-events-none absolute inset-0">
                  <DayHeader sc={sc} lo={lo} hi={hi} left={scrollX} />
                </div>
              </div>
            </div>

            <div ref={gridRef} className="relative" style={{ height }}>
              {Array.from({ length: hi - lo }, (_, k) => lo + k).filter((i) => i % 7 >= 5).map((i) => (
                <span key={i} className="pointer-events-none absolute inset-y-0"
                  style={{ left: tree + X(i), width: X(i + 1) - X(i), background: "color-mix(in srgb, var(--color-ink) 1.8%, transparent)" }} />
              ))}
              {/* With hours showing, a line at each labeled hour and a stronger one where each day starts. */}
              {dayW >= HOURS_FROM && Array.from({ length: hi - lo }, (_, k) => lo + k).flatMap((i) => {
                const step = hourStep(dayW);
                return Array.from({ length: Math.ceil(24 / step) }, (_, j) => j * step).map((h) => (
                  <span key={`${i}-${h}`} className="pointer-events-none absolute inset-y-0 w-px"
                    style={{ left: tree + X(i + h / 24), background: h ? "color-mix(in srgb, var(--color-line) 70%, transparent)" : "var(--color-line)" }} />
                ));
              })}

              {rows.map((r) => {
                const isSel = r.kind === "task" && r.task.key === sel;
                const bg = r.kind === "area" ? "bg-raised" : isSel ? "bg-sel" : "bg-panel group-hover:bg-hover";
                const line = r.kind === "task" ? "var(--color-hover)" : "var(--color-line)";
                return (
                  <div key={r.id} className={cx("group flex", r.kind === "area" ? "bg-raised" : isSel ? "bg-sel" : "hover:bg-hover")}
                    style={{ height: r.h, borderBottom: `1px solid ${line}` }}>
                    {/* Its shadow covers the row's border as well, so the lines and bars scrolled under the names don't show through it. */}
                    <div data-names className={cx("sticky left-0 z-10 flex shrink-0 items-center gap-2 overflow-hidden border-r border-line pr-3", bg)}
                      style={{
                        width: tree, boxShadow: `0 1px 0 ${line}`,
                        paddingLeft: r.kind === "task" ? (r.nested ? indent.nested : indent.task) : r.kind === "proj" ? indent.proj : indent.area,
                      }}>
                      {/* A phone's narrow column shows just the names: a task's key is in its details, a project's progress in its bar. */}
                      {r.kind === "cap" && (
                        <>
                          <span className="text-[12.5px] text-fg2">{tx("Your time")}</span>
                          <span className="truncate text-[11.5px] text-mut2 max-md:hidden">{tx("hours planned per day")}</span>
                        </>
                      )}
                      {r.kind === "area" && (
                        <button type="button" aria-expanded={r.open} onClick={() => setCollapsed((c) => ({ ...c, [r.areaId]: r.open }))}
                          className="flex h-full min-w-0 flex-1 items-center gap-2 text-left">
                          <Icon name={r.open ? "chevronDown" : "chevronRight"} size={11} strokeWidth={2.6} className="shrink-0 text-mut2" />
                          {r.area ? <AreaMark area={r.area} /> : <Icon name="inbox" size={12} className="shrink-0 text-mut2" />}
                          <span className="truncate text-[12.5px] font-medium text-fg2">{r.name}</span>
                        </button>
                      )}
                      {r.kind === "proj" && (
                        <button type="button" aria-expanded={r.total ? r.open : undefined} disabled={!r.total}
                          onClick={() => setExpanded((x) => ({ ...x, [r.project.id]: !r.open }))}
                          className="flex h-full min-w-0 flex-1 items-center gap-2 text-left disabled:cursor-default">
                          <Icon name={r.open ? "chevronDown" : "chevronRight"} size={11} strokeWidth={2.6} className={cx("shrink-0 text-dim", !r.total && "invisible")} />
                          <ProgressRing pct={r.total ? (r.done / r.total) * 100 : 0} color={r.color} />
                          <span className="min-w-0 flex-1 truncate text-fg">{r.project.name}</span>
                          <span className="shrink-0 text-[11.5px] text-mut2 max-md:hidden">{r.total ? tx("{0} of {1}", [r.done, r.total]) : tx("No tasks")}</span>
                        </button>
                      )}
                      {r.kind === "task" && (
                        <button type="button" onClick={() => select(r.task)} className="flex h-full min-w-0 flex-1 items-center gap-2 text-left">
                          <span className="w-[46px] shrink-0 font-mono text-[11px] text-mut2 max-md:hidden">{r.task.key}</span>
                          <span className={cx("min-w-0 flex-1 truncate text-[12.5px]", isOpenTask(r.task) ? "text-fg2" : "text-mut2")}>{r.task.title}</span>
                        </button>
                      )}
                    </div>
                    {/* A task's lane opens the task. Any other row's adds a task planned for the day clicked, in its project or area. */}
                    <div className={cx("relative shrink-0 overflow-hidden", r.kind === "task" && "cursor-pointer select-none")} style={{ width: sc.gridW }}
                      {...(r.kind === "task" ? { onClick: () => select(r.task) } : {
                        ...addOnClick((e) => addFor(r, addDaysStr(from, dayAt(e)))),
                        onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => {
                          if (e.pointerType !== "mouse" || drag || link) return;
                          const i = dayAt(e);
                          setSpot((s) => (s?.row === r.id && s.i === i ? s : { row: r.id, i }));
                        },
                        onPointerLeave: () => setSpot(null),
                      })}>
                      {r.kind === "cap" && layers.blocks && <CapLane loads={loads} dayMinutes={dayMinutes} sc={sc} lo={lo} hi={hi} />}
                      {r.kind === "proj" && <ProjectLane row={r} sc={sc} />}
                      {r.kind === "task" && (
                        <TaskLane row={r} state={states[r.task.id]} sc={sc} layers={layers}
                          dragText={drag?.taskId === r.task.id ? dragLabel(r.span, drag.part, from, tx) : null}
                          linkTarget={!!link && link.target === r.task.id && !link.problem}
                          onGrab={!phone && isOpenTask(r.task) ? (e, part) => grabBar(e, r, part) : null}
                          onLink={!phone && isOpenTask(r.task) && layers.deps ? (e, side) => grabLink(e, r, side) : null} />
                      )}
                      {/* Where the new task would go, drawn like a task that's still to do. */}
                      {spot?.row === r.id && (
                        <span className="pointer-events-none absolute flex items-center justify-center rounded border border-dashed border-line-strong text-mut"
                          style={{ top: (r.h - 1 - BAR_H) / 2, height: BAR_H, left: X(spot.i) + 1, width: Math.max(4, X(spot.i + 1) - X(spot.i) - 2) }}>
                          {dayW >= 16 && <Icon name="plus" size={11} strokeWidth={2.4} />}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}

              {deps.length > 0 && (
                <svg width={sc.gridW} height={height} className="pointer-events-none absolute top-0" style={{ left: tree }} aria-hidden="true">
                  {deps.map((p) => (
                    <g key={p.edge.id} className="group/dep">
                      <path d={p.d} fill="none" stroke="var(--color-line-strong)" strokeWidth="1.2" strokeLinejoin="round" className="group-hover/dep:stroke-mut" />
                      <path d={p.head} fill="none" stroke="var(--color-dim)" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" className="group-hover/dep:stroke-mut" />
                      {/* A wider, invisible copy to click: it offers to remove the dependency. */}
                      <path d={p.d} fill="none" stroke="transparent" strokeWidth="9" className="cursor-pointer" style={{ pointerEvents: "stroke" }}
                        onClick={(e) => setDepMenu({ edge: p.edge, from: p.from, to: p.to, anchor: { x: e.clientX, y: e.clientY } })}>
                        <title>{tx("{0} waits for {1}", [p.to, p.from])}</title>
                      </path>
                    </g>
                  ))}
                </svg>
              )}
              {linkLine && (
                <svg width={sc.gridW} height={height} className="pointer-events-none absolute top-0 z-[2] overflow-visible" style={{ left: tree }} aria-hidden="true">
                  <path d={linkLine.d} fill="none" stroke={linkLine.ok ? ACCENT_LINE : "var(--color-line-strong)"} strokeWidth="1.5" strokeDasharray="5 4" />
                  <circle cx={linkLine.x1} cy={linkLine.y1} r="4" fill="var(--color-panel)" stroke={linkLine.ok ? ACCENT_LINE : "var(--color-line-strong)"} strokeWidth="1.5" />
                </svg>
              )}
              {link?.problem && (
                <span className="pointer-events-none absolute z-[3] whitespace-nowrap rounded-md border border-line2 bg-raised px-2 py-1 text-[11.5px] text-mut shadow-[var(--shadow-popover)]"
                  style={{ left: tree + link.x + 14, top: link.y + 12 }}>
                  {link.problem}
                </span>
              )}
              {sc.nowPos >= 0 && sc.nowPos <= days && (
                <span className="pointer-events-none absolute inset-y-0 w-px" style={{ left: tree + X(sc.nowPos), background: "color-mix(in srgb, var(--color-accent) 75%, transparent)" }} />
              )}
            </div>
          </div>
        </div>
      </section>
      {selected && <TaskDetail key={`${selected.id}-${selected.updatedAt}`} task={selected} ctx={ctx} onClose={() => setSel(null)} />}
      {depMenu && (
        <Popover anchor={depMenu.anchor} onClose={() => setDepMenu(null)} width={236}>
          <PopoverLabel>{depMenu.to} {" "}{tx("waits for")}{" "}{depMenu.from}</PopoverLabel>
          <PopoverItem icon={<Icon name="x" size={13} />} onClick={() => unlink(depMenu.edge, depMenu.from, depMenu.to)}>{tx("Remove dependency")}</PopoverItem>
        </Popover>
      )}
    </div>
  );
}
