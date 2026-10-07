"use server";

import { refresh } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import * as repo from "@/server/repo";
import { importLegacy, moveToThisComputer, resetAccount } from "@/server/account";
import { billingPortal, readPlan, subscribe } from "@/server/billing";
import { deleteCopy, restoreCopy } from "@/server/copies";
import { usesCloud } from "@/server/scope";
import { resetLocal } from "@/server/store/local-db";
import { checkThisDevice, deviceIdFor, offeredDevice, runsHere, thisDeviceId, toolsHere } from "@/server/devices";
import { deviceWithNeeds, missingFrom, needList } from "@/lib/needs";
import { mcpUrl, plannedFolder, resumeSession, startSession } from "@/server/launcher";
import {
  afterTaskDone, changesProblem, closeSession, edgeWouldLoop, finishTask, repeatTask, requestChanges, saveProject,
} from "@/server/ops";
import { approve, cutOffAgents, deny } from "@/server/requests";
import { commandProblem, deviceConfig, rotateOwnerToken, setAreaFolder, setProjectServers, updateDevice } from "@/server/device";
import { folderProblem } from "@/server/folders";
import { markAll, markArea, markProject } from "@/server/marker";
import { connectClaudeCode, connectCodex } from "@/server/connect";
import { findWork, importAreas, importProjects, keyOf, type FoundArea, type FoundProject, type ImportArea, type ImportItem } from "@/server/import";
import { linkFolder, mergeProjects } from "@/server/project-links";
import { changePreferences, type PreferenceChanges } from "@/server/preferences";
import { approveFolder, isFolderApproval, refuseFolder } from "@/server/folder-requests";
import { STEP_UP_REFUSED, codeFreshUntil, refusedStepUp, verifyCode } from "@/server/step-up";
import { MODE, readAuthState, supabase } from "@/server/supabase";
import { guardAction as guard } from "@/server/guard";
import { computerAccessProblem } from "@/server/computer-access";
import { answerHere, askedHere, withdrawHere } from "@/server/asks";
import { PUSH_ENDPOINT, ensurePushKeys } from "@/server/push";
import { repoIdentity } from "@/server/git-remote";
import { attachOutsideSession, type AttachInput } from "@/server/attach";
import { areaIconOf, isAreaIcon } from "@/lib/area-icons";
import { READ_ONLY_MESSAGE, type BillingPeriod } from "@/lib/billing";
import { areaPictureProblem } from "@/lib/area-picture";
import { addDaysStr, dateOnly, dayDiff, fmtDay, parseLocal, timeOf, toDateTimeStr } from "@/lib/dates";
import {
  AGENT_LABEL, CONNECT_CARD_COOKIE, LIVE_STATUSES, agentOf, deviceOnline, isLiveSession,
  type AgentId, type Device, type LaunchRequestKind, type Project, type RemoteStart, type Settings, type Surface,
  type TerminalId,
} from "@/lib/types";

type Result = { ok: boolean; error?: string; message?: string };

function done<T extends Result = Result>(r: T = { ok: true } as T): T {
  refresh();
  return r;
}

const errorOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/* ---------- tasks ---------- */

export async function createTaskAction(input: repo.TaskInput & { subtasks?: string[] }): Promise<Result & { key?: string }> {
  await guard();
  if (!input.title?.trim()) return { ok: false, error: "Give the task a title" };
  const t = await repo.createTask(input);
  for (const s of input.subtasks ?? []) await repo.addSubtask(t.id, s);
  refresh();
  return { ok: true, key: t.key };
}

/** A task's own folder is this computer's setting, so it's checked here (repo.updateTask). */
export async function updateTaskAction(id: number, patch: repo.TaskPatch): Promise<Result> {
  await guard();
  const before = await repo.getTask(id);
  if (!before) return { ok: false, error: "Task not found" };
  if (patch.folder !== undefined && MODE !== "desktop") return { ok: false, error: "Folders are set in the PacedMind desktop app." };
  const bad = patch.folder ? folderProblem(patch.folder) : null;
  if (bad) return { ok: false, error: `Can't use ${patch.folder}: ${bad}` };
  try {
    await repo.updateTask(id, patch);
  } catch (e) {
    return { ok: false, error: errorOf(e) };
  }
  if (patch.status === "done" && before.status !== "done") {
    // A repeating task comes back first, so the message can say when.
    const again = await repeatTask(id);
    await afterTaskDone(id);
    return done({ ok: true, message: again ? `${before.key} comes back as ${again.key} on ${fmtDay(again.plannedDate ?? again.dueDate!)}` : undefined });
  }
  return done();
}

export async function deleteTaskAction(id: number) {
  await guard();
  await repo.deleteTask(id);
  return done();
}

export async function addSubtaskAction(taskId: number, title: string) {
  await guard();
  if (title.trim()) await repo.addSubtask(taskId, title);
  return done();
}

export async function toggleSubtaskAction(id: number, isDone: boolean) {
  await guard();
  await repo.setSubtaskDone(id, isDone);
  return done();
}

export async function deleteSubtaskAction(id: number) {
  await guard();
  await repo.deleteSubtask(id);
  return done();
}

/* ---------- events ---------- */

export async function createEventAction(input: { title: string; areaId?: string | null; start: string; end: string; recurrence?: "weekly" | null }) {
  await guard();
  if (!input.title?.trim()) return { ok: false, error: "Give the activity a title" };
  await repo.createEvent(input);
  return done();
}

/** A real local date and time, "YYYY-MM-DDTHH:mm". */
const isStamp = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s) && toDateTimeStr(parseLocal(s)) === s;

/**
 * Changes an activity from one of its days: `occurrence` is the start it had there. A weekly activity changes every
 * week. Moved to another day, the whole series moves by as many days and keeps its first week; made one-off, it
 * stays only on the day the change gives it.
 */
export async function updateEventAction(id: number, occurrence: string, input: { title: string; areaId: string | null; start: string; end: string; weekly: boolean }) {
  await guard();
  const e = await repo.getEvent(id);
  if (!e) return { ok: false, error: "That activity is no longer in the calendar" };
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (!title) return { ok: false, error: "Give the activity a title" };
  if (title.length > 200) return { ok: false, error: "Keep the title under 200 characters" };
  if (!isStamp(occurrence) || !isStamp(input.start) || !isStamp(input.end)) return { ok: false, error: "That isn't a day and time" };
  if (dateOnly(input.end) !== dateOnly(input.start)) return { ok: false, error: "An activity starts and ends on the same day" };
  if (input.end <= input.start) return { ok: false, error: "The end has to be after the start" };
  let { start, end } = input;
  if (e.recurrence === "weekly" && input.weekly) {
    const first = addDaysStr(e.start, dayDiff(occurrence, start));
    start = `${first}T${timeOf(start)}`;
    end = `${first}T${timeOf(end)}`;
  }
  await repo.updateEvent(id, { title, areaId: input.areaId ?? null, start, end, recurrence: input.weekly ? "weekly" : null });
  return done();
}

/** Marks an activity done, or not done, on one day: `day` is its occurrence's date ("YYYY-MM-DD"). */
export async function setEventDoneAction(id: number, day: string, isDone: boolean) {
  await guard();
  if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !isStamp(`${day}T00:00`)) return { ok: false, error: "That isn't a day" };
  if (!(await repo.getEvent(id))) return { ok: false, error: "That activity is no longer in the calendar" };
  await repo.setEventDone(id, day, isDone === true);
  return done();
}

