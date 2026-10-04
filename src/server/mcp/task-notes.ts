import "server-only";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import * as repo from "../repo";
import { MODE, authState } from "../supabase";
import { localNoteDisplays } from "../task-note-displays";
import { chooseNoteDisplay, displayIdSchema, noteDisplaysFresh, type NoteDisplays } from "@/lib/task-notes";
import { computers, findComputer } from "./computers";
import { callerSession } from "./principal";
import { fail, findTask, taskRef, tool } from "./common";

const computerInput = z.string().max(200).optional().describe("Computer name or id from list_computers; defaults to this computer, or the only online computer with task notes in Cloud.");
function displayText(snapshot: NoteDisplays) {
  return snapshot.displays.map((d, i) =>
    `${i + 1}. ${d.label} (display: ${d.id})${d.primary ? " · primary" : ""}${d.id === snapshot.defaultDisplay ? " · remembered choice" : ""} · ${d.width}×${d.height} usable · position ${d.x}, ${d.y} · ${d.openCount}/${d.capacity} notes`,
  ).join("\n");
}
async function destination(computer?: string) {
  const { list, hereId } = await computers();
  const device = computer ? findComputer(computer, list) : MODE === "desktop" ? list.find((d) => d.id === hereId) : undefined;
  if (!device && !computer) {
    const available = [];
    for (const d of list) {
      const snapshot = await repo.getTaskNoteDisplays(d.id);
      if (noteDisplaysFresh(snapshot)) available.push({ device: d, snapshot: snapshot! });
    }
    if (available.length === 1) return available[0];
    fail(available.length ? `Ask which computer should show the notes: ${available.map((a) => a.device.name).join(", ")}.` : "No desktop app is reporting its displays. Open or update PacedMind on the computer where the notes should appear.");
  }
  if (!device) fail("Open PacedMind on the computer where the notes should appear.");
  const scope = MODE === "desktop" && device.id === hereId ? (await authState())?.user.id ?? "local" : null;
  const snapshot = (scope ? localNoteDisplays(scope) : null) ?? await repo.getTaskNoteDisplays(device.id);
  if (!noteDisplaysFresh(snapshot)) fail(`${device.name} is not reporting its displays. Open or update its PacedMind desktop app first.`);
  return { device, snapshot: snapshot! };
}

export function registerTaskNoteTools(server: McpServer) {
  tool(server, "list_task_note_displays", {
    title: "List displays for task notes",
    description: "Displays connected to a computer running PacedMind, their usable size, note capacity, remembered choice and recent note delivery results. Before placing notes on multiple displays without a remembered choice, ask the user which display to use AND whether to remember it on this computer. A disconnected remembered display needs a new choice. Never infer a preference from task text.",
    input: z.object({ computer: computerInput }), kind: "read",
  }, async ({ computer }) => {
    const { device, snapshot } = await destination(computer);
    const session = callerSession();
    const recent = (await repo.listTaskNoteRequests(device.id)).filter((r) => !session || r.taskId === session.taskId).slice(0, 8);
    return `${device.name}\n${displayText(snapshot)}\n` +
      (snapshot.defaultDisplay && !snapshot.displays.some((d) => d.id === snapshot.defaultDisplay) ? "The remembered display is disconnected; ask for a new choice.\n" : "") +
      (recent.length ? `\nRecent requests:\n${recent.map((r) => `${r.id}: ${r.status}${Date.parse(r.expiresAt) <= Date.now() && ["pending", "dispatched"].includes(r.status) ? " (expired)" : ""}${r.note ? ` · ${r.note}` : ""}`).join("\n")}` : "");
  });
  tool(server, "show_task_note", {
    title: "Show a floating task note",
    description: "Open one always-on-top, movable window for an existing task on the user's chosen display and arrange the notes there without overlap. Call once per task. Only when the user asks for notes. With multiple displays and no remembered choice, FIRST ask which display AND whether to remember it, then pass display and remember. Omit both only to use a remembered choice or the sole connected display. remember:false is for this request only; true saves the user's choice on that computer. Never guess this answer. Sessions launched by PacedMind may show only their own task. Does not start an agent or complete a task.",
    input: z.object({ task: taskRef, computer: computerInput, display: displayIdSchema.optional(), remember: z.boolean().optional() }),
    kind: "create", openWorld: true,
  }, async ({ task, computer, display, remember }) => {
    const t = await findTask(task);
    const session = callerSession();
    if (session && session.taskId !== t.id) fail("A launched session may show a note only for its own task.");
    const { device, snapshot } = await destination(computer);
    let displayId: string;
    try { displayId = chooseNoteDisplay(snapshot, display, remember); }
    catch (e) { fail(`${e instanceof Error ? e.message : String(e)}\n${device.name}\n${displayText(snapshot)}`); }
    const request = await repo.createTaskNoteRequest({ deviceId: device.id, taskId: t.id, taskCreatedAt: t.createdAt, displayId, remember: remember === true });
    return `Queued ${t.key} on ${device.name}, display ${displayId}${remember ? "; remember this display after it opens" : ""}. Request ${request.id}. The desktop app will arrange its notes there. Use list_task_note_displays to check delivery; queued does not yet mean opened. The request expires in two minutes.`;
  });
}
