import "server-only";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import * as repo from "../repo";
import { inviteLink } from "../store/shared";
import { cloudOrigin } from "../supabase-config";
import { WEBHOOK_EVENTS, type Task, type Workspace, type WorkspaceDetails, type WorkspaceMember } from "@/lib/types";
import { areaRef, fail, findArea, isOpen, plural, tool } from "./common";

/*
 * Team workspaces (PacedMind Cloud): a company's shared areas, with the people in them. Owners and admins manage
 * people, invitations, domains and which areas are shared; members work on everything inside. The database decides
 * all of it (supabase/migrations/*_team_workspaces.sql); these tools only find what the user names and say what
 * happened. Nothing here sends email: an invitation is a link the user passes on.
 */

export const workspaceRef = z.string().describe("Team workspace name, address (slug) or id");
const memberRef = z.string().describe('A member\'s email address or user id, or "me"');

const ROLE_TEXT = { owner: "owner", admin: "admin", member: "member" } as const;

/** A workspace the user is in, by id, slug or name (any case). */
export async function findWorkspace(query: string): Promise<Workspace> {
  const q = query.trim().toLowerCase();
  const all = await repo.listWorkspaces();
  if (!all.length) return fail("The user isn't in any team workspace. create_workspace makes one (PacedMind Cloud only).");
  const exact = all.find((w) => w.id === q || w.slug === q || w.name.toLowerCase() === q);
  if (exact) return exact;
  const partial = all.filter((w) => w.name.toLowerCase().includes(q));
  if (partial.length === 1) return partial[0];
  return fail(`No team workspace matches "${query}". Workspaces: ${all.map((w) => `${w.name} (${w.slug})`).join(", ")}.`);
}

async function details(query: string): Promise<WorkspaceDetails> {
  const w = await findWorkspace(query);
  return (await repo.getWorkspace(w.id)) ?? fail(`No team workspace ${query}.`);
}

/** A member of the workspace: "me", their email address, their user id, or their name when only one has it. */
export async function findMember(ws: WorkspaceDetails, query: string): Promise<WorkspaceMember> {
  const q = query.trim().toLowerCase();
  const me = await repo.currentUserId();
  const member = q === "me"
    ? ws.members.find((m) => m.userId === me)
    : ws.members.find((m) => m.userId === q || m.email === q) ?? (() => {
      const named = ws.members.filter((m) => m.name.toLowerCase() === q);
      return named.length === 1 ? named[0] : undefined;
    })();
  return member ?? fail(`${query} isn't a member of ${ws.name}. Members: ${ws.members.map((m) => `${m.name} <${m.email}>`).join(", ")}.`);
}

const memberLine = (m: WorkspaceMember, me: string | null) =>
  `${m.name} <${m.email}> · ${ROLE_TEXT[m.role]}${m.userId === me ? " · the user" : ""} · id ${m.userId} · joined ${m.joinedAt.slice(0, 10)}${m.joinedVia === "domain" ? " through the domain" : ""}`;

async function workspaceText(w: WorkspaceDetails): Promise<string> {
  const [me, areas, tasks, hooks] = await Promise.all([
    repo.currentUserId(), repo.listAreas(), repo.listTasks({ workspaceId: w.id }), repo.listWebhooks(w.id).catch(() => []),
  ]);
  const shared = areas.filter((a) => a.workspaceId === w.id);
  const open = tasks.filter(isOpen);
  const mine = open.filter((t) => t.assigneeId === me);
  return [
    `${w.name} · address ${w.slug} · id ${w.id} · the user is ${w.role === "member" ? "a member" : `an ${w.role}`}`,
    `Members (${w.members.length}):\n${w.members.map((m) => `- ${memberLine(m, me)}`).join("\n")}`,
    w.role === "member" ? null
      : `Invitations waiting: ${w.invites.length ? `\n${w.invites.map((i) => `- ${i.email} as ${i.role} · until ${i.expiresAt.slice(0, 10)} · invitation ${i.id}`).join("\n")}` : "none"}`,
    `Domains (people whose confirmed email address is there may join as members): ${w.domains.length ? w.domains.join(", ") : "none"}`,
    `Shared areas: ${shared.length ? shared.map((a) => `${a.name} (key ${a.key}, id ${a.id})`).join(", ") : "none yet: share_area moves one of the user's own in"}`,
    `Tasks: ${plural(open.length, "open task")}, ${mine.length} of them assigned to the user`,
    `The user's webhooks here: ${hooks.length}`,
  ].filter((x) => x !== null).join("\n");
}

