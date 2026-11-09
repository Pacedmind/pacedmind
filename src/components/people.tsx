"use client";

import { useState } from "react";
import { useTranslation } from "./language";
import { ME, initialsOf, type Task, type TaskContext } from "@/lib/types";
import { Icon } from "./icons";
import { cx } from "./ui";

export type Person = { userId: string; name: string; email: string };

/** A person's avatar, with initials while a picture loads or when there is none. */
export function PersonMark({ userId, name, email, version, size = 20, className }: {
  userId?: string | null; name: string; email?: string | null; version?: string | null; size?: number; className?: string;
}) {
  const [loaded, setLoaded] = useState<string | null>(null);
  const src = userId && userId !== ME ? `/api/people/${encodeURIComponent(userId)}/avatar${version ? `?v=${version}` : ""}` : null;
  return (
    <span aria-hidden className={cx("relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-ctl bg-panel font-medium text-fg3", className)}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.45) }}>
      {initialsOf(name, email)}
      {src && (
        // eslint-disable-next-line @next/next/no-img-element -- the private avatar route checks this browser's session
        <img key={src} src={src} alt="" width={size} height={size} loading="lazy" decoding="async" draggable={false}
          onLoad={() => setLoaded(src)} className={cx("absolute inset-0 h-full w-full object-cover", loaded !== src && "opacity-0")} />
      )}
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

/** Resolve a task's author or assignee within its workspace. */
export function useTaskPerson(id: string | null, workspaceId: string | null, ctx: TaskContext): (Person & { you: boolean; avatarId: string | null }) | null {
  const tx = useTranslation();
  if (!id) return null;
  const you = id === ctx.people?.me || id === ME;
  const found = (workspaceId ? ctx.people?.members[workspaceId] : Object.values(ctx.people?.members ?? {}).flat())
    ?.find((m) => m.userId === id);
  if (found) return { ...found, you, avatarId: id };
  return { userId: id, name: you ? tx("You") : tx("Former member"), email: "", you, avatarId: you ? id : null };
}

/** Shared task lists show who is responsible, including tasks still waiting for someone. */
export function AssigneeChip({ task, ctx }: { task: Task; ctx: TaskContext }) {
  const tx = useTranslation();
  const person = useTaskPerson(task.assigneeId, task.workspaceId, ctx);
  if (!person && !task.workspaceId) return null;
  const name = person?.you ? tx("You") : person?.name ?? tx("Unassigned");
  const label = person?.you ? tx("Assigned to you") : person ? tx("Assigned to {0}", [person.name]) : name;
  return <span role="img" title={label} aria-label={label} className="inline-flex shrink-0 items-center gap-1.5 text-mut2">
    {person ? <PersonMark userId={person.avatarId} name={person.name || tx("You")} email={person.email} size={18} /> : <Icon name="user" size={16} />}
    {task.workspaceId && <span className="max-w-24 truncate text-[11px] max-sm:hidden">{name}</span>}
  </span>;
}
