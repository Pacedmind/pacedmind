import "server-only";
import { createHash } from "node:crypto";
import { floatingTaskData, type FloatingTaskData } from "@/lib/floating-task";
import type { Session } from "@/lib/types";
import * as repo from "./repo";

export function floatingTaskVersion(data: FloatingTaskData | null): string {
  return createHash("sha256").update(JSON.stringify(data)).digest("hex");
}

/** One set of reads for all open notes, rather than a full planner poll in every renderer. */
export async function floatingTaskVersions(scope: string, notes: { id: number; createdAt: string }[]) {
  if (!notes.length) return [];
  const [tasks, areas, projects, sessions] = await Promise.all([
    repo.listTasks(), repo.listAreas(), repo.listProjects(), repo.listSessions(),
  ]);
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const byProject = new Map(projects.map((project) => [project.id, project]));
  const ids = new Set(notes.filter((n) => byId.get(n.id)?.createdAt === n.createdAt).map((n) => n.id));
  const latest = new Map<number, Session>();
  for (const session of sessions) if (ids.has(session.taskId) && !latest.has(session.taskId)) latest.set(session.taskId, session);
  const [events, reports] = await Promise.all([
    repo.sessionEventsFor([...latest.values()].map((s) => s.id)), repo.reportsForTasks([...latest.keys()]),
  ]);
  return notes.map(({ id, createdAt }) => {
    const task = byId.get(id);
    const session = latest.get(id) ?? null;
    const report = reports.get(id)?.find((r) => r.sessionId === session?.id) ?? null;
    const data = task?.createdAt === createdAt ? floatingTaskData(scope, task, areas,
      task.projectId ? byProject.get(task.projectId) ?? null : null,
      session, session ? events[session.id] ?? [] : [], report) : null;
    return { id, createdAt, version: floatingTaskVersion(data) };
  });
}
