import "server-only";
import { trustCheck } from "./claude-trust";
import { deviceConfig } from "./device";
import { deviceIdFor, runsHere, thisDevice, thisDeviceId } from "./devices";
import { needKey, toolsOn } from "@/lib/needs";
import { plannedFolder, plannedSurface } from "./launcher";
import { changesProblemIn, changesViaIn } from "./ops";
import * as repo from "./repo";
import { usesCloud } from "./scope";
import { MODE, authState } from "./supabase";
import { floatingTaskScope } from "./floating-tasks";
import { agentOf, isLiveSession, type Area, type Project, type Session, type Task, type TaskContext, type Usage } from "@/lib/types";
import { NO_USE, addUse, sessionUse, type AgentUse } from "@/lib/usage";

export async function taskContext(tasks: Task[]): Promise<TaskContext> {
  const ids = new Set(tasks.map((t) => t.id));
  const [all, areas, projects] = await Promise.all([repo.listSessions(), repo.listAreas(), repo.listProjects()]);
  const sessions: Record<number, Session> = {};
  for (const s of all) {
    if (ids.has(s.taskId) && !sessions[s.taskId]) sessions[s.taskId] = s;
  }
  const shown = Object.values(sessions).map((s) => s.id);
  const [sessionEvents, reports, pending] = await Promise.all([repo.sessionEventsFor(shown), repo.reportsForTasks([...ids]), repo.pendingImages(shown)]);
  const live = new Set(all.filter(isLiveSession).map((s) => s.taskId));
  // What every session of each task used, as its agent reported it.
  const agentUse: Record<number, AgentUse> = {};
  for (const s of all) if (ids.has(s.taskId)) agentUse[s.taskId] = addUse(agentUse[s.taskId] ?? NO_USE, sessionUse(s));
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const changesOk: Record<string, boolean> = {};
  // Changes for a session that ran elsewhere go to its computer as a request (requestChangesRemoteAction).
  const changesVia: Record<string, string> = {};
  for (const s of Object.values(sessions)) {
    if (s.status !== "finished" && s.status !== "done") continue;
    const ctx = { task: byId.get(s.taskId), live: live.has(s.taskId), newest: reports.get(s.taskId)?.[0] };
    changesOk[s.id] = !changesProblemIn(s, ctx);
    const via = changesViaIn(s, ctx);
    if (via) changesVia[s.id] = via;
  }
  return {
    areas, projects, sessions, sessionEvents, reports: Object.fromEntries(reports), pending: Object.fromEntries(pending), changesOk, changesVia,
    desktop: MODE === "desktop", deviceId: MODE === "desktop" && (await usesCloud()) ? thisDeviceId() : null,
    floatingScope: floatingTaskScope(await authState()),
    asksTrust: MODE === "desktop" ? asksTrust(tasks, sessions, projects) : undefined,
    tools: await accountTools(),
    agentUse,
  };
}

/**
 * What the account's computers said their agents have, by name (toolsOn), each with the computers that have it: this
 * computer as it found it just now, and the others as they last said. Sorted by name.
 */
async function accountTools(): Promise<{ name: string; on: string[] }[]> {
  const cloud = await usesCloud();
  const here = MODE === "desktop" ? await thisDevice() : null;
  const others = cloud ? (await repo.listDevices()).filter((d) => !d.revokedAt && d.id !== here?.id) : [];
  const byKey = new Map<string, { name: string; on: Set<string> }>();
  for (const d of [...(here ? [here] : []), ...others]) {
    for (const agent of ["claude", "codex"] as const) {
      for (const name of toolsOn(d, agent) ?? []) {
        const k = needKey(name);
        if (!k) continue;
        const t = byKey.get(k) ?? { name, on: new Set<string>() };
        t.on.add(d.name);
        byKey.set(k, t);
      }
    }
  }
  return [...byKey.values()].map((t) => ({ name: t.name, on: [...t.on] })).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 200);
}

/**
 * Tasks whose Claude Code session on this computer opens in a folder Claude Code doesn't trust yet (claude-trust.ts):
 * the running one's, in a terminal, else where the next one would start, unless that's the Claude app, which asks
 * about the folder its own way. With "Trust session folders" on, the next one's folder gets its answer as it starts,
 * so only a running session can still be asked (when giving the answer failed).
 */
function asksTrust(tasks: Task[], sessions: Record<number, Session>, projects: Project[]): Record<number, boolean> {
  const asks = trustCheck();
  if (!asks) return {};
  const answered = deviceConfig().trustFolders;
  const projectOf = new Map(projects.map((p) => [p.id, p]));
  const out: Record<number, boolean> = {};
  for (const t of tasks) {
    const s = sessions[t.id];
    const project = t.projectId ? projectOf.get(t.projectId) : undefined;
    let folder: string | null = null;
    if (s && isLiveSession(s)) {
      if (s.agent === "claude" && s.surface === "terminal" && runsHere(s.deviceId)) folder = s.folder;
    } else if (!answered && agentOf(t, project?.agent) === "claude" && runsHere(deviceIdFor(t.deviceId, project?.deviceId)) && plannedSurface(t, "claude") !== "desktop") {
      folder = plannedFolder(t);
    }
    if (folder && asks(folder)) out[t.id] = true;
  }
  return out;
}

export const isOpen = (t: Task) => t.status !== "done" && t.status !== "canceled";

export function usage(areas: Area[], projects: Project[], tasks: Task[]): Usage {
  const areaOf = new Map(projects.map((p) => [p.id, p.areaId]));
  const inArea = (t: Task, id: string) => t.areaId === id || (t.projectId !== null && areaOf.get(t.projectId) === id);
  return {
    areas: Object.fromEntries(areas.map((a) => {
      const ts = tasks.filter((t) => inArea(t, a.id));
      return [a.id, {
        projects: projects.filter((p) => p.areaId === a.id).length, tasks: ts.length, open: ts.filter(isOpen).length,
        loose: ts.filter((t) => !t.projectId && isOpen(t)).length,
      }];
    })),
    projects: Object.fromEntries(projects.map((p) => {
      const ts = tasks.filter((t) => t.projectId === p.id);
      const counted = ts.filter((t) => t.status !== "canceled");
      const done = counted.filter((t) => t.status === "done").length;
      return [p.id, { tasks: ts.length, open: ts.filter(isOpen).length, done, pct: counted.length ? Math.round((done / counted.length) * 100) : 0 }];
    })),
  };
}

const STATUS_ORDER = ["review", "progress", "todo", "backlog", "done", "canceled"] as const;
const STATUS_GROUP: Record<string, string> = {
  review: "In review", progress: "In progress", todo: "Todo", backlog: "Backlog", done: "Done", canceled: "Canceled",
};

/** Groups tasks by status in Linear's order, dropping empty groups. */
export function groupByStatus(tasks: Task[]) {
  return STATUS_ORDER.map((st) => ({
    id: st,
    name: STATUS_GROUP[st],
    tasks: tasks.filter((t) => t.status === st).sort((a, b) => (a.priority || 5) - (b.priority || 5) || a.sortOrder - b.sortOrder),
  })).filter((g) => g.tasks.length);
}
