"use client";

import { useTranslation } from "./language";
import { ME, initialsOf, type Task, type TaskContext } from "@/lib/types";
import { cx } from "./ui";

export type Person = { userId: string; name: string; email: string };

/** A person's initials in a small circle: state is grayscale, so people get no colors of their own. */
export function PersonMark({ name, email, size = 20, className }: { name: string; email?: string | null; size?: number; className?: string }) {
  return (
    <span aria-hidden className={cx("inline-flex shrink-0 items-center justify-center rounded-full border border-ctl bg-panel font-medium text-fg3", className)}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.45) }}>
      {initialsOf(name, email)}
    </span>
  );
}

/** Who a task can be assigned to: the members of its team workspace, or for one of your own tasks you alone. */
export function assignable(task: Pick<Task, "workspaceId">, ctx: TaskContext): Person[] {
  const people = ctx.people;
  if (!people?.me) return [];
  if (task.workspaceId) return people.members[task.workspaceId] ?? [];
  const self = Object.values(people.members).flat().find((m) => m.userId === people.me);
  return [{ userId: people.me, name: self?.name ?? "", email: self?.email ?? "" }];
}

/** The person a task is assigned to, as its list and details show them. */
export function useAssignee(task: Pick<Task, "assigneeId" | "workspaceId">, ctx: TaskContext): (Person & { you: boolean }) | null {
  const tx = useTranslation();
  if (!task.assigneeId) return null;
  const you = task.assigneeId === ctx.people?.me || task.assigneeId === ME;
  const found = (task.workspaceId ? ctx.people?.members[task.workspaceId] : Object.values(ctx.people?.members ?? {}).flat())
    ?.find((m) => m.userId === task.assigneeId);
  if (found) return { ...found, you };
  return { userId: task.assigneeId, name: you ? tx("You") : tx("Former member"), email: "", you };
}

/** The assignee's initials on a task's row. */
export function AssigneeChip({ task, ctx }: { task: Task; ctx: TaskContext }) {
  const tx = useTranslation();
  const person = useAssignee(task, ctx);
  if (!person) return null;
  const label = person.you ? tx("Assigned to you") : tx("Assigned to {0}", [person.name]);
  return <span title={label} aria-label={label} className="inline-flex shrink-0"><PersonMark name={person.name || tx("You")} email={person.email} size={18} /></span>;
}
