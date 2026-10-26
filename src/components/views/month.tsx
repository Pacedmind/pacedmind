"use client";
import { useTranslation } from "@/components/language";
import { type Translator } from "@/lib/i18n";

import Link from "next/link";
import { useEffect, useOptimistic, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from "react";

import { deleteTaskAction, updateTaskAction } from "@/app/actions";
import { projectColor } from "@/lib/colors";
import { dateOnly, fmtDay, fmtTime, parseLocal, timeOf } from "@/lib/dates";
import type { EventOccurrence, Project, Task, TaskContext } from "@/lib/types";
import { openActivity } from "../activity-editor";
import { CalendarSourceLegend } from "../calendar-source";
import { calendarSource } from "@/lib/calendar-source";
import { Diamond, Icon, StatusIcon } from "../icons";
import { DatePicker } from "../date-picker";
import { Popover, PopoverItem, PopoverSeparator, anchorOf, type Anchor } from "../popover";
import { TaskDetail } from "../task-detail";
import { openAdd } from "../task-list";
import { Dot, cx, useAction } from "../ui";
import { AddButton, PeriodNav, ViewHeader, ViewSwitch, areaColor, isOpenTask, useAddOnClick, useSelection } from "./calendar-parts";

const DRAG_TYPE = "application/x-organizer-task";
const WEEKDAYS = (tx: Translator) => ([tx("Mon"), tx("Tue"), tx("Wed"), tx("Thu"), tx("Fri"), tx("Sat"), tx("Sun")]);
const MAX_ITEMS = 3;

type Filter = "due" | "event" | "plan" | "target";

const FILTERS = (tx: Translator): { value: Filter; label: string }[] => ([
  { value: "due", label: tx("Deadlines") },
  { value: "event", label: tx("Activities") },
  { value: "plan", label: tx("Planned") },
  { value: "target", label: tx("Project targets") },
]);

type Item = { filter: Filter; sort: string } & (
  | { kind: "due" | "plan" | "done"; task: Task; time: string | null; overdue: boolean }
  | { kind: "event"; event: EventOccurrence; past: boolean }
  | { kind: "target"; project: Project }
);

/** Which of a task's dates a chip stands for: its deadline, its planned day, or none (the "No date" list). */
type DateKind = "due" | "plan" | "none";
type Chip = { task: Task; kind: DateKind | "done" };
type DatePatch = { dueDate?: string | null; plannedDate?: string | null };

const KIND_ORDER = { due: 0, target: 1, plan: 2, event: 3, done: 4 } as const;

/** Everything with a date, grouped by day in display order. Done tasks sit on their due (or planned) day. */
function itemsByDay(tasks: Task[], events: EventOccurrence[], projects: Project[], today: string, now: string) {
  const map = new Map<string, Item[]>();
  const add = (day: string, item: Item) => {
    const list = map.get(day);
    if (list) list.push(item);
    else map.set(day, [item]);
  };
  for (const t of tasks) {
    if (t.status === "canceled") continue;
    const due = t.dueDate ? dateOnly(t.dueDate) : null;
    if (t.status === "done") {
      const day = due ?? t.plannedDate;
      if (day) add(day, { kind: "done", filter: due ? "due" : "plan", task: t, time: null, overdue: false, sort: t.key });
      continue;
    }
    if (t.dueDate && due) {
      const time = timeOf(t.dueDate);
      add(due, { kind: "due", filter: "due", task: t, time, overdue: time ? t.dueDate < now : due < today, sort: `${time ?? "24:00"}|${t.priority || 5}` });
    }
    if (t.plannedDate && t.plannedDate !== due) {
      add(t.plannedDate, { kind: "plan", filter: "plan", task: t, time: null, overdue: false, sort: String(t.priority || 5) });
    }
  }
  for (const p of projects) if (p.targetDate) add(p.targetDate, { kind: "target", filter: "target", project: p, sort: p.name });
  for (const e of events) add(dateOnly(e.start), { kind: "event", filter: "event", event: e, past: e.end <= now, sort: e.start });
  for (const list of map.values()) list.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.sort.localeCompare(b.sort));
  return map;
}

