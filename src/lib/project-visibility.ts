import type { Project, Task } from "./types";

export function hiddenProjectIds(projects: Pick<Project, "id" | "hidden">[]): Set<string> {
  return new Set(projects.filter((p) => p.hidden).map((p) => p.id));
}

/** Area to-dos merely related to a project remain independent of that project's visibility. */
export function taskIsVisible(task: Pick<Task, "projectId">, hidden: ReadonlySet<string>): boolean {
  return task.projectId === null || !hidden.has(task.projectId);
}