export function registerWorkspaceTools(server: McpServer) {
  tool(server, "list_workspaces", {
    title: "List team workspaces",
    description: "The team workspaces the user is in (PacedMind Cloud), with their role, members, shared areas and how many open tasks are assigned to the user.",
    input: z.object({}),
    kind: "read",
  }, async () => {
    const [list, areas, me, members] = await Promise.all([repo.listWorkspaces(), repo.listAreas(), repo.currentUserId(), repo.listWorkspaceMembers()]);
    if (!list.length) return "The user isn't in any team workspace yet. create_workspace makes one (PacedMind Cloud only).";
    const tasks = await repo.listTasks();
    return list.map((w) => {
      const shared = areas.filter((a) => a.workspaceId === w.id);
      const open = tasks.filter((t) => t.workspaceId === w.id && isOpen(t));
      return `${w.name} · address ${w.slug} · id ${w.id} · ${ROLE_TEXT[w.role]} · ${plural(members.filter((m) => m.workspaceId === w.id).length, "member")}`
        + ` · areas: ${shared.length ? shared.map((a) => `${a.name} (${a.key})`).join(", ") : "none"}`
        + ` · ${plural(open.length, "open task")}, ${open.filter((t) => t.assigneeId === me).length} assigned to the user`;
    }).join("\n");
  });

  tool(server, "create_workspace", {
    title: "Create team workspace",
    description: "Make a team workspace (PacedMind Cloud) with the user as its owner, who pays for it with their Cloud plan. Then invite_member, set_workspace_domain and share_area or create_area with workspace.",
    input: z.object({ name: z.string().describe("The team's name, like the company's") }),
    kind: "create",
  }, async ({ name }) => {
    if (!name.trim()) fail("A team workspace needs a name.");
    const w = await repo.createWorkspace(name);
    return `Created team workspace ${w.name} · address ${w.slug} · id ${w.id}. The user is its owner.`;
  });

  tool(server, "get_workspace", {
    title: "Get team workspace",
    description: "A team workspace's members with their roles and ids, waiting invitations (owners and admins see them), domains, shared areas and task counts.",
    input: z.object({ workspace: workspaceRef }),
    kind: "read",
  }, async ({ workspace }) => workspaceText(await details(workspace)));

  tool(server, "invite_member", {
    title: "Invite member",
    description: "Invite someone to a team workspace by email (owners and admins). Returns an invitation link, valid 14 days, that only an account with that confirmed email address can accept. PacedMind sends no email: give the link to the user to send. A new invitation to the same address replaces the old link.",
    input: z.object({
      workspace: workspaceRef,
      email: z.string().describe("Their email address"),
      role: z.enum(["member", "admin"]).optional().describe("member (default) works on the shared areas; admin also manages people, domains and areas"),
    }),
    kind: "create",
  }, async ({ workspace, email, role }) => {
    const w = await findWorkspace(workspace);
    const invite = await repo.inviteMember(w.id, email, role ?? "member");
    return [
      `Invited ${invite.email} to ${w.name} as ${invite.role}, until ${invite.expiresAt.slice(0, 10)}.`,
      `Link: ${inviteLink(cloudOrigin(), invite.token)}`,
      "PacedMind doesn't email it: the user sends this link. It only works for that email address, once confirmed; anyone else who opens it gets nothing.",
    ].join("\n");
  });

  tool(server, "update_member", {
    title: "Change member's role",
    description: "Change a member's role in a team workspace: owner, admin or member. Owners and admins change roles; only an owner makes or unmakes owners, and the workspace always keeps one.",
    input: z.object({ workspace: workspaceRef, member: memberRef, role: z.enum(["owner", "admin", "member"]) }),
    kind: "write",
  }, async ({ workspace, member, role }) => {
    const w = await details(workspace);
    const m = await findMember(w, member);
    await repo.setMemberRole(w.id, m.userId, role);
    return `${m.name} <${m.email}> is now ${role === "member" ? "a member" : `an ${role}`} of ${w.name}.`;
  });

  tool(server, "remove_member", {
    title: "Remove member",
    description: 'Remove someone from a team workspace (owners and admins), or with "me" leave it. They lose access to its shared areas at once and their assignments there are cleared; what they wrote stays. The last owner can\'t leave while others are in it, and the last member leaving deletes the workspace with everything shared in it. Ask the user first.',
    input: z.object({ workspace: workspaceRef, member: memberRef }),
    kind: "delete",
  }, async ({ workspace, member }) => {
    const w = await details(workspace);
    const m = await findMember(w, member);
    const last = w.members.length === 1;
    await repo.removeMember(w.id, m.userId);
    return last ? `The user left ${w.name}, its last member: the workspace and everything shared in it are deleted.` : `${m.name} <${m.email}> is no longer in ${w.name}.`;
  });

  tool(server, "set_workspace_domain", {
    title: "Add workspace domain",
    description: "Let everyone whose confirmed email address is at a domain (like persate.com) join a team workspace as a member, without an invitation (owners and admins). Only the domain of the user's own confirmed address, never a public mail provider's.",
    input: z.object({ workspace: workspaceRef, domain: z.string().describe("The domain, like example.com") }),
    kind: "write",
  }, async ({ workspace, domain }) => {
    const w = await findWorkspace(workspace);
    await repo.addWorkspaceDomain(w.id, domain);
    return `People whose confirmed email address is at ${domain.trim().replace(/^@/, "").toLowerCase()} can now join ${w.name} as members, from Settings or the prompt PacedMind shows them.`;
  });

  tool(server, "remove_workspace_domain", {
    title: "Remove workspace domain",
    description: "Stop a domain letting people join a team workspace by themselves (owners and admins). Members who joined through it stay.",
    input: z.object({ workspace: workspaceRef, domain: z.string() }),
    kind: "delete",
  }, async ({ workspace, domain }) => {
    const w = await findWorkspace(workspace);
    await repo.removeWorkspaceDomain(w.id, domain);
    return `${domain.trim().replace(/^@/, "").toLowerCase()} no longer lets people join ${w.name}.`;
  });

  tool(server, "share_area", {
    title: "Share area with team",
    description: "Move one of the user's own areas into a team workspace they manage, with all its projects and tasks (and their sub-tasks, dependencies and reports): every member then sees and works on them, and they can't be moved back. Links to work outside the area are dropped, a key the workspace already has changes, and computers stay personal. Ask the user first.",
    input: z.object({ area: areaRef, workspace: workspaceRef }),
    kind: "write",
  }, async ({ area, workspace }) => {
    const a = await findArea(area);
    if (a.workspaceId) fail(`${a.name} is already shared with a team workspace.`);
    const w = await findWorkspace(workspace);
    const moved = await repo.shareArea(a.id, w.id);
    return `Shared ${a.name} (${a.key}) with ${w.name}: ${plural(moved.projects, "project")} and ${plural(moved.tasks, "task")} moved into the workspace, for all its members.`;
  });

  tool(server, "list_webhooks", {
    title: "List webhooks",
    description: "The user's own webhooks in their team workspaces: the address PacedMind calls, which events, and whether each is on.",
    input: z.object({ workspace: workspaceRef.optional() }),
    kind: "read",
  }, async ({ workspace }) => {
    const w = workspace ? await findWorkspace(workspace) : null;
    const [hooks, list] = await Promise.all([repo.listWebhooks(w?.id), repo.listWorkspaces()]);
    if (!hooks.length) return w ? `The user has no webhooks in ${w.name}.` : "The user has no webhooks.";
    const name = (id: string) => list.find((x) => x.id === id)?.name ?? id;
    return hooks.map((h) => `webhook ${h.id} · ${name(h.workspaceId)} · ${h.url} · ${h.events.join(", ")} · ${h.enabled ? "on" : "off"}`).join("\n");
  });

  tool(server, "set_webhook", {
    title: "Set webhook",
    description: "Add one of the user's own webhooks in a team workspace, or change one (give webhook). PacedMind then posts JSON to the https address when a task is assigned to the user (task.assigned), when the status of a task assigned to or written by the user changes (task.status_changed), or when any task is created (task.created): the task's key, title, status, priority, dates and people, never its description. Each call is signed: X-PacedMind-Signature is sha256= and the HMAC-SHA256 of the body with the webhook's secret, which is shown only when it's added.",
    input: z.object({
      workspace: workspaceRef,
      url: z.string().describe("https address on a public name (no IP address, port or credentials)"),
      events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).max(3),
      webhook: z.string().optional().describe("The id of one of the user's webhooks, to change it"),
      enabled: z.boolean().optional().describe("false switches it off without deleting it"),
    }),
    kind: "write",
    openWorld: true,
  }, async ({ workspace, url, events, webhook, enabled }) => {
    const w = await findWorkspace(workspace);
    const r = await repo.setWebhook({ workspaceId: w.id, url, events, id: webhook, enabled });
    return r.secret
      ? `Added webhook ${r.id} in ${w.name} for ${events.join(", ")}.\nSecret (shown only now; it signs every call): ${r.secret}`
      : `Changed webhook ${r.id} in ${w.name}: ${events.join(", ")}${enabled === false ? ", switched off" : ""}.`;
  });

  tool(server, "delete_webhook", {
    title: "Delete webhook",
    description: "Delete one of the user's own webhooks. Ask the user first.",
    input: z.object({ webhook: z.string().describe("Its id, from list_webhooks") }),
    kind: "delete",
  }, async ({ webhook }) => {
    await repo.deleteWebhook(webhook.trim());
    return `Deleted webhook ${webhook.trim()}.`;
  });
}

