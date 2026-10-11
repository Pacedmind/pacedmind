import { getTranslation } from "@/server/i18n";

import { TaskList } from "@/components/task-list";
import * as repo from "@/server/repo";
import { isOpen, taskContext } from "@/server/views";
import { dateOnly, todayStr } from "@/lib/dates";

export default async function TodayPage(props: PageProps<"/today">) {
  const tx = await getTranslation();
  const sp = await props.searchParams;
  const today = todayStr();
  const [tasks, schedule] = await Promise.all([repo.listTasks(), repo.occurrences(today, today)]);
  const byUrgency = (a: (typeof tasks)[number], b: (typeof tasks)[number]) =>
    Number(a.status === "done") - Number(b.status === "done") || (a.priority || 5) - (b.priority || 5) || (a.dueDate ?? "").localeCompare(b.dueDate ?? "");
  const overdue = tasks.filter((t) => isOpen(t) && t.dueDate && dateOnly(t.dueDate) < today).sort((a, b) => a.dueDate!.localeCompare(b.dueDate!));
  const dueToday = tasks
    .filter((t) => t.dueDate && dateOnly(t.dueDate) === today && (isOpen(t) || (t.completedAt && dateOnly(t.completedAt) === today)))
    .sort(byUrgency);
  const planned = tasks
    .filter((t) => isOpen(t) && t.plannedDate === today && !overdue.includes(t) && !dueToday.includes(t))
    .sort(byUrgency);
  const groups = [
    { id: "overdue", name: tx("Overdue"), tasks: overdue, tone: "danger" as const },
    { id: "due", name: tx("Due today"), tasks: dueToday, add: { plannedDate: today } },
    { id: "planned", name: tx("Planned for today"), tasks: planned, add: { plannedDate: today } },
  ].filter((g) => g.tasks.length);
  return (
    <TaskList
      icon="sun"
      title={tx("Today")}
      subtitle={tx.date(new Date(), "EEE, d MMM")}
      groups={groups}
      groupedBy="Section"
      schedule={schedule}
      ctx={await taskContext([...overdue, ...dueToday, ...planned])}
      initialKey={typeof sp.task === "string" ? sp.task : null}
      addDefaults={{ plannedDate: today }}
      empty={tx("Nothing is due or planned for today")}
    />
  );
}