export async function deleteEventAction(id: number) {
  await guard();
  await repo.deleteEvent(id);
  return done();
}

/* ---------- sessions ---------- */

const SURFACES = new Set<Surface>(["terminal", "desktop", "cloud"]);

/**
 * What start, resume and changes answer when they can't run on this computer (the web app has none, and a task or
 * session can belong to another computer): `remote`, with the computer to offer (`deviceId`, null when there's none to
 * suggest) and whether it's the only one that can take it (`pinned`: the task or its project names it, or the session
 * ran there). The page then asks that computer, with a fresh two-factor code unless it takes requests without one:
 * requestSessionAction, requestResumeAction or requestChangesRemoteAction.
 */
type Remote = {
  remote?: boolean; deviceId?: string | null; pinned?: boolean;
  /** Offered instead of starting here: what the task needs that the agent doesn't have on this computer. */
  missingHere?: string[];
};

/**
 * What a request to a computer answers: the request's id once sent (it shows in /api/state's `requests`), and
 * `needCode` when it needs a current two-factor code first (none was given, none was entered in the last four minutes,
 * and the computer doesn't take requests without one), or the one given didn't do.
 */
type Requested = Result & { requestId?: string; needCode?: boolean };

/**
 * Starts a session: in the desktop app, where the task says (a terminal or the agent's app here, or its cloud).
 * The web app can't start anything, and a task that runs on another computer starts there: both answer `remote`,
 * offering the computer the task names, else its project's, else one whose agent has what the task needs, else the
 * account's default. A task that needs something (Task.needs) the agent doesn't have here, when another computer has
 * it, answers `remote` too, with that computer and what's missing here (`missingHere`), unless `anyway`.
 */
export async function startSessionAction(
  taskId: number, agent?: AgentId | null, surface?: Surface, anyway = false,
): Promise<Result & Remote> {
  await guard();
  const access = await computerAccessProblem();
  if (access) return { ok: false, error: access };
  if (surface && !SURFACES.has(surface)) return { ok: false, error: "Unknown place to run the session" };
  const task = await repo.getTask(taskId);
  if (!task) return { ok: false, error: "Task not found" };
  const project = task.projectId ? await repo.getProject(task.projectId) : null;
  const who = agent ?? agentOf(task, project?.agent);
  if (MODE === "web") {
    return { ok: false, remote: true, ...offeredDevice(task, project, await repo.listDevices(), who), error: "Choose a computer to start it on." };
  }
  const runsOn = deviceIdFor(task.deviceId, project?.deviceId);
  if (runsOn && !runsHere(runsOn)) return { ok: false, remote: true, deviceId: runsOn, pinned: true, error: `${task.key} runs on another computer.` };
  const missing = who && task.needs.length && surface !== "cloud" ? missingFrom(task.needs, toolsHere(who, plannedFolder(task))) : [];
  if (missing.length && !anyway && !runsOn && (await usesCloud())) {
    const other = deviceWithNeeds(task.needs, who!, (await repo.listDevices()).filter((d) => d.id !== thisDeviceId()));
    if (other) {
      return {
        ok: false, remote: true, deviceId: other.id, pinned: false, missingHere: missing,
        error: `${task.key} needs ${needList(missing)}, which ${AGENT_LABEL[who!]} doesn't have on this computer. ${other.name} has everything it needs.`,
      };
    }
  }
  const r = await startSession(taskId, { agent: agent ?? undefined, surface, reason: "you" });
  const started = r.message ?? "Session started";
  const lacks = missing.length ? `${/[.!?]$/.test(started) ? "" : "."} ${AGENT_LABEL[who!]} doesn't have ${needList(missing)} here, which ${task.key} needs.` : "";
  return done(r.ok ? { ok: true, message: `${started}${lacks}` } : { ok: false, error: r.error });
}

/**
 * The computer a request goes to, when it's signed in and takes requests (its setting as it last said: the computer
 * decides for itself when the request arrives).
 */
async function requestTarget(deviceId: string | null | undefined): Promise<Device | string> {
  if (!(await usesCloud())) return "Sign in to PacedMind Cloud to use your other computers.";
  const access = await computerAccessProblem();
  if (access) return access;
  const device = deviceId ? await repo.getDevice(deviceId) : null;
  if (!device || device.revokedAt) return "That computer isn't signed in to PacedMind anymore.";
  if (device.remoteStart === "off") return `${device.name} doesn't take sessions from elsewhere. Change that in its Settings.`;
  return device;
}

/**
 * The fresh two-factor code a request to a computer needs: `code` when given, else one this session entered in the
 * last four minutes. The database checks the code's time and authenticator either way. Null when the request can go.
 */
async function stepUp(code: string | null | undefined): Promise<Requested | null> {
  if (code?.trim()) {
    const wrong = await verifyCode(await supabase(), code);
    return wrong ? { ok: false, error: wrong, needCode: true } : null;
  }
  const until = codeFreshUntil(await readAuthState());
  return until && until > Date.now() ? null : { ok: false, error: "Enter a current two-factor code.", needCode: true };
}

/** What the computer does with a request, as its setting last said, for the message after sending it. */
function sentMessage(device: Device, kind: LaunchRequestKind, asks: boolean): string {
  const now = asks
    ? { start: "allow it there to start", resume: "allow it there to resume the session", changes: "allow it there to send the changes" }[kind]
    : { start: "it starts within seconds", resume: "it opens within seconds", changes: "the agent gets your changes within seconds" }[kind];
  const away = deviceOnline(device) ? "" : ` It hasn't been online in the last few minutes; the request waits there for 10 minutes.`;
  return `Sent to ${device.name}: ${now}.${away}`;
}

/**
 * Sends a request, after its fresh code: `code`, one entered in the last four minutes, or none for a computer that takes
 * requests without one (as its entry says; the database checks that entry itself).
 */
async function sendRequest(input: repo.LaunchRequestInput, device: Device, code: string, asks: boolean): Promise<Requested> {
  const given = !!(code ?? "").trim();
  if (device.remoteCode || given) {
    const stale = await stepUp(code);
    if (stale) return stale;
  }
  try {
    const r = await repo.createLaunchRequest(input);
    return done({ ok: true, requestId: r.id, message: sentMessage(device, input.kind ?? "start", asks) });
  } catch (e) {
    const message = errorOf(e);
    if (!refusedStepUp(message)) return { ok: false, error: message };
    // A code from an authenticator added in this session doesn't count (SECURITY.md), and neither does an old one. A
    // computer that took requests without a code may have switched that off since the page read it.
    return {
      ok: false, needCode: true,
      error: given ? STEP_UP_REFUSED : device.remoteCode ? "Enter a current two-factor code." : `${device.name} asks for a two-factor code now. Enter a current one.`,
    };
  }
}

/**
 * Asks a computer to start a session for a task, where the task says or on `surface`. Needs a fresh two-factor code,
 * unless the computer takes requests without one: `code`, or "" to use one entered in the last four minutes (or none).
 * A task or project that names its computer starts only there, so another computer is refused here already.
 */
