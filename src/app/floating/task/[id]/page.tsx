import { FloatingTask } from "@/components/floating-task";
import { floatingTaskScope } from "@/server/floating-tasks";
import { authState } from "@/server/supabase";
import { requireDesktopWindow } from "@/server/window";
import * as repo from "@/server/repo";
import { floatingTaskData } from "@/lib/floating-task";
import { floatingTaskVersion } from "@/server/floating-task-state";

export const dynamic = "force-dynamic";

/** A small authenticated view outside the planner layout, with its own live refresh. */
export default async function FloatingTaskPage(props: PageProps<"/floating/task/[id]">) {
  await requireDesktopWindow();
  const { id } = await props.params;
  const { scope, createdAt } = await props.searchParams;
  if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)) || typeof scope !== "string" ||
      typeof createdAt !== "string" || floatingTaskScope(await authState()) !== scope) return <FloatingTask data={null} version={floatingTaskVersion(null)} />;
  const task = await repo.getTask(Number(id));
  if (!task || task.createdAt !== createdAt) return <FloatingTask data={null} version={floatingTaskVersion(null)} />;
  const [areas, project, sessions] = await Promise.all([
    repo.listAreas(), task.projectId ? repo.getProject(task.projectId) : null, repo.listSessions({ taskId: task.id }),
  ]);
  const session = sessions[0] ?? null;
  const [events, reports] = await Promise.all([
    repo.sessionEventsFor(session ? [session.id] : []), repo.reportsForTasks(session ? [task.id] : []),
  ]);
  const report = reports.get(task.id)?.find((r) => r.sessionId === session?.id) ?? null;
  const data = floatingTaskData(scope, task, areas, project, session, session ? events[session.id] ?? [] : [], report);
  return <FloatingTask data={data} version={floatingTaskVersion(data)} />;
}
