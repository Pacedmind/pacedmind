import "server-only";
import * as repo from "./repo";
import type { StoredImage } from "./attachments";
import { revokeSessionTokens } from "./device";
import { changesSurfaceProblem, forgetSessionFiles, reopenForChanges, reopenProblem, type LaunchResult } from "./launcher";
import { MODE } from "./supabase";
import { takeDiff } from "./diff";
import { markProject } from "./marker";
import { addDaysStr, dateOnly, dayDiff, nowStamp, timeOf, toDateStr } from "@/lib/dates";
import { nextRepeat } from "@/lib/repeat";
import {
  ANSWERS_HEADING, LIVE_STATUSES, isAnswers, isLiveSession,
  type Project, type Report, type ReportCriterion, type ReportOutcome, type Session, type Task,
} from "@/lib/types";

/* Operations shared by the Server Actions (the UI) and the MCP tools, so both behave the same. */

/**
 * Call after a task's status became done: a repeating task comes back, and its finished sessions count as reviewed.
 * A cloud session never reports back, so marking its task done ends it too.
 */
export async function afterTaskDone(taskId: number): Promise<void> {
  await repeatTask(taskId);
  const finished = await repo.listAllSessions({ taskId, status: ["finished"] });
  for (const s of finished) {
    await repo.updateSession(s.id, { status: "done" });
    await repo.addSessionEvent(s.id, "done", "You marked it done");
  }
  for (const s of await repo.listAllSessions({ taskId, surface: "cloud", status: LIVE_STATUSES })) {
    await repo.updateSession(s.id, { status: "done", finishedAt: nowStamp() });
    await repo.addSessionEvent(s.id, "done", "You marked it done");
  }
  // Their agents are done with PacedMind.
  if (MODE === "desktop") {
    revokeSessionTokens(finished.map((s) => s.id));
    forgetSessionFiles(finished.map((s) => s.id));
  }
}

/**
 * A repeating task that's done comes back as a new one, at its next date: its planned day and deadline move on by
 * the same number of days (the deadline keeps its time), a task with neither gets the next day from today, and its
 * sub-tasks come back unticked. The repeat moves on to the new task, so the done one repeats only once. Null when
 * the task doesn't repeat, isn't done, or already came back.
 */
export async function repeatTask(taskId: number): Promise<Task | null> {
  const t = await repo.getTask(taskId);
  if (!t?.repeat || t.status !== "done") return null;
  const today = toDateStr(new Date());
  const from = t.plannedDate ?? (t.dueDate ? dateOnly(t.dueDate) : today);
  const next = nextRepeat(t.repeat, from, today);
  const shift = dayDiff(from, next);
  const moved = (v: string) => (timeOf(v) ? `${addDaysStr(v, shift)}T${timeOf(v)}` : addDaysStr(v, shift));
  await repo.updateTask(t.id, { repeat: null });
  const again = await repo.createTask({
    title: t.title, description: t.description, areaId: t.areaId, projectId: t.projectId, relatedProjectId: t.relatedProjectId,
    priority: t.priority, estimateMin: t.estimateMin, labels: t.labels, doneWhen: t.doneWhen, needs: t.needs, agent: t.agent,
    runIn: t.runIn, deviceId: t.deviceId, modelSettings: t.modelSettings, repeat: t.repeat,
    plannedDate: t.plannedDate || !t.dueDate ? next : null, plannedTime: t.plannedDate ? t.plannedTime : null,
    dueDate: t.dueDate ? moved(t.dueDate) : null,
  });
  for (const s of t.subtasks) await repo.addSubtask(again.id, s.title);
  return again;
}

/** The session an agent works in on a task: the one it names, else the task's running one. */
export async function activeSession(taskId: number, sessionId?: string | null): Promise<Session | null> {
  if (sessionId) {
    const s = await repo.getSession(sessionId);
    if (s && s.taskId === taskId) return s;
  }
  return (await repo.listAllSessions({ taskId, status: LIVE_STATUSES }))[0] ?? null;
}

