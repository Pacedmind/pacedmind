import "server-only";
import { trustCheck } from "./claude-trust";
import { deviceConfig } from "./device";
import { runsHere, thisDeviceId } from "./devices";
import { changesProblemIn, changesViaIn } from "./ops";
import { attachedConversations } from "./attach";
import { scanOtherSessions } from "./other-sessions";
import * as repo from "./repo";
import { usesCloud } from "./scope";
import { MODE } from "./supabase";
import { hiddenAreaIds, hiddenProjectIds } from "@/lib/project-visibility";
import { attentionOf, dateOnly, todayStr } from "@/lib/dates";
import type { AttachableTask, OtherGroup, SessionGroup, SessionItem, StartableTask } from "@/components/views/sessions";
import { agentOf, deviceOnline, outsideConversation, taskHref, type OtherSession, type Report, type Session, type Status, type Task } from "@/lib/types";

const EARLIER_LIMIT = 30;
const active = (s: Session) => s.status === "starting" || s.status === "running";

/**
 * The sessions PacedMind didn't start, by computer: this one's as it finds them now (other-sessions.ts), the others'
 * as they last said (every minute while they run). Computers without any are left out.
 */
export async function otherSessionGroups(): Promise<OtherGroup[]> {
  const [projects, areas, devices, cloud, attached] = await Promise.all([repo.listAllProjects(), repo.listAllAreas(), repo.listDevices(), usesCloud(), attachedConversations()]);
  const names = new Map(projects.map((p) => [p.id, p.name]));
  // One attached to a task since its computer last said is PacedMind's now.
  const hidden = hiddenProjectIds(projects, hiddenAreaIds(areas));
  const named = (list: OtherSession[]) => list.filter((s) => !attached.has(outsideConversation(s) ?? s.ref) && (!s.projectId || !hidden.has(s.projectId)))
    .map((s) => ({ ...s, project: (s.projectId && names.get(s.projectId)) || null }));
  const groups: OtherGroup[] = [];
  if (MODE === "desktop") groups.push({ id: "here", computer: deviceConfig().name, here: true, online: true, sessions: named(scanOtherSessions(projects, attached)) });
  const me = MODE === "desktop" && cloud ? thisDeviceId() : null;
  for (const d of devices) {
    if (d.revokedAt || d.id === me) continue;
    groups.push({ id: d.id, computer: d.name, here: false, online: deviceOnline(d), sessions: named(d.otherSessions) });
  }
  return groups.filter((g) => g.sessions.length);
}