export async function requestSessionAction(
  taskId: number, agent: AgentId, deviceId: string, code: string, surface?: Surface | null,
): Promise<Requested> {
  await guard();
  if (agent !== "claude" && agent !== "codex") return { ok: false, error: "Choose Claude Code or Codex." };
  if (surface && !SURFACES.has(surface)) return { ok: false, error: "Unknown place to run the session" };
  const task = await repo.getTask(taskId);
  if (!task) return { ok: false, error: "Task not found" };
  if (task.agent === "human") return { ok: false, error: `${task.key} is marked as yours. Hand it to Claude Code or Codex first.` };
  if ((await repo.listSessions({ taskId, status: LIVE_STATUSES })).length) return { ok: false, error: `${task.key} already has a running session` };
  const device = await requestTarget(deviceId);
  if (typeof device === "string") return { ok: false, error: device };
  const project = task.projectId ? await repo.getProject(task.projectId) : null;
  const named = deviceIdFor(task.deviceId, project?.deviceId);
  if (named && named !== device.id) {
    const other = await repo.getDevice(named);
    return { ok: false, error: `${task.key} runs on ${other?.name ?? "another computer"}. Send it there, or pick another computer in its details.` };
  }
  // A session in the agent's cloud always waits for you on the computer, whatever its setting.
  const asks = device.remoteStart !== "auto" || (surface ?? task.runIn) === "cloud";
  return sendRequest({ deviceId: device.id, taskId, agent, via: MODE === "web" ? "web" : "desktop", kind: "start", surface: surface ?? null }, device, code, asks);
}

/**
 * Picks a session up again where it ran, or in the desktop app (`surface` "desktop"). From the web app, and for a
 * session that ran on another computer, it answers `remote` with that computer (a cloud session can be pulled in on any
 * computer from its desktop app, and from the web app on the one that sent it).
 */
export async function resumeSessionAction(sessionId: string, surface?: Surface): Promise<Result & Remote> {
  await guard();
  const access = await computerAccessProblem();
  if (access) return { ok: false, error: access };
  if (surface && !SURFACES.has(surface)) return { ok: false, error: "Unknown place to open the session" };
  const s = await repo.getSession(sessionId);
  if (!s) return { ok: false, error: "Session not found" };
  if (MODE === "web" || (s.surface !== "cloud" && !runsHere(s.deviceId))) {
    if (!s.deviceId) return { ok: false, error: "This session didn't run on a computer of your account, so it can't be resumed from here." };
    return { ok: false, remote: true, deviceId: s.deviceId, pinned: true, error: "Resume it on the computer it ran on." };
  }
  const r = await resumeSession(sessionId, surface);
  return done(r.ok ? { ok: true, message: r.message } : { ok: false, error: r.error });
}

/**
 * Reopens a running terminal session in a new terminal, when its own is gone (closed, crashed, the computer restarted)
 * or you closed it after its agent lost PacedMind: the conversation goes on there (resumeSession with `reopen`). What the
 * old terminal still waited for an answer to is withdrawn, since no one there would get it.
 */
export async function reopenSessionAction(sessionId: string): Promise<Result> {
  await guard();
  const access = await computerAccessProblem();
  if (access) return { ok: false, error: access };
  if (MODE !== "desktop") return { ok: false, error: "Reopen it from the PacedMind desktop app on the computer it runs on." };
  const s = await repo.getSession(sessionId);
  if (!s) return { ok: false, error: "Session not found" };
  if (!runsHere(s.deviceId)) return { ok: false, error: "That session runs on another computer. Reopen it there." };
  const stale = await repo.listAsks({ sessionIds: [sessionId], status: ["pending"] });
  const r = await resumeSession(sessionId, undefined, true);
  if (!r.ok) return { ok: false, error: r.error };
  for (const a of stale) await withdrawHere(a.id).catch(() => {});
  return done({ ok: true, message: r.message });
}

/**
 * Asks the computer a session ran on to pick it up again: where it ran, or with `surface` "desktop" a Claude Code
 * conversation moves from its terminal into the Claude app. Needs a fresh code, like requestSessionAction.
 */
export async function requestResumeAction(sessionId: string, code: string, surface?: Surface | null): Promise<Requested> {
  await guard();
  if (surface === "cloud" || (surface && !SURFACES.has(surface))) return { ok: false, error: "A session resumes where it ran, or in the Claude app." };
  const s = await repo.getSession(sessionId);
  if (!s) return { ok: false, error: "Session not found" };
  if (!(await repo.getTask(s.taskId))) return { ok: false, error: "The task is gone" };
  if (!s.deviceId) return { ok: false, error: "This session didn't run on a computer of your account, so it can't be resumed from here." };
  const to = surface === "desktop" ? "desktop" : null;
  if (!to && s.surface === "terminal" && isLiveSession(s)) {
    return { ok: false, error: "That session is still running in its terminal. If its terminal is gone, reopen it in the PacedMind app on its computer." };
  }
  const device = await requestTarget(s.deviceId);
  if (typeof device === "string") return { ok: false, error: device };
  // Pulling a cloud session in runs its work on the computer, so that always waits for you there.
  const asks = device.remoteStart !== "auto" || s.surface === "cloud";
  return sendRequest({
    deviceId: device.id, taskId: s.taskId, agent: s.agent, via: MODE === "web" ? "web" : "desktop", kind: "resume", targetSessionId: s.id, surface: to,
  }, device, code, asks);
}

/** For sessions that can't report back (the cloud, an app without PacedMind's MCP server): you say the work is finished. */
export async function finishSessionAction(sessionId: string): Promise<Result> {
  await guard();
  const s = await repo.getSession(sessionId);
  if (!s) return { ok: false, error: "Session not found" };
  if (s.status !== "starting" && s.status !== "running") return { ok: false, error: "The session isn't running" };
  await finishTask(s.taskId, s.id, "", "you", undefined, s);
  return done({ ok: true, message: `${(await repo.getTask(s.taskId))?.key ?? "The task"} waits for your check` });
}

/**
 * Attaches a session PacedMind didn't start to a task, or to a new one made from its title (attach.ts). From the app,
 * for this computer's sessions; for another computer's, from anywhere: the session keeps running on that computer.
 */
export async function attachSessionAction(input: AttachInput): Promise<Result & { sessionId?: string }> {
  await guard();
  const r = await attachOutsideSession({
    computer: String(input.computer), harness: input.harness, ref: String(input.ref),
    taskId: typeof input.taskId === "number" ? input.taskId : null, title: typeof input.title === "string" ? input.title.slice(0, 200) : undefined,
    projectId: typeof input.projectId === "string" ? input.projectId : null,
  });
  if (!r.ok) return { ok: false, error: r.error };
  return done({ ok: true, message: r.message, sessionId: r.session.id });
}

/** Closes a session by hand, e.g. when its terminal was closed or it got stuck before the agent checked in. */
export async function closeSessionAction(sessionId: string): Promise<Result> {
  await guard();
  if (!(await closeSession(sessionId))) return { ok: false, error: "Session not found" };
  return done();
}

/**
 * Sends a hand-back back to its agent with what should change. It reopens in a new terminal here. From the web app, and
 * for a session that ran on another computer, it answers `remote` with that computer (requestChangesRemoteAction).
 */
export async function requestChangesAction(sessionId: string, changes: string): Promise<Result & Remote> {
  await guard();
  const access = await computerAccessProblem();
  if (access) return { ok: false, error: access };
  const s = await repo.getSession(sessionId);
  if (!s) return { ok: false, error: "Session not found" };
  if (MODE === "web" || !runsHere(s.deviceId)) {
    const problem = await changesProblem(s, "remote");
    if (problem) return { ok: false, error: problem };
    return { ok: false, remote: true, deviceId: s.deviceId, pinned: true, error: "Send the changes to the computer the session ran on." };
  }
  const r = await requestChanges(sessionId, changes);
  return done(r.ok ? { ok: true, message: r.message } : { ok: false, error: r.error });
}

