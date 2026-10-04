"use server";

import { updateTaskAction } from "@/app/actions";
import { guardAction } from "@/server/guard";
import { floatingTaskScope } from "@/server/floating-tasks";
import { authState } from "@/server/supabase";
import * as repo from "@/server/repo";

export async function setFloatingTaskDone(id: number, scope: string, createdAt: string, done: boolean) {
  await guardAction();
  if (!Number.isSafeInteger(id) || id < 1 || typeof scope !== "string" || typeof createdAt !== "string" ||
      typeof done !== "boolean" || floatingTaskScope(await authState()) !== scope) {
    return { ok: false, error: "This note is no longer connected to your planner. Reopen the task in PacedMind." };
  }
  const task = await repo.getTask(id);
  if (!task || task.createdAt !== createdAt) return { ok: false, error: "This task is no longer available." };
  // The same completion path as the planner: repeating tasks and session hand-backs stay consistent.
  return updateTaskAction(id, { status: done ? "done" : "todo" });
}
