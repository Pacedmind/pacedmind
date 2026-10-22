import type { Area, Project, Task } from "./types";

export function hiddenAreaIds(areas: Pick<Area, "id" | "hidden">[]): Set<string> {
  return new Set(areas.filter((a) => a.hidden).map((a) => a.id));
}

export function hiddenProjectIds(projects: Pick<Project, "id" | "hidden" | "areaId">[], areas: ReadonlySet<string>): Set<string> {
  return new Set(projects.filter((p) => p.hidden || areas.has(p.areaId)).map((p) => p.id));
}

/** Area to-dos merely related to a project remain independent of that project's visibility. */
export function taskIsVisible(task: Pick<Task, "projectId" | "areaId">, projects: ReadonlySet<string>, areas: ReadonlySet<string>): boolean {
  return (!task.projectId || !projects.has(task.projectId)) && (!task.areaId || !areas.has(task.areaId));
}
