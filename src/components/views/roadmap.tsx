"use client";
import { useTranslation } from "@/components/language";
import { createTranslator, type Translator } from "@/lib/i18n";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useEffect, useLayoutEffect, useOptimistic, useRef, useState, type ReactNode } from "react";

import { linkFoundFolderAction, setCodexEnvAction, updateProjectAction } from "@/app/actions";
import { reorderTasksAction, setNextProjectAction } from "@/app/(app)/roadmap/actions";
import { projectColor } from "@/lib/colors";
import { addDaysStr, dateOnly, dayDiff, fmtDay, fmtShort, parseLocal } from "@/lib/dates";
import { AGENT_LABEL, type AgentId, type Area, type Project, type Session, type Task, type TaskContext } from "@/lib/types";
import type { ProjectStats, StateTone, TaskState } from "@/server/timeline";
import { AreaMark, Diamond, Icon, StatusIcon } from "@/components/icons";
import { TaskDetail } from "@/components/task-detail";
import { useExecution } from "@/components/execution-context";
import { FolderField } from "@/components/folder-field";
import { useQuickAddProject } from "@/components/quick-add";
import { openAdd } from "@/components/task-list";
import { Button, Dot, Menu, cx, useAction } from "@/components/ui";
import { dayPos, tint, useWidth } from "./timeline";

export interface RoadmapItem {
  task: Task;
  /** Keys of the tasks this one waits for. */
  after: string[];
  state: TaskState;
  session: Session | null;
}

const LEFT = 220;
const ROW = 40;
const HEAD = 32;
const AGENT_SHORT: Record<AgentId, string> = { claude: "Claude", codex: "Codex" };
const AGENT_DOT: Record<AgentId, string> = { claude: "var(--color-mut)", codex: "var(--color-fg3)" };
const TONE: Record<StateTone, string> = {
  done: "text-mut2", waiting: "text-fg2", running: "text-fg3", active: "text-fg3", next: "text-mut", queued: "text-mut2", idle: "text-mut2",
};
const EMPTY: ProjectStats = { done: 0, total: 0, started: false };
const pv = "flex h-7 max-w-full items-center gap-2 rounded-md px-2 text-left text-fg2 hover:bg-hover";
const NOW_LINE = "color-mix(in srgb, var(--color-accent) 70%, transparent)";

/** Each project's bar: its days from `from` (the end is exclusive), whether it waits to start, and what it says. */
function barsOf(from: string, days: number, today: string, projects: Project[], stats: Record<string, ProjectStats>, colorOf: (p: Project) => string, tx: Translator = createTranslator("en")) {
  const byId = new Map(projects.map((p) => [p.id, p]));
  return projects.map((p, i) => {
    const st = stats[p.id] ?? EMPTY;
    let s = p.startDate ? dayDiff(from, p.startDate) : null;
    let e = p.targetDate ? dayDiff(from, p.targetDate) + 1 : null;
    if (s === null && e !== null) s = Math.min(e - 1, dayDiff(from, today));
    if (e === null && s !== null) e = Math.max(s + 1, days);
    const waiting = !st.started && !!p.startDate && p.startDate > today;
    const after = p.afterProjectId ? byId.get(p.afterProjectId) : undefined;
    const label = waiting
      ? after ? tx("Starts after {0}", [after.name]) : tx("Starts {0}", [fmtShort(p.startDate!, tx.language)])
      : st.total ? tx("{0} of {1} {2}", [st.done, st.total, tx.count(st.total, "task").replace(/^\d+ /, "")]) : tx("No tasks yet");
    return { p, i, s, e, waiting, after, label, pct: st.total ? (st.done / st.total) * 100 : 0, color: colorOf(p) };
  });
}

function AgentChip({ agent }: { agent: AgentId }) {
  return (
    <span className="inline-flex h-[18px] shrink-0 items-center gap-[5px] rounded-full border border-line2 px-[7px] text-[11px] text-mut">
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: AGENT_DOT[agent] }} />
      {AGENT_SHORT[agent]}
    </span>
  );
}

/* ---------- project timeline ---------- */

