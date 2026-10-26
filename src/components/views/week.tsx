"use client";
import { useTranslation } from "@/components/language";
import { createTranslator, type Translator } from "@/lib/i18n";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  useLayoutEffect, useOptimistic, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode,
} from "react";

import { updateTaskAction } from "@/app/actions";
import { projectColor } from "@/lib/colors";
import { addDaysStr, dateOnly, fmtDay, fmtTime, hhmm, minutesOf, parseLocal, timeOf } from "@/lib/dates";
import { blockMinutes, type PlannedBlock } from "@/lib/planner";
import { AGENT_LABEL, type AgentId, type Area, type EventOccurrence, type Project, type SessionStatus, type Settings, type Task, type TaskContext } from "@/lib/types";
import type { WeekPlan } from "@/server/calendar";
import { openActivity } from "../activity-editor";
import { CalendarSourceBadge, CalendarSourceLegend } from "../calendar-source";
import { calendarSource } from "@/lib/calendar-source";
import { AgentIcon, Icon, StatusIcon } from "../icons";
import { TaskDetail } from "../task-detail";
import { Button, Dot, Segmented, Switch, cx, useAction } from "../ui";
import { PeriodNav, ViewHeader, ViewSwitch, areaColor, isOpenTask, pressable, useAddOnClick, useNow, useSelection } from "./calendar-parts";

/** An agent session that ran (or runs) in the week: a block from its start to its end, in its agent's color. */
export interface SessionBlock {
  id: string;
  taskId: number;
  key: string;
  title: string;
  agent: AgentId;
  start: string;
  /** null while the session is still running. */
  end: string | null;
  status: SessionStatus;
}

export type WorkRules = Pick<Settings, "workStart" | "workEnd" | "lunchStart" | "lunchEnd" | "workDays">;

/** Pixels per hour. The day runs from midnight to midnight. */
const PX = 44;
const DAY = 24 * 60;
/** Dragged blocks land on quarter hours. */
const SNAP = 15;
/** The shortest a block is drawn, in minutes of the grid, so a two-minute session still has a line to click. */
const MIN_DRAWN = 25;
const DAY_NAMES = (tx: Translator) => ([tx("Mon"), tx("Tue"), tx("Wed"), tx("Thu"), tx("Fri"), tx("Sat"), tx("Sun")]);

const y = (min: number) => Math.round((min / 60) * PX);
const minutes = (b: { start: string; end: string }) => minutesOf(b.end.slice(11, 16)) - minutesOf(b.start.slice(11, 16));
const hours = (min: number) => Math.round((min / 60) * 10) / 10;
const snap = (min: number) => Math.round(min / SNAP) * SNAP;
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** Minutes after midnight of `day` for a local timestamp, clamped to that day. */
function minOn(stamp: string, day: string) {
  const d = dateOnly(stamp);
  return d < day ? 0 : d > day ? DAY : minutesOf(stamp.slice(11, 16));
}

/** The half hour a click in a day's column falls on, "HH:mm". */
function slotAt(e: MouseEvent<HTMLElement>) {
  const min = Math.floor(((e.clientY - e.currentTarget.getBoundingClientRect().top) / PX) * 2) * 30;
  return hhmm(clamp(min, 0, DAY - 30));
}

/** A light wash of an agent's color: its sessions and the tasks it does. */
function tint(agent: AgentId, past: boolean): CSSProperties {
  return {
    background: `color-mix(in srgb, var(--color-${agent}) ${past ? 7 : 14}%, var(--color-panel))`,
    borderColor: `color-mix(in srgb, var(--color-${agent}) ${past ? 22 : 45}%, transparent)`,
  };
}

/** A finished task, and the sessions of one: dimmed, so what's left stands out. Hovered, it comes back to read. */
const DIMMED = "opacity-40 hover:opacity-90";

/** The agent a task names outright; a task without one is shown as yours, as the auto-planner treats it. */
const namedAgent = (t: Task): AgentId | null => (t.agent === "claude" || t.agent === "codex" ? t.agent : null);

const taskColor = (t: Pick<Task, "projectId" | "areaId">, projects: Project[], areas: Area[]) => {
  const p = t.projectId ? projects.find((x) => x.id === t.projectId) : null;
  return p ? projectColor(p, areas) : areaColor(areas, t.areaId);
};

type Kind = "fixed" | "auto" | "check" | "pinned" | "session";

type Block = {
  id: string;
  /** Minutes after midnight, clamped to the day. */
  s: number;
  e: number;
  kind: Kind;
  title: string;
  start: string;
  end: string;
  color: string;
  task?: Task;
  /** A fixed block's activity, which a click opens. */
  event?: EventOccurrence;
  agent?: AgentId | null;
  running?: boolean;
};

/** Puts overlapping blocks side by side: each cluster of overlaps gets as many columns as it needs. */
function columns(blocks: Block[]) {
  const out: (Block & { col: number; cols: number })[] = [];
  let cluster: typeof out = [];
  let ends: number[] = [];
  let clusterEnd = -1;
  const flush = () => {
    for (const b of cluster) b.cols = ends.length;
    cluster = [];
    ends = [];
  };
  const drawnEnd = (b: Block) => Math.max(b.e, b.s + MIN_DRAWN);
  for (const b of [...blocks].sort((a, z) => a.s - z.s || z.e - a.e)) {
    if (b.s >= clusterEnd) flush();
    let col = ends.findIndex((e) => e <= b.s);
    if (col === -1) {
      col = ends.length;
      ends.push(drawnEnd(b));
    } else {
      ends[col] = drawnEnd(b);
    }
    const placed = { ...b, col, cols: 1 };
    cluster.push(placed);
    out.push(placed);
    clusterEnd = Math.max(clusterEnd, drawnEnd(b));
  }
  flush();
  return out;
}

/** Where a dragged task would land: at a time on a day, on a day without a time, or back in the list without one. */
type Drop = { kind: "grid"; day: string; min: number; len: number } | { kind: "allday"; day: string } | { kind: "list" };

