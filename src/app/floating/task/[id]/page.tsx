import { FloatingTask } from "@/components/floating-task";
import { floatingTaskScope } from "@/server/floating-tasks";
import { authState } from "@/server/supabase";
import { requireDesktopWindow } from "@/server/window";
import * as repo from "@/server/repo";
import { projectColor } from "@/lib/colors";

export const dynamic = "force-dynamic";

/** A small authenticated view outside the planner layout, with its own live refresh. */
export default async function FloatingTaskPage(props: PageProps<"/floating/task/[id]">) {
  await requireDesktopWindow();
  const { id } = await props.params;
  const { scope, createdAt } = await props.searchParams;
  if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)) || typeof scope !== "string" ||
      typeof createdAt !== "string" || floatingTaskScope(await authState()) !== scope) return <FloatingTask data={null} />;
  const task = await repo.getTask(Number(id));
  if (!task || task.createdAt !== createdAt) return <FloatingTask data={null} />;
  const [areas, project, sessions] = await Promise.all([
    repo.listAreas(), task.projectId ? repo.getProject(task.projectId) : null, repo.listSessions({ taskId: task.id }),
  ]);
  const session = sessions[0] ?? null;
  const [events, reports] = await Promise.all([
    repo.sessionEventsFor(session ? [session.id] : []), repo.reportsForTasks(session ? [task.id] : []),
  ]);
  const area = areas.find((a) => a.id === task.areaId);
  const report = reports.get(task.id)?.find((r) => r.sessionId === session?.id) ?? null;
  const href = task.projectId ? `/project/${task.projectId}` : task.areaId ? `/area/${task.areaId}/todos` : "/inbox";
  return <FloatingTask data={{
    scope,
    task: { id: task.id, key: task.key, title: task.title, status: task.status, dueDate: task.dueDate, createdAt: task.createdAt },
    place: project?.name ?? area?.name ?? "Inbox",
    color: project ? projectColor(project, areas) : area?.color ?? null,
    href: `${href}?task=${encodeURIComponent(task.key)}`,
    subtasks: { done: task.subtasks.filter((s) => s.done).length, total: task.subtasks.length },
    session,
    events: session ? events[session.id] ?? [] : [],
    report: report ? { outcome: report.outcome, summary: report.summary } : null,
  }} />;
}