/** What an agent hands back with finish_task besides its summary (the note). The images are already stored. */
export interface HandBack {
  outcome: ReportOutcome;
  details?: string;
  criteria?: ReportCriterion[];
  verify?: string[];
  questions?: string[];
  links?: { label: string; url: string }[];
  followUps?: string[];
  images?: { img: StoredImage; caption?: string }[];
}

/**
 * The work on a task is finished and waits for your check: its session and the task say so. An agent's hand-back
 * comes with a report. `session` is the session to finish when the caller already knows it (a session token's own).
 */
export async function finishTask(
  taskId: number, sessionId: string | null, note: string, by: "agent" | "you" | "cloud", report?: HandBack, session?: Session | null,
): Promise<{ session: Session | null }> {
  const s = session === undefined ? await activeSession(taskId, sessionId) : session;
  if (s) {
    await repo.updateSession(s.id, { status: "finished", finishedAt: nowStamp(), note: note.slice(0, 2000) || null });
    await repo.addSessionEvent(s.id, "finished", (by === "you" ? `You marked it finished${note ? `: ${note}` : ""}` : note).slice(0, 2000));
    if (report) {
      const { images = [], ...fields } = report;
      // What changed in its folder since it started, when it started on this computer (diff.ts).
      const diff = MODE === "desktop" ? await takeDiff(s.id) : null;
      const reportId = await repo.createReport({ sessionId: s.id, taskId, summary: note, ...fields, diff });
      for (const x of images) await repo.addAttachment(x.img, { taskId, sessionId: s.id, reportId, caption: x.caption });
    }
  }
  await repo.updateTask(taskId, { status: "review" });
  return { session: s };
}

/** Saves a project; a new folder gets its pacedmind.md. */
export async function saveProject(id: string, patch: Partial<Omit<Project, "id">>): Promise<void> {
  await repo.updateProject(id, patch);
  if (patch.folder) {
    const p = await repo.getProject(id);
    if (p) await markProject(p);
  }
}

/** Closes a session by hand, e.g. when its terminal was closed or it got stuck before the agent checked in. */
export async function closeSession(sessionId: string): Promise<boolean> {
  const s = await repo.getSession(sessionId);
  if (!s) return false;
  // Its agent loses PacedMind access now, whatever its terminal does next.
  if (MODE === "desktop") {
    revokeSessionTokens([sessionId]);
    forgetSessionFiles([sessionId]);
  }
  if (isLiveSession(s)) {
    await repo.updateSession(sessionId, { status: "closed", endedAt: nowStamp() });
    await repo.addSessionEvent(sessionId, "closed", "You closed the session");
    const task = await repo.getTask(s.taskId);
    if (task?.status === "progress") await repo.updateTask(task.id, { status: "todo" });
  }
  return true;
}

/**
 * Why the user can't send changes to this session's agent right now, or null, from what the caller already has:
 * the session's task, whether the task has a running session, and its newest report. `where` "here" (the default):
 * whether this computer can reopen it itself; "remote": whether a request to the computer the session ran on can
 * (the web app, or another computer's session), which that computer checks again with "here". The app offers
 * Request changes only where this is null, so the button and requestChanges agree.
 */
export function changesProblemIn(
  s: Session, ctx: { task: Task | null | undefined; live: boolean; newest: Report | null | undefined }, where: "here" | "remote" = "here",
): string | null {
  if (s.status !== "finished" && s.status !== "done") return "The agent hasn't handed this task back yet";
  const task = ctx.task;
  if (!task) return "The task is gone";
  if (task.agent === "human") return `${task.key} is marked as yours. Hand it to Claude Code or Codex first.`;
  if (ctx.live) return "This task already has a running session";
  const elsewhere = where === "here"
    ? reopenProblem(s)
    : (changesSurfaceProblem(s) ?? (s.deviceId ? null : "This session didn't run on a computer of your account, so there's nowhere to send the changes."));
  if (elsewhere) return elsewhere;
  // The agent reads the changes with the task's latest report (start_task), so they can only go on that one.
  if (ctx.newest && ctx.newest.sessionId !== s.id) return `${task.key} has a newer report. Ask for the changes on that one.`;
  return null;
}

/**
 * The computer to send changes to for a session that can't take them from here (the web app, another computer's
 * session), or null: when this computer can reopen it itself, or nobody can.
 */
