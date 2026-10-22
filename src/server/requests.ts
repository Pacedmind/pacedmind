import "server-only";
import { computerAccessProblem } from "./computer-access";
import crypto from "node:crypto";
import * as repo from "./repo";
import {
  forgetSessionFiles, plannedFolder, plannedSurface, resumeProblem, resumeSession, startSession, type LaunchResult,
} from "./launcher";
import { deviceConfig, deviceFor, revokeAllSessionTokens, thisPlatform, updateDevice } from "./device";
import { approvals, clearApprovals, handledRequests, type Approval, type ApprovalFrom } from "./approval-store";
import { pendingFolderApprovals, syncFolderRequests } from "./folder-requests";
import { APP_VERSION, deviceIdFor, runsHere, toolsHere } from "./devices";
import { missingFrom } from "@/lib/needs";
import { changesProblem, requestChanges } from "./ops";
import { attachedConversations } from "./attach";
import { scanOtherSessions } from "./other-sessions";
import { MODE, authState, supabase } from "./supabase";
import { cleanDeviceName } from "./store/shared";
import {
  AGENT_LABEL, SURFACE_LABEL, agentOf,
  type AgentId, type LaunchRequest, type LaunchRequestKind, type OtherSession, type RemoteStart, type Session, type Surface, type Task,
} from "@/lib/types";

/*
 * Sessions asked for from outside this computer's PacedMind window: from the web app or another computer (a launch
 * request in the cloud, which the database only accepts from a live two-factor session, with a code from the last five
 * minutes from an authenticator older than the asking session unless this computer takes requests without one), from an
 * agent elsewhere (the same, from an approved agent signed in to PacedMind Cloud or an agent on another computer: only
 * where no code is needed, since an agent never has one, and only to start a session), or from an agent over this
 * computer's own MCP server. A request from elsewhere starts a session, resumes one that ran here, or sends one that ran
 * here back to its agent with changes. What happens to it is this computer's setting (device.ts):
 * - off: refused;
 * - ask (the default): the request waits here until you allow or refuse it in the app;
 * - auto: acted on right away, except anything that runs in the agent's cloud, which always waits for you.
 * A request that came without a fresh code is refused while this computer's own setting asks for one (remoteCode).
 * Agents over this computer's own MCP server always wait for you. Each approval keeps the task, agent, folder and way it
 * runs that you were shown, and acting refuses if any of them changed in between. Folders asked for the same ways wait
 * here too (folder-requests.ts), always for you.
 */

const TTL_MS = 10 * 60_000;

export type { Approval };

export function pendingApprovals(): Approval[] {
  const now = Date.now();
  for (const [id, a] of approvals()) if (a.expiresAt <= now) approvals().delete(id);
  return [...approvals().values()].sort((a, b) => a.requestedAt - b.requestedAt);
}

/** What the app shows for a waiting request: what it asks, which task, which agent, where it would run, who asked. */
export interface ApprovalItem {
  modelSettings: import("@/lib/agent-models").ModelSelection | null;
  id: string;
  /** Start a session, resume one, or send one back to its agent with changes; or use a folder here. */
  kind: LaunchRequestKind | "folder";
  key: string;
  title: string;
  /** The agent and where it runs, in words ("Claude Code · Terminal"). */
  agent: string;
  surface: Surface;
  folder: string;
  from: string;
  /** For kind "changes": what should change, as the user wrote it (untrusted text, shown as it is). */
  changes: string | null;
  /** For a start: what the task needs that the agent doesn't have on this computer. */
  missing: string[];
  requestedAt: number;
  expiresAt: number;
}

const FROM_TEXT: Record<ApprovalFrom, string> = {
  elsewhere: "the web app or another computer",
  agent: "an agent over MCP",
  agentElsewhere: "an agent, from elsewhere",
};