/**
 * Asks the computer a session ran on to send it back to its agent with `text` (trimmed, 1 to 20,000 characters): its
 * terminal reopens there and the agent reads the changes through start_task. Needs a fresh code, like
 * requestSessionAction. Only terminal sessions take changes; the apps and the cloud take them where they run.
 */
export async function requestChangesRemoteAction(sessionId: string, text: string, code: string): Promise<Requested> {
  await guard();
  const changes = (text ?? "").trim();
  if (!changes) return { ok: false, error: "Write what should change" };
  if (changes.length > 20000) return { ok: false, error: "Keep the changes under 20,000 characters." };
  const s = await repo.getSession(sessionId);
  if (!s) return { ok: false, error: "Session not found" };
  const problem = await changesProblem(s, "remote");
  if (problem) return { ok: false, error: problem };
  const device = await requestTarget(s.deviceId);
  if (typeof device === "string") return { ok: false, error: device };
  return sendRequest({
    deviceId: device.id, taskId: s.taskId, agent: s.agent, via: MODE === "web" ? "web" : "desktop", kind: "changes", targetSessionId: s.id, changes,
  }, device, code, device.remoteStart !== "auto");
}

/**
 * Answers what a running session's agent waits for (asks.ts): "allow" or "deny" for a permission, the text for a
 * question. On the session's own computer it goes at once; from anywhere else only when that computer takes answers
 * from elsewhere, and with a two-factor code from the last five minutes (`code`, or "" to use one entered in the last
 * four), which the database checks again.
 */
export async function answerAskAction(askId: string, answer: string, code = ""): Promise<Requested> {
  await guard();
  const access = await computerAccessProblem();
  if (access) return { ok: false, error: access };
  const ask = typeof askId === "string" ? await repo.getAsk(askId) : null;
  if (!ask || ask.status !== "pending" || Date.parse(ask.expiresAt) <= Date.now()) {
    return done({ ok: false, error: "The agent isn't waiting for this answer any more." });
  }
  const value = ask.kind === "permission"
    ? (answer === "allow" || answer === "deny" ? answer : null)
    : (typeof answer === "string" ? answer.trim().slice(0, 20000) : "") || null;
  if (!value) return { ok: false, error: ask.kind === "permission" ? "Allow it or refuse it." : "Write your answer." };
  const session = await repo.getSession(ask.sessionId);
  if (!session || !isLiveSession(session)) return done({ ok: false, error: "That session isn't running any more." });
  if (await askedHere(ask)) {
    try {
      await answerHere(ask.id, value);
    } catch (e) {
      return done({ ok: false, error: errorOf(e) });
    }
    return done({ ok: true });
  }
  if (!ask.remoteOk) {
    return { ok: false, error: "Its computer takes answers only there. Answer it there, or turn on Answer from elsewhere in that computer's Settings." };
  }
  const stale = await stepUp(code);
  if (stale) return stale;
  try {
    await repo.answerAsk(ask.id, value);
  } catch (e) {
    const message = errorOf(e);
    if (!refusedStepUp(message)) return done({ ok: false, error: message });
    return { ok: false, needCode: true, error: (code ?? "").trim() ? STEP_UP_REFUSED : "Enter a current two-factor code." };
  }
  return done({ ok: true, message: "Sent. The agent gets it within a few seconds." });
}

/* ---------- notifications on your phone and in the browser (push.ts) ---------- */

const NO_PUSH = "Notifications on your phone and in the browser come with PacedMind Cloud.";

/** The account's public key for web push, which a browser subscribes with: made the first time one asks. */
export async function pushKeyAction(): Promise<Result & { publicKey?: string }> {
  await guard();
  if (!(await usesCloud())) return { ok: false, error: NO_PUSH };
  try {
    return { ok: true, publicKey: await ensurePushKeys() };
  } catch (e) {
    return { ok: false, error: errorOf(e) };
  }
}

/** Keeps a browser that turned notifications on (its PushSubscription), for the account's computers to send to. */
export async function savePushSubscriptionAction(sub: { endpoint: string; p256dh: string; auth: string; label: string }): Promise<Result> {
  await guard();
  if (!(await usesCloud())) return { ok: false, error: NO_PUSH };
  if (!sub || typeof sub.endpoint !== "string" || !PUSH_ENDPOINT.test(sub.endpoint) || typeof sub.p256dh !== "string" || typeof sub.auth !== "string") {
    return { ok: false, error: "This browser's push service isn't one PacedMind sends to." };
  }
  const label = typeof sub.label === "string" ? sub.label.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 100) : "";
  try {
    await repo.addPushSubscription({ endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth, label });
  } catch (e) {
    return { ok: false, error: errorOf(e) };
  }
  return done({ ok: true, message: "Notifications are on in this browser." });
}

/** Stops notifications to a browser (this one, or one listed in Settings). */
export async function removePushSubscriptionAction(endpoint: string): Promise<Result> {
  await guard();
  if (typeof endpoint !== "string" || !(await usesCloud())) return { ok: false, error: NO_PUSH };
  await repo.removePushSubscription(endpoint);
  return done({ ok: true, message: "Notifications are off there." });
}

/** "Answer in the terminal": the session's computer stops holding a permission, so the agent's own prompt asks there. */
export async function withdrawAskAction(askId: string): Promise<Result> {
  await guard();
  const ask = typeof askId === "string" ? await repo.getAsk(askId) : null;
  if (!ask || ask.status !== "pending") return done();
  if (!(await askedHere(ask))) return { ok: false, error: "Only the computer the session runs on can hand this to its terminal." };
  await withdrawHere(ask.id);
  return done({ ok: true, message: "Answer it in the agent's terminal." });
}

export async function markSessionDoneAction(sessionId: string): Promise<Result> {
  await guard();
  const s = await repo.getSession(sessionId);
  if (!s) return { ok: false, error: "Session not found" };
  return updateTaskAction(s.taskId, { status: "done" });
}

/** A session or a folder asked for over MCP or from elsewhere, allowed in this window. */
export async function approveLaunchAction(id: string): Promise<Result> {
  await guard();
  const access = await computerAccessProblem();
  if (access) return { ok: false, error: access };
  if (MODE !== "desktop") return { ok: false, error: "Only the desktop app starts sessions." };
  if (isFolderApproval(id)) return done(await approveFolder(id));
  const r = await approve(id);
  return done(r.ok ? { ok: true, message: r.message ?? "Session started" } : { ok: false, error: r.error });
}

export async function denyLaunchAction(id: string): Promise<Result> {
  await guard();
  if (isFolderApproval(id)) await refuseFolder(id);
  else await deny(id);
  return done();
}

/* ---------- dependencies ---------- */

/** A dependency drawn on the timeline: `toTaskId` waits for `fromTaskId`. It only orders the work; nothing starts by itself. */
export async function linkTasksAction(fromTaskId: number, toTaskId: number): Promise<Result> {
  await guard();
  const [from, to] = await Promise.all([repo.getTask(fromTaskId), repo.getTask(toTaskId)]);
  if (!from || !to) return { ok: false, error: "Task not found" };
  if (from.id === to.id) return { ok: false, error: "A task can't wait for itself" };
  if (from.projectId !== to.projectId) return { ok: false, error: `${from.key} and ${to.key} are in different projects. Dependencies stay within one project.` };
  if (await edgeWouldLoop(from.id, to.id)) return { ok: false, error: `${from.key} already waits for ${to.key}, so this would make a loop` };
  await repo.createEdge(from.id, to.id);
  return done({ ok: true, message: `${to.key} now waits for ${from.key}` });
}