function ProjectTimeline({ from, days, now, projects, colorOf, markOf, stats, selectedId }: {
  from: string; days: number; now: string; projects: Project[]; colorOf: (p: Project) => string;
  markOf: (p: Project) => ReactNode;
  stats: Record<string, ProjectStats>; selectedId: string | null;
}) {
  const tx = useTranslation();
  const [ref, width] = useWidth<HTMLDivElement>(LEFT + 950);
  const dayW = Math.max(5, (width - LEFT) / days);
  const X = (d: number) => Math.round(d * dayW);
  const clampX = (d: number) => X(Math.max(0, Math.min(days, d)));
  const gridW = X(days);
  const today = dateOnly(now);
  const nowPos = dayPos(from, now);

  const lines: { x: number; strong: boolean }[] = [];
  const months: { x: number; label: string }[] = [];
  for (let i = 1; i < days; i++) {
    const d = parseLocal(addDaysStr(from, i));
    if (d.getDate() === 1) {
      lines.push({ x: X(i), strong: true });
      months.push({ x: X(i), label: tx.date(d, "MMMM") });
    } else if (i % 7 === 0) {
      lines.push({ x: X(i), strong: false });
    }
  }
  if (!months.length || months[0].x > 90) months.unshift({ x: 0, label: tx.date(parseLocal(from), "MMMM") });

  const bars = barsOf(from, days, today, projects, stats, colorOf, tx);
  // Where today's date sits over the months, kept inside the grid.
  const pill = nowPos >= 0 && nowPos <= days ? Math.min(Math.max(X(nowPos), 26), gridW - 26) : null;

  // A project that starts after another one: an arrow from the end of the first to the start of the second.
  const deps = bars.flatMap((b) => {
    const a = b.p.afterProjectId ? bars.find((x) => x.p.id === b.p.afterProjectId) : undefined;
    if (!a || a.e === null || b.s === null) return [];
    const x1 = X(a.e) + (a.p.targetDate ? 7 : 1);
    const y1 = a.i * ROW + ROW / 2;
    const x2 = X(b.s);
    const y2 = b.i * ROW + ROW / 2;
    const ym = y2 > y1 ? y2 - ROW / 2 : y2 + ROW / 2;
    const d = x2 - x1 >= 18 ? `M${x1} ${y1} H${x1 + 11} V${y2} H${x2 - 5}` : `M${x1} ${y1} H${x1 + 7} V${ym} H${x2 - 12} V${y2} H${x2 - 5}`;
    return [{ id: b.p.id, d, head: `M${x2 - 6} ${y2 - 4} L${x2 + 1} ${y2} L${x2 - 6} ${y2 + 4} Z` }];
  });

  const height = projects.length * ROW;
  return (
    <div ref={ref} className="max-h-[44vh] shrink-0 overflow-auto border-b border-line max-md:hidden">
      <div style={{ width: LEFT + gridW }}>
        <div className="sticky top-0 z-20 flex border-b border-line bg-panel" style={{ height: HEAD }}>
          <div className="sticky left-0 z-10 flex shrink-0 items-center border-r border-line bg-panel px-5 text-[11.5px] text-mut2" style={{ width: LEFT }}>
            {tx("Projects")}</div>
          <div className="relative shrink-0 overflow-hidden" style={{ width: gridW }}>
            {months.map((m) => {
              // Today's date covers the name of a month that starts next to it: one that starts under it or after it is
              // named just after it, and one that started before it is named by it already.
              const under = pill !== null && m.x + 72 > pill - 30 && m.x < pill + 30;
              if (under && m.x <= pill) return null;
              return (
                <span key={m.x} className="absolute top-[9px] whitespace-nowrap pl-1.5 text-[11.5px] text-mut" style={{ left: under ? pill + 30 : m.x }}>
                  {m.label}
                </span>
              );
            })}
            {pill !== null && (
              <span className="absolute top-[7px] flex h-[18px] -translate-x-1/2 items-center whitespace-nowrap rounded bg-accent-strong px-1.5 text-[11px] font-medium text-white"
                style={{ left: pill }}>
                {fmtShort(today, tx.language)}
              </span>
            )}
          </div>
        </div>

        <div className="relative" style={{ height }}>
          <svg width={gridW} height={height} className="pointer-events-none absolute top-0" style={{ left: LEFT }} aria-hidden="true">
            {lines.map((l) => <line key={l.x} x1={l.x + 0.5} x2={l.x + 0.5} y1={0} y2={height} stroke={l.strong ? "var(--color-line2)" : "var(--color-hover)"} />)}
          </svg>
          {bars.map(({ p, s, e, waiting, label, pct, color }) => {
            const selected = p.id === selectedId;
            const visible = s !== null && e !== null && e > 0 && s < days;
            const left = s === null ? 0 : clampX(s);
            const barW = e === null ? 0 : Math.max(8, clampX(e) - left);
            const inside = barW >= label.length * 6.2 + 16;
            const target = p.targetDate && e !== null && e >= 0 && e <= days ? X(e) : null;
            const outLeft = left + barW + (target !== null ? 14 : 8);
            return (
              <Link key={p.id} href={`/roadmap?p=${encodeURIComponent(p.id)}`} scroll={false} aria-current={selected ? "true" : undefined}
                className={cx("group flex border-b border-hover", selected ? "bg-sel" : "hover:bg-hover")} style={{ height: ROW }}>
                <div className={cx("sticky left-0 z-10 flex shrink-0 items-center gap-[9px] border-r border-line pl-5 pr-3", selected ? "bg-sel" : "bg-panel group-hover:bg-hover")}
                  style={{ width: LEFT }}>
                  {markOf(p)}
                  <span className="min-w-0 flex-1 truncate text-fg">{p.name}</span>
                  {p.agent && <AgentChip agent={p.agent} />}
                </div>
                <div className="relative shrink-0 overflow-hidden" style={{ width: gridW }}>
                  {visible && (
                    <div className="absolute overflow-hidden rounded-[5px]"
                      style={{ top: 9, height: 22, left, width: barW, background: waiting ? "transparent" : tint(color, 14), border: `1px ${waiting ? "dashed" : "solid"} ${tint(color, waiting ? 45 : 36)}` }}>
                      {!waiting && <div className="absolute inset-y-0 left-0" style={{ width: `${pct}%`, background: tint(color, 40) }} />}
                      {inside && (
                        <span className={cx("absolute left-2 top-[2px] whitespace-nowrap text-[11.5px] leading-4", waiting ? "text-mut2" : "text-fg")}>{label}</span>
                      )}
                    </div>
                  )}
                  {visible && !inside && (
                    <span className="absolute top-3 whitespace-nowrap text-[11.5px] leading-4 text-mut2"
                      style={outLeft + label.length * 6.2 <= gridW ? { left: outLeft } : { right: gridW - left + 8 }}>
                      {label}
                    </span>
                  )}
                  {target !== null && (
                    <span title={tx("Target date · {0}", [fmtDay(p.targetDate!, tx.language)])} className="absolute flex" style={{ left: target - 6, top: 14 }}>
                      <Diamond color={color} size={12} hollow />
                    </span>
                  )}
                  {!visible && s !== null && e !== null && (
                    <span className={cx("absolute top-3 whitespace-nowrap text-[11px] leading-4 text-dim", e <= 0 ? "left-2" : "right-2")}>
                      {e <= 0 ? `‹ ${fmtShort(p.targetDate ?? addDaysStr(from, e - 1), tx.language)}` : `${fmtShort(p.startDate ?? addDaysStr(from, s), tx.language)} ›`}
                    </span>
                  )}
                  {s === null && <span className="absolute left-2 top-3 text-[11px] leading-4 text-dim">{tx("No dates yet")}</span>}
                </div>
              </Link>
            );
          })}
          {nowPos >= 0 && nowPos <= days && (
            <span className="pointer-events-none absolute inset-y-0 w-px" style={{ left: LEFT + X(nowPos), background: NOW_LINE }} />
          )}
          {deps.length > 0 && (
            <svg width={gridW} height={height} className="pointer-events-none absolute top-0" style={{ left: LEFT }} aria-hidden="true">
              {deps.map((dp) => (
                <g key={dp.id}>
                  <path d={dp.d} fill="none" stroke="var(--color-mut)" strokeWidth="1.4" strokeLinejoin="round" />
                  <path d={dp.head} fill="var(--color-mut)" />
                </g>
              ))}
            </svg>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------- the projects on a phone ---------- */

/** Height of the month strip over the phone's project list. */
const STRIP = 32;

/**
 * A phone has no room for the names beside the weeks, so each project is a row with its name over a bar across the
 * same weeks, and the chosen project opens under its row (`children`: its tasks and settings).
 */
function PhoneProjects({ from, days, now, projects, colorOf, markOf, stats, selectedId, children }: {
  from: string; days: number; now: string; projects: Project[]; colorOf: (p: Project) => string;
  markOf: (p: Project) => ReactNode;
  stats: Record<string, ProjectStats>; selectedId: string; children: ReactNode;
}) {
  const tx = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const today = dateOnly(now);
  const nowPos = dayPos(from, now);
  const showNow = nowPos >= 0 && nowPos <= days;
  /** A day's place on the bars, in percent of their width. */
  const at = (d: number) => (Math.max(0, Math.min(days, d)) / days) * 100;
  const months: { day: number; label: string }[] = [];
  for (let i = 1; i < days; i++) {
    const d = parseLocal(addDaysStr(from, i));
    if (d.getDate() === 1) months.push({ day: i, label: tx.date(d, "MMM") });
  }
  if (!months.length || months[0].day > 10) months.unshift({ day: 0, label: tx.date(parseLocal(from), "MMM") });
  const pill = `clamp(24px, ${at(nowPos)}%, calc(100% - 24px))`;

  // Opening a project closes the one open above it, which would pull the new one up out of sight: bring it to the top.
  useLayoutEffect(() => {
    const row = ref.current?.querySelector<HTMLElement>("[aria-current=true]");
    if (ref.current && row) ref.current.scrollTop = row.offsetTop - STRIP;
  }, [selectedId]);

  return (
    <div ref={ref} className="relative min-h-0 flex-1 overflow-y-auto md:hidden">
      <div className="sticky top-0 z-10 grid grid-cols-[minmax(0,1fr)_44px] gap-x-2 overflow-hidden border-b border-line bg-panel px-4" style={{ height: STRIP }}>
        <div className="relative">
          {months.map((m) => {
            // Today's date covers about a week either side of it: a month that starts under it is named after it,
            // and one that started before it is already named by it.
            const under = showNow && Math.abs(m.day + 3.5 - nowPos) < 13;
            if (under && m.day <= nowPos) return null;
            return (
              <span key={m.day} className="absolute top-[9px] pl-1 text-[11.5px] text-mut"
                style={{ left: under ? `max(${at(m.day)}%, calc(${pill} + 24px))` : `${at(m.day)}%` }}>
                {m.label}
              </span>
            );
          })}
          {showNow && (
            <span className="absolute top-[7px] flex h-[18px] -translate-x-1/2 items-center whitespace-nowrap rounded bg-accent-strong px-1.5 text-[11px] font-medium text-white"
              style={{ left: pill }}>
              {fmtShort(today, tx.language)}
            </span>
          )}
        </div>
      </div>

      {barsOf(from, days, today, projects, stats, colorOf, tx).map(({ p, s, e, waiting, after, label, pct, color }) => {
        const selected = p.id === selectedId;
        const visible = s !== null && e !== null && e > 0 && s < days;
        const target = p.targetDate && e !== null && e >= 0 && e <= days ? at(e) : null;
        return (
          <Fragment key={p.id}>
            <Link href={`/roadmap?p=${encodeURIComponent(p.id)}`} scroll={false} aria-current={selected ? "true" : undefined}
              className={cx("grid grid-cols-[minmax(0,1fr)_44px] items-center gap-x-2 gap-y-2 border-b border-hover px-4 py-2.5", selected ? "bg-sel" : "hover:bg-hover")}>
              <span className="col-span-2 flex min-w-0 items-center gap-2">
                {markOf(p)}
                <span className="min-w-0 flex-1 truncate text-fg">{p.name}</span>
                {p.agent && <AgentChip agent={p.agent} />}
                <span className="max-w-[55%] shrink-0 truncate text-[12px] text-mut2">{after && !waiting ? tx("{0}, after {1}", [label, after.name]) : label}</span>
              </span>
              <span className="relative h-4">
                {months.map((m) => m.day > 0 && <span key={m.day} className="absolute inset-y-0 w-px bg-line2" style={{ left: `${at(m.day)}%` }} />)}
                {visible && (
                  <span className="absolute top-0.5 h-3 overflow-hidden rounded-[4px]"
                    style={{ left: `${at(s)}%`, width: `max(6px, ${at(e) - at(s)}%)`, background: waiting ? "transparent" : tint(color, 14), border: `1px ${waiting ? "dashed" : "solid"} ${tint(color, waiting ? 45 : 36)}` }}>
                    {!waiting && <span className="absolute inset-y-0 left-0" style={{ width: `${pct}%`, background: tint(color, 40) }} />}
                  </span>
                )}
                {target !== null && (
                  <span className="absolute top-[3px] flex" style={{ left: `calc(${target}% - 5px)` }}><Diamond color={color} size={10} hollow /></span>
                )}
                {!visible && s !== null && e !== null && (
                  <span className={cx("absolute top-0 whitespace-nowrap text-[11px] leading-4 text-dim", e <= 0 ? "left-1" : "right-1")}>
                    {e <= 0 ? `‹ ${fmtShort(p.targetDate ?? addDaysStr(from, e - 1), tx.language)}` : `${fmtShort(p.startDate ?? addDaysStr(from, s), tx.language)} ›`}
                  </span>
                )}
                {s === null && <span className="absolute left-1 top-0 text-[11px] leading-4 text-dim">{tx("No dates yet")}</span>}
                {showNow && <span className="absolute -inset-y-1 w-px" style={{ left: `${at(nowPos)}%`, background: NOW_LINE }} />}
              </span>
              <span className="text-right text-[11.5px] leading-4 text-mut">{p.targetDate && fmtShort(p.targetDate, tx.language)}</span>
            </Link>
            {selected && <div className="border-b border-line">{children}</div>}
          </Fragment>
        );
      })}
    </div>
  );
}

/** The chosen project's tasks on a phone, under its row. Tapping one opens its details; reordering is left to a computer. */
function PhoneTasks({ project, items, next, stats, onSelect }: {
  project: Project; items: RoadmapItem[]; next: Project[]; stats: Record<string, ProjectStats>; onSelect: (key: string) => void;
}) {
  const tx = useTranslation();
  return (
    <section aria-label={tx("Task order")} className="pb-2">
      <div className="flex h-11 items-center gap-2 pl-4 pr-3">
        <h2 className="text-[12.5px] font-medium text-fg2">{tx("Task order")}</h2>
        <span className="text-[12px] text-mut2">{items.length} {items.length === 1 ? "task" : "tasks"}</span>
      </div>
      {items.map((it, i) => {
        const t = it.task;
        const after = afterOf(it, tx);
        return (
          <div key={t.id} onClick={() => onSelect(t.key)} className="flex cursor-pointer items-center gap-2.5 border-t border-hover py-2 pl-4 pr-3 hover:bg-hover">
            <span className="w-4 shrink-0 self-start font-mono text-[11px] leading-[18px] text-dim">{i + 1}</span>
            <span className="flex h-[18px] shrink-0 items-center self-start"><StatusIcon status={t.status} /></span>
            <span className="min-w-0 flex-1">
              <button type="button" className={cx("block w-full truncate text-left leading-[18px]", t.status === "done" ? "text-mut2" : "text-fg")}>{t.title}</button>
              <span className="mt-0.5 flex items-center gap-2 text-[12px] leading-4">
                <span className="shrink-0 font-mono text-[11.5px] text-mut2">{t.key}</span>
                {it.state.tone === "waiting" && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />}
                <span className={cx("min-w-0 truncate", TONE[it.state.tone])}>
                  {it.state.text}{after && <span className="text-dim"> · {after}</span>}
                </span>
              </span>
            </span>
            {canOpen(it) && (
              <Link href={`/sessions?s=${it.session!.id}`} onClick={(e) => e.stopPropagation()}
                className="inline-flex h-7 shrink-0 items-center rounded-md border border-ctl px-2 text-[12px] text-fg2 hover:bg-sel">
                {tx("Open session")}</Link>
            )}
          </div>
        );
      })}
      {!items.length && <NoTasks project={project} />}
      <NextProjects project={project} next={next} stats={stats} />
    </section>
  );
}

/* ---------- task order ---------- */

const afterOf = (it: RoadmapItem, tx: Translator = createTranslator("en")) =>
  it.after.length ? tx("After {0}", [it.after.join(", ")]) : it.task.agent === "human" ? tx("Done by you") : "";
const canOpen = (it: RoadmapItem) => it.state.tone === "waiting" && !!it.session;

function NoTasks({ project }: { project: Project }) {
  const tx = useTranslation();
  return (
    <div className="flex flex-col items-center gap-3 px-8 py-16 text-center max-md:py-8">
      <div className="text-[14px] text-fg2">{tx("No tasks in")}{" "}{project.name} {" "}{tx("yet")}</div>
      <div className="text-[12.5px] text-mut2 max-md:hidden">
        {tx("Press")}<span className="rounded border border-ctl px-1.5 font-mono text-[11px]">C</span> {tx("anywhere to add a task.")}</div>
      {/* A phone has no C key. */}
      <Button className="md:hidden" onClick={() => openAdd({ projectId: project.id, areaId: project.areaId })}>
        <Icon name="plus" size={13} />{tx("Add a task")}</Button>
    </div>
  );
}

/** The projects that start once this one is done. */
function NextProjects({ project, next, stats }: { project: Project; next: Project[]; stats: Record<string, ProjectStats> }) {
  const tx = useTranslation();
  return next.map((q) => {
    const n = (stats[q.id] ?? EMPTY).total;
    return (
      <Link key={q.id} href={`/roadmap?p=${encodeURIComponent(q.id)}`} scroll={false}
        className="mx-5 mt-2 flex h-[38px] items-center gap-2.5 rounded-md border border-dashed border-ctl px-3 text-[12.5px] text-mut hover:bg-hover max-md:mx-4 max-md:h-auto max-md:py-2">
        <Icon name="arrowRight" size={14} strokeWidth={2} />
        {/* A phone wraps the sentence rather than cutting it off. */}
        <span className="min-w-0 flex-1 truncate max-md:whitespace-normal">
          {tx("Then")}{q.name}, {n ? tx.count(n, "task") : tx("no tasks yet")}{tx(", once")}{" "}{project.name} {tx("is done")}</span>
        {q.startDate && <span className="shrink-0 text-[12px] text-mut2">{tx("Est.")}{" "}{fmtShort(q.startDate, tx.language)}</span>}
      </Link>
    );
  });
}

function TaskOrder({ project, items, next, stats, sel, onSelect }: {
  project: Project; items: RoadmapItem[]; next: Project[]; stats: Record<string, ProjectStats>;
  sel: string | null; onSelect: (key: string) => void;
}) {
  const tx = useTranslation();
  const { run } = useAction();
  const [list, setList] = useOptimistic(items);
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    const order = [...list];
    [order[i], order[j]] = [order[j], order[i]];
    run(async () => {
      setList(order);
      return reorderTasksAction(order.map((it) => it.task.id));
    });
  };
  const arrow = "flex h-6 w-6 items-center justify-center rounded text-mut2 hover:bg-sel hover:text-fg2 disabled:pointer-events-none disabled:opacity-30";
  // Keeps the columns lined up when some rows have an "Open session" button.
  const actions = list.some(canOpen);

  return (
    <section aria-label={tx("Task order")} className="flex min-w-0 flex-1 flex-col max-md:hidden">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-5">
        <h2 className="mr-1 text-[12.5px] font-medium text-fg2">{tx("Task order")}</h2>
        <span className="truncate text-[12px] text-mut2">{project.name} · {list.length} {list.length === 1 ? "task" : "tasks"}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-4">
        {list.map((it, i) => {
          const t = it.task;
          const done = t.status === "done";
          const waiting = it.state.tone === "waiting";
          const after = afterOf(it, tx);
          return (
            <div key={t.id} onClick={() => onSelect(t.key)}
              className={cx("group flex h-[38px] cursor-pointer items-center gap-2.5 border-b border-hover pl-5 pr-3", t.key === sel ? "bg-sel" : "hover:bg-hover")}>
              <span className="w-4 shrink-0 font-mono text-[11px] text-dim">{i + 1}</span>
              <StatusIcon status={t.status} />
              <span className="w-[50px] shrink-0 font-mono text-[11.5px] text-mut2">{t.key}</span>
              <button type="button" className={cx("min-w-0 flex-1 truncate text-left", done ? "text-mut2" : "text-fg")}>{t.title}</button>
              <span title={after} className="hidden w-[110px] shrink-0 truncate text-[12px] text-dim min-[1360px]:block">{after}</span>
              <span className={cx("flex w-[210px] shrink-0 items-center justify-end gap-2 text-[12px]", TONE[it.state.tone])}>
                {waiting && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />}
                <span className="truncate">{it.state.text}</span>
              </span>
              {actions && (
                <span className="flex w-[98px] shrink-0 justify-end">
                  {canOpen(it) && (
                    <Link href={`/sessions?s=${it.session!.id}`} onClick={(e) => e.stopPropagation()}
                      className="inline-flex h-6 items-center rounded-md border border-ctl px-2 text-[12px] text-fg2 hover:bg-sel">
                      {tx("Open session")}</Link>
                  )}
                </span>
              )}
              <span className="flex shrink-0 items-center opacity-0 group-hover:opacity-100 focus-within:opacity-100">
                <button type="button" aria-label={tx("Move {0} up", [t.key])} title={tx("Move up")} disabled={i === 0} className={arrow}
                  onClick={(e) => { e.stopPropagation(); move(i, -1); }}>
                  <Icon name="chevronDown" size={13} strokeWidth={2.2} className="rotate-180" />
                </button>
                <button type="button" aria-label={tx("Move {0} down", [t.key])} title={tx("Move down")} disabled={i === list.length - 1} className={arrow}
                  onClick={(e) => { e.stopPropagation(); move(i, 1); }}>
                  <Icon name="chevronDown" size={13} strokeWidth={2.2} />
                </button>
              </span>
            </div>
          );
        })}
        {!list.length && <NoTasks project={project} />}
        <NextProjects project={project} next={next} stats={stats} />
      </div>
    </section>
  );
}

/* ---------- session settings for the project ---------- */

function Setting({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-[34px] items-center gap-3 rounded-md px-2 text-[12.5px]">
      <span className="w-[112px] shrink-0 text-mut2">{label}</span>
      <div className="flex min-w-0 flex-1 items-center gap-2">{children}</div>
    </div>
  );
}

/** `areaFolder`: the workspace of the project's area on this computer, which it uses without a folder of its own. */
type SettingsProps = { project: Project; projects: Project[]; markOf: (p: Project) => ReactNode; terminal: string; areaFolder: string | null };

function SessionPanel(props: SettingsProps) {
  const tx = useTranslation();
  return (
    <aside aria-label={tx("Session settings")} className="flex w-[380px] shrink-0 flex-col border-l border-line max-md:hidden">
      <div className="flex h-11 shrink-0 items-center border-b border-line px-5">
        <h2 className="truncate text-[12.5px] font-medium text-fg2">{tx("Sessions ·")}{" "}{props.project.name}</h2>
      </div>
      <SessionSettings {...props} />
    </aside>
  );
}

/** A phone keeps the project's session settings folded away under its tasks. */
function PhoneSessionSettings(props: SettingsProps) {
  const tx = useTranslation();
  return (
    // Unfolded near the bottom of the screen, they would open out of sight.
    <details className="group/settings border-t border-hover"
      onToggle={(e) => { if (e.currentTarget.open) e.currentTarget.scrollIntoView({ block: "nearest", behavior: "smooth" }); }}>
      <summary className="flex h-11 cursor-pointer list-none items-center gap-2 px-4 text-[12.5px] hover:bg-hover [&::-webkit-details-marker]:hidden">
        <Icon name="chevronRight" size={13} strokeWidth={2} className="shrink-0 text-mut2 group-open/settings:rotate-90" />
        <span className="font-medium text-fg2">{tx("Session settings")}</span>
      </summary>
      <SessionSettings key={`${props.project.id}:${props.project.folder ?? ""}`} {...props} />
    </details>
  );
}

function SessionSettings({ project, projects, markOf, terminal, areaFolder }: SettingsProps) {
  const tx = useTranslation();
  const { run } = useAction();
  const found = useExecution().folders?.projects[project.id] ?? [];
  const byId = new Map(projects.map((p) => [p.id, p]));
  /** Whether `start` waits, directly or through other projects, for `targetId`. */
  const waitsFor = (start: Project, targetId: string) => {
    const seen = new Set<string>();
    for (let cur = start.afterProjectId; cur && !seen.has(cur); cur = byId.get(cur)?.afterProjectId ?? null) {
      if (cur === targetId) return true;
      seen.add(cur);
    }
    return false;
  };
  const others = projects.filter((p) => p.id !== project.id);
  const startsAfter = project.afterProjectId ? byId.get(project.afterProjectId) ?? null : null;
  const next = projects.filter((p) => p.afterProjectId === project.id);
  const agent: AgentId = project.agent ?? "claude";
  const save = (patch: Partial<Omit<Project, "id">>) => run(() => updateProjectAction(project.id, patch));
  const item = (p: Project) => ({ value: p.id as string | null, label: p.name, icon: markOf(p) });

  return (
    <>
      <div className="flex flex-col gap-0.5 px-3 py-2.5 max-md:px-2 max-md:pt-0">
        <Setting label={tx("Default agent")}>
          <Menu className="min-w-0" width={200}
            trigger={<button type="button" className={pv}>
              <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: AGENT_DOT[agent] }} />{tx(AGENT_LABEL[agent])}
            </button>}
            items={(Object.keys(AGENT_LABEL) as AgentId[]).map((a) => ({
              value: a, label: tx(AGENT_LABEL[a]), icon: <span className="h-1.5 w-1.5 rounded-full" style={{ background: AGENT_DOT[a] }} />,
            }))}
            onSelect={(v) => save({ agent: v })} />
        </Setting>
        <Setting label={tx("Opens in")}>
          <span className="truncate px-2 text-fg2">{terminal}</span>
        </Setting>
        <Setting label={tx("Folder")}>
          <div className="min-w-0 flex-1">
            <FolderField variant="row" label={tx("Folder for {0}", [project.name])} value={project.folder} own=""
              inherited={areaFolder ? { folder: areaFolder, from: tx("area's") } : null} empty={tx("PacedMind's folder per task")}
              emptyTitle="No folder: PacedMind makes an empty folder for each task, in its data folder"
              clear={areaFolder ? tx("Use the area's workspace again") : tx("Remove its folder")} found={found}
              onUse={(folder) => run(() => linkFoundFolderAction(project.id, folder))} onChange={(folder) => save({ folder })} />
          </div>
        </Setting>
        {/* Where its tasks run when they go to Codex cloud: the environment's label or id. */}
        <Setting label={tx("Codex cloud")}>
          <input key={project.codexEnv ?? ""} defaultValue={project.codexEnv ?? ""} placeholder={tx("Environment label or id")} aria-label={tx("Codex cloud environment")}
            title={tx("Its label or id at chatgpt.com/codex/settings/environments, for tasks that run in Codex cloud")}
            onBlur={(e) => { if ((e.target.value.trim() || null) !== project.codexEnv) run(() => setCodexEnvAction(project.id, e.target.value)); }}
            onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
            className="h-7 min-w-0 flex-1 rounded-md bg-transparent px-2 font-mono text-[12px] text-fg2 outline-none placeholder:font-sans placeholder:text-mut2 hover:bg-hover focus:bg-input" />
        </Setting>
        <Setting label={tx("Starts after")}>
          <Menu className="min-w-0" width={240}
            trigger={<button type="button" className={cx(pv, !startsAfter && "text-mut2")}>
              {startsAfter && markOf(startsAfter)}
              <span className="truncate">{startsAfter?.name ?? tx("Nothing, starts any time")}</span>
            </button>}
            items={[{ value: null as string | null, label: tx("Nothing, starts any time") }, ...others.filter((p) => !waitsFor(p, project.id)).map(item)]}
            onSelect={(v) => save({ afterProjectId: v })} />
        </Setting>
        <Setting label={tx("After this project")}>
          <Menu className="min-w-0" width={240}
            trigger={<button type="button" className={cx(pv, !next.length && "text-mut2")}>
              <span className="truncate">
                {next.length ? next.map((p) => (p.agent ? tx("{0}, in {1}", [p.name, tx(AGENT_LABEL[p.agent])]) : p.name)).join("; ") : tx("Nothing")}
              </span>
            </button>}
            items={[{ value: null as string | null, label: tx("Nothing") }, ...others.filter((p) => !waitsFor(project, p.id)).map(item)]}
            onSelect={(v) => run(() => setNextProjectAction(project.id, v))} />
        </Setting>
      </div>
      <p className="px-5 py-1.5 text-[12px] leading-[1.55] text-mut2 max-md:px-4 max-md:pb-3">
        {tx("PacedMind only tracks state. You work with the agent in its own terminal, and it tells PacedMind when it starts and when it’s finished.")}</p>
    </>
  );
}

/* ---------- the view ---------- */

export function Roadmap(props: {
  /** First day of the project timeline, a Monday. */
  from: string;
  days: number;
  /** Server time, "YYYY-MM-DDTHH:mm:ss". */
  now: string;
  areas: Area[];
  projects: Project[];
  stats: Record<string, ProjectStats>;
  selectedId: string | null;
  /** Tasks of the selected project in their order. */
  items: RoadmapItem[];
  terminal: string;
  /** Finished sessions that wait for you. */
  waiting: number;
  ctx: TaskContext;
  initialKey: string | null;
}) {
  const tx = useTranslation();
  const { from, days, areas, projects, stats, items, ctx } = props;
  const router = useRouter();
  const [sel, setSel] = useState<string | null>(props.initialKey);
  const project = projects.find((p) => p.id === props.selectedId) ?? null;
  const areaFolder = areas.find((a) => a.id === project?.areaId)?.folder ?? null;
  useQuickAddProject(project?.id ?? null);
  const colorOf = (p: Project) => projectColor(p, areas);
  const markOf = (p: Project) => {
    const area = areas.find((a) => a.id === p.areaId);
    return (
      <span className="flex size-4 shrink-0 items-center justify-center">
        {area ? <AreaMark area={area} /> : <Dot color={colorOf(p)} size={7} />}
      </span>
    );
  };
  const selected = sel ? items.find((it) => it.task.key === sel)?.task ?? null : null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !(e.target as HTMLElement).closest("input, textarea, [contenteditable=true], [role=dialog]")) setSel(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const first = parseLocal(from);
  const last = parseLocal(addDaysStr(from, days - 1));
  const range = tx("{0} to {1}", [tx.date(first, first.getFullYear() === last.getFullYear() ? "MMM" : "MMM yyyy"), tx.date(last, "MMM yyyy")]);
  const waitingText = props.waiting === 1 ? tx("1 finished session waiting for you") : tx("{0} finished sessions waiting for you", [props.waiting]);
  const next = project ? projects.filter((p) => p.afterProjectId === project.id) : [];

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      {/* On a phone the header keeps the number of finished sessions: the months are named above the bars, and the list
          of projects is the project picker. */}
      <div className="flex h-[52px] shrink-0 items-center gap-2.5 border-b border-line pl-5 pr-4">
        <Icon name="roadmap" className="text-mut" />
        <h1 className="text-[14px] font-semibold text-strong">{tx("Roadmap")}</h1>
        <span className="text-mut2 max-md:hidden">{range}</span>
        <span className="flex-1" />
        {props.waiting > 0 && (
          <Link href="/sessions" aria-label={waitingText} className="inline-flex h-[26px] items-center gap-2 rounded-full px-2.5 text-[12px] text-mut hover:bg-hover">
            <span className="h-1.5 w-1.5 rounded-full bg-accent" />
            <span className="max-md:hidden">{waitingText}</span>
            <span className="md:hidden">{props.waiting}</span>
          </Link>
        )}
        {project && (
          <Menu align="right" width={240} className="max-md:hidden"
            trigger={<button type="button" aria-label={tx("Project")}
              className="flex h-7 max-w-[240px] items-center gap-2 rounded-md border border-ctl px-2.5 text-[12.5px] text-fg2 hover:bg-hover">
              {markOf(project)}
              <span className="truncate">{project.name}</span>
              <Icon name="chevronDown" size={12} className="shrink-0 text-mut2" />
            </button>}
            items={projects.map((p) => ({ value: p.id, label: p.name, icon: markOf(p), hint: areas.find((a) => a.id === p.areaId)?.name }))}
            onSelect={(id) => router.push(`/roadmap?p=${encodeURIComponent(id)}`, { scroll: false })} />
        )}
      </div>

      {project ? (
        <>
          <ProjectTimeline from={from} days={days} now={props.now} projects={projects} colorOf={colorOf} markOf={markOf} stats={stats} selectedId={project.id} />
          <PhoneProjects from={from} days={days} now={props.now} projects={projects} colorOf={colorOf} markOf={markOf} stats={stats} selectedId={project.id}>
            <PhoneTasks project={project} items={items} next={next} stats={stats} onSelect={setSel} />
            <PhoneSessionSettings project={project} projects={projects} markOf={markOf} terminal={props.terminal} areaFolder={areaFolder} />
          </PhoneProjects>
          {/* On a phone only a task's details show from here, over the whole page. */}
          <div className="flex min-h-0 flex-1 max-md:contents">
            <TaskOrder project={project} items={items} next={next} stats={stats}
              sel={selected?.key ?? null} onSelect={(key) => setSel((s) => (s === key ? null : key))} />
            {selected ? (
              <TaskDetail key={`${selected.id}-${selected.updatedAt}`} task={selected} ctx={ctx} onClose={() => setSel(null)} />
            ) : (
              <SessionPanel key={`${project.id}:${project.folder ?? ""}`} project={project} projects={projects} markOf={markOf} terminal={props.terminal} areaFolder={areaFolder} />
            )}
          </div>
        </>
      ) : (
        <div className="flex flex-col items-center gap-3 px-8 py-24 text-center">
          <div className="text-[14px] text-fg2">{tx("No projects yet")}</div>
          <div className="text-[12.5px] text-mut2">{tx("Projects and their target dates show up here once you add one.")}</div>
        </div>
      )}
    </div>
  );
}