export function approvalItems(tasks: Task[], visibleProjectIds: ReadonlySet<string>): ApprovalItem[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const sessions: ApprovalItem[] = pendingApprovals().filter((a) => byId.has(a.taskId)).map((a) => ({
    id: a.id, kind: a.kind, key: a.key, title: byId.get(a.taskId)?.title ?? "", agent: `${AGENT_LABEL[a.agent]} · ${SURFACE_LABEL[a.surface]}`,
    surface: a.surface, folder: a.folder, modelSettings: a.modelSettings,
    from: a.changes ? `${FROM_TEXT[a.from]}, sending the session back with changes: “${excerpt(a.changes.text)}”`
      : a.resume ? `${FROM_TEXT[a.from]}, resuming its session` : FROM_TEXT[a.from],
    changes: a.changes?.text ?? null, missing: a.missing ?? [],
    requestedAt: a.requestedAt, expiresAt: a.expiresAt,
  }));
  // A folder: `title` says what gets it (a project, an area's workspace, a task).
  const folders: ApprovalItem[] = pendingFolderApprovals().filter((a) =>
    a.target.kind === "project" ? visibleProjectIds.has(a.target.id) : a.target.kind !== "task" || byId.has(Number(a.target.id))
  ).map((a) => ({
    id: a.id, kind: "folder", key: "", title: a.name, agent: "", surface: "terminal", folder: a.folder, modelSettings: null,
    from: FROM_TEXT[a.from], changes: null, missing: [], requestedAt: a.requestedAt, expiresAt: a.expiresAt,
  }));
  return [...sessions, ...folders].sort((a, b) => a.requestedAt - b.requestedAt);
}

const excerpt = (text: string) => (text.length > 200 ? `${text.slice(0, 200).trimEnd()}…` : text);

type Times = { at: number; until: number };

/**
 * Puts a request to start a session in front of you, with what it would run right now, and what the task needs that the
 * agent doesn't have here. Null when the task can't run here at all.
 */
async function ask(
  task: Task, agent: AgentId | null, from: ApprovalFrom, requestId: string | null, times?: Times, surface?: Surface,
): Promise<Approval | null> {
  const project = task.projectId ? await repo.getProject(task.projectId) : null;
  const who = agent ?? agentOf(task, project?.agent);
  const folder = plannedFolder(task);
  if (!who || !folder) return null;
  const same = pendingApprovals().find((a) => a.kind === "start" && a.taskId === task.id && a.from === from && a.requestId === requestId);
  if (same) return same;
  const now = Date.now();
  const where = surface ?? plannedSurface(task, who);
  const a: Approval = {
    id: requestId ?? crypto.randomUUID(), requestId, from, kind: "start", taskId: task.id, key: task.key, agent: who, folder,
    surface: where, modelSettings: task.modelSettings, requestedAt: times?.at ?? now, expiresAt: times?.until ?? now + TTL_MS,
    // The agent's cloud has its own servers, not this computer's.
    missing: task.needs.length && where !== "cloud" ? missingFrom(task.needs, toolsHere(who, folder)) : [],
  };
  approvals().set(a.id, a);
  return a;
}

/** An agent asked over MCP to start a session (where it runs, if it said): it waits for you in the app. */
export const askFromAgent = (task: Task, agent: AgentId | null, surface?: Surface) => ask(task, agent, "agent", null, undefined, surface);

/**
 * Asks you to send a session back to work with changes: an agent's request_changes over MCP, or (with `origin`) a
 * request from the web app or another computer. Reopening it runs an agent here, so it waits for you like a session
 * it asks for. The changes are written when you allow it. A newer request for the same session replaces the older one.
 */
export async function askForChanges(
  session: Session, task: Task, text: string, origin?: { requestId: string; times: Times },
): Promise<Approval | null> {
  const folder = plannedFolder(task);
  if (!folder) return null;
  for (const [id, x] of approvals()) {
    if (x.changes?.sessionId !== session.id) continue;
    approvals().delete(id);
    if (x.requestId) await repo.settleLaunchRequest(x.requestId, "failed", { note: "A newer request for the same session replaced it" });
  }
  const now = Date.now();
  const a: Approval = {
    id: origin?.requestId ?? crypto.randomUUID(), requestId: origin?.requestId ?? null, from: origin ? "elsewhere" : "agent", kind: "changes",
    taskId: task.id, key: task.key, agent: session.agent, folder, surface: "terminal", modelSettings: task.modelSettings, changes: { sessionId: session.id, text },
    requestedAt: origin?.times.at ?? now, expiresAt: origin?.times.until ?? now + TTL_MS,
  };
  approvals().set(a.id, a);
  return a;
}