export async function deleteEdgeAction(edgeId: number) {
  await guard();
  await repo.deleteEdge(edgeId);
  return done();
}

/* ---------- projects and settings ---------- */

export async function createProjectAction(input: {
  name: string; areaId: string; folder?: string | null; agent?: AgentId | null; color?: string | null;
}): Promise<Result & { id?: string }> {
  await guard();
  if (!input.name?.trim()) return { ok: false, error: "Give the project a name" };
  if (!(await repo.listAreas()).some((a) => a.id === input.areaId)) return { ok: false, error: "Pick an area for the project" };
  if (input.folder && MODE !== "desktop") return { ok: false, error: "Folders are set in the PacedMind desktop app." };
  const problem = input.folder ? folderProblem(input.folder) : null;
  if (problem) return { ok: false, error: `Can't use the folder ${input.folder}: ${problem}` };
  const p = await repo.createProject(input);
  await markProject(p);
  refresh();
  return { ok: true, id: p.id, message: `Created ${p.name}` };
}

export async function deleteProjectAction(id: string) {
  await guard();
  const p = await repo.getProject(id);
  if (!p) return { ok: false, error: "Project not found" };
  const kept = (await repo.listTasks({ projectId: id })).length;
  await repo.deleteProject(id);
  return done({ ok: true, message: kept ? `Deleted ${p.name}. Its tasks stay in the area.` : `Deleted ${p.name}` });
}

export async function createAreaAction(input: { name: string; color: string }): Promise<Result & { id?: string }> {
  await guard();
  if (!input.name?.trim()) return { ok: false, error: "Give the area a name" };
  const a = await repo.createArea(input);
  refresh();
  return { ok: true, id: a.id, message: `Created ${a.name} (${a.key})` };
}

/** `icon: null` puts the area's dot back. */
export async function updateAreaAction(id: string, patch: { name?: string; color?: string; icon?: string | null }) {
  await guard();
  if (patch.icon != null && !isAreaIcon(patch.icon)) return { ok: false, error: "Pick one of the icons" };
  await repo.updateArea(id, { name: patch.name, color: patch.color, icon: patch.icon === undefined ? undefined : areaIconOf(patch.icon) });
  return done();
}

/** The area's default workspace is local to this computer, just like a project's or task's folder. */
export async function setAreaFolderAction(id: string, folder: string | null): Promise<Result> {
  await guard();
  if (MODE !== "desktop") return { ok: false, error: "Workspaces are set in the PacedMind desktop app on this computer." };
  if (folder !== null && typeof folder !== "string") return { ok: false, error: "Enter a folder path." };
  const area = (await repo.listAreas()).find((a) => a.id === id);
  if (!area) return { ok: false, error: "Area not found" };
  const next = folder?.trim() || null;
  const error = setAreaFolder(id, next);
  if (error) return { ok: false, error };
  // The repository it holds, so your other computers can offer their copy of it.
  const holds = next ? repoIdentity(next) : null;
  if (holds && holds !== area.repo) await repo.setAreaRepo(id, holds);
  // And by its pacedmind.md, whether it holds a repository or not.
  if (next) await markArea({ ...area, folder: next });
  return done({ ok: true, message: "Workspace saved" });
}

/**
 * Gives a project the copy of it found on this computer (folder-hints.ts), as an import does for a folder that joins a
 * project: its folder here, and a project that only ran on another computer runs on both.
 */
export async function linkFoundFolderAction(projectId: string, folder: string): Promise<Result> {
  await guard();
  if (MODE !== "desktop") return { ok: false, error: "Folders are set in the PacedMind desktop app." };
  if (typeof folder !== "string") return { ok: false, error: "Choose a folder." };
  const problem = folderProblem(folder);
  if (problem) return { ok: false, error: `Can't use ${folder}: ${problem}` };
  const project = await repo.getProject(projectId);
  if (!project) return { ok: false, error: "Project not found" };
  try {
    await linkFolder(project, folder);
  } catch (e) {
    return { ok: false, error: errorOf(e) };
  }
  return done({ ok: true, message: `${project.name} works in ${folder} on this computer` });
}

/** An area's own picture: a small base64 PNG made by the browser. Null removes it. */
export async function setAreaPictureAction(id: string, picture: string | null) {
  await guard();
  const problem = picture === null ? null : typeof picture === "string" ? areaPictureProblem(picture) : "That isn't a picture.";
  if (problem) return { ok: false, error: problem };
  await repo.updateArea(id, { picture });
  return done();
}

export async function deleteAreaAction(id: string) {
  await guard();
  const [areas, projects, tasks] = await Promise.all([repo.listAreas(), repo.listProjects(), repo.listTasks()]);
  const a = areas.find((x) => x.id === id);
  if (!a) return { ok: false, error: "Area not found" };
  const own = new Set(projects.filter((p) => p.areaId === id).map((p) => p.id));
  const kept = tasks.filter((t) => t.areaId === id || (t.projectId !== null && own.has(t.projectId))).length;
  await repo.deleteArea(id);
  return done({ ok: true, message: kept ? `Deleted ${a.name}. Its tasks moved to the Inbox.` : `Deleted ${a.name}` });
}

const isIdList = (ids: unknown): ids is string[] => Array.isArray(ids) && ids.every((id) => typeof id === "string");

/**
 * `items` in the order of `ids`. Ids that are gone are skipped, and items the list leaves out (made elsewhere
 * meanwhile) keep their order after it.
 */
function inOrder<T extends { id: string }>(items: T[], ids: string[]): T[] {
  const byId = new Map(items.map((x) => [x.id, x]));
  const first = [...new Set(ids)].flatMap((id) => byId.get(id) ?? []);
  return [...first, ...items.filter((x) => !first.includes(x))];
}

/** Puts the areas in this order, as dragged in the sidebar. */
export async function reorderAreasAction(ids: string[]): Promise<Result> {
  await guard();
  if (!isIdList(ids)) return { ok: false, error: "That isn't a list of areas." };
  const areas = inOrder(await repo.listAreas(), ids);
  await Promise.all(areas.map((a, i) => (a.sort !== i + 1 ? repo.updateArea(a.id, { sort: i + 1 }) : null)));
  return done();
}

/**
 * Merges projects into one, such as the copies two computers made of the same project: their tasks move into
 * `intoId` and keep their keys, and they're deleted (project-links.ts).
 */
export async function mergeProjectsAction(fromIds: string[], intoId: string): Promise<Result> {
  await guard();
  if (!isIdList(fromIds) || typeof intoId !== "string") return { ok: false, error: "That isn't a list of projects." };
  const r = await mergeProjects(fromIds, intoId);
  if ("error" in r) return { ok: false, error: r.error };
  const what = r.merged.length === 1 ? r.merged[0].name : `${r.merged.length} projects`;
  return done({ ok: true, message: `Merged ${what} into ${r.into.name}` });
}