/** Everything the Sessions screen shows, grouped the way it lists them. */
export async function sessionList(selected: string | null): Promise<{
  groups: SessionGroup[]; initialId: string | null; startable: StartableTask[]; attachable: AttachableTask[];
}> {
  const [all, taskList, projectList, edges, done, deviceList] = await Promise.all([
    repo.listSessions(), repo.listTasks(), repo.listProjects(), repo.listEdges(), repo.doneTimes(), repo.listDevices(),
  ]);
  const tasks = new Map(taskList.map((t) => [t.id, t]));
  const projects = new Map(projectList.map((p) => [p.id, p]));
  const devices = new Map(deviceList.map((d) => [d.id, d.name]));
  const busy = new Set(all.filter(active).map((s) => s.taskId));
  const today = todayStr();

  /** When a session stopped needing anything: marked done, or its terminal closed. */
  const endAt = (s: Session) =>
    s.status === "done"
      ? done.get(s.id) ?? s.endedAt ?? s.finishedAt ?? tasks.get(s.taskId)?.completedAt ?? s.startedAt
      : s.endedAt ?? s.finishedAt ?? s.startedAt;

  const finished = all.filter((s) => s.status === "finished")
    .sort((a, b) => (b.finishedAt ?? b.startedAt).localeCompare(a.finishedAt ?? a.startedAt));
  const running = all.filter(active).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const ended = all.filter((s) => !active(s) && s.status !== "finished").sort((a, b) => endAt(b).localeCompare(endAt(a)));
  const endedToday = ended.filter((s) => dateOnly(endAt(s)) >= today);
  const earlier = ended.filter((s) => dateOnly(endAt(s)) < today);
  const shownEarlier = earlier.slice(0, EARLIER_LIMIT);
  // A link to an older session still opens it.
  const linked = selected ? earlier.slice(EARLIER_LIMIT).find((s) => s.id === selected) : undefined;
  if (linked) shownEarlier.push(linked);

  const shownIds = [...finished, ...running, ...endedToday, ...shownEarlier].map((s) => s.id);
  const [eventsOf, reports, pending] = await Promise.all([
    repo.sessionEventsFor(shownIds), repo.reportsForSessions(shownIds), repo.pendingImages(shownIds),
  ]);
  // Request changes goes on a task's newest report only.
  const newestOfTask = new Map<number, Report>();
  for (const list of reports.values()) {
    for (const r of list) if ((newestOfTask.get(r.taskId)?.id ?? 0) < r.id) newestOfTask.set(r.taskId, r);
  }
  // Claude Code terminals here in folders it doesn't trust yet ask about them first (claude-trust.ts).
  const trustAsks = MODE === "desktop" && running.some((s) => s.agent === "claude") ? trustCheck() : null;

  const item = (s: Session): SessionItem => {
    const task = tasks.get(s.taskId);
    const project = task?.projectId ? projects.get(task.projectId) : undefined;
    const events = eventsOf[s.id] ?? [];
    // The task that waits for this one (a dependency), to start next by hand.
    const next = task
      ? edges
        .filter((e) => e.fromTaskId === task.id)
        .map((e) => tasks.get(e.toTaskId))
        .filter((t): t is Task => !!t && t.status !== "done" && t.status !== "canceled")
        .sort((a, b) => a.sortOrder - b.sortOrder)[0]
      : undefined;
    return {
      id: s.id,
      status: s.status,
      agent: s.agent,
      surface: s.surface,
      device: s.deviceId ? devices.get(s.deviceId) ?? null : null,
      url: s.url,
      folder: s.folder,
      branch: s.branch,
      startedAt: s.startedAt,
      finishedAt: s.finishedAt,
      endedAt: s.endedAt,
      endAt: active(s) || s.status === "finished" ? null : endAt(s),
      note: s.note,
      cliSessionId: s.cliSessionId,
      usage: s.usage ?? null,
      origin: events.some((e) => e.kind === "attached" || (e.kind === "started" && /^Started outside (Organizer|PacedMind)$/.test(e.text))) ? "outside" : "organizer",
      task: task ? { id: task.id, key: task.key, title: task.title } : null,
      project: project ? { id: project.id, name: project.name } : null,
      href: task ? taskHref(task) : null,
      events,
      reports: reports.get(s.id) ?? [],
      pending: pending.get(s.id) ?? [],
      canRequestChanges: (s.status === "finished" || s.status === "done")
        && !changesProblemIn(s, { task, live: busy.has(s.taskId), newest: newestOfTask.get(s.taskId) }),
      changesVia: s.status === "finished" || s.status === "done"
        ? changesViaIn(s, { task, live: busy.has(s.taskId), newest: newestOfTask.get(s.taskId) }) : null,
      deviceId: s.deviceId,
      asksTrust: !!trustAsks && active(s) && s.agent === "claude" && s.surface === "terminal" && !!s.folder && runsHere(s.deviceId) && trustAsks(s.folder),
      next: next
        ? {
          id: next.id, key: next.key, title: next.title, href: taskHref(next),
          canStart: (next.status === "todo" || next.status === "backlog") && !busy.has(next.id),
        }
        : null,
    };
  };

  const needsAttention = (s: Session) => !!attentionOf(eventsOf[s.id] ?? []);
  const groups: SessionGroup[] = (
    [
      { id: "finished", name: "Finished, waiting for you", items: finished.map(item) },
      { id: "attention", name: "Needs attention", items: running.filter(needsAttention).map(item) },
      { id: "starting", name: "Starting", items: running.filter((s) => s.status === "starting" && !needsAttention(s)).map(item) },
      { id: "running", name: "Running", items: running.filter((s) => s.status === "running" && !needsAttention(s)).map(item) },
      { id: "today", name: "Ended today", items: endedToday.map(item) },
      { id: "earlier", name: "Earlier", items: shownEarlier.map(item) },
    ] satisfies SessionGroup[]
  ).filter((g) => g.items.length);

  const shown = groups.flatMap((g) => g.items);
  const newest = [...shown].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  const initialId = (selected && shown.some((s) => s.id === selected) ? selected : null)
    ?? finished[0]?.id ?? running.find(needsAttention)?.id ?? running[0]?.id ?? newest?.id ?? null;

  // Tasks an agent could pick up right now, for the "Start session" menu.
  const rank: Partial<Record<Status, number>> = { progress: 0, todo: 1, backlog: 2 };
  const startable = [...tasks.values()]
    .filter((t) => rank[t.status] !== undefined && !busy.has(t.id))
    .map((t) => ({ t, p: t.projectId ? projects.get(t.projectId) : undefined }))
    .filter(({ t, p }) => t.agent !== "human" && (t.agent || p?.agent))
    .sort((a, b) =>
      rank[a.t.status]! - rank[b.t.status]! || (a.t.priority || 5) - (b.t.priority || 5) ||
      (a.p?.sort ?? 999) - (b.p?.sort ?? 999) || a.t.sortOrder - b.t.sortOrder)
    .slice(0, 20)
    .map(({ t, p }) => ({ id: t.id, key: t.key, title: t.title, agent: agentOf(t, p?.agent) ?? "claude" }));

  // Tasks a session PacedMind didn't start can be attached to: open ones an agent may work on, their project's first.
  const attachable = [...tasks.values()]
    .filter((t) => t.status !== "done" && t.status !== "canceled" && t.agent !== "human")
    .map((t) => ({ t, p: t.projectId ? projects.get(t.projectId) : undefined }))
    .sort((a, b) => (a.p?.sort ?? 999) - (b.p?.sort ?? 999) || a.t.sortOrder - b.t.sortOrder)
    .slice(0, 400)
    .map(({ t }) => ({ id: t.id, key: t.key, title: t.title, projectId: t.projectId, busy: busy.has(t.id) }));

  return { groups, initialId, startable, attachable };
}
