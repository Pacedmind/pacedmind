"use client";

import { useEffect } from "react";
import { setFloatingTaskDone } from "@/app/floating/task/[id]/actions";
import { attentionOf, attentionWords, planOf } from "@/lib/dates";
import { AGENT_LABEL, PRIORITY_LABEL, STATUS_LABEL, isLiveSession } from "@/lib/types";
import type { FloatingTaskData } from "@/lib/floating-task";
import { AgentIcon, Icon, StatusIcon } from "./icons";
import { DueChip } from "./task-row";
import { LiveRefresh } from "./live-refresh";
import { Button, IconButton, Toaster, cx, useAction } from "./ui";
import { useNoteAppearance } from "./task-note-appearance";

export function FloatingTask({ data, version }: { data: FloatingTaskData | null; version: string }) {
  const { run, pending } = useAction();
  useNoteAppearance(data);
  const task = data?.task;
  const done = task?.status === "done";
  const closed = done || task?.status === "canceled";
  const session = data?.session;
  const live = session && isLiveSession(session);
  const attention = live ? attentionOf(data.events) : null;
  const plan = live ? planOf(data.events) : null;
  const next = plan?.steps.find((s) => !s.done);
  const progress = data?.events.findLast((e) => e.kind === "progress" || e.kind === "issue" || e.kind === "picked_up");
  const sessionLabel = !session ? null : attention ? attentionWords(attention.kind)
    : session.status === "finished" ? data.report?.outcome === "blocked" ? "Blocked · needs you"
      : data.report?.outcome === "partial" ? "Partly done · review" : "Finished · review"
    : { starting: "Starting", running: "Working", done: "Marked done", closed: "Session closed", failed: "Couldn't start" }[session.status];
  const note = attention?.text ?? (live ? progress?.text ?? session?.note : data?.report?.summary ?? session?.note);
  useEffect(() => { document.title = task ? `${task.key} · ${task.title} — PacedMind` : "Task note — PacedMind"; }, [task]);

  return (
    <main aria-label="Floating task" className="task-note-surface flex h-full flex-col overflow-hidden border border-line2 bg-panel">
      {data && task && <div className="task-note-xs min-h-0 flex-1 items-center gap-2 px-2">
        <span className="task-note-titlebar flex h-full w-3 shrink-0 items-center text-mut2" title="Drag to move"><Icon name="layers" size={12} /></span>
        <button type="button" title={task.title} className={cx("min-w-0 flex-1 text-left text-[13px] leading-snug text-fg2", closed && "line-through text-mut")} onClick={() => window.pacedMindDesktop?.showFloatingTask?.(data.href)}><span className="line-clamp-2">{task.title}</span></button>
        <div className="task-note-xs-controls flex shrink-0 flex-col">
          <IconButton label="Open task details" onClick={() => window.pacedMindDesktop?.showFloatingTask?.(data.href)}><Icon name="external" size={12} /></IconButton>
          <IconButton label="Close compact note" onClick={() => window.pacedMindDesktop?.closeTaskNote?.()}><Icon name="x" size={12} /></IconButton>
        </div>
      </div>}
      <header className="task-note-titlebar flex h-10 shrink-0 items-center gap-2 border-b border-line px-3 text-[11px] text-mut">
        <Icon name="layers" size={13} />
        <span title="Drag to move this note. It stays above other windows." className="flex-1 select-none">Always on top</span>
        <IconButton label="Open in PacedMind" onClick={() => window.pacedMindDesktop?.showFloatingTask?.(data?.href ?? "/today")}>
          <Icon name="appWindow" size={14} />
        </IconButton>
        <IconButton label="Close note" onClick={() => window.pacedMindDesktop?.closeTaskNote?.()}><Icon name="x" size={15} /></IconButton>
      </header>
      {data && task ? <>
        <div className="task-note-content flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
          <div className="flex min-w-0 items-center gap-2 text-[11px] text-mut">
            {data.color && <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: data.color }} />}
            <span className="min-w-0 flex-1 truncate">{data.place}</span>
            <span className="shrink-0 font-mono">{task.key}</span>
          </div>
          <h1 className={cx("break-words text-[17px] font-semibold leading-snug tracking-[-0.01em]", closed ? "text-mut line-through" : "text-strong")}>{task.title}</h1>
          <div className="flex flex-wrap items-center gap-2.5 text-[12px] text-fg3" aria-live="polite">
            <span className="inline-flex items-center gap-1.5"><StatusIcon status={task.status} />{STATUS_LABEL[task.status]}</span>
            <DueChip due={task.dueDate} done={closed} />
            {task.priority !== 0 && <span className="text-mut">{PRIORITY_LABEL[task.priority]}</span>}
          </div>
          {session && <section aria-label="Agent progress" aria-live="polite" className="flex flex-col gap-2 rounded-lg border border-line2 bg-bg p-3 text-[12px]">
            <div className="flex flex-wrap items-center gap-1.5 text-fg2">
              <AgentIcon agent={session.agent} size={13} /><span>{AGENT_LABEL[session.agent]}</span>
              <span className="text-dim">·</span>
              <span className={session.status === "finished" ? "text-accent" : "text-fg3"}>{sessionLabel}</span>
            </div>
            {note && <p className="line-clamp-4 break-words whitespace-pre-line leading-relaxed text-mut">{note}</p>}
            {plan && <div className="flex flex-col gap-1.5 text-mut">
              <div className="flex items-center justify-between text-[11px]"><span>Agent plan</span><span>{plan.steps.filter((s) => s.done).length} / {plan.steps.length}</span></div>
              <progress className="task-note-progress h-1 w-full" max={plan.steps.length} value={plan.steps.filter((s) => s.done).length} aria-label="Agent plan progress" />
              {next && <p className="line-clamp-2 break-words text-[11px]">{next.text}</p>}
            </div>}
          </section>}
          {data.subtasks.total > 0 && <span className="text-[11px] text-mut">{data.subtasks.done} of {data.subtasks.total} subtasks done</span>}
        </div>
        <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-line px-4 py-3">
          <span className="text-[11px] text-mut2">Live updates</span>
          <Button variant={closed ? "outline" : "primary"} disabled={pending} onClick={() => run(() => setFloatingTaskDone(task.id, data.scope, task.createdAt, !closed))}>
            <Icon name={closed ? "refresh" : "check"} size={13} />{pending ? "Saving…" : closed ? "Reopen task" : "Mark as done"}
          </Button>
        </footer>
      </> : <div className="flex flex-1 items-center p-5 text-[13px] leading-relaxed text-mut" role="status">This task is no longer available. Reopen it in PacedMind.</div>}
      <Toaster />
      <LiveRefresh refreshOnMount taskNoteVersion={version} />
    </main>
  );
}