/** Puts the projects in this order, as dragged in the sidebar. */
export async function reorderProjectsAction(ids: string[]): Promise<Result> {
  await guard();
  if (!isIdList(ids)) return { ok: false, error: "That isn't a list of projects." };
  const projects = inOrder(await repo.listProjects(), ids);
  await Promise.all(projects.map((p, i) => (p.sort !== i + 1 ? repo.updateProject(p.id, { sort: i + 1 }) : null)));
  return done();
}

/** Moves projects and their tasks into an area, then saves the sidebar order. */
export async function moveProjectsAction(moving: string[], areaId: string, order: string[]): Promise<Result> {
  await guard();
  if (!isIdList(moving) || !isIdList(order) || typeof areaId !== "string") return { ok: false, error: "Choose projects and a destination area." };
  const [areas, projects] = await Promise.all([repo.listAreas(), repo.listProjects()]);
  const area = areas.find((a) => a.id === areaId);
  if (!area || moving.some((id) => !projects.some((p) => p.id === id))) return { ok: false, error: "A project or the destination area no longer exists." };
  try {
    for (const p of projects.filter((p) => moving.includes(p.id) && p.areaId !== areaId)) await saveProject(p.id, { areaId });
    const sorted = inOrder(projects, order);
    for (const [i, p] of sorted.entries()) if (p.sort !== i + 1) await repo.updateProject(p.id, { sort: i + 1 });
  } catch (e) {
    return done({ ok: false, error: errorOf(e) });
  }
  return done({ ok: true, message: `Moved ${moving.length === 1 ? projects.find((p) => p.id === moving[0])!.name : `${moving.length} projects`} to ${area.name}` });
}

/** Saves a project. */
export async function updateProjectAction(id: string, patch: Partial<Omit<Project, "id">>): Promise<Result> {
  await guard();
  try {
    await saveProject(id, patch);
  } catch (e) {
    return { ok: false, error: errorOf(e) };
  }
  return done();
}

/** The Codex cloud environment a project's tasks run in when they go to Codex cloud (its label or id). */
export async function setCodexEnvAction(projectId: string, env: string | null): Promise<Result> {
  await guard();
  const value = env?.trim() || null;
  const problem = value && repo.codexEnvProblem(value);
  if (problem) return { ok: false, error: problem };
  if (!(await repo.getProject(projectId))) return { ok: false, error: "Project not found" };
  await repo.updateProject(projectId, { codexEnv: value });
  return done();
}

/**
 * Which MCP servers besides PacedMind a project's sessions get on this computer, by name; null for all of them. This
 * computer's own setting, like the project's folder.
 */
export async function setProjectServersAction(projectId: string, names: string[] | null): Promise<Result> {
  await guard();
  if (MODE !== "desktop") return { ok: false, error: "A project's MCP servers are set in the desktop app, on the computer where its sessions run." };
  if (names && (!Array.isArray(names) || names.some((n) => typeof n !== "string"))) return { ok: false, error: "Pick servers by name" };
  if (!(await repo.getProject(projectId))) return { ok: false, error: "Project not found" };
  setProjectServers(projectId, names);
  return done();
}

/** Planning settings, stored with the account. */
export async function updateSettingsAction(patch: Partial<Settings>) {
  await guard();
  await repo.setSettings(patch);
  return done();
}

/** Adds, changes or removes preferences in Settings → How you work: yours, as you wrote them. */
export async function savePreferencesAction(changes: PreferenceChanges): Promise<Result> {
  await guard();
  try {
    await changePreferences(changes, "you");
  } catch (e) {
    return { ok: false, error: errorOf(e) };
  }
  return done();
}

const TERMINAL_IDS = new Set<TerminalId>(["wt", "cmd", "terminal", "iterm"]);

/**
 * How sessions start on this computer; only its own window changes it. `remoteCode` false lets requests from elsewhere
 * come without a two-factor code: the account's entry for this computer says so (the database takes requests by it), and
 * this computer checks its own setting again for each one.
 */
export async function updateDeviceSettingsAction(patch: {
  name?: string; terminal?: TerminalId; claudeCommand?: string; codexCommand?: string; remoteStart?: RemoteStart; remoteCode?: boolean;
  trustFolders?: boolean; remoteAnswers?: boolean;
}): Promise<Result> {
  await guard();
  const access = await computerAccessProblem();
  if (access) return { ok: false, error: access };
  if (MODE !== "desktop") return { ok: false, error: "These are set in the PacedMind desktop app." };
  for (const command of [patch.claudeCommand, patch.codexCommand]) {
    const problem = command === undefined ? null : commandProblem(command);
    if (problem) return { ok: false, error: problem };
  }
  if (patch.terminal && !TERMINAL_IDS.has(patch.terminal)) return { ok: false, error: "Unknown terminal" };
  if (patch.remoteStart && !["off", "ask", "auto"].includes(patch.remoteStart)) return { ok: false, error: "Unknown setting" };
  if (patch.remoteCode !== undefined && typeof patch.remoteCode !== "boolean") return { ok: false, error: "Unknown setting" };
  const name = patch.name === undefined ? undefined : repo.cleanDeviceName(patch.name);
  updateDevice({
    ...(name ? { name } : {}),
    ...(patch.terminal ? { terminal: patch.terminal } : {}),
    ...(patch.claudeCommand ? { claudeCommand: patch.claudeCommand.trim() } : {}),
    ...(patch.codexCommand ? { codexCommand: patch.codexCommand.trim() } : {}),
    ...(patch.remoteStart ? { remoteStart: patch.remoteStart } : {}),
    ...(typeof patch.remoteCode === "boolean" ? { remoteCode: patch.remoteCode } : {}),
    ...(typeof patch.trustFolders === "boolean" ? { trustFolders: patch.trustFolders } : {}),
    ...(typeof patch.remoteAnswers === "boolean" ? { remoteAnswers: patch.remoteAnswers } : {}),
  });
  const id = deviceConfig().deviceId;
  // The account's copy, for Settings elsewhere and, for the code, the database. What counts here is saved above already:
  // if the copy doesn't go through now (offline, or just signed in again), the account sync sends it within a minute
  // (requests.ts), and until then a request without a code is refused here anyway.
  if (id && (name || patch.remoteStart || typeof patch.remoteCode === "boolean")) {
    await repo.updateDeviceRow(id, { name, remoteStart: patch.remoteStart, remoteCode: patch.remoteCode }).catch(() => {});
  }
  // A new command can find a different tool: look again.
  if (patch.claudeCommand || patch.codexCommand) void checkThisDevice(mcpUrl()).catch(() => {});
  return done({ ok: true, message: "Saved" });
}

/* ---------- the account's computers ---------- */

/**
 * Renames one of the account's computers, from any signed-in window (the web app, any computer). This computer takes a
 * new name at once, another one within a minute. Without an account, it renames this computer (id "" or its own id).
 */
export async function renameDeviceAction(deviceId: string, name: string): Promise<Result> {
  await guard();
  const access = await computerAccessProblem();
  if (access) return { ok: false, error: access };
  const clean = repo.cleanDeviceName(name ?? "");
  if (!clean) return { ok: false, error: "Give the computer a name" };
  const here = MODE === "desktop" && (deviceId === deviceConfig().deviceId || (deviceId === "" && !(await usesCloud())));
  if (await usesCloud()) {
    try {
      await repo.renameDevice(deviceId, clean);
    } catch (e) {
      return { ok: false, error: errorOf(e) };
    }
  } else if (!here) {
    return { ok: false, error: "Without an account, PacedMind knows only this computer." };
  }
  if (here) updateDevice({ name: clean });
  return done({ ok: true, message: `Renamed to ${clean}` });
}