/** Asks you to resume a session that ran here, as the web app or another computer asked (`to` "desktop": in the Claude app). */
function askResume(session: Session, task: Task, to: Surface | undefined, requestId: string, times: Times): Approval | null {
  const folder = plannedFolder(task);
  if (!folder) return null;
  const a: Approval = {
    id: requestId, requestId, from: "elsewhere", kind: "resume", taskId: task.id, key: task.key, agent: session.agent, folder,
    surface: to ?? session.surface, modelSettings: task.modelSettings, resume: { sessionId: session.id, ...(to ? { to } : {}) }, requestedAt: times.at, expiresAt: times.until,
  };
  approvals().set(a.id, a);
  return a;
}

export async function approve(id: string): Promise<LaunchResult> {
  const a = approvals().get(id);
  approvals().delete(id);
  if (!a || a.expiresAt <= Date.now()) return { ok: false, error: "That request expired. Ask for the session again." };
  const r = await act(a);
  if (a.requestId) await repo.settleLaunchRequest(a.requestId, r.ok ? "launched" : "failed", { sessionId: r.session?.id, note: r.error });
  return r;
}

/** Does what you allowed, as long as the task, its folder and the session are still what you were shown. */
async function act(a: Approval): Promise<LaunchResult> {
  const again = a.kind === "changes" ? "Ask for the changes again." : a.kind === "resume" ? "Ask to resume it again." : "Ask for the session again.";
  if (a.changes || a.resume) {
    const sessionId = a.changes?.sessionId ?? a.resume!.sessionId;
    const task = await repo.getTask(a.taskId);
    if (!task || task.key !== a.key || plannedFolder(task) !== a.folder || JSON.stringify(task.modelSettings) !== JSON.stringify(a.modelSettings)) {
      return { ok: false, error: `${a.key} changed after you saw the request (its task, folder or model settings). ${again}` };
    }
    const session = await repo.getSession(sessionId);
    if (!session || session.taskId !== a.taskId) return { ok: false, error: `That session is gone. ${again}` };
    return a.changes ? requestChanges(sessionId, a.changes.text) : resumeSession(sessionId, a.resume!.to);
  }
  return startSession(a.taskId, {
    agent: a.agent, surface: a.surface, reason: "approved", expect: { key: a.key, agent: a.agent, folder: a.folder, surface: a.surface, modelSettings: a.modelSettings },
  });
}

export async function deny(id: string) {
  const a = approvals().get(id);
  approvals().delete(id);
  if (a?.requestId) await repo.settleLaunchRequest(a.requestId, "denied", { note: "Refused on the computer" });
}

const g = globalThis as unknown as {
  __pacedmindSeen?: number;
  /** This computer's name in the account's list as last seen, to tell a name given elsewhere from one given here. */
  __pacedmindRowName?: string;
  /** This computer's other sessions as last written to the account's list. */
  __pacedmindOthersSent?: string;
  /** Looking for folder requests failed once already: said once in the log. */
  __pacedmindFolderSyncFailed?: boolean;
};

/**
 * This computer's sessions that PacedMind didn't start, for the Sessions page on the other computers and in the web app,
 * with their last activity to five minutes: within those, only a new state or session changes the list, and open pages
 * refresh for that. Null when looking failed; nothing then changes in the account.
 */
async function othersToReport(): Promise<OtherSession[] | null> {
  try {
    const five = 5 * 60_000;
    const [projects, attached] = await Promise.all([repo.listAllProjects(), attachedConversations()]);
    return scanOtherSessions(projects, attached)
      .map((s) => ({ ...s, activeAt: new Date(Math.floor(Date.parse(s.activeAt) / five) * five).toISOString() }));
  } catch (e) {
    console.error("[organizer] looking for other sessions failed", e);
    return null;
  }
}

/**
 * The desktop app's side of the account, every few seconds: registers this computer, notices when it was
 * signed out from elsewhere, keeps its entry current (still here, its name and version), and handles the
 * launch requests sent to it, each exactly once.
 */