/** A planned day on the deadline's day shows as the deadline alone, so it moves and goes with it. */
const sharesDueDay = (t: Task) => !!t.plannedDate && !!t.dueDate && t.plannedDate === dateOnly(t.dueDate);

/**
 * The dates to save when a chip goes to `day`: the chip's own date moves, so the task never shows up twice.
 * A deadline keeps its time unless `time` is given. Dropped on the deadline flag, a chip becomes the deadline.
 */
function movePatch(t: Task, kind: DateKind, day: string, asDeadline: boolean, time?: string | null): DatePatch {
  if (kind !== "due" && !asDeadline) return { plannedDate: day };
  const keep = time === undefined ? timeOf(t.dueDate) : time;
  const dueDate = keep ? `${day}T${keep}` : day;
  return kind === "plan" || (kind === "due" && sharesDueDay(t)) ? { dueDate, plannedDate: day } : { dueDate };
}

function clearPatch(t: Task, kind: "due" | "plan"): DatePatch {
  if (kind === "plan") return { plannedDate: null };
  return sharesDueDay(t) ? { dueDate: null, plannedDate: null } : { dueDate: null };
}

/** True when a drag event happens over the "set as deadline" flag inside a day. */
function onFlag(e: DragEvent) {
  const node = e.target as Node;
  return !!(node instanceof Element ? node : node.parentElement)?.closest("[data-flag]");
}

