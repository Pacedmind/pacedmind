import { getTranslation } from "@/server/i18n";
import { addMonths, endOfMonth, getDaysInMonth } from "date-fns";
import { MonthView } from "@/components/views/month";
import * as repo from "@/server/repo";
import { isOpen, taskContext } from "@/server/views";
import { addDaysStr, dateOnly, dayDiff, mondayOf, parseLocal, toDateStr, toDateTimeStr } from "@/lib/dates";
import type { Task } from "@/lib/types";

const STATUS_RANK: Record<string, number> = { progress: 0, review: 1, todo: 2, backlog: 3 };
const byUrgency = (a: Task, b: Task) =>
  (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9) || (a.priority || 5) - (b.priority || 5) || a.sortOrder - b.sortOrder || a.id - b.id;

export default async function CalendarPage(props: PageProps<"/calendar">) {
  const tx = await getTranslation();
  const sp = await props.searchParams;
  const now = new Date();
  const today = toDateStr(now);
  const month = typeof sp.m === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(sp.m) ? sp.m : today.slice(0, 7);
  const first = parseLocal(`${month}-01`);
  const monthStart = toDateStr(first);
  const monthEnd = toDateStr(endOfMonth(first));
  const start = toDateStr(mondayOf(first));
  const weeks = Math.max(5, Math.ceil((dayDiff(start, monthStart) + getDaysInMonth(first)) / 7));
  const days = Array.from({ length: weeks * 7 }, (_, i) => addDaysStr(start, i));
  const end = days[days.length - 1];
  const inGrid = (d: string | null) => !!d && dateOnly(d) >= start && dateOnly(d) <= end;

  const [all, events] = await Promise.all([repo.listTasks(), repo.occurrences(start, end)]);
  const dated = all.filter((t) => t.status !== "canceled" && (inGrid(t.dueDate) || inGrid(t.plannedDate)));
  const undated = all.filter((t) => isOpen(t) && !t.dueDate && !t.plannedDate).sort(byUrgency);
  const shown = undated.slice(0, 15);

  const isCurrent = month === today.slice(0, 7);
  const openDue = (from: string, to: string) =>
    all.filter((t) => isOpen(t) && t.dueDate && dateOnly(t.dueDate) >= from && dateOnly(t.dueDate) <= to).length;
  const name = tx.date(first, "MMMM");
  const plural = (n: number) => tx("{0} deadline{1}", [n || tx("No"), n === 1 ? "" : "s"]);
  let summary: { text: string; danger?: boolean };
  if (monthEnd < today) {
    const n = openDue(monthStart, monthEnd);
    summary = n ? { text: tx("{0} overdue from {1}", [n, name]), danger: true } : { text: tx("Nothing left open from {0}", [name]) };
  } else if (isCurrent) {
    summary = { text: tx("{0} left this month", [plural(openDue(today, monthEnd))]) };
  } else {
    summary = { text: tx("{0} in {1}", [plural(openDue(monthStart, monthEnd)), name]) };
  }

  return (
    <MonthView
      title={tx.date(first, "MMMM yyyy")}
      month={month}
      days={days}
      now={toDateTimeStr(now)}
      tasks={dated}
      undated={shown}
      undatedCount={undated.length}
      events={events}
      ctx={await taskContext([...dated, ...shown])}
      summary={summary}
      nav={{
        prev: `/calendar?m=${tx.date(addMonths(first, -1), "yyyy-MM")}`,
        next: `/calendar?m=${tx.date(addMonths(first, 1), "yyyy-MM")}`,
        month: isCurrent ? "/calendar" : `/calendar?m=${month}`,
        week: isCurrent ? "/calendar/week" : `/calendar/week?w=${monthStart}`,
      }}
      initialKey={typeof sp.task === "string" ? sp.task : null}
    />
  );
}
