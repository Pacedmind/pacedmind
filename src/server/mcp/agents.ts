import "server-only";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { ImageError, removeImageFiles, storeImage, type StoredImage } from "../attachments";
import { deviceConfig, projectServers, revokeSessionTokens } from "../device";
import { deviceIdFor, noteAccountServers, offeredDevice } from "../devices";
import { agentExtras, folderExtras, sortReported, type ReportedServers } from "../extras";
import { noteSessionMcp, sessionMcp } from "../session-mcp";
import { nextReadyTask } from "../dependencies";
import { forgetSessionFiles, plannedFolder } from "../launcher";
import { askForChanges, askFromAgent } from "../requests";
import { activeSession, changesProblem, closeSession, edgeWouldLoop, finishTask } from "../ops";
import * as repo from "../repo";
import { MODE } from "../supabase";
import { refusedStepUp } from "../step-up";
import { computers, findComputer } from "./computers";
import { cloudOrigin } from "../supabase-config";
import { callerSession } from "./principal";
import { QUESTION_CALL_MS, QUESTION_OPEN_MS, answeredText, openAsk, waitForAnswer } from "../asks";
import { planText } from "@/lib/dates";
import {
  AGENT_LABEL, APP_LABEL, CLOUD_LABEL, LIVE_STATUSES, MCP_NAME, OLD_MCP_NAME, SURFACE_LABEL, agentOf, isAnswers, isLiveSession,
  deviceOnline, type AgentId, type Device, type LaunchRequest, type Report, type ReportCriterion, type Session, type Surface, type Task,
} from "@/lib/types";
import { sessionUse, usageText } from "@/lib/usage";
import {
  agentSchema, describeTask, fail, findProject, findSession, findTask, imageLine, plural, projectRef, reportCounts, taskRef, tool,
} from "./common";

const SESSION_TEXT: Record<Session["status"], string> = {
  starting: "starting", running: "running", finished: "finished, waiting for the user's review", done: "reviewed and done",
  closed: "closed", failed: "failed",
};

/** The account's computers by id, for "on DESKTOP-1". */
const deviceNames = async () => new Map((await repo.listDevices()).map((d) => [d.id, d.name]));

/** "in a terminal on DESKTOP-1", "in the Claude app on DESKTOP-1" or "in Claude Code on the web". */
function placeText(agent: AgentId, surface: Surface, deviceId: string | null, devices: Map<string, string>): string {
  if (surface === "cloud") return `in ${CLOUD_LABEL[agent]}`;
  const on = deviceId ? ` on ${devices.get(deviceId) ?? "another computer"}` : "";
  return surface === "desktop" ? `in the ${APP_LABEL[agent]}${on}` : `in a terminal${on}`;
}

function sessionLine(s: Session, tasks: Map<number, Task>, reports: Map<string, Report[]>, devices: Map<string, string>): string {
  const t = tasks.get(s.taskId);
  const report = reports.get(s.id)?.[0] ?? null;
  // A session reopened for changes has been at work since the user asked for them.
  const working = (s.status === "starting" || s.status === "running") && report?.changesAt ? report.changesAt : null;
  const at = (working ?? s.finishedAt ?? s.endedAt ?? s.startedAt).replace("T", " ");
  const counts = report ? reportCounts(report) : "";
  const used = usageText(sessionUse(s));
  return `Session ${s.id} · ${t ? `${t.key} ${t.title}` : `task #${s.taskId}`} · ${AGENT_LABEL[s.agent]} ${placeText(s.agent, s.surface, s.deviceId, devices)} · ` +
    `${SESSION_TEXT[s.status]} · ${at}${report && report.outcome !== "done" ? ` · handed back ${report.outcome}` : ""}` +
    `${s.note ? ` · ${s.note}` : ""}${counts ? ` (${counts})` : ""}${used ? ` · used ${used}` : ""}`;
}

/** Session lines with their reports and computers looked up once. */
async function sessionLines(sessions: Session[], tasks: Map<number, Task>): Promise<string[]> {
  const [reports, devices] = await Promise.all([repo.reportsForSessions(sessions.map((s) => s.id)), deviceNames()]);
  return sessions.map((s) => sessionLine(s, tasks, reports, devices));
}

/** The agent that runs a task: its own, else the project's, else Claude Code. None for a task that is the user's own. */
const agentFor = async (t: Task): Promise<AgentId | null> => agentOf(t, t.projectId ? (await repo.getProject(t.projectId))?.agent : null);
const notYours = (t: Task) => {
  if (t.agent === "human") fail(`${t.key} is marked as the user's own task (human), so it never gets an agent session. Ask the user before changing that with update_task.`);
};

/**
 * The session a session token works in, checked against the task it names: a session PacedMind started can
 * only report on its own task.
 */