/* ---------- assignees, for the planning tools ---------- */

export const assigneeSchema = z.string().nullable()
  .describe('The person it\'s assigned to: "me" (the user), or a member\'s email address or user id in the task\'s team workspace; the user\'s own tasks only "me". null clears it');

/**
 * The user id an assignee means for a task in `workspaceId` (null: one of the user's own): "me", or a member there by
 * email, id or name.
 */
export async function assigneeFor(query: string | null, workspaceId: string | null): Promise<string | null> {
  if (query === null || /^(none|nobody|no one|unassigned)$/i.test(query.trim())) return null;
  const me = await repo.currentUserId();
  if (query.trim().toLowerCase() === "me") return me ?? fail("Sign in to assign tasks.");
  if (!workspaceId) fail(`Only a team workspace's tasks can be assigned to someone else: this one is the user's own, so "me" or null.`);
  const ws = (await repo.getWorkspace(workspaceId)) ?? fail("That task's team workspace isn't one of the user's.");
  return (await findMember(ws, query)).userId;
}

/** Where a task will be: a project's or area's workspace. */
export async function workspaceOfPlace(place: { projectId?: string | null; areaId?: string | null }): Promise<string | null> {
  if (place.projectId) return (await repo.getProject(place.projectId))?.workspaceId ?? null;
  if (place.areaId) return (await repo.listAreas()).find((a) => a.id === place.areaId)?.workspaceId ?? null;
  return null;
}

/** A filter on who tasks are assigned to: "me", "nobody", or a member by email, id or name in any of the user's workspaces. */
export async function assigneeFilter(query: string): Promise<(t: Task) => boolean> {
  const q = query.trim().toLowerCase();
  if (/^(none|nobody|no one|unassigned)$/.test(q)) return (t) => t.assigneeId === null;
  const me = await repo.currentUserId();
  if (q === "me") return (t) => t.assigneeId === me;
  const members = await repo.listWorkspaceMembers();
  const ids = new Set(members.filter((m) => m.userId === q || m.email === q || m.name.toLowerCase() === q).map((m) => m.userId));
  if (!ids.size) fail(`No member of the user's team workspaces is ${query}. get_workspace lists them.`);
  return (t) => t.assigneeId !== null && ids.has(t.assigneeId);
}

/** A filter on where tasks are: "personal" (the user's own), or a team workspace. */
export async function workspaceFilter(query: string): Promise<(t: Task) => boolean> {
  if (/^(personal|own|mine|my own|none)$/i.test(query.trim())) return (t) => t.workspaceId === null;
  const w = await findWorkspace(query);
  return (t) => t.workspaceId === w.id;
}
