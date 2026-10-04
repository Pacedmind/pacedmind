import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { noteDisplaysSchema, type TaskNoteRequest } from "@/lib/task-notes";
import * as repo from "@/server/repo";
import { authState, MODE } from "@/server/supabase";
import { deviceConfig } from "@/server/device";
import { floatingTaskScope } from "@/server/floating-tasks";
import { floatingTaskVersions } from "@/server/floating-task-state";
import { publishNoteDisplays } from "@/server/task-note-displays";
import { isUiKey, UI_HEADER } from "@/server/ui-key";

export const dynamic = "force-dynamic";
const bodySchema = z.object({
  scope: z.string().max(36), displays: noteDisplaysSchema,
  receive: z.boolean().default(true),
  notes: z.array(z.object({ id: z.number().int().positive().safe(), createdAt: z.string().max(40) })).max(200).default([]),
  results: z.array(z.object({ id: z.string().uuid(), status: z.enum(["opened", "failed"]), note: z.string().max(500) })).max(40),
});
const g = globalThis as unknown as { __pacedmindDisplaysSent?: { scope: string; device: string; key: string; at: number } };

/** The header's Show notes button starts a fresh set after a restart, using only open tasks. */
export async function GET(request: NextRequest) {
  if (MODE !== "desktop" || request.headers.has("origin") || !isUiKey(request.headers.get(UI_HEADER))) {
    return new NextResponse(null, { status: 403 });
  }
  const scope = floatingTaskScope(await authState());
  if (request.nextUrl.searchParams.get("scope") === "1") {
    return NextResponse.json({ scope }, { headers: { "Cache-Control": "no-store" } });
  }
  const tasks = scope ? (await repo.listTasks()).filter((t) => t.status !== "done" && t.status !== "canceled")
    .map((t) => ({ id: t.id, createdAt: t.createdAt })) : [];
  return NextResponse.json({ scope, tasks }, { headers: { "Cache-Control": "no-store" } });
}

/** Only the main process has this header: cookies, an MCP bearer token and a browser Origin never suffice. */
export async function POST(request: NextRequest) {
  if (MODE !== "desktop" || request.headers.has("origin") || !isUiKey(request.headers.get(UI_HEADER))) {
    return new NextResponse(null, { status: 403 });
  }
  if (Number(request.headers.get("content-length")) > 24000) return new NextResponse(null, { status: 413 });
  const raw = await request.text();
  if (raw.length > 24000) return new NextResponse(null, { status: 413 });
  let input;
  try { input = bodySchema.parse(JSON.parse(raw)); } catch { return new NextResponse(null, { status: 400 }); }
  const scope = await floatingTaskScope(await authState());
  if (!scope || input.scope !== scope) return NextResponse.json({ scope, requests: [], acknowledged: [] });
  const displays = { ...input.displays, updatedAt: new Date().toISOString() };
  publishNoteDisplays(scope, displays);
  const device = scope === "local" ? "" : deviceConfig().deviceId;
  // Planner-only accounts may still open local notes before registering this computer.
  if (device === null) return NextResponse.json({ scope, requests: [], acknowledged: [], versions: await floatingTaskVersions(scope, input.notes) });

  // Publish on a change and every half minute, without refreshing every planner page on each heartbeat.
  const key = JSON.stringify({ ...displays, updatedAt: null });
  const sent = g.__pacedmindDisplaysSent;
  if (!sent || sent.scope !== scope || sent.device !== device || sent.key !== key || Date.now() - sent.at > 30_000) {
    await repo.saveTaskNoteDisplays(device, displays);
    g.__pacedmindDisplaysSent = { scope, device, key, at: Date.now() };
  }
  const rows = await repo.listTaskNoteRequests(device);
  const acknowledged: string[] = [];
  for (const result of input.results) {
    const row = rows.find((r) => r.id === result.id);
    if (row?.status === "dispatched") await repo.settleTaskNoteRequest(row.id, "dispatched", result.status, result.note);
    acknowledged.push(result.id);
  }
  const requests: TaskNoteRequest[] = [];
  for (const row of input.receive ? rows.reverse() : []) {
    if (row.status !== "pending" && row.status !== "dispatched") continue;
    if (acknowledged.includes(row.id)) continue;
    if (Date.parse(row.expiresAt) <= Date.now()) {
      await repo.settleTaskNoteRequest(row.id, row.status, "expired", "The desktop app did not open this note in time. Ask again if it is still needed.");
      continue;
    }
    if (row.status !== "pending") continue;
    const task = await repo.getTask(row.taskId);
    if (!task || task.createdAt !== row.taskCreatedAt) {
      await repo.settleTaskNoteRequest(row.id, "pending", "failed", "That task was deleted or replaced.");
      continue;
    }
    // Claim before handing it to Electron. A lost reply or restart must never reopen a note the user has closed.
    if (await repo.settleTaskNoteRequest(row.id, "pending", "dispatched")) requests.push(row);
  }
  const versions = await floatingTaskVersions(scope, input.notes);
  return NextResponse.json({ scope, requests, acknowledged, versions });
}