export async function syncDevice(): Promise<void> {
  if (MODE !== "desktop") return;
  const state = await authState();
  if (!state || state.aal !== "aal2") return;
  if (await computerAccessProblem()) return;
  let d = deviceFor(state.user.id);

  if (!d.deviceId) {
    updateDevice({ deviceId: await repo.registerDevice(d.name, thisPlatform()), claimedSession: state.sessionId });
    d = deviceConfig();
  } else if (state.sessionId && d.claimedSession !== state.sessionId) {
    try {
      await repo.claimDevice(d.deviceId);
      updateDevice({ claimedSession: state.sessionId });
    } catch {
      // Signed out from another device while this one was away: register again as a new computer.
      updateDevice({ deviceId: await repo.registerDevice(d.name, thisPlatform()), claimedSession: state.sessionId });
    }
    d = deviceConfig();
  }

  // Once a minute: are we still signed in (revoking a device ends its session, and the database then shows
  // it nothing), and tell the account we're here.
  const now = Date.now();
  if (!g.__pacedmindSeen || now - g.__pacedmindSeen > 60_000) {
    const me = await repo.getDevice(d.deviceId!);
    if (!me || me.revokedAt) return signOutHere();
    // A name given in the web app or on another computer becomes this computer's name here too; one given here that
    // didn't reach the account (it was offline) goes there now.
    let pushName = false;
    const adopted = cleanDeviceName(me.name);
    if (adopted !== cleanDeviceName(d.name)) {
      if (adopted && (g.__pacedmindRowName === undefined || me.name !== g.__pacedmindRowName)) updateDevice({ name: adopted });
      else pushName = !!cleanDeviceName(d.name);
      d = deviceConfig();
    }
    const others = await othersToReport();
    const othersKey = others && JSON.stringify(others);
    const sendOthers = !!others && othersKey !== (g.__pacedmindOthersSent ?? JSON.stringify(me.otherSessions));
    await repo.updateDeviceRow(d.deviceId!, {
      lastSeen: true,
      ...(me.remoteStart !== d.remoteStart ? { remoteStart: d.remoteStart } : {}),
      ...(me.remoteCode !== (d.remoteCode !== false) ? { remoteCode: d.remoteCode !== false } : {}),
      ...(pushName ? { name: d.name } : {}),
      ...(APP_VERSION && me.appVersion !== APP_VERSION ? { appVersion: APP_VERSION } : {}),
      ...(sendOthers ? { otherSessions: others } : {}),
    });
    if (othersKey) g.__pacedmindOthersSent = othersKey;
    g.__pacedmindRowName = pushName ? cleanDeviceName(d.name) : me.name;
    g.__pacedmindSeen = now;
  }

  // Folders asked of this computer wait for you here, whatever its setting for sessions. A failure there (an account's
  // database from before folder requests, say) mustn't keep the sessions asked for below from being handled.
  await syncFolderRequests(d.deviceId!, now).catch((e) => {
    if (!g.__pacedmindFolderSyncFailed) console.error("[organizer] folder requests", e);
    g.__pacedmindFolderSyncFailed = true;
  });

  const pending = await repo.listLaunchRequests({ deviceId: d.deviceId!, status: ["pending"] });
  const open = new Set(pending.map((r) => r.id));
  for (const [id, a] of approvals()) if (a.requestId && !open.has(a.requestId)) approvals().delete(id);
  pendingApprovals(); // drops the ones that expired
  for (const r of pending) {
    if (handledRequests().has(r.id) || approvals().has(r.id)) {
      // Asked here but never answered: it ran out of time.
      if (Date.parse(r.expiresAt) <= now && !approvals().has(r.id)) await repo.settleLaunchRequest(r.id, "expired");
      continue;
    }
    // Whatever happens next, this request is this computer's to decide once.
    handledRequests().add(r.id);
    await handle(r, d, d.deviceId!, now);
  }
}

/**
 * Decides one request from elsewhere by this computer's settings, after checking it can run here at all. Everything is
 * checked again when it runs (startSession, resumeSession, requestChanges), and the outcome goes back to the request.
 */
