import "server-only";
import * as repo from "./repo";
import { thisDeviceId } from "./devices";
import { otherSessionHere } from "./other-sessions";
import { oneLine } from "./store/shared";
import { MODE } from "./supabase";
import { toStamp } from "@/lib/dates";
import {
  HARNESS_LABEL, LIVE_STATUSES, harnessAgent, outsideConversation, type Harness, type OtherSession, type Session, type Task,
} from "@/lib/types";

/*
 * Bringing a Claude Code or Codex session PacedMind didn't start under a task (Sessions → Attach to a task). It becomes
 * one of the task's sessions, on the computer it ran on, with the same conversation: one at work or waiting for you
 * runs, one quiet for hours is finished and waits for your review. From then on it's PacedMind's like any other:
 * Resume reopens that very conversation with PacedMind's hooks and token (the launcher finds its folder in the agent's
 * own record on that computer, other-sessions.ts), and when its agent calls start_task or finish_task for the task
 * with your own connection, it reports on this session.
 */

const HARNESSES: Harness[] = ["claude-cli", "claude-app", "codex-cli", "codex-app"];
const REF = /^[A-Za-z0-9_-]{1,80}$/;

/** The conversations PacedMind's sessions have: sessions it started, and outside ones attached to a task. */
export async function attachedConversations(): Promise<Set<string>> {
  return new Set((await repo.listAllSessions()).flatMap((s) => (s.cliSessionId ? [s.cliSessionId] : [])));
}

export interface AttachInput {
  /** "here", or the id of the computer whose list it's on. */
  computer: string;
  harness: Harness;
  ref: string;
  /** The task to attach it to; without one, a new task is made from the session's title. */
  taskId?: number | null;
  /** For a new task: its title (else the session's) and project (else the Inbox). */
  title?: string;
  projectId?: string | null;
}

export type AttachResult = { ok: true; session: Session; task: Task; message: string } | { ok: false; error: string };

const local = (iso: string) => toStamp(new Date(iso));

/**
 * Attaches a session PacedMind didn't start to a task. The session is looked up again where its computer found it:
 * this computer looks at the agents' records now, another computer's is what it last said. Nothing here reaches a
 * command line: the conversation id is checked against a pattern, and the folder is only shown.
 */
export async function attachOutsideSession(input: AttachInput): Promise<AttachResult> {
  const fail = (error: string): AttachResult => ({ ok: false, error });
  if (!HARNESSES.includes(input.harness) || !REF.test(input.ref)) return fail("That session isn't there any more.");

  let found: OtherSession | null;
  let folder: string | null = null;
  let deviceId: string | null;
  let where = "";
  if (input.computer === "here") {
    if (MODE !== "desktop") return fail("Attach it from the PacedMind desktop app on its computer.");
    const here = otherSessionHere(input.harness, input.ref);
    if (!here) return fail("That session isn't on this computer any more: nothing happened in it for three days, or its record was removed.");
    found = here.session;
    folder = here.folder;
    deviceId = thisDeviceId();
  } else {
    const device = await repo.getDevice(input.computer);
    found = device?.otherSessions.find((s) => s.harness === input.harness && s.ref === input.ref) ?? null;
    if (!device || !found) return fail("That session isn't on its computer's list any more.");
    deviceId = device.id;
    where = ` on ${device.name}`;
  }

  // One conversation, one session: attached already, or started by PacedMind.
  const conversation = outsideConversation(found);
  if (conversation) {
    const already = (await repo.listAllSessions()).find((s) => s.cliSessionId === conversation);
    if (already) return fail(`That session is already ${(await repo.getTask(already.taskId))?.key ?? "another task"}'s.`);
  }

  const agent = harnessAgent(found.harness);
  let task: Task | null;
  if (input.taskId) {
    task = await repo.getTask(input.taskId);
    if (!task) return fail("That task is gone.");
  } else {
    const project = input.projectId ? await repo.getProject(input.projectId) : null;
    const title = oneLine(input.title?.trim() || found.title, 200) || `Work from ${HARNESS_LABEL[found.harness]} in ${found.place}`;
    task = await repo.createTask({ title, projectId: project?.id ?? null, agent });
  }
  if (task.agent === "human") return fail(`${task.key} is marked as yours. Hand it to Claude Code or Codex before attaching a session to it.`);

  const live = found.state !== "idle";
  if (live && (await repo.listAllSessions({ taskId: task.id, status: LIVE_STATUSES })).length) {
    return fail(`${task.key} already has a running session. Attach this one to another task, or close that one first.`);
  }
  const session = await repo.createSession({
    taskId: task.id, agent, surface: found.harness.endsWith("-app") ? "desktop" : "terminal", folder, deviceId,
    status: live ? "running" : "finished", cliSessionId: conversation, startedAt: local(found.startedAt), finishedAt: live ? null : local(found.activeAt),
  });
  if (found.title) await repo.updateSession(session.id, { note: found.title.slice(0, 2000) });
  await repo.addSessionEvent(session.id, "attached",
    `Attached to ${task.key}: it ran outside PacedMind, in ${found.harness === "claude-cli" ? "Claude Code" : `the ${HARNESS_LABEL[found.harness]}`} in ${found.place}${where}`);
  if (task.agent !== agent) await repo.updateTask(task.id, { agent });
  // Running, the task is in progress; finished, it waits for your review, as after a hand-back.
  if (live && (task.status === "todo" || task.status === "backlog")) await repo.updateTask(task.id, { status: "progress" });
  if (!live && (task.status === "todo" || task.status === "backlog" || task.status === "progress")) await repo.updateTask(task.id, { status: "review" });
  return {
    ok: true, session: (await repo.getSession(session.id))!, task: (await repo.getTask(task.id))!,
    message: `Attached to ${task.key}${live ? "" : ": it waits for your review"}`,
  };
}
