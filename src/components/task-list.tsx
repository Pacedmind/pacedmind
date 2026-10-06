"use client";
import { useTranslation } from "@/components/language";

import { useEffect, useState, type ReactNode } from "react";
import { dateOnly, fmtTime, parseLocal, toDateTimeStr } from "@/lib/dates";
import { fmtSpan } from "@/lib/usage";
import { setEventDoneAction } from "@/app/actions";
import { AreaDetail } from "./area-detail";
import type { Area, EventOccurrence, Task, TaskContext } from "@/lib/types";
import { openActivity } from "./activity-editor";
import { Icon, StatusIcon, type IconName } from "./icons";
import type { QuickAddDefaults } from "./quick-add";
import { TaskDetail } from "./task-detail";
import { DisplayMenu, arrange, useTaskDisplay } from "./task-display";
import { TaskRow } from "./task-row";
import { Button, Segmented, cx, useAction } from "./ui";

export interface TaskGroup {
  id: string;
  name: string;
  tasks: Task[];
  tone?: "danger";
  /** Defaults for the quick-add opened from this group's + button. */
  add?: QuickAddDefaults;
  /** Starts collapsed, like Done and Canceled. */
  folded?: boolean;
}

export function openAdd(detail: QuickAddDefaults = {}) {
  window.dispatchEvent(new CustomEvent("organizer:new", { detail }));
}