async function ownSession(t: Task, session?: string): Promise<Session | null> {
  const me = callerSession();
  if (!me) return null;
  const own = await repo.getSession(me.sessionId);
  // The token says which task it's for; the cloud's session row has to agree.
  if (!own || me.taskId !== t.id || own.taskId !== me.taskId || (session && session !== me.sessionId)) {
    const ownKey = own ? (await repo.getTask(own.taskId))?.key : null;
    fail(`This session works on ${ownKey ?? "another task"}${own ? ` (session ${own.id})` : ""}; it can only report on that task.`);
  }
  return own;
}

/**
 * The session an agent reports on: the one it names, else the one running, else the latest if it already
 * handed the task back (the user resumed it and asked for more).
 */
async function reportingSession(taskId: number, sessionId?: string | null): Promise<Session | null> {
  const s = await activeSession(taskId, sessionId);
  if (s) return s;
  const latest = await repo.latestSession(taskId);
  return latest?.status === "finished" ? latest : null;
}

/**
 * PacedMind Cloud's MCP server (the hosted app) serves agents on any computer, so it knows none of their folders or
 * files, and nothing it does runs on a computer.
 */
const HOSTED = MODE === "web";

/** Where the user sees a task in the web app. */
const taskLink = (t: Task) => `${cloudOrigin()}/${t.projectId ? `project/${encodeURIComponent(t.projectId)}` : "inbox"}?task=${t.key}`;

/**
 * The computer a session you ask for goes to: `name` (list_computers), else the one the task or its project runs on,
 * else (in the hosted app) the account's default. Null for this computer, which asks the user in its window itself.
 */
async function sessionComputer(t: Task, agent: AgentId, name?: string): Promise<Device | null> {
  const { list, hereId } = await computers();
  const project = t.projectId ? await repo.getProject(t.projectId) : null;
  const pinned = deviceIdFor(t.deviceId, project?.deviceId);
  const pinnedName = () => list.find((d) => d.id === pinned)?.name ?? "another computer";
  if (name) {
    const d = findComputer(name, list);
    if (!HOSTED && d.id === hereId) return null;
    if (pinned && pinned !== d.id) fail(`${t.key} runs on ${pinnedName()} only. Ask that one, or the user picks another computer in its details.`);
    return d;
  }
  if (!HOSTED) {
    if (!pinned || pinned === hereId) return null;
    return list.find((d) => d.id === pinned) ?? fail(`${t.key} runs on a computer that isn't signed in any more. The user picks another in its details.`);
  }
  const offered = offeredDevice(t, project, list, agent).deviceId;
  return list.find((d) => d.id === offered) ?? fail("None of the user's computers is signed in to PacedMind. Sessions run on a computer with the PacedMind desktop app.");
}

/**
 * Asks another computer for a session: it does what its own settings say (start, ask the user there, refuse), and only
 * where asking takes no two-factor code, since an agent never has one. Waits a few seconds for its answer.
 */
async function askComputer(t: Task, agent: AgentId, where: Surface | undefined, d: Device): Promise<string> {
  const code = () =>
    `${d.name} takes sessions from elsewhere only with the user's two-factor code, which you can't give. The user starts ${t.key} there with Start, ` +
    `or at ${taskLink(t)} with their code; to let you ask, they switch its Two-factor code off in PacedMind on ${d.name} (Settings → General). ` +
    "Give the user that link; don't ask again.";
  if (d.remoteStart === "off") {
    return `${d.name} refuses sessions asked for from elsewhere. The user starts ${t.key} there, or changes that in PacedMind on ${d.name} (Settings → General). Tell the user; don't ask again.`;
  }
  if (d.remoteCode) return code();
  let r: LaunchRequest;
  try {
    r = await repo.createLaunchRequest({ deviceId: d.id, taskId: t.id, agent, via: "agent", kind: "start", surface: where ?? null });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // It switched its code on since its entry said otherwise.
    if (refusedStepUp(message)) return code();
    fail(message);
  }
  // The computer looks for requests every few seconds.
  for (let waited = 0; r.status === "pending" && waited < 12_000; waited += 1500) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    r = (await repo.listLaunchRequests({ taskId: t.id, limit: 20 })).find((x) => x.id === r.id) ?? r;
  }
  const what = `${AGENT_LABEL[agent]} on ${t.key}`;
  if (r.status === "launched") return `${d.name} started ${what}${r.sessionId ? ` (session ${r.sessionId})` : ""}. It reports back here as it works.`;
  if (r.status !== "pending") return `${d.name} didn't start ${what}: ${r.note ?? r.status}. Tell the user; don't ask again.`;
  if (d.remoteStart === "ask" || (where ?? t.runIn) === "cloud") {
    return `Asked ${d.name}: ${what} waits for the user to allow it in PacedMind there (up to 10 minutes). Tell the user; don't ask again.`;
  }
  return `Sent to ${d.name}, which starts ${what} as soon as it sees the request` +
    `${deviceOnline(d) ? "" : `; it hasn't been online in the last few minutes, and the request waits there for 10 minutes`}.`;
}