export function MonthView({
  title, month, days, now, tasks, undated, undatedCount, events, ctx, summary, nav, initialKey,
}: {
  title: string;
  /** "YYYY-MM" */
  month: string;
  /** Every day in the grid, Monday first, whole weeks. */
  days: string[];
  now: string;
  /** Tasks with a due or planned date inside the grid. */
  tasks: Task[];
  undated: Task[];
  undatedCount: number;
  events: EventOccurrence[];
  ctx: TaskContext;
  summary: { text: string; danger?: boolean };
  nav: { prev: string; next: string; month: string; week: string };
  initialKey: string | null;
}) {
  const tx = useTranslation();
  const today = now.slice(0, 10);
  const weeks = days.length / 7;
  const { run } = useAction();
  const addOnClick = useAddOnClick();
  const [sel, setSel] = useSelection(initialKey);
  // A null patch means the task was deleted.
  const [all, patchTask] = useOptimistic([...tasks, ...undated], (state, p: { id: number; patch: DatePatch | null }) =>
    p.patch ? state.map((t) => (t.id === p.id ? { ...t, ...p.patch } : t)) : state.filter((t) => t.id !== p.id));
  const [show, setShow] = useState<Record<Filter, boolean>>({ due: true, event: true, plan: true, target: true });
  const [drag, setDrag] = useState<{ key: string; kind: DateKind } | null>(null);
  const [over, setOver] = useState<{ day: string; flag: boolean } | null>(null);
  const [overClear, setOverClear] = useState(false);
  const [menu, setMenu] = useState<{ chip: Chip; anchor: Anchor } | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [rows, setRows] = useState(MAX_ITEMS + 1);
  const gridRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  // How many 25px lines (an item or the "+N more" button) fit under the day number of one cell.
  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setRows(Math.max(1, Math.floor((entry.contentRect.height / weeks - 37) / 25))));
    ro.observe(el);
    return () => ro.disconnect();
  }, [weeks]);

  useEffect(() => {
    if (!expanded) return;
    const onDown = (e: globalThis.MouseEvent) => {
      // A task's menu opens over the day; picking from it shouldn't close the day behind it.
      if (!popRef.current?.contains(e.target as Node) && !(e.target as Element).closest?.("[role=menu]")) setExpanded(null);
    };
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") setExpanded(null); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [expanded]);

  const selected = all.find((t) => t.key === sel) ?? null;
  const byDay = itemsByDay(all.filter((t) => t.dueDate || t.plannedDate), events, ctx.projects, today, now);
  const noDate = all.filter((t) => !t.dueDate && !t.plannedDate && isOpenTask(t));
  const undatedLeft = undatedCount - (undated.length - noDate.length);
  const dragDated = !!drag && drag.kind !== "none";
  // Closed while every open task has a date. Dragging a dated task opens it, to drop the task there and remove its date.
  const panelOpen = dragDated || (!selected && undatedLeft > 0);

  const save = (t: Task, patch: DatePatch, message: string) => {
    if (Object.entries(patch).every(([k, v]) => t[k as keyof DatePatch] === v)) return;
    run(() => {
      patchTask({ id: t.id, patch });
      return updateTaskAction(t.id, patch);
    }, message);
  };

  const moveTo = (t: Task, kind: DateKind, day: string, asDeadline = false, time?: string | null) => {
    const patch = movePatch(t, kind, day, asDeadline, time);
    save(t, patch, patch.dueDate ? tx("{0} is now due {1}", [t.key, fmtDay(day, tx.language)]) : tx("Planned {0} for {1}", [t.key, fmtDay(day, tx.language)]));
  };

  const clearDate = (t: Task, kind: DateKind) => {
    if (kind === "none") return;
    const patch = clearPatch(t, kind);
    const left = { ...t, ...patch };
    save(t, patch, !left.dueDate && !left.plannedDate ? tx("{0} has no date now", [t.key])
      : kind === "due" ? tx("Removed the due date of {0}", [t.key]) : tx("Removed the planned date of {0}", [t.key]));
  };

  const remove = (t: Task) => {
    if (sel === t.key) setSel(null);
    run(() => {
      patchTask({ id: t.id, patch: null });
      return deleteTaskAction(t.id);
    }, tx("Deleted {0}", [t.key]));
  };

  const openMenu = (el: Element, chip: Chip) => setMenu({ chip, anchor: anchorOf(el) });
  const menuOn = (t: Task, kind: Chip["kind"]) => menu?.chip.task.id === t.id && menu.chip.kind === kind;

  /** A click (or Enter) on a task opens its menu. */
  const menuPress = (chip: Chip) => ({
    role: "button" as const,
    tabIndex: 0,
    "aria-haspopup": "menu" as const,
    onClick: (e: MouseEvent<HTMLElement>) => openMenu(e.currentTarget, chip),
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      openMenu(e.currentTarget, chip);
    },
  });

  const dragSource = (task: Task, kind: DateKind) => ({
    draggable: true,
    onDragStart: (e: DragEvent) => {
      e.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ key: task.key, kind }));
      e.dataTransfer.setData("text/plain", `${task.key} ${task.title}`);
      e.dataTransfer.effectAllowed = "move";
      setMenu(null);
      // Restyling the dragged element inside dragstart can cancel the drag in Chromium.
      setTimeout(() => setDrag({ key: task.key, kind }), 0);
    },
    onDragEnd: () => {
      setDrag(null);
      setOver(null);
      setOverClear(false);
    },
  });

  /** The task a drop carries, and which of its dates it was dragged by. */
  const dropped = (e: DragEvent) => {
    try {
      const d = JSON.parse(e.dataTransfer.getData(DRAG_TYPE)) as { key: string; kind: DateKind };
      const task = all.find((t) => t.key === d.key);
      return task ? { task, kind: d.kind } : null;
    } catch {
      return null;
    }
  };

  const dropTarget = (day: string) => ({
    onDragOver: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const flag = onFlag(e);
      setOver((o) => (o?.day === day && o.flag === flag ? o : { day, flag }));
    },
    onDragLeave: (e: DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver((o) => (o?.day === day ? null : o));
    },
    onDrop: (e: DragEvent) => {
      const d = dropped(e);
      if (!d) return;
      e.preventDefault();
      setOver(null);
      setDrag(null);
      moveTo(d.task, d.kind, day, onFlag(e));
    },
  });

  // The "No date" panel takes a dated task and removes the date it was dragged by.
  const clearTarget = {
    onDragOver: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes(DRAG_TYPE) || drag?.kind === "none") return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setOverClear(true);
    },
    onDragLeave: (e: DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOverClear(false);
    },
    onDrop: (e: DragEvent) => {
      const d = dropped(e);
      if (!d) return;
      e.preventDefault();
      setOverClear(false);
      setDrag(null);
      clearDate(d.task, d.kind);
    },
  };

  const renderItem = (it: Item) => {
    const pill = "flex h-[22px] w-full min-w-0 shrink-0 items-center gap-[5px] overflow-hidden whitespace-nowrap rounded-[5px] border px-1.5 text-left text-[11.5px]";
    if (it.kind === "event") {
      const e = it.event;
      return (
        <button key={`e${e.eventId}-${e.start}`} type="button" title={`${fmtTime(e.start)}–${fmtTime(e.end)} ${e.title} · ${calendarSource(e.calendar).label}`} onClick={() => openActivity(e)}
          className={cx(pill, "border-transparent hover:bg-hover", it.past ? "text-mut2" : "text-fg3")}>
          <Dot color={e.calendar?.source ? calendarSource(e.calendar).color : areaColor(ctx.areas, e.areaId)} size={6} />
          <span className="shrink-0 font-mono text-[10.5px] text-mut2">{fmtTime(e.start)}</span>
          <span className="min-w-0 flex-1 truncate">{e.title}</span>
        </button>
      );
    }
    if (it.kind === "target") {
      const p = it.project;
      return (
        <Link key={`p${p.id}`} href={`/project/${p.id}`} title={tx("{0} target date", [p.name])} className={cx(pill, "border-line2 bg-hover text-fg2 hover:bg-sel")}>
          <Diamond color={projectColor(p, ctx.areas)} size={10} />
          <span className="truncate">{p.name}</span>
        </Link>
      );
    }
    const t = it.task;
    const tone = it.kind === "done" ? "border-transparent text-mut2 hover:bg-hover"
      : it.kind === "plan" ? "border-line2 bg-hover text-fg3 hover:bg-sel"
      : it.overdue ? "border-ink/5 bg-ink/5 text-danger hover:bg-ink/[0.08]"
      : dateOnly(t.dueDate ?? "") === today ? "border-ink/5 bg-ink/5 text-fg2 hover:bg-ink/[0.08]"
      : "border-line2 bg-hover text-fg3 hover:bg-sel";
    return (
      <div key={`${it.kind}${t.id}`} title={`${t.key} ${t.title}`} {...menuPress({ task: t, kind: it.kind })} {...(it.kind === "done" ? {} : dragSource(t, it.kind))}
        className={cx(pill, tone, "cursor-pointer", (t.key === sel || menuOn(t, it.kind)) && "ring-1 ring-accent/70",
          drag?.key === t.key && drag.kind === it.kind && "opacity-40")}>
        <Icon name={it.kind === "done" ? "check" : it.kind === "plan" ? "calendarCheck" : "flag"} size={11} strokeWidth={it.kind === "done" ? 2.4 : 2.2} className="shrink-0" />
        {it.time && <span className="shrink-0 font-mono text-[10.5px] text-mut2">{it.time}</span>}
        <span className={cx("truncate", it.kind === "done" && "line-through")}>{t.title}</span>
      </div>
    );
  };

  return (
    <div className="flex min-w-0 flex-1">
      <section aria-label={tx("Calendar")} className="flex min-w-0 flex-1 flex-col">
        {/* On a phone the month's name is short, so it fits beside the buttons. */}
        <ViewHeader icon="calendar" title={tx("Calendar")} phoneSubtitleOnly subtitle={<>
          <span className="max-sm:hidden">{title}</span>
          <span className="sm:hidden">{tx.date(parseLocal(`${month}-01`), "MMM yyyy")}</span>
        </>}>
          <PeriodNav unit="month" prev={nav.prev} next={nav.next} today="/calendar" />
          <span className="flex-1" />
          <ViewSwitch value="month" month={nav.month} week={nav.week} />
        </ViewHeader>
        <CalendarSourceLegend events={events} />

        <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-line px-5 text-[12px] max-md:overflow-x-auto max-md:px-3">
          {FILTERS(tx).map((f) => (
            <button key={f.value} type="button" aria-pressed={show[f.value]} onClick={() => setShow((s) => ({ ...s, [f.value]: !s[f.value] }))}
              className={cx("flex h-[26px] shrink-0 items-center gap-1.5 rounded-[13px] border px-[9px] hover:bg-hover", show[f.value] ? "border-ctl text-fg2" : "border-line text-dim")}>
              <span className={cx("flex items-center", !show[f.value] && "opacity-50")}>
                {f.value === "due" && <Icon name="flag" size={12} strokeWidth={2.2} />}
                {f.value === "event" && <span className="h-[7px] w-[7px] rounded-full bg-mut" />}
                {f.value === "plan" && <Icon name="calendarCheck" size={12} strokeWidth={2.2} className="text-mut" />}
                {f.value === "target" && <Diamond color="var(--color-mut)" size={12} />}
              </span>
              {f.label}
            </button>
          ))}
          <span className="flex-1" />
          <span className={cx("shrink-0 max-sm:hidden", summary.danger ? "text-danger" : "text-mut2")}>{summary.text}</span>
        </div>

        <div className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="grid h-8 shrink-0 grid-cols-7 border-b border-line">
              {WEEKDAYS(tx).map((w) => <div key={w} className="flex items-center px-3 text-[11.5px] text-mut2">{w}</div>)}
            </div>
            <div ref={gridRef} className={cx("grid min-h-0 flex-1 grid-cols-7", weeks === 6 ? "grid-rows-6" : "grid-rows-5")}>
              {days.map((day, i) => {
                const items = (byDay.get(day) ?? []).filter((it) => show[it.filter]);
                const visible = items.length <= Math.min(rows, MAX_ITEMS) ? items : items.slice(0, Math.max(0, Math.min(rows - 1, MAX_ITEMS)));
                const hidden = items.length - visible.length;
                const out = !day.startsWith(month);
                const isToday = day === today;
                const isOver = over?.day === day;
                const row = Math.floor(i / 7);
                const col = i % 7;
                // A click on the day's empty space, or its "+", adds a task planned for it.
                return (
                  <div key={day} role="group" aria-label={tx.date(parseLocal(day), "EEEE d MMMM")} {...dropTarget(day)}
                    {...addOnClick(() => ({ plannedDate: day }))}
                    className={cx("group/day relative flex min-h-0 min-w-0 flex-col gap-[3px] border-b border-line p-1.5",
                      col < 6 && "border-r", expanded === day ? "z-20" : "overflow-hidden",
                      isOver ? "bg-accent/[0.07] ring-1 ring-inset ring-accent/55" : isToday ? "bg-raised" : out && "bg-input")}>
                    <div className="flex h-6 shrink-0 items-center gap-1 px-0.5">
                      <Link href={`/calendar/week?w=${day}`} title={tx("Open this week")}
                        className={cx("inline-flex h-[22px] min-w-[22px] items-center justify-center rounded-full px-1.5 text-[12px]",
                          isToday ? "bg-accent font-semibold text-bg" : cx("font-medium hover:bg-hover", out ? "text-faint" : day < today ? "text-mut2" : "text-fg2"))}>
                        {day.endsWith("-01") ? tx.date(parseLocal(day), "d MMM") : Number(day.slice(8))}
                      </Link>
                      {/* A deadline moves wherever it's dropped; anything else can become one here. */}
                      {isOver && drag && drag.kind !== "due" && (
                        <span data-flag title={tx("Drop here to make it the due date")}
                          className={cx("ml-auto flex h-5 items-center gap-1 rounded-[5px] border px-1.5 text-[11px]",
                            over.flag ? "border-accent/60 bg-accent/15 text-accent-fg" : "border-line2 bg-panel text-mut")}>
                          <Icon name="flag" size={10} strokeWidth={2.4} />{tx("Due")}</span>
                      )}
                      {!drag && <AddButton label={fmtDay(day, tx.language)} onAdd={() => openAdd({ plannedDate: day })} className="ml-auto max-md:hidden" />}
                    </div>
                    {visible.map(renderItem)}
                    {hidden > 0 && (
                      <button type="button" onClick={() => setExpanded(day)}
                        className="h-5 shrink-0 rounded-[5px] px-1.5 text-left text-[11.5px] text-mut2 hover:bg-hover">
                        +{hidden} {tx("more")}</button>
                    )}
                    {expanded === day && (
                      <div ref={popRef} role="dialog" aria-label={tx.date(parseLocal(day), "EEEE d MMMM")}
                        className={cx("absolute z-30 flex max-h-[320px] w-[calc(100%+2px)] min-w-[240px] flex-col gap-[3px] overflow-y-auto rounded-lg border border-line2 bg-raised p-1.5 shadow-[var(--shadow-popover)]",
                          row >= weeks / 2 ? "-bottom-px" : "-top-px", col === 6 ? "-right-px" : "-left-px")}>
                        <div className="flex h-6 shrink-0 items-center gap-0.5 px-1 text-[12px] font-medium text-fg2">
                          <span className="flex-1">{tx.date(parseLocal(day), "EEE d MMM")}</span>
                          <AddButton label={fmtDay(day, tx.language)} shown onAdd={() => { setExpanded(null); openAdd({ plannedDate: day }); }} />
                          <button type="button" aria-label={tx("Close")} onClick={() => setExpanded(null)}
                            className="flex h-5 w-5 items-center justify-center rounded text-mut2 hover:bg-hover">
                            <Icon name="x" size={12} />
                          </button>
                        </div>
                        {items.map(renderItem)}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Dragging tasks onto days needs a mouse: on a phone the month gets the whole width. */}
          {(!selected || dragDated) && (
            <aside aria-label={tx("Tasks without a date")} inert={!panelOpen} {...clearTarget}
              className={cx("shrink-0 overflow-hidden transition-[width] duration-200 ease-out motion-reduce:transition-none max-md:hidden",
                panelOpen ? "w-[280px] border-l border-line" : "w-0")}>
              <div className={cx("flex h-full w-[280px] flex-col", overClear && "bg-accent/[0.04]")}>
                <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-4">
                  <h2 className="text-[12.5px] font-medium text-fg2">{tx("No date")}</h2>
                  {undatedLeft > 0 && <span className="text-[12px] text-mut2">{undatedLeft}</span>}
                </div>
                {dragDated ? (
                  <div className={cx("mx-2.5 mb-1 mt-3 flex h-16 shrink-0 items-center justify-center gap-2 rounded-lg border border-dashed text-[12.5px]",
                    overClear ? "border-accent/60 bg-accent/[0.07] text-accent-fg" : "border-ctl text-mut")}>
                    <Icon name="x" size={13} strokeWidth={2} />{tx("Drop here to remove the date")}</div>
                ) : (
                  <p className="px-4 pb-2 pt-3 text-[12px] leading-normal text-mut2">
                    {tx("Drag a task onto a day to plan it. Drop it on the deadline flag to set a due date instead.")}</p>
                )}
                <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-2.5 pb-3 pt-1">
                  {noDate.map((t) => (
                    <div key={t.id} title={`${t.key} ${t.title}`} {...menuPress({ task: t, kind: "none" })} {...dragSource(t, "none")}
                      className={cx("flex h-[34px] shrink-0 cursor-grab items-center gap-2 rounded-md border px-2 active:cursor-grabbing",
                        drag?.key === t.key ? "border-dashed border-ctl text-dim" : menuOn(t, "none") ? "border-ctl bg-hover text-fg2" : "border-line text-fg2 hover:bg-hover")}>
                      <Grip />
                      <StatusIcon status={t.status} />
                      <span className="min-w-0 flex-1 truncate text-[12.5px]">{t.title}</span>
                      {t.areaId && <Dot color={areaColor(ctx.areas, t.areaId)} size={7} />}
                    </div>
                  ))}
                  {undatedCount > undated.length && (
                    <div className="px-1.5 py-1 text-[12px] text-mut2">{tx("and")}{" "}{undatedCount - undated.length} {" "}{tx("more")}</div>
                  )}
                </div>
              </div>
            </aside>
          )}
        </div>
      </section>
      {selected && <TaskDetail key={`${selected.id}-${selected.updatedAt}`} task={selected} ctx={ctx} onClose={() => setSel(null)} />}
      {menu && (
        <TaskMenu key={`${menu.chip.task.id}-${menu.chip.kind}`} chip={menu.chip} anchor={menu.anchor} onClose={() => setMenu(null)}
          onOpen={() => { setSel(menu.chip.task.key); setMenu(null); }}
          onDate={(v) => {
            const { task: t, kind } = menu.chip;
            if (kind !== "done") moveTo(t, kind, dateOnly(v), false, kind === "due" ? timeOf(v) : undefined);
            setMenu(null);
          }}
          onClear={() => { if (menu.chip.kind !== "done") clearDate(menu.chip.task, menu.chip.kind); setMenu(null); }}
          onDelete={() => { remove(menu.chip.task); setMenu(null); }} />
      )}
    </div>
  );
}

/** What a click on a task in the calendar offers: open it, move or remove the date it shows, or delete it. */
function TaskMenu({ chip, anchor, onClose, onOpen, onDate, onClear, onDelete }: {
  chip: Chip;
  anchor: Anchor;
  onClose: () => void;
  onOpen: () => void;
  /** "YYYY-MM-DD", or with a time for a deadline. */
  onDate: (value: string) => void;
  onClear: () => void;
  onDelete: () => void;
}) {
  const tx = useTranslation();
  const { task: t, kind } = chip;
  const value = kind === "due" ? t.dueDate : kind === "plan" ? t.plannedDate : null;
  const withTime = kind === "due";
  const [picking, setPicking] = useState(false);
  // A deadline's new day and time, until Done moves the task.
  const [draft, setDraft] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  return (
    <Popover anchor={anchor} onClose={onClose} width={288}>
      <div className="flex min-w-0 items-baseline gap-2 px-2 pb-1.5 pt-1">
        <span className="shrink-0 font-mono text-[11px] text-mut2">{t.key}</span>
        <span className="truncate text-[12px] text-fg2">{t.title}</span>
      </div>
      <PopoverItem icon={<Icon name="arrowRight" size={13} />} onClick={onOpen}>{tx("Open task")}</PopoverItem>
      {kind !== "done" && (
        <PopoverItem icon={<Icon name="calendar" size={13} />} onClick={() => setPicking((p) => !p)}>
          {kind === "none" ? tx("Plan for a day") : tx("Change date")}
        </PopoverItem>
      )}
      {picking && (
        <div className="mx-1 mb-1 rounded-md border border-line2 bg-panel p-1.5">
          <DatePicker value={draft ?? value} withTime={withTime}
            onChange={(v, done) => (!done ? setDraft(v) : v === value ? onClose() : onDate(v))}
            onDone={() => (draft && draft !== value ? onDate(draft) : onClose())} />
        </div>
      )}
      {(kind === "due" || kind === "plan") && (
        <PopoverItem icon={<Icon name="x" size={13} />} onClick={onClear}>{kind === "due" ? tx("Remove due date") : tx("Remove planned date")}</PopoverItem>
      )}
      <PopoverSeparator />
      <PopoverItem danger icon={<Icon name="trash" size={13} />} onClick={() => (confirming ? onDelete() : setConfirming(true))}>
        {confirming ? tx("Delete {0}? Click again", [t.key]) : tx("Delete task")}
      </PopoverItem>
    </Popover>
  );
}

function Grip() {
  return (
    <svg width="10" height="14" viewBox="0 0 10 14" aria-hidden="true" className="shrink-0">
      {[3, 7, 11].flatMap((y) => [3, 7].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.1" fill="var(--color-faint)" />))}
    </svg>
  );
}