async function handle(r: LaunchRequest, settings: { remoteStart: RemoteStart; remoteCode: boolean }, here: string, now: number) {
  const setting = settings.remoteStart;
  const settle = (status: "launched" | "failed" | "denied" | "expired", extra?: { sessionId?: string | null; note?: string | null }) =>
    repo.settleLaunchRequest(r.id, status, extra);
  if (Date.parse(r.expiresAt) <= now) return settle("expired");
  if (setting === "off") return settle("denied", { note: "Taking sessions from elsewhere is off on this computer" });
  // An agent elsewhere asks for new sessions only, and never counts as having a code, even when the desktop app it asked
  // through had one entered minutes before (the database takes nothing else from an agent signed in to PacedMind Cloud).
  const agent = r.requestedVia === "agent";
  if (agent && r.kind !== "start") return settle("denied", { note: "Agents ask for new sessions only" });
  // The database takes a request without a fresh code only while this computer's entry says it may. What counts is the
  // setting here: switched back on, it refuses them at once, before the entry has caught up.
  if ((agent || !r.freshCode) && settings.remoteCode !== false) {
    return settle("denied", { note: "This computer takes sessions from elsewhere only with a two-factor code" });
  }
  const task = await repo.getTask(r.taskId);
  if (!task) return settle("failed", { note: "The task is gone" });
  if (task.agent === "human") return settle("failed", { note: `${task.key} is marked as yours` });
  const times = { at: Date.parse(r.requestedAt), until: Date.parse(r.expiresAt) };
  const done = (res: LaunchResult, sessionId?: string) =>
    settle(res.ok ? "launched" : "failed", { sessionId: res.ok ? res.session?.id ?? sessionId : null, note: res.error });

  if (r.kind === "start") {
    const project = task.projectId ? await repo.getProject(task.projectId) : null;
    if (!runsHere(deviceIdFor(task.deviceId, project?.deviceId))) return settle("failed", { note: `${task.key} runs on another computer` });
    const surface = r.surface ?? plannedSurface(task, r.agent);
    const folder = plannedFolder(task);
    // A session in the agent's cloud sends the project there, so it always waits for you, whatever the setting.
    if (setting === "auto" && surface !== "cloud" && folder) {
      return done(await startSession(task.id, {
        agent: r.agent, surface, reason: agent ? "agent" : r.freshCode ? "remote" : "remoteNoCode",
        expect: { key: task.key, agent: r.agent, folder, surface, modelSettings: task.modelSettings },
      }));
    }
    if (!(await ask(task, r.agent, agent ? "agentElsewhere" : "elsewhere", r.id, times, surface))) {
      await settle("failed", { note: "That task can't run on this computer" });
    }
    return;
  }

  // Resuming and changes: the session has to be this computer's and the request's task's (the database checked that
  // too), and a conversation only goes on where it is.
  const session = r.targetSessionId ? await repo.getSession(r.targetSessionId) : null;
  if (!session || session.taskId !== task.id || session.agent !== r.agent || session.deviceId !== here) {
    return settle("failed", { note: "That session didn't run on this computer" });
  }

  if (r.kind === "resume") {
    const to = r.surface === "desktop" ? "desktop" : undefined;
    const problem = resumeProblem(session, to);
    if (problem) return settle("failed", { note: problem });
    // Pulling a cloud session in runs its work here, so it waits for you too.
    if (setting === "auto" && session.surface !== "cloud") return done(await resumeSession(session.id, to), session.id);
    if (!askResume(session, task, to, r.id, times)) await settle("failed", { note: "That task can't run on this computer" });
    return;
  }

  // The changes are the user's words for the agent: they go on its report, where start_task reads them, never on a command line.
  const text = (r.changes ?? "").trim().slice(0, 20000);
  const problem = text ? await changesProblem(session) : "No changes were written";
  if (problem) return settle("failed", { note: problem });
  if (setting === "auto") return done(await requestChanges(session.id, text), session.id);
  if (!(await askForChanges(session, task, text, { requestId: r.id, times }))) await settle("failed", { note: "That task can't run on this computer" });
}

/** Signing out here, or this computer signed out from elsewhere: its agents lose PacedMind at once. */
export function cutOffAgents() {
  forgetSessionFiles(Object.values(deviceConfig().sessionTokens).map((t) => t.sessionId));
  revokeAllSessionTokens();
  clearApprovals();
}

async function signOutHere() {
  cutOffAgents();
  updateDevice({ deviceId: null, claimedSession: null });
  g.__pacedmindSeen = undefined;
  g.__pacedmindRowName = undefined;
  await (await supabase()).auth.signOut({ scope: "local" });
}