const NO_FILES =
  "PacedMind Cloud's MCP server can't read files from your computer, so it can't attach images. Describe what they'd show in the report's details, or link to it.";

/** A session for an agent that works on a task PacedMind didn't start (your own Claude Code or Codex). */
async function outsideSession(t: Task, agent?: AgentId): Promise<Session> {
  notYours(t);
  const s = await repo.createSession({
    taskId: t.id, agent: agent ?? (await agentFor(t)) ?? "claude", folder: HOSTED ? null : plannedFolder(t),
    deviceId: HOSTED ? null : deviceConfig().deviceId, status: "running",
  });
  await repo.addSessionEvent(s.id, "started", "Started outside PacedMind");
  return s;
}

/** Copies images into PacedMind. If one fails, none are kept, so the agent can fix the path and call again. */
function storeImages(images: { path: string; caption?: string }[], base: string | null): { img: StoredImage; caption?: string }[] {
  const stored: { img: StoredImage; caption?: string }[] = [];
  try {
    for (const x of images) stored.push({ img: storeImage(x.path, base), caption: x.caption });
    return stored;
  } catch (e) {
    removeImageFiles(stored.map((x) => x.img.file));
    if (e instanceof ImageError) fail(images.length > 1 ? `${e.message} Nothing was recorded; fix it and call again.` : e.message);
    throw e;
  }
}

const norm = (x: string) => x.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Matches the agent's answers to the task's "Done when" items, by number or text. The report keeps each
 * item's text as it is now. Answers that match no item are kept too, as extra items the agent checked.
 */
function answerCriteria(t: Task, answers: { item: number | string; verdict: ReportCriterion["verdict"]; note?: string }[]): ReportCriterion[] {
  const out: ReportCriterion[] = t.doneWhen.map((text) => ({ text, verdict: null, note: "" }));
  for (const a of answers) {
    const ref = String(a.item).trim();
    let i: number;
    if (/^\d+$/.test(ref)) {
      i = Number(ref) - 1;
      if (i < 0 || i >= t.doneWhen.length) {
        fail(t.doneWhen.length
          ? `${t.key}'s Done when has ${plural(t.doneWhen.length, "item")}; there's no item ${ref}.`
          : `${t.key} has no Done when items. Pass the text of what you checked as item.`);
      }
    } else {
      i = t.doneWhen.findIndex((c) => norm(c) === norm(ref));
      if (i < 0) {
        const partial = t.doneWhen.map((c, k) => (norm(c).includes(norm(ref)) || norm(ref).includes(norm(c)) ? k : -1)).filter((k) => k >= 0);
        if (partial.length === 1) i = partial[0];
      }
    }
    const answer = { verdict: a.verdict, note: (a.note ?? "").trim() };
    if (i >= 0) out[i] = { ...out[i], ...answer };
    else if (ref) out.push({ text: ref, ...answer });
  }
  return out.slice(0, 50);
}

/** A session PacedMind started is done with PacedMind once it hands its task back: its token stops working. */
function releaseCaller() {
  const me = callerSession();
  if (me) {
    revokeSessionTokens([me.sessionId]);
    forgetSessionFiles([me.sessionId]);
  }
}

const taskMap = async () => new Map((await repo.listTasks()).map((t) => [t.id, t]));

/**
 * What an agent says it runs with (start_task's environment), as its session shows it: plain names only, the MCP
 * servers by where they come from (sortReported). Null when it said nothing that can be shown.
 */
function environmentText(who: string, model: string | undefined, servers: ReportedServers | null): string | null {
  const m = (model ?? "").replace(/[^\w .:()/+-]/g, "").trim().slice(0, 80);
  const parts = servers
    ? [
      servers.own.length ? `the MCP servers ${servers.own.join(", ")}` : null,
      servers.account.length ? `the claude.ai connectors ${servers.account.join(", ")}` : null,
      servers.plugins.length ? `the servers of its plugins ${servers.plugins.join(", ")}` : null,
    ].filter((p): p is string => !!p)
    : [];
  if (!m && !servers) return null;
  const list = servers ? `with ${parts.length ? parts.join("; ") : "no other MCP servers"}` : "";
  return `${who} says it runs${m ? ` as ${m}${list ? `, ${list}` : ""}` : ` ${list}`}`;
}

/**
 * Records what a session runs with: the model its agent says, and the MCP servers it has tools from. For a Claude Code
 * session this computer started in a terminal (it calls with its own token), those come from Claude Code's own record
 * of the session (session-mcp.ts), with the ones it lacks and why; with no project's pick, what the account its CLI is
 * signed in to gave it also goes on this computer's entry (noteAccountServers). Other sessions show what their agent
 * says, which can be wrong: an agent told a server failed can still list it.
 */