/** Makes a signed-in computer the account's default: sessions go there when neither the task nor its project names one. */
export async function setDefaultDeviceAction(deviceId: string): Promise<Result> {
  await guard();
  const access = await computerAccessProblem();
  if (access) return { ok: false, error: access };
  if (!(await usesCloud())) return { ok: false, error: "Without an account, this computer is the only one." };
  try {
    await repo.setDefaultDevice(deviceId);
  } catch (e) {
    return { ok: false, error: errorOf(e) };
  }
  return done({ ok: true, message: `${(await repo.getDevice(deviceId))?.name ?? "That computer"} is the default now` });
}

/** A new owner token: agents set up with the old one lose access until you connect them again. */
export async function rotateMcpTokenAction(): Promise<Result> {
  await guard();
  if (MODE !== "desktop") return { ok: false, error: "Agents connect to the PacedMind desktop app." };
  rotateOwnerToken();
  void checkThisDevice(mcpUrl()).catch(() => {});
  return done({ ok: true, message: "New token made. Connect your agents again." });
}

/* ---------- this computer's agents, and importing projects ---------- */

/** Looks for Claude Code and Codex on this computer again. */
export async function checkDeviceAction(): Promise<Result> {
  await guard();
  if (MODE !== "desktop") return { ok: false, error: "Each computer looks for its agents in its desktop app." };
  await checkThisDevice(mcpUrl());
  return done({ ok: true, message: `Checked ${deviceConfig().name}` });
}

/**
 * Sets an agent up to reach PacedMind from sessions PacedMind doesn't configure itself (its desktop app, a terminal you
 * opened): Claude Code for all projects, Codex in its config.toml. Signed in to PacedMind Cloud, its MCP server, which
 * the agent signs in to itself (a terminal opens for that); without an account, this computer's with your token.
 */
export async function connectAgentAction(agent: AgentId): Promise<Result> {
  await guard();
  if (MODE !== "desktop") return { ok: false, error: "Agents are connected from the PacedMind desktop app, or with the commands shown here." };
  if (agent !== "claude" && agent !== "codex") return { ok: false, error: "Unknown agent" };
  const target = (await usesCloud()) ? "cloud" : "local";
  const r = agent === "claude" ? connectClaudeCode(target) : connectCodex(target);
  await checkThisDevice(mcpUrl());
  return done(r.ok ? { ok: true, message: r.message } : { ok: false, error: r.error });
}

/**
 * The offer after signing in (desktop): connects the agents found here to PacedMind Cloud's MCP server, one sign-in
 * terminal each, or (`connect` false) just stops offering. Either way it doesn't show again for this account here.
 */
export async function cloudConnectOfferAction(connect: boolean): Promise<Result> {
  await guard();
  if (MODE !== "desktop" || !(await usesCloud())) return { ok: false, error: "Sign in to PacedMind Cloud first." };
  updateDevice({ cloudConnectOffered: true });
  if (!connect) return done({ ok: true });
  const found = await checkThisDevice(mcpUrl());
  const results = (["claude", "codex"] as AgentId[]).filter((a) => found[a].cli)
    .map((a) => ({ agent: a, r: a === "claude" ? connectClaudeCode("cloud") : connectCodex("cloud") }));
  await checkThisDevice(mcpUrl());
  const failed = results.filter((x) => !x.r.ok);
  if (!results.length) return done({ ok: false, error: "Neither Claude Code nor Codex is installed here." });
  if (failed.length) return done({ ok: false, error: failed.map((x) => x.r.error).join(" ") });
  return done({ ok: true, message: `Connected ${results.map((x) => AGENT_LABEL[x.agent]).join(" and ")} to PacedMind Cloud. Allow each in the browser page its terminal opens.` });
}

/** Not now, on the web app's card about connecting an agent: this browser doesn't show it for a year. */
export async function dismissConnectCardAction(): Promise<Result> {
  await guard();
  (await cookies()).set(CONNECT_CARD_COOKIE, "1", { path: "/", maxAge: 365 * 24 * 60 * 60, httpOnly: true, sameSite: "lax", secure: MODE === "web" });
  return { ok: true };
}