export function TaskList({
  icon, mark, title, subtitle, groups: pageGroups, groupedBy, schedule, ctx, initialKey, empty, headerRight, addDefaults, areaDetails,
}: {
  icon: IconName;
  /** Shown instead of the icon, such as an area's own icon. */
  mark?: ReactNode;
  title: string;
  subtitle?: string;
  groups: TaskGroup[];
  /** What the page's own groups are by, for the Display menu. */
  groupedBy?: string;
  schedule?: EventOccurrence[];
  ctx: TaskContext;
  initialKey?: string | null;
  empty?: ReactNode;
  headerRight?: ReactNode;
  addDefaults?: QuickAddDefaults;
  areaDetails?: Area;
}) {
  const tx = useTranslation();
  groupedBy ??= tx("Status");
  const [areaOpen, setAreaOpen] = useState(true);
  const [sel, setSel] = useState<string | null>(initialKey ?? null);
  const [filter, setFilter] = useState<"all" | "tasks" | "activities">("all");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => ({
    done: true, canceled: true, ...Object.fromEntries(pageGroups.filter((g) => g.folded).map((g) => [g.id, true])),
  }));
  const [display, setDisplay] = useTaskDisplay();
  const groups = arrange(pageGroups, display, tx);
  const all = pageGroups.flatMap((g) => g.tasks);
  const selected = all.find((t) => t.key === sel) ?? null;
  const now = toDateTimeStr(new Date());

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !(e.target as HTMLElement).closest("input, textarea, [contenteditable=true], [role=dialog]")) setSel(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!areaDetails) return;
    const show = (e: Event) => { if ((e as CustomEvent<string>).detail === areaDetails.id) { setAreaOpen(true); setSel(null); } };
    window.addEventListener("organizer:area-details", show);
    return () => window.removeEventListener("organizer:area-details", show);
  }, [areaDetails]);

  const open = all.filter((t) => t.status !== "done" && t.status !== "canceled").length;
  const showTasks = filter !== "activities";
  const showSchedule = !!schedule && filter !== "tasks";

  return (
    <div className="flex min-w-0 flex-1">
      <section aria-label={title} className="flex min-w-0 flex-1 flex-col">
        {/* A container, so what's in headerRight can shorten to icons when the list is narrow (a task's details open, say). */}
        <div className="@container flex h-[52px] shrink-0 items-center gap-2.5 border-b border-line pl-5 pr-4">
          {mark ?? <Icon name={icon} className="shrink-0 text-mut" />}
          <h1 className="min-w-0 truncate text-[14px] font-semibold text-strong">{title}</h1>
          {subtitle && <span className="min-w-0 shrink-[3] truncate text-mut2">{subtitle}</span>}
          <span className="flex-1" />
          {headerRight}
          {all.length > 0 && <DisplayMenu display={display} onChange={setDisplay} groupedBy={groupedBy} />}
          {areaDetails && <Button aria-expanded={areaOpen && !selected} onClick={() => { setSel(null); setAreaOpen((v) => !v || !!selected); }}>{tx("Area details")}</Button>}
          <Button onClick={() => openAdd(addDefaults)} aria-label={tx("New task")}><Icon name="plus" size={13} /><span className="max-sm:hidden">{tx("New task")}</span></Button>
        </div>

        {schedule && (
          <div className="flex h-10 shrink-0 items-center gap-1 border-b border-line px-5">
            <Segmented value={filter} onChange={setFilter} options={[
              { value: "all", label: tx("All") }, { value: "tasks", label: tx("Tasks") }, { value: "activities", label: tx("Activities") },
            ]} />
            <span className="flex-1" />
            <span className="text-[12px] text-mut2">{open} {" "}{tx("open ·")}{" "}{all.length - open} {" "}{tx("done")}</span>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {showSchedule && schedule!.length > 0 && (
            <>
              <GroupHeader name="Schedule" count={schedule!.length} onAdd={() => openAdd({ mode: "activity" })} />
              {schedule!.map((e) => (
                <ActivityRow key={`${e.eventId}-${e.start}`} activity={e} area={ctx.areas.find((a) => a.id === e.areaId)} now={now} />
              ))}
            </>
          )}
          {showTasks && groups.map((g) => (
            <div key={g.id}>
              <GroupHeader name={g.id === "no-label" || ["backlog", "todo", "progress", "review", "done", "canceled", "overdue", "due", "planned", "today"].includes(g.id) ? tx(g.name) : g.name} count={g.tasks.length} tone={g.tone} collapsed={collapsed[g.id]}
                onToggle={() => setCollapsed((c) => ({ ...c, [g.id]: !c[g.id] }))}
                onAdd={() => openAdd({ ...addDefaults, ...g.add })} />
              {!collapsed[g.id] && g.tasks.map((t) => (
                <TaskRow key={t.id} task={t} ctx={ctx} selected={t.key === sel} onSelect={() => setSel(t.key === sel ? null : t.key)} />
              ))}
            </div>
          ))}
          {!all.length && (!schedule || !schedule.length) && (
            <div className="flex flex-col items-center gap-3 px-8 py-24 text-center">
              <div className="text-[14px] text-fg2">{empty ?? tx("No tasks here yet")}</div>
              <div className="text-[12.5px] text-mut2">{tx("Press")}{" "}<span className="rounded border border-ctl px-1.5 font-mono text-[11px]">C</span> {" "}{tx("anywhere to add a task.")}</div>
            </div>
          )}
        </div>
      </section>
      {!selected && areaDetails && areaOpen && <AreaDetail area={areaDetails} projects={ctx.projects} onClose={() => setAreaOpen(false)} />}
      {selected && <TaskDetail key={`${selected.id}-${selected.updatedAt}`} task={selected} ctx={ctx} onClose={() => setSel(null)} />}
    </div>
  );
}

/**
 * An activity on the day's schedule, lined up with the tasks below it: its time where a task's key is, and a circle
 * where a task's status is, to mark it done (for this day only, when it repeats every week). Its title opens it.
 */
function ActivityRow({ activity: e, area, now }: { activity: EventOccurrence; area: Area | undefined; now: string }) {
  const tx = useTranslation();
  const { run } = useAction();
  const past = e.end <= now;
  const current = e.start <= now && now < e.end;
  const length = fmtSpan(parseLocal(e.end).getTime() - parseLocal(e.start).getTime());
  return (
    <div className="flex h-[38px] items-center gap-2.5 border-b border-hover pl-5 pr-4 hover:bg-hover max-sm:h-[46px] max-sm:pl-3.5">
      <span title={tx("Activity")} className="flex w-4 shrink-0 justify-center text-mut2 max-sm:hidden"><Icon name="calendar" size={13} /></span>
      <span className={cx("w-[54px] shrink-0 font-mono text-[11.5px]", past || e.done ? "text-dim" : "text-fg3")}>{fmtTime(e.start)}</span>
      <button type="button" aria-label={e.done ? tx("Mark as not done") : tx("Mark as done")} title={e.weekly ? tx("Marks this day only") : undefined}
        onClick={() => run(() => setEventDoneAction(e.eventId, dateOnly(e.start), !e.done))}
        className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded hover:bg-ink/5 max-sm:h-9 max-sm:w-9 max-sm:-mx-2">
        <StatusIcon status={e.done ? "done" : "todo"} />
      </button>
      <button type="button" onClick={() => openActivity(e)}
        className={cx("h-full min-w-0 flex-1 truncate text-left", e.done ? "text-mut2 line-through" : past ? "text-mut2" : "text-fg")}>
        {e.title}
      </button>
      {current && !e.done && <span className="shrink-0 rounded-full bg-accent/15 px-2 py-0.5 text-[11.5px] font-medium text-accent-fg">{tx("Now")}</span>}
      {area && (
        <span className="inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full border border-ctl px-2 text-[11.5px] text-mut max-sm:hidden">
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: area.color }} />{area.name}
        </span>
      )}
      <span title={`${fmtTime(e.start)}–${fmtTime(e.end)}`}
        className={cx("inline-flex h-5 shrink-0 items-center gap-1.5 rounded-[5px] border border-ctl px-1.5 text-[11.5px]", past || e.done ? "text-dim" : "text-mut")}>
        <Icon name="clock" size={11} strokeWidth={2.2} />{length}
      </span>
    </div>
  );
}

function GroupHeader({ name, count, tone, collapsed, onToggle, onAdd }: {
  name: string; count: number; tone?: "danger"; collapsed?: boolean; onToggle?: () => void; onAdd?: () => void;
}) {
  const tx = useTranslation();
  return (
    <div className="flex h-[34px] items-center gap-2 border-b border-line bg-raised pl-5 pr-4 text-[12.5px] font-medium text-fg2">
      <button type="button" onClick={onToggle} className="flex items-center gap-2" aria-expanded={!collapsed}>
        <Icon name={collapsed ? "chevronRight" : "chevronDown"} size={12} strokeWidth={2.4} className="text-mut2" />
        <span className={tone === "danger" ? "text-danger" : ""}>{name}</span>
        <span className="font-normal text-mut2">{count}</span>
      </button>
      <span className="flex-1" />
      {onAdd && (
        <button type="button" aria-label={tx("Add to {0}", [name])} onClick={onAdd} className="flex h-[22px] w-[22px] items-center justify-center rounded text-mut2 hover:bg-hover">
          <Icon name="plus" size={13} strokeWidth={2} />
        </button>
      )}
    </div>
  );
}
