"use client";

import { usePathname } from "next/navigation";
import { updateTaskAction } from "@/app/actions";
import { attentionOf, attentionWords, dueInfo } from "@/lib/dates";
import { AGENT_LABEL, PRIORITY_LABEL, REPEAT_LABEL, type Task, type TaskContext } from "@/lib/types";
import { Icon, PriorityIcon, StatusIcon } from "./icons";
import { cx, useAction } from "./ui";
import { FloatTaskButton } from "./float-task-button";

const DUE_TONE = { overdue: "text-danger", today: "text-fg2", soon: "text-fg3", later: "text-mut" } as const;

export function DueChip({ due, done }: { due: string | null; done?: boolean }) {
  const info = dueInfo(due);
  if (!info) return null;
  return (
    <span className={cx("inline-flex h-5 shrink-0 items-center gap-1.5 rounded-[5px] border border-ctl px-1.5 text-[11.5px]", done ? "text-dim" : DUE_TONE[info.tone])}>
      <Icon name="flag" size={11} strokeWidth={2.2} />
      {info.text}
    </span>
  );
}

export function SessionChip({ task, ctx }: { task: Task; ctx: TaskContext }) {
  const s = ctx.sessions[task.id];
  if (!s) return null;
  // On a phone only the dot shows; the words would take the title's room.
  if (s.status === "running" || s.status === "starting") {
    const waits = attentionOf(ctx.sessionEvents[s.id] ?? []);
    if (waits) {
      const words = attentionWords(waits.kind);
      return (
        <span title={waits.text} className="inline-flex shrink-0 items-center gap-1.5 text-[11.5px] text-fg3">
          <span className="h-1.5 w-1.5 rounded-full bg-accent" />
          <span className="max-sm:hidden">{words}</span>
        </span>
      );
    }
    return (
      <span title={`${AGENT_LABEL[s.agent]} ${s.status}`} className="inline-flex shrink-0 items-center gap-1.5 text-[11.5px] text-mut">
        <span className="h-1.5 w-1.5 rounded-full bg-fg3" />
        <span className="max-sm:hidden">{AGENT_LABEL[s.agent]} {s.status}</span>
      </span>
    );
  }
  if (s.status === "finished") {
    return (
      <span title="Session finished" className="inline-flex shrink-0 items-center gap-1.5 text-[11.5px] text-fg3">
        <span className="h-1.5 w-1.5 rounded-full bg-accent" />
        <span className="max-sm:hidden">Session finished</span>
      </span>
    );
  }
  return null;
}

export function TaskRow({ task, ctx, selected, onSelect }: { task: Task; ctx: TaskContext; selected: boolean; onSelect: () => void }) {
  const { run } = useAction();
  // On the page of the project it's about, the project goes without saying.
  const path = usePathname();
  const about = task.relatedProjectId && !task.projectId && path !== `/project/${task.relatedProjectId}`
    ? ctx.projects.find((p) => p.id === task.relatedProjectId) : undefined;
  const done = task.status === "done" || task.status === "canceled";
  return (
    // On a phone: taller rows and a bigger target for the status, without the key and labels.
    <div className={cx("flex h-[38px] items-center gap-2.5 border-b border-hover pl-5 pr-4 max-sm:h-[46px] max-sm:pl-3.5", selected ? "bg-sel" : "hover:bg-hover")}>
      <span title={PRIORITY_LABEL[task.priority]} className="flex w-4 shrink-0 justify-center"><PriorityIcon priority={task.priority} /></span>
      <span className="w-[54px] shrink-0 font-mono text-[11.5px] text-mut2 max-sm:hidden">{task.key}</span>
      <button type="button" aria-label={done ? "Mark as not done" : "Mark as done"}
        onClick={() => run(() => updateTaskAction(task.id, { status: done ? "todo" : "done" }))}
        className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded hover:bg-ink/5 max-sm:h-9 max-sm:w-9 max-sm:-mx-2">
        <StatusIcon status={task.status} />
      </button>
      <button type="button" onClick={onSelect}
        className={cx("h-full min-w-0 flex-1 truncate text-left", done ? "text-mut2 line-through" : "text-fg")}>
        {task.title}
      </button>
      <SessionChip task={task} ctx={ctx} />
      {/* A project it's about, without being in it; and whether it comes back once done. */}
      {about && (
        <span title="About this project, without being part of it"
          className="inline-flex h-5 min-w-0 max-w-[160px] shrink items-center gap-1 rounded-[5px] border border-line2 px-1.5 text-[11.5px] text-mut max-sm:hidden">
          <Icon name="link" size={11} className="shrink-0" />
          <span className="truncate">{about.name}</span>
        </span>
      )}
      {task.repeat && (
        <span title={REPEAT_LABEL[task.repeat]} aria-label={REPEAT_LABEL[task.repeat]} className="shrink-0 text-mut2">
          <Icon name="repeat" size={13} />
        </span>
      )}
      {task.labels.slice(0, 2).map((l) => (
        <span key={l} className="inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full border border-ctl px-2 text-[11.5px] text-mut max-sm:hidden">
          <span className="h-1.5 w-1.5 rounded-full bg-mut2" />{l}
        </span>
      ))}
      <DueChip due={task.dueDate} done={done} />
      <FloatTaskButton task={task} scope={ctx.floatingScope} />
    </div>
  );
}