/** Disconnects an agent from PacedMind Cloud's MCP server: its sign-in ends at once. */
export async function disconnectAgentAction(id: string): Promise<Result> {
  await guard();
  if (!/^[0-9a-f-]{36}$/.test(id)) return { ok: false, error: "Unknown agent" };
  try {
    await repo.disconnectAgent(id);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  return done({ ok: true, message: "Disconnected. It has to sign in and be allowed again." });
}

/**
 * Links the copies found here that you picked (the offer's Link, one click): a project gets its folder here as the
 * import gives it, an area its workspace. Each only if it has none here yet.
 */
export async function linkFoundAction(items: { kind: "project" | "area"; id: string; folder: string }[]): Promise<Result> {
  await guard();
  if (MODE !== "desktop") return { ok: false, error: "Folders are set in the PacedMind desktop app." };
  const list = Array.isArray(items) ? items.filter((i) => i && typeof i.id === "string" && typeof i.folder === "string") : [];
  const projects = await repo.listProjects();
  let linked = 0;
  const skipped: string[] = [];
  for (const i of list.filter((x) => x.kind === "project")) {
    const p = projects.find((x) => x.id === i.id && !x.folder);
    if (!p || folderProblem(i.folder)) {
      skipped.push(p?.name ?? "a project");
      continue;
    }
    try {
      await linkFolder(p, i.folder);
      linked++;
    } catch {
      skipped.push(p.name);
    }
  }
  const areas = await repo.listAreas();
  const spaces = await importAreas(list.filter((x) => x.kind === "area").flatMap((x) => {
    const a = areas.find((y) => y.id === x.id && !y.folder);
    return a ? [{ folder: x.folder, name: a.name, areaId: a.id }] : [];
  }));
  linked += spaces.linked.length;
  skipped.push(...spaces.skipped);
  updateDevice({ linkOfferSeen: [...deviceConfig().linkOfferSeen, ...list.map((x) => `${x.id}>${x.folder}`)].slice(-500) });
  return done(linked
    ? { ok: true, message: `Linked ${linked} folder${linked === 1 ? "" : "s"} on this computer${skipped.length ? `. Skipped ${skipped.join(", ")}` : ""}` }
    : { ok: false, error: skipped.length ? `Couldn't link ${skipped.join(", ")}` : "Nothing to link" });
}

/** "Not now": the offer doesn't come back for these copies (it does for others found later). */
export async function dismissLinkOfferAction(keys: string[]): Promise<Result> {
  await guard();
  if (MODE === "desktop" && Array.isArray(keys)) {
    updateDevice({ linkOfferSeen: [...deviceConfig().linkOfferSeen, ...keys.filter((k) => typeof k === "string").slice(0, 200)].slice(-500) });
  }
  return done();
}

/** Writes pacedmind.md into this computer's linked folders that don't have it, so your other computers find them. */
export async function markFoldersAction(): Promise<Result> {
  await guard();
  if (MODE !== "desktop") return { ok: false, error: "Folders are on the computer, in the PacedMind desktop app." };
  const n = await markAll();
  return done({ ok: true, message: n ? `Added pacedmind.md to ${n} folder${n === 1 ? "" : "s"}` : "Every linked folder has its pacedmind.md" });
}

/** What the import offers on this computer: the folders that may be projects, and the ones that hold them, areas. */
export async function findWorkAction(): Promise<{ projects: FoundProject[]; areas: FoundArea[] }> {
  await guard();
  if (MODE !== "desktop") return { projects: [], areas: [] };
  return findWork();
}

/**
 * Sets up the picked areas (each the workspace here of an area you have, or a new area), then the picked projects,
 * each in its area: the one its folder is in when that's set up, else `areaId`.
 */
export async function importProjectsAction(items: ImportItem[], areaId: string, areas: ImportArea[] = []): Promise<Result> {
  await guard();
  if (MODE !== "desktop") return { ok: false, error: "Import from the desktop app on the computer with the folders." };
  const valid = items.filter((i) => i && typeof i.folder === "string" && typeof i.name === "string" && (i.projectId == null || typeof i.projectId === "string")
    && (i.area == null || typeof i.area === "string"));
  const spaces = await importAreas(Array.isArray(areas) ? areas.slice(0, 200) : []);
  const known = new Set((await repo.listAreas()).map((a) => a.id));
  const areaOf = (i: ImportItem) => (i.area ? spaces.areaOf.get(keyOf(i.area)) : undefined) ?? (known.has(areaId) ? areaId : null);
  // A folder that joins a project needs no area; a new project does.
  if (valid.some((i) => !i.projectId && !areaOf(i))) return { ok: false, error: "Pick an area for the projects" };
  const { created, linked, skipped } = await importProjects(valid, areaOf);
  skipped.push(...spaces.skipped);
  updateDevice({ importOffered: true });
  const count = (n: number, one: string, many: string) => (n === 1 ? one : `${n} ${many}`);
  const names = (ps: Project[]) => count(ps.length, ps[0]?.name ?? "", "projects");
  const made = [
    spaces.created.length ? `added the area${spaces.created.length > 1 ? "s" : ""} ${spaces.created.join(", ")}` : "",
    created.length ? `added ${names(created)}` : "",
    linked.length ? `linked ${names(linked)} to ${linked.length === 1 ? "its" : "their"} folder${linked.length === 1 ? "" : "s"} here` : "",
    spaces.linked.length ? `set the workspace of ${spaces.linked.join(", ")}` : "",
  ].filter(Boolean).join(", ");
  const sentence = made && made[0].toUpperCase() + made.slice(1);
  return done(sentence
    ? { ok: true, message: skipped.length ? `${sentence}. Skipped ${skipped.join(", ")}.` : sentence }
    : { ok: false, error: skipped.length ? `Couldn't add ${skipped.join(", ")}` : "Pick a project or an area to add" });
}

/** The import opens by itself once on each computer; after that it's in Settings. */
export async function dismissImportAction(): Promise<Result> {
  await guard();
  if (MODE === "desktop") updateDevice({ importOffered: true });
  return done();
}

/* ---------- data ---------- */

/** Starts the data in use over, after keeping a copy of it: the account's, or without an account this computer's own. */
export async function resetDataAction(mode: "sample" | "empty"): Promise<Result> {
  await guard();
  if (mode !== "sample" && mode !== "empty") return { ok: false, error: "Pick the sample data or an empty start." };
  try {
    if (await usesCloud()) {
      // Starting over deletes before it adds: on a read-only account only the deleting would go through.
      if ((await readPlan())?.writable === false) return { ok: false, error: READ_ONLY_MESSAGE };
      await resetAccount(mode);
    } else resetLocal(mode);
  } catch (e) {
    return done({ ok: false, error: errorOf(e) });
  }
  return done();
}

/** Puts a copy kept before a reset back in place of the data in use; what's there now becomes a copy first. */
export async function restoreCopyAction(id: string): Promise<Result> {
  await guard();
  if (typeof id !== "string") return { ok: false, error: "That copy isn't there any more." };
  try {
    if ((await usesCloud()) && (await readPlan())?.writable === false) return { ok: false, error: READ_ONLY_MESSAGE };
    await restoreCopy(id);
  } catch (e) {
    return done({ ok: false, error: errorOf(e) });
  }
  return done({ ok: true, message: "Copy put back" });
}

export async function deleteCopyAction(id: string): Promise<Result> {
  await guard();
  if (typeof id !== "string") return { ok: false, error: "That copy isn't there any more." };
  try {
    await deleteCopy(id);
  } catch (e) {
    return { ok: false, error: errorOf(e) };
  }
  return done({ ok: true, message: "Copy deleted" });
}

/* ---------- billing ---------- */

/**
 * Subscribing to PacedMind Cloud at a country's price, monthly or yearly: answers the Checkout page to open (the
 * desktop app opens it in the browser). With a subscription already, it switches it between monthly and yearly.
 */
export async function subscribeAction(country: string, period: BillingPeriod): Promise<Result & { url?: string }> {
  await guard();
  if (!(await usesCloud())) return { ok: false, error: "Sign in to PacedMind Cloud first." };
  if (!/^[A-Z]{2}$/.test(country) || (period !== "month" && period !== "year")) return { ok: false, error: "Pick a country and monthly or yearly." };
  try {
    const r = await subscribe(country, period);
    if ("switched" in r) return done({ ok: true, message: period === "year" ? "You pay yearly from now on" : "You pay monthly from now on" });
    return { ok: true, url: r.url };
  } catch (e) {
    return { ok: false, error: errorOf(e) };
  }
}

/** The page for the card, invoices and cancelling. */
export async function manageBillingAction(): Promise<Result & { url?: string }> {
  await guard();
  if (!(await usesCloud())) return { ok: false, error: "Sign in to PacedMind Cloud first." };
  try {
    return { ok: true, url: await billingPortal() };
  } catch (e) {
    return { ok: false, error: errorOf(e) };
  }
}

/**
 * The account's data to this computer's own, then signing out, so PacedMind goes on without an account here: for when
 * the account's Cloud has ended (it only reads the account, which works while it's read-only).
 */
export async function moveToThisComputerAction(): Promise<Result> {
  await guard();
  if (MODE !== "desktop") return { ok: false, error: "Move it from the desktop app on the computer that should keep it." };
  if (!(await usesCloud())) return { ok: false, error: "Sign in to PacedMind Cloud first." };
  try {
    await moveToThisComputer();
  } catch (e) {
    return { ok: false, error: errorOf(e) };
  }
  cutOffAgents();
  await (await supabase()).auth.signOut({ scope: "local" });
  updateDevice({ withoutAccount: true });
  refresh();
  redirect("/today");
}

/** Copies this computer's own data (what PacedMind keeps without an account) into the signed-in account. */
export async function importLegacyAction(): Promise<Result> {
  await guard();
  if (MODE !== "desktop") return { ok: false, error: "Move it from the desktop app on the computer that has it." };
  if (!(await usesCloud())) return { ok: false, error: "Sign in to PacedMind Cloud first." };
  // It clears the account's default areas first: on a read-only account that would go through and the rest wouldn't.
  if ((await readPlan())?.writable === false) return { ok: false, error: READ_ONLY_MESSAGE };
  try {
    const n = await importLegacy();
    return done({ ok: true, message: `Moved ${n.tasks} tasks, ${n.projects} projects and ${n.areas} areas to your account` });
  } catch (e) {
    return { ok: false, error: errorOf(e) };
  }
}
