"use client";

import { useSyncExternalStore } from "react";
import type { Task } from "@/lib/types";
import { Icon } from "./icons";
import { IconButton, useAction } from "./ui";

const subscribe = () => () => {};
const available = () => !!window.pacedMindDesktop?.floatTask;
const serverAvailable = () => false;

/** Hidden in the web app, ordinary browsers and older desktop builds. */
export function FloatTaskButton({ task, scope }: { task: Task; scope?: string | null }) {
  const desktop = useSyncExternalStore(subscribe, available, serverAvailable);
  const { run, pending } = useAction();
  if (!desktop || !scope) return null;
  return <IconButton label="Float task" disabled={pending} className="shrink-0" onClick={() => run(async () => {
    const result = await window.pacedMindDesktop!.floatTask!(task.id, scope, task.createdAt);
    return typeof result === "object" ? result : { ok: result, error: "Couldn't open the task note. Reopen the task and try again." };
  })}><Icon name="external" size={14} /></IconButton>;
}