async function recordEnvironment(s: Session, projectId: string | null, env: { model?: string; mcp_servers?: string[] }) {
  const own = callerSession()?.sessionId === s.id && s.agent === "claude" && s.folder && s.cliSessionId;
  const state = own ? sessionMcp(s.folder!, s.cliSessionId!) : null;
  const servers = state?.servers
    ?? env.mcp_servers?.map((n) => n.trim()).filter((n) => /^[\w.@:+-]{1,60}$/.test(n) && n !== MCP_NAME && n !== OLD_MCP_NAME);
  // What the agent's plugins bring, from this computer's config files; PacedMind Cloud's server has none to read (a
  // session's folder there is a path on the user's computer).
  const plugins = HOSTED ? [] : [...agentExtras(s.agent).plugins, ...(s.folder ? folderExtras(s.folder).plugins : [])];
  const sorted = servers ? sortReported(servers, plugins) : null;
  const text = environmentText(AGENT_LABEL[s.agent], env.model, sorted);
  if (text) await repo.addSessionEvent(s.id, "environment", text);
  await noteSessionMcp(s, state, false);
  if (state && sorted && !projectServers(projectId)) await noteAccountServers(s.agent, sorted.account).catch(() => {});
}

export function registerAgentTools(server: McpServer) {
  /* ---------- dependencies ---------- */

  tool(server, "connect_tasks", {
    title: "Make a task wait for another",
    description:
      "Make one task wait for another in the same project (a dependency, drawn as an arrow on the Timeline): it's ready to work on once the other is done, or handed back for review unless that hand-back was partial or blocked. It only orders the work: nothing starts by itself. get_next_task and get_project follow it.",
    input: z.object({
      from: taskRef.describe("The task that comes first"),
      to: taskRef.describe("The task that waits for it"),
    }),
    kind: "create",
  }, async (args) => {
    const from = await findTask(args.from);
    const to = await findTask(args.to);
    if (from.id === to.id) fail("A task can't wait for itself.");
    if (!from.projectId || from.projectId !== to.projectId) fail("Both tasks have to be in the same project.");
    if (await edgeWouldLoop(from.id, to.id)) fail(`${from.key} already waits for ${to.key}, so this would make a loop.`);
    await repo.createEdge(from.id, to.id);
    return `${to.key} waits for ${from.key}.`;
  });

  tool(server, "disconnect_tasks", {
    title: "Remove a dependency",
    description: "Stop one task waiting for another.",
    input: z.object({ from: taskRef, to: taskRef }),
    kind: "delete",
  }, async ({ from, to }) => {
    const a = await findTask(from);
    const b = await findTask(to);
    const edge = (await repo.listEdges()).find((e) => e.fromTaskId === a.id && e.toTaskId === b.id);
    if (!edge) fail(`${b.key} doesn't wait for ${a.key}.`);
    await repo.deleteEdge(edge.id);
    return `${b.key} no longer waits for ${a.key}.`;
  });

  /* ---------- sessions ---------- */

  tool(server, "list_sessions", {
    title: "List agent sessions",
    description: "Agent sessions (Claude Code or Codex working on a task), newest first, with where they run and what they handed back. waiting means an agent finished and the user should review it.",
    input: z.object({
      status: z.enum(["waiting", "running", "all"]).optional().describe("Default all"),
      project: projectRef.optional(),
      task: taskRef.optional(),
      limit: z.number().int().min(1).max(200).optional().describe("Default 20"),
    }),
    kind: "read",
  }, async (args) => {
    const status = args.status === "waiting" ? ["finished" as const] : args.status === "running" ? LIVE_STATUSES : undefined;
    const task = args.task ? await findTask(args.task) : null;
    const project = args.project ? await findProject(args.project) : null;
    const tasks = await taskMap();
    const sessions = (await repo.listSessions({ status }))
      .filter((s) => (!task || s.taskId === task.id) && (!project || tasks.get(s.taskId)?.projectId === project.id));
    if (!sessions.length) return "No sessions match.";
    return (await sessionLines(sessions.slice(0, args.limit ?? 20), tasks)).join("\n");
  });

  tool(server, "start_session", {
    title: "Start agent session",
    description:
      "Ask to start Claude Code or Codex working on a task on one of the user's computers: in a terminal or the agent's desktop app there, in the task's folder, or in the agent's cloud (Claude Code on the web, Codex cloud); where the task says unless `where` is given. " +
      (HOSTED
        ? "It goes to `computer` (list_computers), else to the task's computer, else the default one, which does what its own settings say: starts it, asks the user there, or refuses. A computer that takes such requests only with the user's two-factor code can't take one from you: then the answer gives a link where the user starts it."
        : "On this computer the user allows it in the PacedMind app first (the request expires after 10 minutes). With `computer`, another of the user's computers (list_computers) does what its own settings say: starts it, asks the user there, or refuses."),
    input: z.object({
      task: taskRef,
      agent: agentSchema.optional(),
      where: z.enum(["terminal", "desktop", "cloud"]).optional()
        .describe("terminal, desktop (the Claude or Codex app, with the first message written for the user to send) or cloud"),
      computer: z.string().max(200).optional().describe("The computer's name or id from list_computers"),
    }),
    kind: "launch",
  }, async ({ task, agent, where, computer }) => {
    const t = await findTask(task);
    notYours(t);
    if ((await repo.listSessions({ taskId: t.id, status: LIVE_STATUSES })).length) fail(`${t.key} already has a running session.`);
    const who = agent ?? (await agentFor(t)) ?? "claude";
    const there = await sessionComputer(t, who, computer);
    if (there) return askComputer(t, who, where, there);
    const a = (await askFromAgent(t, who, where)) ?? fail(`${t.key} can't run on this computer.`);
    return (
      `Asked the user to allow ${t.key} with ${AGENT_LABEL[a.agent]} (${SURFACE_LABEL[a.surface].toLowerCase()}): PacedMind shows the request in its window ` +
      "and a notification. It starts once they allow it (within 10 minutes). Tell the user to look at PacedMind; don't ask again." +
      (a.surface === "cloud" ? " Cloud sessions can't report back to PacedMind; the user marks the task finished or done." : "")
    );
  });

  tool(server, "close_session", {
    title: "Close agent session",
    description: "Mark a running session as closed, e.g. when its terminal was closed or it got stuck. The task goes back to Todo.",
    input: z.object({ session: z.string().describe("Session id from list_sessions") }),
    kind: "delete",
  }, async ({ session }) => {
    const s = await findSession(session);
    await closeSession(s.id);
    return (await sessionLines([(await repo.getSession(s.id))!], await taskMap()))[0];
  });

  tool(server, "request_changes", {
    title: "Request changes",
    description:
      "Ask to send work an agent handed back to the agent again, with what the user wants changed. Once the user allows it in the PacedMind app, the changes go on the agent's last report and its session reopens in a new terminal on the user's computer, in a new conversation that reads the report and the changes. The task goes back to in progress.",
    input: z.object({
      task: taskRef,
      changes: z.string().max(20000).describe("What should change, in the user's words. The agent reads it as written"),
    }),
    kind: "launch",
  }, async ({ task, changes }) => {
    const t = await findTask(task);
    const s = await repo.latestSession(t.id);
    if (!s || (s.status !== "finished" && s.status !== "done")) {
      fail(`${t.key} has no hand-back to send changes to${s ? `: its latest session is ${SESSION_TEXT[s.status]}` : ""}. start_session starts a new session.`);
    }
    if (!changes.trim()) fail("Write what should change.");
    if (HOSTED) {
      return `Sending changes reopens the agent's session on the computer it ran on, so the user sends them themselves: with Request changes on ` +
        `${t.key} in PacedMind, or at ${taskLink(t)} with a two-factor code. Give the user that link and the changes to paste; don't ask again.`;
    }
    const problem = await changesProblem(s);
    if (problem) fail(problem);
    const a = (await askForChanges(s, t, changes.trim())) ?? fail(`${t.key} can't run on this computer.`);
    return (
      `Asked the user to allow sending the changes to ${AGENT_LABEL[a.agent]} for ${t.key}: PacedMind shows the request in its window and a notification. ` +
      "Once they allow it (within 10 minutes), session " + s.id + " reopens in a new terminal and the task is in progress again. Tell the user to look at PacedMind; don't ask again."
    );
  });

  /* ---------- the session protocol for agents working on a task ---------- */

  tool(server, "get_next_task", {
    title: "Get next task",
    description: "The next task in a project that is ready to be worked on (the tasks it waits for are finished).",
    input: z.object({ project: projectRef }),
    kind: "read",
  }, async ({ project }) => {
    const p = await findProject(project);
    const t = await nextReadyTask(p.id);
    return t ? describeTask(t) : `Nothing in ${p.name} is ready right now.`;
  });

  tool(server, "start_task", {
    title: "Start task",
    description:
      "Records that an agent's session is starting work on a task, and returns the task with what its hand-back should contain. " +
      "`environment` records what the session runs with, for the user to see.",
    input: z.object({
      task: taskRef,
      session: z.string().optional().describe("Session id given in your first message, if any"),
      agent: agentSchema.optional(),
      environment: z.object({
        model: z.string().max(80).optional().describe("The model you run as"),
        mcp_servers: z.array(z.string().max(60)).max(30).optional()
          .describe("Every MCP server you have tools from besides pacedmind, deferred ones too: the part between mcp__ and the next __ in those tools' names. PacedMind tells the user which configured ones you don't have"),
      }).optional().describe("What you run with. PacedMind shows it on the session as you report it"),
    }),
    kind: "write",
  }, async ({ task, session, agent, environment }) => {
    const t = await findTask(task);
    const s = (await ownSession(t, session)) ?? (callerSession() ? null : await activeSession(t.id, session)) ?? (await outsideSession(t, agent));
    await repo.updateSession(s.id, { status: "running" });
    await recordEnvironment(s, t.projectId, environment ?? {});
    await repo.addSessionEvent(s.id, "picked_up", `${AGENT_LABEL[s.agent]} read the task over MCP`);
    if (t.status !== "progress") await repo.updateTask(t.id, { status: "progress" });
    const after = (await repo.getTask(t.id))!;
    // A request for changes stays on the last report until the agent hands the task back again.
    const asked = await repo.latestReport(t.id);
    return [
      asked?.changes
        ? `The user reviewed your last hand-back and ${isAnswers(asked.changes) ? "answered your questions" : "asked for changes"} (${(asked.changesAt ?? "").replace("T", " ")}):\n${asked.changes}\n\n` +
          `${isAnswers(asked.changes) ? "Go on with the task using these answers" : "Make these changes first"}; your last report is at the end of the task below. ` +
          "Then hand the task back again with finish_task and a new report whose summary starts with what you changed.\n"
        : null,
      await describeTask(after),
      `\nPacedMind session: ${s.id}`,
      "Work on this task here. Keep the user posted with report_progress, but only when it matters: your plan once you have one (send it " +
        "again as steps get done) and anything that changes the scope or the risk (kind issue). Skip routine updates. When you need the " +
        (HOSTED
          ? "user to decide something before you can go on, ask in this conversation; report_progress with kind question also shows it on the task."
          : "user to decide something before you can go on, ask with ask_user: it waits for their answer, which they can give on any device."),
      `When it is ready for the user to check, call finish_task with task ${t.key}, session ${s.id} and a report:`,
      "- summary: one or two sentences on what changed and what the user should look at first;",
      after.doneWhen.length ? "- criteria: your answer to each Done when item above (met, partly or not_met, with a short note on how you checked);" : null,
      HOSTED
        ? null
        : "- images: screenshots of anything you changed that can be seen. Save each as a PNG, JPEG, GIF or WebP file and pass its path; attach_image adds them while you work;",
      "- verify: steps the user can follow to check the result, and questions: anything the user has to decide;",
      "- details: anything longer, in Markdown.",
      "If you can't finish, still call finish_task, with outcome partial or blocked, and say why. Do not mark the task done yourself.",
    ].filter((l) => l !== null).join("\n");
  });

  tool(server, "attach_image", {
    title: "Attach image",
    description:
      "For agents: add a screenshot or another image (PNG, JPEG, GIF or WebP, up to 20 MB) to the task you're working on, so the user sees it with your report. Save the image as a file first and pass its path; PacedMind keeps its own copy on this computer. You can also pass images to finish_task.",
    input: z.object({
      task: taskRef,
      session: z.string().optional().describe("Your session id"),
      path: z.string().max(1000).describe("Path of the image file on this computer. Relative paths are read from the task's folder"),
      caption: z.string().max(500).optional().describe("What the image shows, in a few words"),
    }),
    kind: "create",
  }, async ({ task, session, path, caption }) => {
    const t = await findTask(task);
    const s = (await ownSession(t, session)) ?? (callerSession() ? null : (await activeSession(t.id, session)) ?? (await repo.latestSession(t.id)));
    if (!s) fail(`${t.key} has no session yet. Call start_task with task ${t.key} first.`);
    if ((await repo.countSessionImages(s.id)) >= 40) fail("This session already has 40 images. Attach the ones that show the result best.");
    const [{ img }] = storeImages([{ path }], plannedFolder(t));
    // After a hand-back, the image joins the latest report; before, it waits for finish_task.
    const report = s.status === "running" || s.status === "starting" ? null : await repo.latestSessionReport(s.id);
    const a = await repo.addAttachment(img, { taskId: t.id, sessionId: s.id, reportId: report?.id ?? null, caption });
    return `Attached ${imageLine(a)} to ${t.key}${report ? ", in your last report" : ". It will be part of your report when you call finish_task"}.`;
  });

  tool(server, "report_progress", {
    title: "Report progress",
    description:
      "Posts an update on the task an agent is working on, which the user sees in PacedMind: the agent's plan (sent again as steps get done or it changes), " +
      "a problem that changes the scope or the risk (kind issue), or a decision the agent needs from the user (kind question, which notifies the user). " +
      "It doesn't wait for an answer and doesn't hand the work back.",
    input: z.object({
      task: taskRef,
      session: z.string().optional().describe("Your session id"),
      message: z.string().max(1000).optional().describe("What happened or what you need, in a sentence or two"),
      kind: z.enum(["progress", "issue", "question"]).optional()
        .describe("progress (default); issue: something that changes the scope or the risk; question: a decision you need from the user"),
      plan: z.array(z.object({
        step: z.string().min(1).max(120).describe("A step, as a short outcome"),
        done: z.boolean().optional().describe("Whether it's done"),
      })).max(15).optional().describe("Your whole plan, in order. Send it again when a step is done or the plan changes"),
    }),
    kind: "create",
  }, async ({ task, session, message, kind, plan }) => {
    const t = await findTask(task);
    const s = (await ownSession(t, session)) ?? (callerSession() ? null : await activeSession(t.id, session));
    if (!s || !isLiveSession(s)) fail(`${t.key} has no running session. Call start_task with task ${t.key} first.`);
    const text = (message ?? "").replace(/\s+/g, " ").trim();
    const steps = (plan ?? []).map((p) => ({ text: p.step.replace(/\s+/g, " ").trim(), done: !!p.done })).filter((p) => p.text);
    if (!text && !steps.length) fail("Pass a message, a plan, or both.");
    const sent = (await repo.sessionEvents(s.id)).filter((e) => e.kind === "plan" || e.kind === "progress" || e.kind === "issue" || e.kind === "question");
    if (sent.length >= 100) fail("This session already sent 100 updates. Put the rest in your report when you call finish_task.");
    const who = AGENT_LABEL[s.agent];
    const out: string[] = [];
    // The plan first: a question after it stays the latest event, which is what the user is told about (attentionOf).
    if (steps.length) {
      await repo.addSessionEvent(s.id, "plan", planText(steps));
      out.push(`Your plan is on ${t.key}: ${steps.filter((p) => p.done).length} of ${steps.length} steps done.`);
    }
    if (text) {
      const k = kind ?? "progress";
      await repo.addSessionEvent(s.id, k, k === "question" ? `${who} asks you: ${text}` : k === "issue" ? `${who} ran into a problem: ${text}` : `${who}: ${text}`);
      out.push(k === "question"
        ? "PacedMind shows your question on the task and notifies the user. Ask it in this conversation too, then wait for the answer here."
        : `Noted on ${t.key}.`);
    }
    return out.join(" ");
  });

  tool(server, "ask_user", {
    title: "Ask the user",
    description:
      "For agents: ask the user a question you need answered before you can go on, and wait for the answer. PacedMind shows it " +
      "on the task, notifies the user on their devices, and they answer in PacedMind. A call waits up to 45 seconds; with no " +
      "answer yet, call again with the ask it returned to keep waiting (up to 30 minutes in all). Don't ask the question again.",
    input: z.object({
      task: taskRef,
      session: z.string().optional().describe("Your session id"),
      question: z.string().max(4000).optional().describe("Your question, with the options when there are some"),
      ask: z.string().max(60).optional().describe("The ask a previous call returned, to keep waiting for its answer"),
    }),
    kind: "create",
  }, async ({ task, session, question, ask: askId }) => {
    const t = await findTask(task);
    const s = (await ownSession(t, session)) ?? (callerSession() ? null : await activeSession(t.id, session));
    if (!s || !isLiveSession(s)) fail(`${t.key} has no running session. Call start_task with task ${t.key} first.`);
    let ask;
    if (askId) {
      ask = await repo.getAsk(askId.trim());
      if (!ask || ask.sessionId !== s.id || ask.kind !== "question") fail("This session has no such question. Ask it again with question.");
      // Answered between two calls: nobody was waiting to pass it on yet.
      if (ask.status === "answered" && ask.answer) {
        await repo.addSessionEvent(s.id, "working", answeredText(s, "question", ask.answer));
        return `The user answered:\n${ask.answer}`;
      }
      if (ask.status !== "pending") fail("The user didn't answer in time. Ask again, ask in this conversation, or hand the task back as blocked.");
    } else {
      const q = (question ?? "").trim();
      if (!q) fail("Pass your question, or the ask a previous call returned.");
      ask = await openAsk(s, "question", q, null, QUESTION_OPEN_MS);
    }
    const answer = await waitForAnswer(ask, QUESTION_CALL_MS);
    if (answer !== null) {
      await repo.addSessionEvent(s.id, "working", answeredText(s, "question", answer));
      return `The user answered:\n${answer}`;
    }
    const now = await repo.getAsk(ask.id);
    if (now?.status === "answered") {
      return "An answer came from another device, but this computer takes answers only here. Ask in this conversation instead.";
    }
    if (now?.status === "pending" && Date.parse(now.expiresAt) > Date.now()) {
      return `No answer yet. To keep waiting, call ask_user again with ask ${ask.id} (not the question again), or go on with what you can do meanwhile.`;
    }
    if (now?.status === "pending") await repo.settleAsk(ask.id, "expired");
    return "The user didn't answer within 30 minutes. Hand the task back with finish_task, outcome blocked, and the question in questions.";
  });

  const listItem = z.string().max(2000);
  const criterion = z.object({
    item: z.union([z.number().int().min(1), z.string().max(400)]).describe("The Done when item's number, as start_task listed it, or its text"),
    verdict: z.enum(["met", "partly", "not_met"]),
    note: z.string().max(2000).optional().describe("How you checked it, or what's missing"),
  });

  tool(server, "finish_task", {
    title: "Finish task",
    description:
      "Hands a task back for the user's review with a report of the work, which PacedMind shows on the task: a summary, an answer to each Done when item, screenshots, how to check the result and questions. Outcome partial or blocked marks work that isn't finished.",
    input: z.object({
      task: taskRef,
      session: z.string().optional(),
      summary: z.string().max(2000).optional().describe("Required. One or two sentences on what changed and what the user should look at first"),
      outcome: z.enum(["done", "partial", "blocked"]).optional()
        .describe("done (default): everything asked for is ready. partial: only some of it is. blocked: you can't go on without the user"),
      criteria: z.array(criterion).max(50).optional().describe("Your answer to each of the task's Done when items"),
      images: z.array(z.object({
        path: z.string().max(1000).describe("Path of a PNG, JPEG, GIF or WebP file on this computer"),
        caption: z.string().max(500).optional().describe("What it shows"),
      })).max(20).optional().describe("Screenshots of the result, or other images that show it. Save them as files first"),
      verify: z.array(listItem).max(50).optional().describe("Steps the user can follow to check the result: a command to run, a page to open, what to look for"),
      questions: z.array(listItem).max(50).optional().describe("Decisions or answers you need from the user"),
      details: z.string().max(100000).optional().describe("Anything longer, in Markdown: what you did and why, trade-offs, test results, findings"),
      links: z.array(z.object({ label: z.string().max(200), url: z.string().max(2000) })).max(50).optional()
        .describe("Pull requests, commits, previews or documents (http or https links)"),
      follow_ups: z.array(taskRef).max(50).optional().describe("Keys of tasks you created for work outside this one"),
      note: z.string().max(2000).optional().describe("Older name for summary"),
    }),
    kind: "write",
  }, async (args) => {
    const t = await findTask(args.task);
    const summary = (args.summary ?? args.note ?? "").replace(/\s+/g, " ").trim();
    if (!summary) fail("finish_task needs a summary: one or two sentences on what changed and what the user should look at first.");
    const outcome = args.outcome ?? "done";
    if (t.doneWhen.length && !args.criteria?.length && outcome !== "blocked") {
      fail(`${t.key} lists what "done" means. Answer each item in criteria (verdict met, partly or not_met, with a note), then call finish_task again:\n` +
        t.doneWhen.map((c, i) => `${i + 1}. ${c}`).join("\n"));
    }
    const criteria = answerCriteria(t, args.criteria ?? []);
    const refs = [...new Set((args.follow_ups ?? []).map((k) => k.trim()).filter(Boolean))];
    const found = await Promise.all(refs.map(async (k) => [k, (await repo.getTask(k))?.key ?? null] as const));
    const followUps = found.flatMap(([, key]) => (key && key !== t.key ? [key] : []));
    const unknown = found.flatMap(([k, key]) => (key ? [] : [k]));
    const clean = (xs?: string[]) => (xs ?? []).map((x) => x.trim()).filter(Boolean);
    const links = (args.links ?? []).map((l) => ({ label: l.label.trim(), url: l.url.trim() }))
      .filter((l) => /^https?:\/\/\S+$/i.test(l.url)).map((l) => ({ label: l.label || l.url, url: l.url }));
    if (HOSTED && args.images?.length) fail(`${NO_FILES} Call finish_task again without images.`);
    const mine = await ownSession(t, args.session);
    const reporting = mine ?? (callerSession() ? null : await reportingSession(t.id, args.session));
    const stored = HOSTED ? [] : storeImages(args.images ?? [], plannedFolder(t));
    let result: Awaited<ReturnType<typeof finishTask>>;
    try {
      // A report belongs to a session: the agent's, or a new one when it works on the task outside PacedMind.
      const s = reporting ?? (await outsideSession(t));
      result = await finishTask(t.id, s.id, summary, "agent", {
        outcome, details: args.details, criteria, verify: clean(args.verify), questions: clean(args.questions), links, followUps, images: stored,
      }, s);
    } catch (e) {
      removeImageFiles(stored.map((x) => x.img.file));
      throw e;
    }
    const { session } = result;
    const report = session ? await repo.latestSessionReport(session.id) : null;
    const lines = [`Recorded your report for ${t.key} (${(report && reportCounts(report)) || "summary only"}). It waits for the user's check.`];
    const unanswered = criteria.filter((c) => c.verdict === null);
    if (unanswered.length && outcome !== "blocked") lines.push(`Not answered: ${unanswered.map((c) => `"${c.text}"`).join(", ")}.`);
    if (unknown.length) lines.push(`Left out follow-ups that aren't PacedMind tasks: ${unknown.join(", ")}.`);
    if ((args.links ?? []).length > links.length) lines.push("Left out links that aren't http or https.");
    if (outcome !== "done") lines.push(`You handed it back as ${outcome}: tasks that wait for ${t.key} wait until the user marks it done.`);
    lines.push("You can stop here.");
    releaseCaller();
    return lines.join("\n");
  });
}
