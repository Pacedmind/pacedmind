import { projectColor } from "./colors";
import type { Area, Project, Report, Session, SessionEvent, Task } from "./types";

export interface FloatingTaskData {
  scope: string;
  task: Pick<Task, "id" | "key" | "title" | "status" | "dueDate" | "createdAt" | "priority" | "plannedDate">;
  projectId: string | null;
  projectName: string | null;
  areaId: string | null;
  areaName: string | null;
  place: string;
  color: string | null;
  href: string;
  subtasks: { done: number; total: number };
  session: Session | null;
  events: SessionEvent[];
  report: Pick<Report, "outcome" | "summary"> | null;
}

/** The page and the desktop's batched poll compare exactly the fields a note displays. */
export function floatingTaskData(scope: string, task: Task, areas: Area[], project: Project | null,
  session: Session | null, events: SessionEvent[], report: Report | null): FloatingTaskData {
  const area = areas.find((a) => a.id === (project?.areaId ?? task.areaId));
  const href = task.projectId ? `/project/${task.projectId}` : task.areaId ? `/area/${task.areaId}/todos` : "/inbox";
  return {
    scope,
    task: { id: task.id, key: task.key, title: task.title, status: task.status, dueDate: task.dueDate, createdAt: task.createdAt, priority: task.priority, plannedDate: task.plannedDate },
    projectId: project?.id ?? null, projectName: project?.name ?? null, areaId: area?.id ?? null, areaName: area?.name ?? null,
    place: project?.name ?? area?.name ?? "Inbox",
    color: project ? projectColor(project, areas) : area?.color ?? null,
    href: `${href}?task=${encodeURIComponent(task.key)}`,
    subtasks: { done: task.subtasks.filter((s) => s.done).length, total: task.subtasks.length },
    session, events,
    report: report ? { outcome: report.outcome, summary: report.summary } : null,
  };
}