type Drag = {
  task: Task;
  /** Moving the task, or one edge of its block: the top moves its start, the bottom its finish (its estimate). */
  mode: "move" | "top" | "bottom";
  len: number;
  /** How far below the block's top it was picked up, in minutes. */
  grab: number;
  /** The day and start of the block it was picked up from, if any. */
  fromDay: string | null;
  fromMin: number;
  drop: Drop | null;
  x: number;
  y: number;
};

type Patch = Partial<Pick<Task, "plannedDate" | "plannedTime" | "estimateMin">>;

export function WeekView({
  days, now: serverNow, subtitle, current, events, plan, runs, tasks, toPlace, rules, ctx, nav, initialKey,
}: {
  /** Monday to Sunday. */
  days: string[];
  now: string;
  subtitle: string;
  /** The week contains today. */
  current: boolean;
  events: EventOccurrence[];
  plan: WeekPlan | null;
  runs: SessionBlock[];
  tasks: Task[];
  /** The tasks the side list offers to place, most urgent first, and how many there are in all. */
  toPlace: { ids: number[]; total: number };
  rules: WorkRules;
  ctx: TaskContext;
  nav: { month: string; week: string };
  initialKey: string | null;
}) {
  const tx = useTranslation();
  const now = useNow(serverNow);
  const today = now.slice(0, 10);
  const nowMin = minutesOf(now.slice(11, 16));
  const router = useRouter();
  const params = useSearchParams();
  const { run } = useAction();
  const [sel, setSel] = useSelection(initialKey);
  const [on, setOn] = useState(true);
  const addOnClick = useAddOnClick();
  const [all, patchTask] = useOptimistic(tasks, (state, p: { id: number; patch: Patch }) =>
    state.map((t) => (t.id === p.id ? { ...t, ...p.patch } : t)));
  // The day whose column is under the mouse: its header lights up with a "+", as a click there adds a task.
  const [hovered, setHovered] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const selected = all.find((t) => t.key === sel) ?? null;
  const toggle = (key: string) => setSel((s) => (s === key ? null : key));
  const byId = new Map(all.map((t) => [t.id, t]));

  // A phone shows one day: the one the URL names (?w=), else today, else Monday. The week arrows keep its weekday.
  const w = params.get("w");
  const shown = w && days.includes(w) ? w : days.includes(today) ? today : days[0];
  const show = (day: string) => {
    const q = new URLSearchParams(params.toString());
    q.set("w", day);
    // The whole week is already here, so only the URL changes: no request to the server.
    window.history.replaceState(null, "", `?${q}`);
  };

  // The day runs from midnight, but opens where there's something to see: just before now, or the start of work.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = y(Math.max(0, current ? nowMin - 120 : minutesOf(rules.workStart) - 30));
    // Only when another week opens: afterwards the day stays where you scrolled it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days[0]]);

  /** The open tasks due on `day`, whether one of them is late, and the time of a lone deadline. */
  const deadlines = (day: string) => {
    const dues = all.filter((t) => isOpenTask(t) && t.dueDate && dateOnly(t.dueDate) === day);
    const late = dues.some((t) => (timeOf(t.dueDate) ? t.dueDate! < now : day < today));
    return { dues, late, single: dues.length === 1 ? timeOf(dues[0].dueDate) : null };
  };
  const shownDues = deadlines(shown).dues;

  const autoOn = (day: string) => (plan && on ? plan.blocks.filter((b) => dateOnly(b.start) === day) : []);

  const blocksOn = (day: string) => {
    const list: Block[] = events.filter((e) => dateOnly(e.start) === day).map((e) => ({
      id: `e${e.eventId}-${e.start}`, s: minOn(e.start, day), e: minOn(e.end, day), kind: "fixed", title: e.title,
      start: e.start, end: e.end, color: e.calendar?.source ? calendarSource(e.calendar).color : areaColor(ctx.areas, e.areaId), event: e,
    }));
    for (const b of autoOn(day)) {
      const t = byId.get(b.taskId);
      // A task you just put somewhere yourself leaves the auto-plan, before the page catches up.
      if (b.kind === "task" && t && (t.plannedTime || (t.plannedDate && t.plannedDate > day))) continue;
      list.push({
        id: `b${b.taskId}-${b.start}`, s: minOn(b.start, day), e: minOn(b.end, day), kind: b.kind === "check" ? "check" : "auto",
        title: b.kind === "check" ? tx("Check {0}", [b.key]) : `${b.key} ${b.title}`, start: b.start, end: b.end,
        color: t ? taskColor(t, ctx.projects, ctx.areas) : areaColor(ctx.areas, b.areaId), task: t,
      });
    }
    for (const t of all) {
      if (t.plannedDate !== day || !t.plannedTime || t.status === "canceled") continue;
      const s = minutesOf(t.plannedTime);
      const e = Math.min(DAY, s + blockMinutes(t));
      list.push({
        id: `t${t.id}`, s, e, kind: "pinned", title: `${t.key} ${t.title}`, start: `${day}T${t.plannedTime}`, end: `${day}T${hhmm(e)}`,
        color: taskColor(t, ctx.projects, ctx.areas), task: t, agent: namedAgent(t),
      });
    }
    for (const r of runs) {
      const end = r.end ?? now;
      if (dateOnly(r.start) > day || dateOnly(end) < day) continue;
      list.push({
        id: `s${r.id}`, s: minOn(r.start, day), e: minOn(end, day), kind: "session", title: `${r.key} ${r.title}`, start: r.start, end,
        color: "", agent: r.agent, running: !r.end, task: byId.get(r.taskId),
      });
    }
    return columns(list);
  };

  /** Tasks planned for `day` without a time, which the auto-plan didn't put in it either. */
  const allDayOn = (day: string) => {
    const auto = new Set(autoOn(day).map((b) => b.taskId));
    return all.filter((t) => t.plannedDate === day && !t.plannedTime && t.status !== "canceled" && !auto.has(t.id));
  };
  const allDay = days.map(allDayOn);
  const hasAllDay = allDay.some((l) => l.length > 0) || !!drag;

  const listed = toPlace.ids.map((id) => byId.get(id)).filter((t): t is Task =>
    !!t && isOpenTask(t) && !(t.plannedDate && t.plannedDate >= days[0] && t.plannedDate <= days[6]));
  // A task just dragged off its day joins the list at once, before the page catches up.
  const autoPlaced = new Set(plan && on ? plan.blocks.map((b) => b.taskId) : []);
  const offered = new Set(toPlace.ids);
  listed.unshift(...all.filter((t) => !offered.has(t.id) && isOpenTask(t) && !t.plannedDate && !autoPlaced.has(t.id)));

  /* ---------- dragging ---------- */

  const dropAt = (x: number, py: number, d: Omit<Drag, "drop" | "x" | "y">): Drop | null => {
    if (d.mode !== "move") {
      // An edge stays on its day, whichever column the pointer is over, and keeps the block at least a quarter hour long.
      const col = document.querySelector<HTMLElement>(`[data-drop="grid"][data-day="${d.fromDay}"]`);
      if (!col) return null;
      const at = snap(((py - col.getBoundingClientRect().top) / PX) * 60);
      const end = d.fromMin + d.len;
      if (d.mode === "top") {
        const start = clamp(at, 0, end - SNAP);
        return { kind: "grid", day: d.fromDay!, min: start, len: end - start };
      }
      return { kind: "grid", day: d.fromDay!, min: d.fromMin, len: clamp(at, d.fromMin + SNAP, DAY) - d.fromMin };
    }
    const el = document.elementFromPoint(x, py)?.closest<HTMLElement>("[data-drop]");
    if (!el) return null;
    const day = el.dataset.day ?? "";
    if (el.dataset.drop === "grid") {
      const raw = ((py - el.getBoundingClientRect().top) / PX) * 60 - d.grab;
      return { kind: "grid", day, min: clamp(snap(raw), 0, DAY - d.len), len: d.len };
    }
    if (el.dataset.drop === "allday") return { kind: "allday", day };
    return d.task.plannedDate ? { kind: "list" } : null;
  };

  /** Keeps the dragged block in sight: near the top or bottom edge of the day, it scrolls. */
  const autoScroll = (py: number) => {
    const el = scrollRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (py < r.top + 90) el.scrollTop -= 14;
    else if (py > r.bottom - 40) el.scrollTop += 14;
  };

  const commit = (d: Drag) => {
    const t = d.task;
    const drop = d.drop!;
    let patch: Patch;
    let message: string;
    if (d.mode === "bottom" && drop.kind === "grid") {
      patch = { estimateMin: drop.len };
      message = tx("{0} finishes at {1} now", [t.key, hhmm(drop.min + drop.len)]);
    } else if (d.mode === "top" && drop.kind === "grid") {
      patch = { plannedTime: hhmm(drop.min), estimateMin: drop.len };
      message = tx("{0} starts at {1} now", [t.key, hhmm(drop.min)]);
    } else if (drop.kind === "grid") {
      patch = { plannedDate: drop.day, plannedTime: hhmm(drop.min) };
      message = tx("{0} is planned for {1} at {2}", [t.key, fmtDay(drop.day, tx.language), hhmm(drop.min)]);
    } else if (drop.kind === "allday") {
      patch = { plannedDate: drop.day, plannedTime: null };
      message = tx("{0} is planned for {1}", [t.key, fmtDay(drop.day, tx.language)]);
    } else {
      patch = { plannedDate: null, plannedTime: null };
      message = tx("{0} isn't planned for a day now", [t.key]);
    }
    if (Object.entries(patch).every(([k, v]) => t[k as keyof Patch] === v)) return;
    run(() => {
      patchTask({ id: t.id, patch });
      return updateTaskAction(t.id, patch);
    }, message);
  };

  /**
   * Starts dragging a task with the mouse (a touch scrolls, and a tap opens the task). It follows the pointer
   * once it has moved a few pixels, so a plain click still opens the task.
   */
  const grab = (e: ReactPointerEvent, d: Omit<Drag, "drop" | "x" | "y">) => {
    if (e.button !== 0 || e.pointerType === "touch") return;
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX;
    const y0 = e.clientY;
    let active = false;
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("keydown", key);
      document.body.style.cursor = "";
      // The click that ends a drag isn't one: it would open the task, or add one where it was dropped.
      if (active) {
        const swallow = (ev: Event) => { ev.stopPropagation(); ev.preventDefault(); };
        window.addEventListener("click", swallow, { capture: true, once: true });
        setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
      }
      dragRef.current = null;
      setDrag(null);
    };
    const move = (ev: PointerEvent) => {
      if (!active) {
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return;
        active = true;
        document.body.style.cursor = d.mode === "move" ? "grabbing" : "ns-resize";
      }
      autoScroll(ev.clientY);
      const next = { ...d, x: ev.clientX, y: ev.clientY, drop: dropAt(ev.clientX, ev.clientY, d) };
      dragRef.current = next;
      setDrag(next);
    };
    const up = () => {
      const last = dragRef.current;
      end();
      if (last?.drop) commit(last);
    };
    const key = (ev: KeyboardEvent) => { if (ev.key === "Escape") end(); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("keydown", key);
  };

  /** Pick-up props for a task shown as a chip (in a day's top row or the list): it lands with its top at the pointer. */
  const chipGrab = (t: Task) => ({
    onPointerDown: (e: ReactPointerEvent) => grab(e, { task: t, mode: "move", len: blockMinutes(t), grab: 10, fromDay: null, fromMin: 0 }),
  });
  const open = toggle;

  const legend = (
    <>
      <Legend swatch="border-ctl">{tx("Fixed")}</Legend>
      <Legend swatch="border-line-strong bg-line">{tx("Yours")}</Legend>
      <Legend swatch="border-dashed border-ctl bg-hover">{tx("Auto-planned")}</Legend>
      <Legend swatch="border-accent/55 bg-line">{tx("Check a finished session")}</Legend>
      <Legend style={tint("claude", false)}>{AGENT_LABEL.claude}</Legend>
      <Legend style={tint("codex", false)}>{AGENT_LABEL.codex}</Legend>
      <Legend swatch="border-line-strong bg-line opacity-40">{tx("Done")}</Legend>
    </>
  );

  const ghost = drag?.drop?.kind === "grid" ? drag.drop : null;

  return (
    <div className="flex min-w-0 flex-1">
      <section aria-label={tx("Week")} className="flex min-w-0 flex-1 flex-col">
        {/* On a phone the subtitle is the shown day's month, short, as in the month view; the day strip has the dates. */}
        <ViewHeader icon="calendar" title={tx("Calendar")} phoneSubtitleOnly subtitle={<>
          <span className="max-sm:hidden">{subtitle}</span>
          <span className="sm:hidden">{tx.date(parseLocal(shown), "MMM yyyy")}</span>
        </>}>
          <PeriodNav unit="week" prev={`/calendar/week?w=${addDaysStr(shown, -7)}`} next={`/calendar/week?w=${addDaysStr(shown, 7)}`}
            today="/calendar/week" />
          <span className="flex-1" />
          <ViewSwitch value="week" month={nav.month} week={nav.week} />
        </ViewHeader>
        <CalendarSourceLegend events={events} />

        <div className="flex h-10 shrink-0 items-center gap-3.5 overflow-hidden border-b border-line px-5 text-[12px] text-mut max-md:hidden">
          {legend}
          <span className="flex-1" />
          {plan && (
            <span className="truncate">
              {hours(plan.plannedMinutes)} {" "}{tx("h planned of")}{" "}{hours(plan.capacityMinutes)} {" "}{tx("h focus time")}{current ? tx(" left") : ""}
            </span>
          )}
        </div>

        {/* A phone has room for one day: the strip picks it and shows each day's deadlines. */}
        <div role="group" aria-label={tx("Day")} className="flex shrink-0 gap-0.5 border-b border-line px-1.5 py-1 md:hidden">
          {days.map((day, i) => {
            const { dues, late, single } = deadlines(day);
            const isToday = day === today;
            const past = day < today;
            const label = [tx.date(parseLocal(day), "EEEE d MMMM"), isToday && tx("today"),
              dues.length > 0 && `${dues.length} ${past ? "missed" : "due"}`].filter(Boolean).join(", ");
            return (
              <button key={day} type="button" aria-pressed={day === shown} aria-label={label} onClick={() => show(day)}
                className={cx("flex min-w-0 flex-1 flex-col items-center gap-1 rounded-md py-1", day === shown ? "bg-sel" : "hover:bg-hover")}>
                <span className={cx("text-[11px] leading-none", isToday || day === shown ? "text-strong" : past ? "text-mut2" : "text-fg3")}>{tx(DAY_NAMES(tx)[i])}</span>
                <span className={cx("inline-flex h-[22px] min-w-[22px] items-center justify-center rounded-full px-[5px] text-[12px] font-medium",
                  isToday ? "bg-accent text-bg" : day === shown ? "text-strong" : past ? "text-mut2" : "text-fg2")}>
                  {Number(day.slice(8))}
                </span>
                <span className={cx("flex h-2.5 items-center gap-[2px] text-[10px] leading-none", late ? "text-danger" : isToday ? "text-fg2" : "text-fg3")}>
                  {dues.length > 0 && <><Icon name="flag" size={9} strokeWidth={2.4} />{single ?? dues.length}</>}
                </span>
              </button>
            );
          })}
        </div>

        {/* A phone scrolls the day, the legend and the side panel as one page. */}
        <div className="flex min-h-0 flex-1 max-md:flex-col max-md:overflow-y-auto">
          <div ref={scrollRef} className="min-h-0 min-w-0 flex-1 overflow-y-auto max-md:flex-none max-md:overflow-visible">
            {/* A phone can't hover a deadline flag to see its tasks, so the day's deadlines are listed, and open like blocks. */}
            {shownDues.length > 0 && (
              <div className="flex flex-col gap-1 border-b border-line px-3 py-2 md:hidden">
                {shownDues.map((t) => {
                  const time = timeOf(t.dueDate);
                  const late = time ? t.dueDate! < now : shown < today;
                  return (
                    <button key={t.id} type="button" onClick={() => toggle(t.key)}
                      className={cx("flex h-7 min-w-0 items-center gap-1.5 rounded-[5px] border px-2 text-left text-[12px]",
                        late ? "border-ink/5 bg-ink/5 text-danger" : shown === today ? "border-ink/5 bg-ink/5 text-fg2" : "border-line2 bg-hover text-fg3")}>
                      <Icon name="flag" size={11} strokeWidth={2.2} className="shrink-0" />
                      {time && <span className="shrink-0 font-mono text-[10.5px] text-mut2">{time}</span>}
                      <span className="shrink-0 font-mono text-[11px] text-mut2">{t.key}</span>
                      <span className="truncate">{t.title}</span>
                    </button>
                  );
                })}
              </div>
            )}

            <div className="sticky top-0 z-30 border-b border-line bg-panel">
              <div className="flex h-11 max-md:hidden">
                <div className="w-[52px] shrink-0" />
                {days.map((day, i) => {
                  const { dues, late, single } = deadlines(day);
                  const isToday = day === today;
                  const past = day < today;
                  return (
                    <div key={day} title={tx("New task on {0}", [fmtDay(day, tx.language)])} {...addOnClick(() => ({ plannedDate: day }))}
                      className={cx("flex min-w-0 flex-1 basis-0 items-center gap-1.5 overflow-hidden border-l border-line px-2 hover:bg-hover", hovered === day && "bg-hover")}>
                      <span className={cx("shrink-0 text-[12px]", isToday ? "text-strong" : past ? "text-mut2" : "text-fg3")}>{tx(DAY_NAMES(tx)[i])}</span>
                      <span className={cx("inline-flex h-[22px] min-w-[22px] shrink-0 items-center justify-center rounded-full px-[5px] text-[12px] font-medium",
                        isToday ? "bg-accent text-bg" : past ? "text-mut2" : "text-fg2")}>
                        {Number(day.slice(8))}
                      </span>
                      <span className="flex-1" />
                      {/* While the pointer is over the day's column, a "+" in place of its deadlines says a click there adds a task.
                          A narrow day has no room for both. */}
                      {hovered === day ? <Icon name="plus" size={12} strokeWidth={2.2} className="shrink-0 text-mut2" /> : dues.length > 0 && (
                        // In a narrow day the count or time gives way to the day's name, never over the next day.
                        <span data-item title={dues.map((t) => `${t.key} ${t.title}`).join("\n")}
                          className={cx("inline-flex min-w-0 items-center gap-[3px] text-[11px]", late ? "text-danger" : isToday ? "text-fg2" : "text-fg3")}>
                          <Icon name="flag" size={10} strokeWidth={2.4} className="shrink-0" />
                          <span className="truncate">{past ? tx("{0} missed", [dues.length]) : (single ?? dues.length)}</span>
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Tasks planned for a day without a time. Dropped here, a task keeps the day and loses its time. */}
              {hasAllDay && (
                <div className="flex border-t border-line">
                  <div className="flex w-[52px] shrink-0 items-start justify-end pr-2 pt-1.5 text-[10px] text-dim">{tx("Day")}</div>
                  {days.map((day, i) => (
                    <div key={day} data-drop="allday" data-day={day}
                      className={cx("flex max-h-[98px] min-h-[30px] min-w-0 flex-1 basis-0 flex-col gap-[3px] overflow-y-auto border-l border-line p-[3px]",
                        day !== shown && "max-md:hidden",
                        drag?.drop?.kind === "allday" && drag.drop.day === day && "bg-sel")}>
                      {allDay[i].map((t) => (
                        <div key={t.id} title={`${t.key} ${t.title}`} {...pressable(() => open(t.key))} {...chipGrab(t)}
                          className={cx("flex h-[22px] shrink-0 cursor-grab items-center gap-[5px] rounded-[4px] border px-1.5 text-[11px]",
                            t.key === sel ? "ring-1 ring-accent/70" : "",
                            drag?.task.id === t.id && "opacity-40",
                            "border-line-strong bg-line text-strong hover:bg-sel", t.status === "done" && DIMMED)}
                          style={namedAgent(t) ? tint(namedAgent(t)!, false) : undefined}>
                          {namedAgent(t) ? <AgentIcon agent={namedAgent(t)!} size={9} className="shrink-0" style={{ color: `var(--color-${namedAgent(t)})` }} />
                            : <Dot color={taskColor(t, ctx.projects, ctx.areas)} size={6} />}
                          <span className="truncate">{t.key} {t.title}</span>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="relative flex" style={{ height: 24 * PX }}>
              <div className="relative w-[52px] shrink-0">
                {Array.from({ length: 23 }, (_, k) => (
                  <span key={k} className="absolute right-2 font-mono text-[10.5px] text-dim" style={{ top: (k + 1) * PX - 7 }}>
                    {hhmm((k + 1) * 60)}
                  </span>
                ))}
              </div>
              {/* A click on a day's free space adds a task planned for it; as an activity, it would start at that half hour. */}
              {days.map((day, i) => {
                const add = addOnClick((e) => ({ plannedDate: day, start: `${day}T${slotAt(e)}` }));
                const workDay = rules.workDays.includes(i + 1);
                return (
                  <div key={day} data-drop="grid" data-day={day}
                    className={cx("relative min-w-0 flex-1 basis-0 border-l border-line", day !== shown && "max-md:hidden")}
                    style={{
                      backgroundImage: "linear-gradient(to bottom, var(--color-line) 1px, transparent 1px)",
                      backgroundSize: `100% ${PX}px`,
                      backgroundColor: workDay ? undefined : "var(--color-nonwork)",
                    }}
                    {...add}
                    onPointerEnter={(e) => { if (e.pointerType === "mouse") setHovered(day); }}
                    onPointerLeave={() => setHovered((d) => (d === day ? null : d))}>
                    {/* Outside work hours the day is shaded, as a day off is. */}
                    {workDay && (
                      <>
                        <span className="pointer-events-none absolute inset-x-0 top-0 bg-nonwork" style={{ height: y(minutesOf(rules.workStart)) }} />
                        <span className="pointer-events-none absolute inset-x-0 bottom-0 bg-nonwork" style={{ top: y(minutesOf(rules.workEnd)) }} />
                      </>
                    )}
                    {blocksOn(day).map((b) => (
                      <BlockView key={b.id} block={b} past={b.end <= now && !b.running}
                        selected={!!b.task && b.task.key === sel} dragging={!!b.task && drag?.task.id === b.task.id}
                        onOpen={() => { if (b.task) open(b.task.key); else if (b.event) openActivity(b.event); }}
                        onGrab={b.task && (b.kind === "pinned" || b.kind === "auto") ? (e, mode) => {
                          const top = e.currentTarget.closest("[data-block]")!.getBoundingClientRect().top;
                          grab(e, {
                            task: b.task!, mode, len: b.kind === "pinned" ? b.e - b.s : blockMinutes(b.task!),
                            grab: mode === "move" ? clamp(((e.clientY - top) / PX) * 60, 0, b.e - b.s) : 0, fromDay: day, fromMin: b.s,
                          });
                        } : undefined} />
                    ))}
                    {ghost && ghost.day === day && drag && (
                      <div className="pointer-events-none absolute inset-x-[2px] z-20 overflow-hidden rounded-[5px] border border-dashed border-accent bg-sel/80 px-1.5 py-[3px] text-[11px] leading-[1.35] text-strong"
                        style={{ top: y(ghost.min) + 1, height: Math.max(18, y(ghost.len) - 2) }}>
                        <span className="block truncate font-medium">{drag.task.key} {drag.task.title}</span>
                        <span className="block font-mono text-[10px] text-mut">{hhmm(ghost.min)}–{hhmm(ghost.min + ghost.len)}</span>
                      </div>
                    )}
                    {day === today && (
                      <>
                        <span className="pointer-events-none absolute inset-x-0 z-20 h-0.5 bg-accent" style={{ top: y(nowMin) - 1 }} />
                        <span className="pointer-events-none absolute -left-1 z-20 h-2 w-2 rounded-full bg-accent" style={{ top: y(nowMin) - 4 }} />
                      </>
                    )}
                  </div>
                );
              })}
            </div>

            {/* On a phone the legend comes after the day, where it can wrap. */}
            <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2 border-t border-line px-4 py-3 text-[12px] text-mut md:hidden">{legend}</div>
          </div>

          {/* An open task takes its place on a computer. On a phone the task covers the screen, and the panel stays under
              it, so the page is still scrolled where it was when the task closes. */}
          <SidePanel taskOpen={!!selected}>
            {(tab) => tab === "tasks" ? (
              <PlaceList tasks={listed} total={toPlace.total - (toPlace.ids.length - listed.length)} ctx={ctx} sel={sel}
                dragging={drag?.task.id ?? null} over={drag?.drop?.kind === "list"} onOpen={open} grabProps={chipGrab} />
            ) : (
              <AutoPlan plan={plan} on={on} onToggle={setOn} current={current} tasks={all} areas={ctx.areas} rules={rules}
                today={today} now={now} onOpen={toggle} onReplan={() => router.refresh()} />
            )}
          </SidePanel>
        </div>
      </section>
      {selected && <TaskDetail key={`${selected.id}-${selected.updatedAt}`} task={selected} ctx={ctx} onClose={() => setSel(null)} />}

      {/* Off the grid, the dragged task follows the pointer. */}
      {drag && drag.drop?.kind !== "grid" && (
        <div className="pointer-events-none fixed z-50 flex h-[22px] max-w-[240px] items-center gap-1.5 rounded-[4px] border border-line-strong bg-raised px-1.5 text-[11px] text-strong shadow-[var(--shadow-popover)]"
          style={{ left: drag.x + 12, top: drag.y + 10 }}>
          <span className="shrink-0 font-mono text-[10.5px] text-mut2">{drag.task.key}</span>
          <span className="truncate">{drag.task.title}</span>
        </div>
      )}
    </div>
  );
}

function Legend({ swatch, style, children }: { swatch?: string; style?: CSSProperties; children: ReactNode }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <span className={cx("h-2.5 w-2.5 rounded-[3px] border", swatch)} style={style} />
      {children}
    </span>
  );
}

function BlockView({ block: b, past, selected, dragging, onOpen, onGrab }: {
  block: Block & { col: number; cols: number };
  past: boolean;
  selected: boolean;
  dragging: boolean;
  onOpen: () => void;
  /** Given for a task you can move: picks it up by its middle, or by its top or bottom edge to move its start or finish. */
  onGrab?: (e: ReactPointerEvent<HTMLElement>, mode: Drag["mode"]) => void;
}) {
  const tx = useTranslation();
  const top = y(b.s) + 1;
  const height = Math.max(18, y(b.e) - top - 1);
  // A finished task's block, and its sessions, are dimmed.
  const done = b.task?.status === "done" && (b.kind === "pinned" || b.kind === "session");
  const style: CSSProperties = {
    top,
    height,
    left: `calc(2px + (100% - 4px) * ${b.col / b.cols})`,
    width: `calc((100% - 4px) / ${b.cols} - ${b.cols > 1 ? 2 : 0}px)`,
    ...(b.agent ? tint(b.agent, past) : {}),
  };
  const tone = b.agent ? cx("hover:brightness-110", past ? "text-mut2" : "text-strong")
    : b.kind === "fixed" ? cx("border-ctl hover:bg-hover", past ? "text-mut2" : "text-fg3")
    : past ? "border-sel bg-hover text-mut2 hover:bg-hover"
    : b.kind === "check" ? "border-accent/55 bg-line text-strong hover:bg-sel"
    : b.kind === "auto" ? "border-dashed border-ctl bg-hover text-fg2 hover:bg-sel"
    : "border-line-strong bg-line text-strong hover:bg-sel";
  const cls = cx("group absolute block overflow-hidden rounded-[5px] border px-1.5 text-left text-[11px] leading-[1.35]",
    height >= 24 ? "py-[3px]" : "py-0", tone, selected && "ring-1 ring-accent/70", dragging ? "opacity-40" : done && DIMMED,
    onGrab ? "cursor-grab" : "cursor-pointer", b.kind === "session" ? "z-[5]" : "");
  const time = `${fmtTime(b.start)}–${b.running ? tx("now") : fmtTime(b.end)}`;
  const label = b.kind === "session"
    ? `${tx(AGENT_LABEL[b.agent!])}: ${b.title}, ${fmtTime(b.start)}–${b.running ? tx("now, running") : fmtTime(b.end)}`
    : `${b.title}, ${time}${b.event ? ` · ${calendarSource(b.event.calendar).label}` : ""}${b.kind === "auto" ? tx(" (auto-planned)") : ""}${done ? tx(", done") : ""}${onGrab ? ". Drag to move it." : ""}`;
  return (
    <div data-block data-item title={label} aria-label={label} {...pressable(onOpen)} className={cls} style={style}
      onPointerDown={onGrab ? (e) => onGrab(e, "move") : undefined}>
      <span className="flex items-center gap-[5px] overflow-hidden whitespace-nowrap font-medium">
        {b.kind === "check" ? <Icon name="terminal" size={10} strokeWidth={2.4} className={cx("shrink-0", past ? "text-dim" : "text-accent")} />
          : b.agent ? <AgentIcon agent={b.agent} size={10} className="shrink-0" style={{ color: `var(--color-${b.agent})` }} />
          : b.kind === "pinned" && b.task ? <StatusIcon status={b.task.status} size={10} />
          : <Dot color={b.color} size={6} />}
        <span className="truncate">{b.title}</span>
        {b.running && <span className="ml-auto h-1.5 w-1.5 shrink-0 animate-pulse rounded-full" style={{ background: `var(--color-${b.agent})` }} />}
        {/* Too short for a second line: a phone can't hover for the time, but its one day has room for it here. */}
        {height < 36 && !b.running && (
          <span className={cx("ml-auto hidden shrink-0 font-mono text-[10px] font-normal max-md:inline", past ? "text-dim" : "text-mut")}>{time}</span>
        )}
      </span>
      {height >= 36 && <span className={cx("block font-mono text-[10px]", past ? "text-dim" : b.kind === "fixed" ? "text-mut2" : "text-mut")}>{time}</span>}
      {b.event && height >= 54 && <CalendarSourceBadge calendar={b.event.calendar} compact />}
      {/* The edges of a block you placed move its start (top) and its finish (bottom); the middle moves the whole block. */}
      {onGrab && b.kind === "pinned" && (
        <>
          <span aria-hidden className="absolute inset-x-0 top-0 flex h-[6px] cursor-ns-resize items-start opacity-0 group-hover:opacity-100"
            onPointerDown={(e) => onGrab(e, "top")}>
            <span className="mx-auto mt-[1px] block h-[2px] w-5 rounded-full bg-mut2" />
          </span>
          <span aria-hidden className="absolute inset-x-0 bottom-0 flex h-[6px] cursor-ns-resize items-end opacity-0 group-hover:opacity-100"
            onPointerDown={(e) => onGrab(e, "bottom")}>
            <span className="mx-auto mb-[1px] block h-[2px] w-5 rounded-full bg-mut2" />
          </span>
        </>
      )}
    </div>
  );
}

type Tab = "tasks" | "plan";

function SidePanel({ taskOpen, children }: { taskOpen: boolean; children: (tab: Tab) => ReactNode }) {
  const tx = useTranslation();
  const [tab, setTab] = useState<Tab>("tasks");
  return (
    // On a phone it follows the day, full width, and scrolls with it.
    <aside aria-label={tab === "tasks" ? tx("Tasks to place") : tx("Auto-plan")} className={cx("flex w-[300px] shrink-0 flex-col overflow-hidden border-l border-line",
      "max-md:w-auto max-md:overflow-visible max-md:border-l-0 max-md:border-t", taskOpen && "md:hidden")}>
      <div className="flex h-11 shrink-0 items-center border-b border-line px-4">
        <Segmented value={tab} onChange={setTab} options={[{ value: "tasks", label: tx("Tasks") }, { value: "plan", label: tx("Auto-plan") }]} />
      </div>
      {children(tab)}
    </aside>
  );
}

/** The open tasks not on this week yet: dragged onto a day or an hour, they get it. */
function PlaceList({ tasks, total, ctx, sel, dragging, over, onOpen, grabProps }: {
  tasks: Task[];
  total: number;
  ctx: TaskContext;
  sel: string | null;
  dragging: number | null;
  /** A planned task is dragged over the list: dropped, it loses its day. */
  over: boolean;
  onOpen: (key: string) => void;
  grabProps: (t: Task) => { onPointerDown: (e: ReactPointerEvent) => void };
}) {
  const tx = useTranslation();
  const [q, setQ] = useState("");
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = words.length ? tasks.filter((t) => words.every((w) => `${t.key} ${t.title}`.toLowerCase().includes(w))) : tasks;
  return (
    <div data-drop="list" className={cx("flex min-h-0 flex-1 flex-col max-md:overflow-visible", over && "bg-sel")}>
      <div className="flex flex-col gap-2 px-4 pb-2 pt-3">
        <p className="text-[12px] leading-[1.45] text-mut2">
          {over ? tx("Drop it here to take it off its day.") : tx("Drag a task onto an hour to plan it then, or onto a day's top row to plan only the day.")}
        </p>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={tx("Filter tasks")} aria-label={tx("Filter tasks")}
          className="h-7 rounded-md border border-line bg-input px-2 text-[12.5px] text-fg outline-none placeholder:text-dim focus:border-ctl" />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-[3px] overflow-y-auto px-3 pb-4 max-md:overflow-visible">
        {shown.map((t) => {
          const agent = namedAgent(t);
          const late = t.plannedDate && !t.plannedTime;
          return (
            <div key={t.id} title={`${t.key} ${t.title}`} {...pressable(() => onOpen(t.key))} {...grabProps(t)}
              className={cx("flex h-8 shrink-0 cursor-grab items-center gap-2 rounded-md border px-2 text-[12.5px]",
                t.key === sel ? "border-ctl bg-sel text-strong" : "border-line text-fg2 hover:bg-hover", dragging === t.id && "opacity-40")}
              style={agent ? tint(agent, false) : undefined}>
              {agent ? <AgentIcon agent={agent} size={11} className="shrink-0" style={{ color: `var(--color-${agent})` }} />
                : <Dot color={taskColor(t, ctx.projects, ctx.areas)} size={7} />}
              <span className="shrink-0 font-mono text-[11px] text-mut2">{t.key}</span>
              <span className="min-w-0 flex-1 truncate">{t.title}</span>
              {late && <span className="shrink-0 text-[11px] text-danger" title={tx("Was planned for {0}", [fmtDay(t.plannedDate!, tx.language)])}>{tx.date(parseLocal(t.plannedDate!), "d MMM")}</span>}
              <span className="shrink-0 text-[11px] text-dim">{blockMinutes(t) >= 60 ? tx("{0} h", [hours(blockMinutes(t))]) : `${blockMinutes(t)}m`}</span>
            </div>
          );
        })}
        {!shown.length && <p className="px-1 py-2 text-[12px] text-mut2">{words.length ? tx("No task matches.") : tx("Every open task has its day.")}</p>}
        {!words.length && total > tasks.length && (
          <p className="px-1 py-2 text-[12px] text-mut2">{total - tasks.length} {" "}{tx("more, less urgent. Plan these first.")}</p>
        )}
      </div>
    </div>
  );
}

function workDaysText(days: number[], tx: Translator = createTranslator("en")) {
  const ds = [...days].sort((a, b) => a - b);
  if (!ds.length) return tx("on no days");
  const range = ds.length > 2 && ds.every((d, i) => i === 0 || d === ds[i - 1] + 1);
  return range ? tx("{0} to {1}", [DAY_NAMES(tx)[ds[0] - 1], DAY_NAMES(tx)[ds[ds.length - 1] - 1]]) : ds.map((d) => tx(DAY_NAMES(tx)[d - 1])).join(", ");
}

/** Short notes on what the planner did: checks it added, overdue work it placed, tasks it split. */
function planNotes(plan: WeekPlan, tasks: Task[], today: string, now: string, tx: Translator = createTranslator("en")) {
  const when = (stamp: string) => {
    const d = dateOnly(stamp);
    const day = d === today ? tx("today") : d === addDaysStr(today, 1) ? tx("tomorrow") : tx("on {0}", [tx.date(parseLocal(d), "EEE")]);
    return tx("{0} at {1}", [day, fmtTime(stamp)]);
  };
  const notes: { dot: string; text: string }[] = [];
  const count = new Map<string, number>();
  for (const b of plan.blocks as PlannedBlock[]) {
    if (b.kind === "check") {
      notes.push({ dot: "var(--color-accent)", text: tx("{0} finished, so {1} min to check it was added {2}", [b.key, minutes(b), when(b.start)]) });
      continue;
    }
    const n = (count.get(b.key) ?? 0) + 1;
    count.set(b.key, n);
    const t = tasks.find((x) => x.id === b.taskId);
    if (n === 1 && t?.dueDate && (timeOf(t.dueDate) ? t.dueDate < now : dateOnly(t.dueDate) < today)) {
      notes.push({ dot: "var(--color-danger)", text: tx("{0} is overdue, planned {1}", [b.key, when(b.start)]) });
    }
  }
  for (const [key, n] of count) if (n > 1) notes.push({ dot: "var(--color-dim)", text: tx("Split {0} into {1} blocks", [key, n]) });
  return notes.slice(0, 4);
}

function AutoPlan({ plan, on, onToggle, current, tasks, areas, rules, today, now, onOpen, onReplan }: {
  plan: WeekPlan | null;
  on: boolean;
  onToggle: (v: boolean) => void;
  current: boolean;
  tasks: Task[];
  areas: Area[];
  rules: WorkRules;
  today: string;
  now: string;
  onOpen: (key: string) => void;
  onReplan: () => void;
}) {
  const tx = useTranslation();
  const placed = new Set(plan?.blocks.map((b) => b.taskId));
  const byArea = new Map<string | null, number>();
  for (const b of plan?.blocks ?? []) byArea.set(b.areaId, (byArea.get(b.areaId) ?? 0) + minutes(b));
  const parts = [...byArea].sort((a, b) => b[1] - a[1]);
  const scale = Math.max(plan?.capacityMinutes ?? 0, plan?.plannedMinutes ?? 0, 1);
  const status = !plan ? tx("This week is over, so there is nothing left to plan.")
    : !on ? tx("Auto-plan is off. Only fixed events, your own blocks and agent sessions are shown.")
    : plan.blocks.length
      ? tx("Planned at {0} · {1} task{2} in {3} block{4}", [plan.at, placed.size, placed.size === 1 ? "" : "s", plan.blocks.length, plan.blocks.length === 1 ? "" : "s"])
      : tx("Planned at {0} · nothing to place this week", [plan.at]);
  const ruleList = [
    tx("Focus time {0}, {1} to {2}", [workDaysText(rules.workDays, tx), rules.workStart, rules.workEnd]),
    tx("Keep {0} to {1} free", [rules.lunchStart, rules.lunchEnd]),
    tx("Tasks you put at a time stay there"),
    tx("Deadlines first, then priority"),
    tx("Finished agent sessions get a check block"),
    tx("Tasks for Claude Code and Codex are left to them"),
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-[18px] overflow-y-auto px-5 py-3.5 max-md:overflow-visible max-md:pb-6">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2.5">
          <span className="flex-1 text-[12.5px] text-fg2">{tx("Show auto-planned blocks")}</span>
          <Switch on={on} onChange={onToggle} label={tx("Show auto-planned blocks")} />
        </div>
        <div className="text-[12px] text-mut2">{status}</div>
        {plan && on && planNotes(plan, tasks, today, now, tx).map((n, i) => (
          <div key={i} className="flex gap-2.5 text-[12.5px] leading-[1.45] text-fg3">
            <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: n.dot }} />
            <span>{n.text}</span>
          </div>
        ))}
      </div>

      {plan && (
        <div className="flex flex-col gap-2">
          <div className="flex items-baseline text-[12.5px]">
            <span className="flex-1 text-fg2">{current ? tx("Rest of this week") : tx("This week")}</span>
            <span className="text-mut2">{hours(plan.plannedMinutes)} {" "}{tx("of")}{" "}{hours(plan.capacityMinutes)} h</span>
          </div>
          <div className="flex h-1.5 gap-0.5 overflow-hidden rounded-[3px] bg-line">
            {parts.map(([id, m]) => (
              <span key={id ?? "none"} style={{ width: `${(m / scale) * 100}%`, background: areaColor(areas, id) }} />
            ))}
          </div>
          {parts.length > 0 && (
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11.5px] text-mut2">
              {parts.map(([id, m]) => <span key={id ?? "none"}>{areas.find((a) => a.id === id)?.name ?? tx("No area")} {hours(m)} h</span>)}
            </div>
          )}
        </div>
      )}

      {plan && plan.unplaced.length > 0 && (
        <div className="flex flex-col gap-2 rounded-lg border border-ink/5 bg-ink/5 p-3">
          <div className="text-[12.5px] font-medium text-fg2">{tx("Didn't fit this week")}</div>
          {plan.unplaced.map((u) => (
            <button key={u.taskId} type="button" onClick={() => onOpen(u.key)}
              className="text-left text-[12.5px] leading-[1.45] text-fg3 hover:text-strong">
              <span className="font-mono text-[11.5px] text-mut2">{u.key}</span> {u.title} {" "}{tx("needs")}{" "}{hours(u.minutes)} h
              {placed.has(u.taskId) ? tx(" more") : ""} {tx("and there's no free slot left this week.")}</button>
          ))}
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <div className="flex items-baseline text-[12.5px]">
          <span className="flex-1 text-fg2">{tx("Rules")}</span>
          <Link href="/settings/planning" className="text-[12px] text-mut2 hover:text-fg2">{tx("Change")}</Link>
        </div>
        {ruleList.map((r) => (
          <div key={r} className="flex gap-2 text-[12px] leading-[1.45] text-mut">
            <span className="text-faint">·</span>
            <span>{r}</span>
          </div>
        ))}
      </div>

      {plan && (
        <Button onClick={onReplan} className="justify-center">
          <Icon name="refresh" size={13} strokeWidth={2} />{tx("Replan the week")}</Button>
      )}
    </div>
  );
}
