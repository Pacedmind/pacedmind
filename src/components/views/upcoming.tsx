"use client";
import { useTranslation } from "@/components/language";
import { createTranslator, type Translator } from "@/lib/i18n";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { addMonths, startOfMonth } from "date-fns";
import { projectColor } from "@/lib/colors";
import { addDaysStr, dateOnly, dayDiff, fmtTime, parseLocal, timeOf, toDateStr } from "@/lib/dates";
import type { EventOccurrence, Task, TaskContext } from "@/lib/types";
import type { Health, ProjectTarget } from "@/server/calendar";
import { openActivity } from "../activity-editor";
import { Diamond, Icon } from "../icons";
import { openAdd } from "../task-list";
import { TaskDetail } from "../task-detail";
import { TaskRow } from "../task-row";
import { Dot, Segmented, cx } from "../ui";
import { ViewHeader, useSelection } from "./calendar-parts";

const DAYS = 14;
/** Days covered by the small timeline next to the project targets. */
const WINDOW = 90;

const HEALTH = (tx: Translator): Record<Health, { label: string; className: string }> => ({
  ok: { label: tx("On track"), className: "text-mut" },
  risk: { label: tx("At risk"), className: "text-fg2" },
  behind: { label: tx("Behind"), className: "text-danger" },
});

function inDays(n: number, tx: Translator = createTranslator("en")) {
  if (n < 0) return n === -1 ? tx("yesterday") : tx("{0} days ago", [-n]);
  if (n === 0) return tx("today");
  if (n === 1) return tx("tomorrow");
  return n < 14 ? tx("in {0} days", [n]) : tx("in {0} weeks", [Math.round(n / 7)]);
}