export function changesViaIn(s: Session, ctx: { task: Task | null | undefined; live: boolean; newest: Report | null | undefined }): string | null {
  if (!s.deviceId || !changesProblemIn(s, ctx) || changesProblemIn(s, ctx, "remote")) return null;
  return s.deviceId;
}

/** changesProblemIn for one session, looking up what it needs. */
export async function changesProblem(s: Session, where: "here" | "remote" = "here"): Promise<string | null> {
  const [task, live, newest] = await Promise.all([
    repo.getTask(s.taskId), repo.listAllSessions({ taskId: s.taskId, status: LIVE_STATUSES }), repo.latestReport(s.taskId),
  ]);
  return changesProblemIn(s, { task, live: live.length > 0, newest }, where);
}

/**
 * The user read an agent's hand-back and wants changes. They go on the session's last report, where start_task
 * finds them, and the session reopens in a new terminal, in a new conversation (reopenForChanges in launcher.ts).
 * Answers to the agent's questions go the same way (their text starts with ANSWERS_HEADING). The task goes back to in
 * progress, also when it was already marked done. From the desktop app's own window, or a request you allowed there
 * (an agent's request_changes waits for you, see requests.ts).
 */
export async function requestChanges(sessionId: string, changes: string): Promise<LaunchResult> {
  const text = changes.trim().slice(0, 20000);
  const s = await repo.getSession(sessionId);
  if (!s) return { ok: false, error: "Session not found" };
  if (!text) return { ok: false, error: "Write what should change" };
  const problem = await changesProblem(s);
  if (problem) return { ok: false, error: problem };
  // Hand-backs from before reports existed only left a note; it becomes their report.
  const report = await repo.latestSessionReport(s.id);
  const reportId = report?.id ?? await repo.createReport({
    sessionId: s.id, taskId: s.taskId, outcome: "done", summary: (s.note || "Handed back without a report").slice(0, 2000),
    createdAt: s.finishedAt ?? undefined,
  });
  // Written before the terminal opens, so the agent finds it however fast it starts; so is the session running
  // again, or the agent's first call would find it ended. The hand-back's time stays on its report.
  await repo.setReportChanges(reportId, text, nowStamp());
  await repo.updateSession(s.id, { status: "running", finishedAt: null, endedAt: null });
  const r = await reopenForChanges(s.id);
  if (!r.ok) {
    // Nothing changes when the terminal doesn't open: the request goes, and so does a report made for it.
    await repo.updateSession(s.id, { status: s.status, finishedAt: s.finishedAt, endedAt: s.endedAt });
    if (report) await repo.setReportChanges(reportId, report.changes ?? null, report.changesAt ?? null);
    else await repo.deleteReport(reportId);
    return r;
  }
  const said = isAnswers(text) ? text.slice(ANSWERS_HEADING.length).trim() : text;
  const short = said.length > 140 ? `${said.slice(0, 140).trimEnd()}…` : said;
  await repo.addSessionEvent(s.id, "changes_requested", isAnswers(text) ? `You answered its questions: ${short}` : `You asked for changes: ${short}`);
  await repo.updateTask(s.taskId, { status: "progress" });
  return { ok: true, session: (await repo.getSession(s.id))!, message: r.message };
}

/* ---------- dependencies ---------- */

/** Whether making toId wait for fromId would close a loop (fromId already waits, directly or not, for toId). */
export async function edgeWouldLoop(fromId: number, toId: number): Promise<boolean> {
  const edges = await repo.listEdges();
  const seen = new Set<number>();
  const stack = [toId];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === fromId) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const e of edges) if (e.fromTaskId === cur) stack.push(e.toTaskId);
  }
  return false;
}

/** Whether making `projectId` start after `afterId` would make projects wait for each other in a circle. */
export async function startsAfterWouldLoop(projectId: string, afterId: string): Promise<boolean> {
  const byId = new Map((await repo.listAllProjects()).map((p) => [p.id, p]));
  const seen = new Set<string>();
  for (let cur: string | null = afterId; cur && !seen.has(cur); cur = byId.get(cur)?.afterProjectId ?? null) {
    if (cur === projectId) return true;
    seen.add(cur);
  }
  return false;
}
