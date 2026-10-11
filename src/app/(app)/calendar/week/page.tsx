import { getTranslation } from "@/server/i18n";
import { getISOWeek } from "date-fns";
import { WeekView, type SessionBlock } from "@/components/views/week";
import { planWeek } from "@/server/calendar";
import * as repo from "@/server/repo";
import { isOpen, taskContext } from "@/server/views";
import { addDaysStr, dateOnly, fmtShort, mondayOf, parseLocal, toDateStr, toDateTimeStr } from "@/lib/dates";
import { isLiveSession, type Session, type Task } from "@/lib/types";

const STATUS_RANK: Record<string, number> = { progress: 0, review: 1, todo: 2, backlog: 3 };
const byUrgency = (a: Task, b: Task) =>
  (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9) || (a.priority || 5) - (b.priority || 5) || a.sortOrder - b.sortOrder || a.id - b.id;
/** How many of the tasks still to place the side list gets. */
const TO_PLACE = 80;

export default async function WeekPage(props: PageProps<"/calendar/week">) {
  const tx = await getTranslation();
  const sp = await props.searchParams;
  const now = new Date();
  const today = toDateStr(now);
  const w = typeof sp.w === "string" && /^\d{4}-\d{2}-\d{2}$/.test(sp.w) && toDateStr(parseLocal(sp.w)) === sp.w ? sp.w : today;
  const start = toDateStr(mondayOf(parseLocal(w)));
  const end = addDaysStr(start, 6);
  const days = Array.from({ length: 7 }, (_, i) => addDaysStr(start, i));
  const current = start <= today && today <= end;
  const inWeek = (d: string | null) => !!d && dateOnly(d) >= start && dateOnly(d) <= end;

  const [all, sessions, settings, events] = await Promise.all([repo.listTasks(), repo.listSessions(), repo.getSettings(), repo.occurrences(start, end)]);
  const plan = await planWeek({ start, end, now, tasks: all, sessions, settings });

  const byId = new Map(all.map((t) => [t.id, t]));
  const stopOf = (s: Session) => s.finishedAt ?? s.endedAt ?? (isLiveSession(s) ? null : s.startedAt);
  const weekSessions = sessions.filter((s) => {
    const stop = stopOf(s);
    return byId.has(s.taskId) && s.status !== "failed" && dateOnly(s.startedAt) <= end && (!stop || dateOnly(stop) >= start);
  });
  const runs: SessionBlock[] = weekSessions.map((s) => {
    const t = byId.get(s.taskId)!;
    return { id: s.id, taskId: t.id, key: t.key, title: t.title, agent: s.agent, start: s.startedAt, end: stopOf(s), status: s.status };
  });

  const placed = new Set((plan?.blocks ?? []).map((b) => b.taskId));
  const ids = new Set([
    ...placed,
    ...(plan?.unplaced ?? []).map((u) => u.taskId),
    ...weekSessions.map((s) => s.taskId),
  ]);
  // Everything the week shows: planned for one of its days (at a time or not), due in it, placed by the auto-plan or
  // worked on by an agent.
  const shown = all.filter((t) => ids.has(t.id) || (t.status !== "canceled" && (inWeek(t.plannedDate) || inWeek(t.dueDate))));
  // The side list: open tasks not on this week yet, or whose planned day passed, most urgent first. Dragged onto a
  // day, they get it.
  const toPlace = all
    .filter((t) => isOpen(t) && !placed.has(t.id) && !inWeek(t.plannedDate) && (!t.plannedDate || t.plannedDate < today))
    .sort(byUrgency);
  const listed = toPlace.slice(0, TO_PLACE);
  const tasks = [...shown, ...listed.filter((t) => !shown.includes(t))];

  const from = start.slice(0, 7) === end.slice(0, 7) ? String(Number(start.slice(8))) : fmtShort(start, tx.language);
  const month = addDaysStr(start, 3).slice(0, 7);

  return (
    <WeekView
      days={days}
      now={toDateTimeStr(now)}
      subtitle={tx("{0} to {1} · week {2}", [from, fmtShort(end, tx.language), getISOWeek(parseLocal(start))])}
      current={current}
      events={events}
      plan={plan}
      runs={runs}
      tasks={tasks}
      toPlace={{ ids: listed.map((t) => t.id), total: toPlace.length }}
      rules={{
        workStart: settings.workStart, workEnd: settings.workEnd, lunchStart: settings.lunchStart, lunchEnd: settings.lunchEnd,
        workDays: settings.workDays,
      }}
      ctx={await taskContext(tasks)}
      nav={{
        month: current ? "/calendar" : `/calendar?m=${month}`,
        week: current ? "/calendar/week" : `/calendar/week?w=${start}`,
      }}
      initialKey={typeof sp.task === "string" ? sp.task : null}
    />
  );
}