export function UpcomingView({ today, tasks, events, targets, ctx, initialKey }: {
  today: string;
  /** Open tasks due or planned in the next 14 days. */
  tasks: Task[];
  events: EventOccurrence[];
  targets: ProjectTarget[];
  ctx: TaskContext;
  initialKey: string | null;
}) {
  const tx = useTranslation();
  const [sel, setSel] = useSelection(initialKey);
  const [mode, setMode] = useState<"all" | "due">("all");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const selected = tasks.find((t) => t.key === sel) ?? null;
  const flip = (id: string) => setCollapsed((c) => ({ ...c, [id]: !c[id] }));

  const groups = Array.from({ length: DAYS }, (_, i) => addDaysStr(today, i + 1)).map((day) => {
    const dueHere = (t: Task) => !!t.dueDate && dateOnly(t.dueDate) === day;
    const due = tasks.filter(dueHere)
      .sort((a, b) => (timeOf(a.dueDate) ?? "24:00").localeCompare(timeOf(b.dueDate) ?? "24:00") || (a.priority || 5) - (b.priority || 5));
    const planned = mode === "all" ? tasks.filter((t) => t.plannedDate === day && !dueHere(t)).sort((a, b) => (a.priority || 5) - (b.priority || 5)) : [];
    return {
      day,
      targets: targets.filter((p) => p.targetDate === day),
      tasks: [...due, ...planned],
      events: mode === "all" ? events.filter((e) => dateOnly(e.start) === day) : [],
    };
  }).filter((g) => g.targets.length + g.tasks.length + g.events.length > 0);

  const ticks = [1, 2, 3, 4]
    .map((i) => addMonths(startOfMonth(parseLocal(today)), i))
    .map((d) => ({ label: tx.date(d, "MMM"), pos: (dayDiff(today, toDateStr(d)) / WINDOW) * 100 }))
    .filter((k) => k.pos <= 100);

  return (
    <div className="flex min-w-0 flex-1">
      <section aria-label={tx("Upcoming")} className="flex min-w-0 flex-1 flex-col">
        <ViewHeader icon="clock" title={tx("Upcoming")} subtitle={tx("Next {0} days", [DAYS])}>
          <span className="flex-1" />
          <Segmented value={mode} onChange={setMode} options={[{ value: "all", label: tx("Everything") }, { value: "due", label: tx("Deadlines only") }]} />
        </ViewHeader>

        <div className="@container min-h-0 flex-1 overflow-y-auto">
          {targets.length > 0 && (
            <>
              <GroupHeader title={tx("Project targets")} count={targets.length} collapsed={collapsed.targets} onToggle={() => flip("targets")}>
                <span className="flex-1" />
                <span aria-hidden className="relative mr-[254px] hidden h-full w-[320px] shrink-0 text-[11px] font-normal text-mut2 @6xl:block">
                  {ticks.map((k) => (
                    <span key={k.label} className="absolute top-2.5 -translate-x-1/2" style={{ left: `${k.pos}%` }}>{k.label}</span>
                  ))}
                </span>
              </GroupHeader>
              {!collapsed.targets && targets.map((p) => <TargetRow key={p.id} target={p} ctx={ctx} />)}
            </>
          )}

          {groups.map((g) => {
            const diff = dayDiff(today, g.day);
            const count = g.targets.length + g.tasks.length + g.events.length;
            return (
              <div key={g.day}>
                <GroupHeader title={diff === 1 ? tx("Tomorrow") : tx.date(parseLocal(g.day), "EEEE")} date={tx.date(parseLocal(g.day), "EEE d MMM")} count={count}
                  collapsed={collapsed[g.day]} onToggle={() => flip(g.day)} onAdd={() => openAdd({ plannedDate: g.day })} />
                {!collapsed[g.day] && (
                  <>
                    {g.targets.map((p) => (
                      <Link key={p.id} href={`/project/${p.id}`} className="flex h-[38px] items-center gap-2.5 border-b border-hover pl-5 pr-4 hover:bg-hover">
                        <span className="flex w-4 shrink-0 justify-center"><Diamond color={projectColor(p, ctx.areas)} size={12} /></span>
                        <span className="min-w-0 flex-1 truncate text-fg">{p.name} {" "}{tx("target date")}</span>
                        <span className="shrink-0 text-[11.5px] text-mut">{p.done} {" "}{tx("of")}{" "}{p.total} {" "}{tx("tasks done")}</span>
                      </Link>
                    ))}
                    {g.tasks.map((t) => (
                      <TaskRow key={t.id} task={t} ctx={ctx} selected={t.key === sel} onSelect={() => setSel(t.key === sel ? null : t.key)} />
                    ))}
                    {g.events.map((e) => {
                      const area = ctx.areas.find((a) => a.id === e.areaId);
                      return (
                        <button key={`${e.eventId}-${e.start}`} type="button" onClick={() => openActivity(e)}
                          className="flex h-[38px] w-full items-center gap-3 border-b border-hover pl-5 pr-4 text-left hover:bg-hover">
                          <span className="w-[96px] shrink-0 font-mono text-[11.5px] text-mut">{fmtTime(e.start)}–{fmtTime(e.end)}</span>
                          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: area?.color ?? "var(--color-mut2)" }} />
                          <span className="min-w-0 flex-1 truncate">{e.title}</span>
                          <span className="shrink-0 text-[11.5px] text-mut2">{area?.name}</span>
                        </button>
                      );
                    })}
                  </>
                )}
              </div>
            );
          })}

          {!groups.length && !targets.length && (
            <div className="flex flex-col items-center gap-3 px-8 py-24 text-center">
              <div className="text-[14px] text-fg2">{mode === "due" ? tx("No deadlines in the next 14 days") : tx("Nothing coming up in the next 14 days")}</div>
              <div className="text-[12.5px] text-mut2">{tx("Tasks with a due or planned date show up here.")}</div>
            </div>
          )}
          {!groups.length && targets.length > 0 && (
            <div className="px-5 py-6 text-[12.5px] text-mut2">
              {mode === "due" ? tx("No deadlines in the next 14 days.") : tx("Nothing due, planned or scheduled in the next 14 days.")}
            </div>
          )}
        </div>
      </section>
      {selected && <TaskDetail key={`${selected.id}-${selected.updatedAt}`} task={selected} ctx={ctx} onClose={() => setSel(null)} />}
    </div>
  );
}

function GroupHeader({ title, date, count, collapsed, onToggle, onAdd, children }: {
  title: string; date?: string; count: number; collapsed?: boolean; onToggle: () => void; onAdd?: () => void; children?: ReactNode;
}) {
  const tx = useTranslation();
  return (
    <div className="flex h-[34px] items-center gap-2 border-b border-line bg-raised pl-5 pr-4 text-[12.5px] font-medium text-fg2">
      <button type="button" onClick={onToggle} className="flex items-center gap-2" aria-expanded={!collapsed}>
        <Icon name={collapsed ? "chevronRight" : "chevronDown"} size={12} strokeWidth={2.4} className="text-mut2" />
        <span>{title}</span>
        {date && <span className="font-normal text-mut2">{date}</span>}
        <span className="font-normal text-mut2">{date ? `· ${count}` : count}</span>
      </button>
      {children}
      {onAdd && (
        <>
          <span className="flex-1" />
          <button type="button" aria-label={tx("Add a task for {0}", [title])} onClick={onAdd}
            className="flex h-[22px] w-[22px] items-center justify-center rounded text-mut2 hover:bg-hover">
            <Icon name="plus" size={13} strokeWidth={2} />
          </button>
        </>
      )}
    </div>
  );
}

function TargetRow({ target: p, ctx }: { target: ProjectTarget; ctx: TaskContext }) {
  const tx = useTranslation();
  const color = projectColor(p, ctx.areas);
  const area = ctx.areas.find((a) => a.id === p.areaId);
  const pos = Math.min(100, Math.max(0, (p.daysLeft / WINDOW) * 100));
  const health = HEALTH(tx)[p.health];
  return (
    // In a narrow column (a phone) the name keeps its room: no progress bar, and the date without "in N days". The
    // timeline takes about 1,100px with the other columns, so it and the header's months wait for @6xl (72rem).
    <Link href={`/project/${p.id}`} className="flex h-[46px] items-center gap-4 border-b border-hover pl-5 pr-4 hover:bg-hover @max-md:gap-3">
      <Diamond color={color} size={12} />
      <span className="min-w-0 flex-1 truncate font-medium text-fg @6xl:w-[150px] @6xl:flex-none">{p.name}</span>
      <span className="hidden w-20 shrink-0 items-center gap-[7px] text-[12px] text-mut @3xl:flex">
        <Dot color={color} size={7} />
        <span className="truncate">{area?.name}</span>
      </span>
      <span className="flex w-[170px] shrink-0 items-center gap-2.5 @max-md:w-auto">
        <span className="h-1 w-[90px] overflow-hidden rounded-sm bg-line2 @max-md:hidden">
          <span className="block h-1 rounded-sm" style={{ width: `${p.total ? (p.done / p.total) * 100 : 0}%`, background: color }} />
        </span>
        <span className="text-[12px] text-mut">{p.total ? `${p.done}/${p.total}` : tx("No tasks")}</span>
      </span>
      <span className="hidden flex-1 @6xl:block" />
      <span aria-hidden className="relative hidden h-[22px] w-[320px] shrink-0 @6xl:block">
        <span className="absolute inset-x-0 top-2.5 h-0.5 rounded-[1px] bg-line" />
        <span className="absolute left-0 top-2.5 h-0.5 rounded-[1px] opacity-35" style={{ width: `${pos}%`, background: color }} />
        <span className="absolute left-0 top-1.5 h-2.5 w-0.5 rounded-[1px] bg-accent" />
        <span className="absolute top-[5px] -ml-1.5 flex" style={{ left: `${pos}%` }}><Diamond color={color} size={12} /></span>
      </span>
      <span className="w-[150px] shrink-0 truncate text-[12.5px] text-fg2 @max-md:w-auto">
        {tx.date(parseLocal(p.targetDate), "EEE d MMM")} <span className="text-mut2 @max-md:hidden">· {inDays(p.daysLeft, tx)}</span>
      </span>
      <span className={cx("w-[72px] shrink-0 text-right text-[12px] @max-md:w-auto", health.className)}>{tx(health.label)}</span>
    </Link>
  );
}
