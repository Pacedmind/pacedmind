import "server-only";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { folderProblem } from "../folders";
import { preferencesText } from "../preferences";
import { nextReadyTask } from "../dependencies";
import { afterTaskDone, repeatTask, startsAfterWouldLoop } from "../ops";
import * as repo from "../repo";
import { MODE } from "../supabase";
import { usage } from "../views";
import { callerSession } from "./principal";
import { nextColor } from "@/lib/colors";
import { MAX_NEEDS } from "@/lib/needs";
import { addDaysStr, dateOnly, timeOf, toDateStr } from "@/lib/dates";
import { AGENT_LABEL, LIVE_STATUSES, STATUS_LABEL, type Doer, type Preference, type Repeat, type Status, type Task } from "@/lib/types";
import {
  AREA_ICON_EXAMPLES, PALETTE_NAMES, agentSchema, areaRef, colorFrom, colorName, dateInput, dateTimeInput, describeTask, doerSchema, eventLine, fail, iconFrom,
  findArea, findAreaOrInbox, findProject, findTask, fmtWhen, isOpen, names, prioritySchema, priorityOf, projectLine,
  plannedInput, plannedOf, plural, projectRef, statusOf, statusSchema, taskLine, taskRef, todayLine, tool, when,
  type PRIORITY_NAMES, type STATUS_NAMES,
} from "./common";

/** A folder for sessions on this computer has to be usable here. PacedMind Cloud's MCP server knows no computer's folders. */
function checkFolder(folder: string | null | undefined) {
  if (!folder) return;
  if (MODE === "web") fail("Folders are set on the computer where sessions run, in its PacedMind desktop app, not through PacedMind Cloud.");
  const problem = folderProblem(folder);
  if (problem) fail(`Can't use the folder ${folder}: ${problem}`);
}

/*
 * A session PacedMind started works on one task. It may note follow-up work as new open tasks and edit its own
 * task's details, but never change a status (finish_task does that), who does a task, where it lives, or where
 * and in which folder its sessions run, and never touch other tasks: a session led astray must not be able to
 * send work elsewhere or plant instructions in tasks other sessions will read.
 */
function sessionMayCreate(status: string | undefined) {
  if (callerSession() && status && status !== "todo" && status !== "backlog") {
    fail("A session can only add open tasks (todo or backlog). The user decides what's done.");
  }
}

function sessionMayUpdate(
  t: Task, changes: { status?: unknown; agent?: unknown; project?: unknown; area?: unknown; runs_in?: unknown; folder?: unknown; needs?: unknown },
) {
  const me = callerSession();
  if (!me) return;
  if (t.id !== me.taskId) fail(`This session can only change its own task, not ${t.key}. Create a new task for follow-up work instead.`);
  if (changes.status !== undefined || changes.agent !== undefined || changes.project !== undefined || changes.area !== undefined) {
    fail("A session can't change its task's status, agent, project or area. Call finish_task when the work is ready to check.");
  }
  if (changes.runs_in !== undefined || changes.folder !== undefined || changes.needs !== undefined) {
    fail("A session can't change where or in which folder its task's sessions run, or what they need.");
  }
}

/** For fields that can be cleared: undefined leaves them alone, null or "" clears them. */
const clearable = <T>(v: string | null | undefined, read: (s: string) => T): T | null | undefined =>
  v === undefined ? undefined : v && v.trim() ? read(v) : null;

/* ---------- task input shared by create_task, create_tasks and update_task ---------- */

const doneWhenSchema = z.array(z.string()).max(20)
  .describe("What must be true when the task is finished: one checkable outcome per item, e.g. \"/reports has a Download CSV button\" or \"A screenshot of the new page\". Agents answer each item when they hand the task back");

const needsSchema = z.array(z.string().max(48)).max(MAX_NEEDS)
  .describe("What its agent needs from the computer its session runs on, by name: MCP servers or claude.ai connectors, e.g. [\"supabase\", \"Gmail\"]. PacedMind offers a computer that has them. Only what differs between computers: a project's own folder brings its servers everywhere");

const repeatSchema = z.enum(["day", "weekday", "week", "month"])
  .describe("Makes it come back: once done, a new task appears at the next date (every day, weekday Mon-Fri, week or month after its planned day or deadline)");

const newTaskFields = {
  description: z.string().optional().describe("Details in Markdown, which the app shows formatted: why it matters, context, constraints, links. Short paragraphs or a list, `code` for paths and commands"),
  done_when: doneWhenSchema.optional(),
  needs: needsSchema.optional(),
  status: statusSchema.optional().describe("Defaults to todo"),
  priority: prioritySchema.optional(),
  due: dateTimeInput.optional().describe("Deadline, with an optional time"),
  planned: plannedInput.optional(),
  estimate_minutes: z.number().int().min(5).max(24 * 60).optional().describe("How long it takes; the auto-planner uses it. Default 60"),
  labels: z.array(z.string()).optional(),
  subtasks: z.array(z.string()).optional().describe("Checklist items"),
  agent: doerSchema.optional()
    .describe("claude or codex when an AI agent should do the task; human when only the user can (it then never gets an agent session). Leave it out for the project's default"),
  related_project: projectRef.optional()
    .describe("A project the task is about without being part of it, for small things like replying to an email about it: the task stays in its area (give area, not project), and the project's page lists it under Related"),
  repeat: repeatSchema.optional(),
};

const cleanLabels = (labels: string[]) => [...new Set(labels.map((l) => l.trim().replace(/^#/, "").toLowerCase()).filter(Boolean))];

type NewTask = {
  title: string; description?: string; done_when?: string[]; needs?: string[]; status?: (typeof STATUS_NAMES)[number]; priority?: (typeof PRIORITY_NAMES)[number];
  due?: string; planned?: string; estimate_minutes?: number; labels?: string[]; subtasks?: string[]; agent?: Doer;
  related_project?: string; repeat?: Repeat;
};

/** Creates a task. The caller runs afterTaskDone for tasks created as done. */
async function createOne(input: NewTask, place: { projectId: string | null; areaId: string | null }): Promise<Task> {
  if (!input.title.trim()) fail("A task needs a title.");
  const t = await repo.createTask({
    title: input.title,
    description: input.description?.trim() ?? "",
    doneWhen: input.done_when,
    needs: input.needs,
    projectId: place.projectId,
    areaId: place.areaId,
    status: input.status ? statusOf(input.status) : "todo",
    priority: input.priority ? priorityOf(input.priority) : 0,
    dueDate: input.due ? when(input.due) : null,
    ...(input.planned ? plannedOf(input.planned) : { plannedDate: null }),
    estimateMin: input.estimate_minutes,
    labels: cleanLabels(input.labels ?? []),
    agent: input.agent,
    relatedProjectId: input.related_project ? (await findProject(input.related_project)).id : null,
    repeat: input.repeat ?? null,
  });
  for (const s of input.subtasks ?? []) if (s.trim()) await repo.addSubtask(t.id, s);
  return (await repo.getTask(t.id))!;
}

/**
 * Resolves a move: a project (which brings its area), or an area / the Inbox (which takes the task out
 * of a project in another area). undefined means "leave as is".
 */
async function moveTarget(t: Task, project: string | null | undefined, area: string | null | undefined) {
  let projectId: string | null | undefined;
  let areaId: string | null | undefined;
  if (typeof project === "string") {
    const p = await findProject(project);
    if (area !== undefined && ((await findAreaOrInbox(area))?.id ?? null) !== p.areaId) {
      fail(`Project ${p.name} is in ${(await names()).area(p.areaId)}; leave out the area when moving to a project.`);
    }
    return { projectId: p.id, areaId: p.areaId };
  }
  if (project === null) projectId = null;
  if (area !== undefined) {
    areaId = (await findAreaOrInbox(area))?.id ?? null;
    const current = t.projectId ? await repo.getProject(t.projectId) : null;
    if (projectId === undefined && current && current.areaId !== areaId) projectId = null;
  }
  return { projectId, areaId };
}

/** Where new tasks go: a project (and its area), or an area, or the Inbox. */
async function placeFor(project?: string, area?: string): Promise<{ projectId: string | null; areaId: string | null }> {
  if (project) {
    const p = await findProject(project);
    if (area && (await findArea(area)).id !== p.areaId) fail(`Project ${p.name} is in ${(await names()).area(p.areaId)}, not ${area}. Leave out the area.`);
    return { projectId: p.id, areaId: p.areaId };
  }
  return { projectId: null, areaId: area ? (await findAreaOrInbox(area))?.id ?? null : null };
}

/** Finds sub-tasks by number (1-based, as get_task shows them) or by title. */
function pickSubtasks(t: Task, refs: string[]) {
  return refs.map((ref) => {
    const r = ref.trim();
    const byNumber = /^\d+$/.test(r) ? t.subtasks[Number(r) - 1] : undefined;
    const sub = byNumber ?? t.subtasks.find((s) => s.title.toLowerCase() === r.toLowerCase())
      ?? t.subtasks.find((s) => s.title.toLowerCase().includes(r.toLowerCase()));
    return sub ?? fail(`${t.key} has no sub-task "${ref}". Its sub-tasks: ${t.subtasks.map((s, i) => `${i + 1}. ${s.title}`).join("; ") || "none"}.`);
  });
}

function shiftValue(value: string | null, days: number): string | null {
  if (!value) return null;
  const t = timeOf(value);
  const d = addDaysStr(value, days);
  return t ? `${d}T${t}` : d;
}

export function registerPlanningTools(server: McpServer) {
  /* ---------- overview ---------- */

  /** The user's preferences in the overview while they're short; otherwise where to find them. */
  const preferencesPart = (list: Preference[]) => {
    if (!list.length) return "The user's preferences: none saved yet. When they tell you how they like to work, offer to save it (update_preferences).";
    const text = preferencesText(list, false);
    return text.length <= 3000
      ? `The user's preferences, for planning and creating tasks (with ids in get_preferences):\n${text}`
      : `The user's preferences: ${plural(list.length, "preference")}. Read them with get_preferences before you plan, set dates or create tasks.`;
  };

  tool(server, "get_overview", {
    title: "Get overview",
    description:
      "Today's date and time, the user's preferences for how they work, their areas and projects with their ids, what's overdue, due or planned today, today's calendar, and agent sessions waiting for review or running.",
    input: z.object({}),
    kind: "read",
  }, async () => {
    const now = new Date();
    const today = toDateStr(now);
    const [n, tasks, events, eventList, waiting, running, preferences] = await Promise.all([
      names(), repo.listTasks(), repo.occurrences(today, today), repo.listEvents(),
      repo.listSessions({ status: ["finished"] }), repo.listSessions({ status: LIVE_STATUSES }), repo.listPreferences().catch(() => []),
    ]);
    const areas = [...n.areas.values()];
    const projects = [...n.projects.values()];
    const u = usage(areas, projects, tasks);
    const open = tasks.filter(isOpen);
    const overdue = open.filter((t) => t.dueDate && dateOnly(t.dueDate) < today);
    const dueToday = open.filter((t) => t.dueDate && dateOnly(t.dueDate) === today);
    const plannedToday = open.filter((t) => t.plannedDate === today && !dueToday.includes(t));
    const inbox = open.filter((t) => !t.areaId && !t.projectId);
    const weekly = new Set(eventList.filter((e) => e.recurrence === "weekly").map((e) => e.id));
    const keys = new Map(tasks.map((t) => [t.id, t.key]));
    const keyOf = (id: number) => keys.get(id) ?? `#${id}`;
    const section = (title: string, lines: string[], empty = "none") => `${title}:\n${lines.length ? lines.map((l) => `- ${l}`).join("\n") : `- ${empty}`}`;
    return [
      todayLine(now),
      preferencesPart(preferences),
      section("Areas", areas.map((a) => `${a.name} (id ${a.id}, key ${a.key}, ${colorName(a.color)}) · ${plural(u.areas[a.id]?.open ?? 0, "open task")} · ${plural(u.areas[a.id]?.projects ?? 0, "project")}`)),
      section("Projects", projects.map((p) => projectLine(p, n, u.projects[p.id]))),
      `Inbox: ${plural(inbox.length, "open task")} without an area`,
      section("Overdue", overdue.map((t) => taskLine(t, n))),
      section("Due today", dueToday.map((t) => taskLine(t, n))),
      section("Planned for today", plannedToday.map((t) => taskLine(t, n))),
      section("Calendar today", events.map((e) => eventLine(e, n, weekly.has(e.eventId))), "nothing scheduled"),
      section("Sessions waiting for the user's review", waiting.map((s) => `${keyOf(s.taskId)} · session ${s.id} · ${s.note ?? "finished"}`)),
      section("Sessions running", running.map((s) => `${keyOf(s.taskId)} · session ${s.id} · ${AGENT_LABEL[s.agent]} since ${s.startedAt.replace("T", " ")}`)),
    ].join("\n\n");
  });

  /* ---------- areas ---------- */

  tool(server, "list_areas", {
    title: "List areas",
    description: "Areas are the top level (like Work, Personal, Health). Each has an id, a name, a key used in task keys (WRK-12), a color and maybe an icon.",
    input: z.object({}),
    kind: "read",
  }, async () => {
    const [areas, projects, tasks] = await Promise.all([repo.listAreas(), repo.listProjects(), repo.listTasks()]);
    if (!areas.length) return "No areas yet.";
    const u = usage(areas, projects, tasks);
    return areas.map((a) => `${a.name} · id ${a.id} · key ${a.key} · ${colorName(a.color)}${a.icon ? ` · icon ${a.icon}` : a.picture ? " · its own picture" : ""} · ${plural(u.areas[a.id]?.projects ?? 0, "project")} · ${plural(u.areas[a.id]?.open ?? 0, "open task")}`).join("\n");
  });

  tool(server, "create_area", {
    title: "Create area",
    description: `Add an area. Its key (for task keys like WRK-12) is made from the name. Colors: ${PALETTE_NAMES}, or a hex color. Icons: Lucide names such as ${AREA_ICON_EXAMPLES}.`,
    input: z.object({
      name: z.string(),
      color: z.string().optional().describe("Palette name or hex; defaults to an unused palette color"),
      icon: z.string().optional().describe("One of the icons; without one the area shows a dot"),
    }),
    kind: "create",
  }, async ({ name, color, icon }) => {
    if (!name.trim()) fail("An area needs a name.");
    const a = await repo.createArea({
      name, color: color ? colorFrom(color) : nextColor((await repo.listAreas()).map((x) => x.color)), icon: icon ? iconFrom(icon) : null,
    });
    return `Created area ${a.name} · id ${a.id} · key ${a.key} · ${colorName(a.color)}${a.icon ? ` · icon ${a.icon}` : ""}.`;
  });

  tool(server, "update_area", {
    title: "Update area",
    description: `Rename an area, or change its color or icon. A new name gives the area the key made from it, which its new tasks get; existing task keys don't change. Icons: Lucide names such as ${AREA_ICON_EXAMPLES}. An icon replaces the area's own picture, which only the app sets.`,
    input: z.object({
      area: areaRef, name: z.string().optional(), color: z.string().optional().describe(`${PALETTE_NAMES}, or a hex color`),
      icon: z.string().optional().describe("One of the icons, or none to show the dot again"),
    }),
    kind: "write",
  }, async ({ area, name, color, icon }) => {
    const a = await findArea(area);
    if (name !== undefined && !name.trim()) fail("The name can't be empty.");
    const nextIcon = icon === undefined ? undefined : icon.trim().toLowerCase() === "none" ? null : iconFrom(icon);
    await repo.updateArea(a.id, { name, color: color ? colorFrom(color) : undefined, icon: nextIcon });
    const after = (await repo.listAreas()).find((x) => x.id === a.id)!;
    return `Updated area ${after.name} · id ${after.id} · key ${after.key} · ${colorName(after.color)}${after.icon ? ` · icon ${after.icon}` : ""}.`;
  });

  tool(server, "delete_area", {
    title: "Delete area",
    description: "Delete an area and its projects. Its tasks are kept and move to the Inbox. It can't be undone.",
    input: z.object({ area: areaRef }),
    kind: "delete",
  }, async ({ area }) => {
    const a = await findArea(area);
    const projects = (await repo.listProjects()).filter((p) => p.areaId === a.id);
    const ids = new Set(projects.map((p) => p.id));
    const tasks = (await repo.listTasks()).filter((t) => t.areaId === a.id || (t.projectId !== null && ids.has(t.projectId)));
    await repo.deleteArea(a.id);
    return `Deleted area ${a.name}. ${projects.length ? `Deleted its projects: ${projects.map((p) => p.name).join(", ")}. ` : ""}${plural(tasks.length, "task")} moved to the Inbox.`;
  });

  /* ---------- projects ---------- */

  tool(server, "list_projects", {
    title: "List projects",
    description: "Projects with their area, progress, target date, agent and folder.",
    input: z.object({ area: areaRef.optional().describe("Only projects in this area") }),
    kind: "read",
  }, async ({ area }) => {
    const n = await names();
    const a = area ? await findArea(area) : null;
    const projects = [...n.projects.values()].filter((p) => !a || p.areaId === a.id);
    if (!projects.length) return a ? `No projects in ${a.name}.` : "No projects yet.";
    const u = usage([...n.areas.values()], [...n.projects.values()], await repo.listTasks());
    return projects.map((p) => projectLine(p, n, u.projects[p.id])).join("\n");
  });

  tool(server, "get_project", {
    title: "Get project",
    description: "A project's details and its tasks in roadmap order, grouped by status, plus the next task that is ready.",
    input: z.object({ project: projectRef, include_done: z.boolean().optional().describe("Also list done and canceled tasks") }),
    kind: "read",
  }, async ({ project, include_done }) => {
    const n = await names();
    const p = await findProject(project);
    const tasks = await repo.listTasks({ projectId: p.id });
    const u = usage([...n.areas.values()], [...n.projects.values()], tasks);
    const order: Status[] = ["review", "progress", "todo", "backlog", ...(include_done ? (["done", "canceled"] as const) : [])];
    const groups = order.map((st) => {
      const ts = tasks.filter((t) => t.status === st);
      return ts.length ? `${STATUS_LABEL[st]}:\n${ts.map((t) => `- ${taskLine(t, n)}`).join("\n")}` : null;
    }).filter(Boolean);
    const closed = tasks.filter((t) => !isOpen(t)).length;
    const next = await nextReadyTask(p.id);
    return [
      projectLine(p, n, u.projects[p.id]),
      p.startDate ? `Started ${fmtWhen(p.startDate)}` : null,
      groups.length ? groups.join("\n\n") : "No open tasks.",
      !include_done && closed ? `(${closed} done or canceled tasks hidden)` : null,
      next ? `Next ready task: ${next.key} · ${next.title}` : null,
    ].filter(Boolean).join("\n\n");
  });

  tool(server, "create_project", {
    title: "Create project",
    description: "Add a project to an area. Color defaults to the area's color.",
    input: z.object({
      name: z.string(),
      area: areaRef,
      color: z.string().optional().describe(`${PALETTE_NAMES}, or a hex color`),
      start_date: dateInput.optional().describe("Defaults to today"),
      target_date: dateInput.optional().describe("When it should be finished"),
      folder: z.string().optional().describe("Absolute path of the folder agent sessions work in on this computer, for code projects"),
      agent: agentSchema.optional().describe("Default agent for the project's tasks"),
      starts_after: projectRef.optional().describe("Another project that must be finished first"),
    }),
    kind: "create",
  }, async (args) => {
    if (!args.name.trim()) fail("A project needs a name.");
    const a = await findArea(args.area);
    const folder = args.folder?.trim() || null;
    checkFolder(folder);
    const after = args.starts_after ? await findProject(args.starts_after) : null;
    const color = args.color ? colorFrom(args.color) : null;
    const targetDate = args.target_date ? when(args.target_date, "drop") : null;
    const startDate = args.start_date ? when(args.start_date, "drop") : undefined;
    const created = await repo.createProject({ name: args.name, areaId: a.id, folder, agent: args.agent ?? null, color, targetDate });
    await repo.updateProject(created.id, { startDate, afterProjectId: after?.id });
    const p = (await repo.getProject(created.id))!;
    return `Created project ${projectLine(p, await names(), undefined)}.`;
  });

  tool(server, "update_project", {
    title: "Update project",
    description:
      'Change a project: rename, move to another area (its tasks move along), color ("area" to use the area\'s color), dates, folder, agent, or which project it starts after. Pass null to clear a field.',
    input: z.object({
      project: projectRef,
      name: z.string().optional(),
      area: areaRef.optional().describe("Move the project and its tasks to this area"),
      color: z.string().optional().describe(`${PALETTE_NAMES}, a hex color, or "area"`),
      start_date: dateInput.nullable().optional(),
      target_date: dateInput.nullable().optional(),
      folder: z.string().nullable().optional().describe("Absolute folder path for agent sessions on this computer"),
      agent: agentSchema.nullable().optional(),
      starts_after: projectRef.nullable().optional().describe("A project that must be finished first, or null for none"),
    }),
    kind: "write",
  }, async (args) => {
    const p = await findProject(args.project);
    if (args.name !== undefined && !args.name.trim()) fail("The name can't be empty.");
    const folder = args.folder === undefined ? undefined : args.folder?.trim() || null;
    checkFolder(folder);
    let afterProjectId: string | null | undefined;
    if (args.starts_after === null) afterProjectId = null;
    else if (args.starts_after !== undefined) {
      const after = await findProject(args.starts_after);
      if (after.id === p.id || (await startsAfterWouldLoop(p.id, after.id))) fail(`${p.name} can't start after ${after.name}: they would wait for each other.`);
      afterProjectId = after.id;
    }
    await repo.updateProject(p.id, {
      name: args.name?.trim(),
      areaId: args.area ? (await findArea(args.area)).id : undefined,
      color: args.color === undefined ? undefined : /^area$/i.test(args.color.trim()) ? null : colorFrom(args.color),
      startDate: clearable(args.start_date, (v) => when(v, "drop")),
      targetDate: clearable(args.target_date, (v) => when(v, "drop")),
      folder,
      agent: args.agent,
      afterProjectId,
    });
    return `Updated ${projectLine((await repo.getProject(p.id))!, await names(), undefined)}.`;
  });

  tool(server, "delete_project", {
    title: "Delete project",
    description: "Delete a project. Its tasks are kept in the project's area without a project. It can't be undone.",
    input: z.object({ project: projectRef }),
    kind: "delete",
  }, async ({ project }) => {
    const p = await findProject(project);
    const kept = (await repo.listTasks({ projectId: p.id })).length;
    await repo.deleteProject(p.id);
    return `Deleted project ${p.name}. ${kept} ${kept === 1 ? "task stays" : "tasks stay"} in ${(await names()).area(p.areaId)}.`;
  });

  /* ---------- tasks ---------- */

  tool(server, "list_tasks", {
    title: "List tasks",
    description:
      "Find tasks. Without filters it lists every open task. Combine filters to narrow down; dates accept words like \"today\" or \"friday\".",
    input: z.object({
      project: projectRef.optional(),
      area: areaRef.optional().describe('Area name, key or id, or "inbox" for tasks without an area'),
      status: z.array(statusSchema).optional().describe("Only these statuses (overrides include_done)"),
      priority: z.array(prioritySchema).optional(),
      label: z.string().optional(),
      search: z.string().optional().describe("Words to look for in titles and descriptions"),
      due_from: dateInput.optional(),
      due_to: dateInput.optional(),
      planned_from: dateInput.optional(),
      planned_to: dateInput.optional(),
      overdue: z.boolean().optional().describe("Only open tasks past their due date"),
      unscheduled: z.boolean().optional().describe("Only tasks with neither a due date nor a planned day"),
      include_done: z.boolean().optional().describe("Also include done and canceled tasks"),
      limit: z.number().int().min(1).max(500).optional().describe("Default 100"),
    }),
    kind: "read",
  }, async (args) => {
    const n = await names();
    const today = toDateStr(new Date());
    const p = args.project ? await findProject(args.project) : null;
    const inboxOnly = args.area !== undefined && /^(inbox|none|no area)$/i.test(args.area.trim());
    const a = args.area && !inboxOnly ? await findArea(args.area) : null;
    const statuses = args.status?.map(statusOf);
    const priorities = args.priority?.map(priorityOf);
    const label = args.label?.trim().replace(/^#/, "").toLowerCase();
    const words = args.search?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
    const range = (from?: string, to?: string) => ({ from: from ? when(from, "drop") : null, to: to ? when(to, "drop") : null });
    const due = range(args.due_from, args.due_to);
    const planned = range(args.planned_from, args.planned_to);
    const inRange = (v: string | null, r: { from: string | null; to: string | null }) =>
      (!r.from && !r.to) || (!!v && (!r.from || dateOnly(v) >= r.from) && (!r.to || dateOnly(v) <= r.to));
    const found = (await repo.listTasks()).filter((t) =>
      (!p || t.projectId === p.id) &&
      (!inboxOnly || (!t.areaId && !t.projectId)) &&
      (!a || t.areaId === a.id) &&
      (statuses ? statuses.includes(t.status) : args.include_done || isOpen(t)) &&
      (!priorities || priorities.includes(t.priority)) &&
      (!label || t.labels.includes(label)) &&
      words.every((w) => `${t.title}\n${t.description}\n${t.key}`.toLowerCase().includes(w)) &&
      inRange(t.dueDate, due) &&
      inRange(t.plannedDate, planned) &&
      (!args.overdue || (isOpen(t) && !!t.dueDate && dateOnly(t.dueDate) < today)) &&
      (!args.unscheduled || (!t.dueDate && !t.plannedDate)));
    if (!found.length) return "No tasks match.";
    const limit = args.limit ?? 100;
    const lines = found.slice(0, limit).map((t) => taskLine(t, n));
    return `${plural(found.length, "task")}:\n${lines.join("\n")}${found.length > limit ? `\n…and ${found.length - limit} more. Narrow the filters or raise the limit.` : ""}`;
  });

  tool(server, "get_task", {
    title: "Get task",
    description: "A task's full details: description, numbered Done when items and sub-tasks, dates, estimate, labels, the tasks it waits for and that wait for it, latest session and the latest report an agent handed back.",
    input: z.object({ task: taskRef }),
    kind: "read",
  }, async ({ task }) => describeTask(await findTask(task)));

  tool(server, "create_task", {
    title: "Create task",
    description:
      "Add a task with as much detail as you know. Put it in a project, or an area, or leave both out for the Inbox. Returns the new task key.",
    input: z.object({
      title: z.string(),
      project: projectRef.optional(),
      area: areaRef.optional().describe("Used when there's no project"),
      ...newTaskFields,
    }),
    kind: "create",
  }, async (args) => {
    sessionMayCreate(args.status);
    const t = await createOne(args, await placeFor(args.project, args.area));
    if (t.status === "done") await afterTaskDone(t.id);
    const extra = [t.doneWhen.length ? plural(t.doneWhen.length, "Done when item") : null, t.subtasks.length ? plural(t.subtasks.length, "sub-task") : null];
    return `Created ${taskLine(t, await names())}${extra.filter(Boolean).map((x) => ` · ${x}`).join("")}.`;
  });

  tool(server, "create_tasks", {
    title: "Create several tasks",
    description: "Add several tasks at once, e.g. when breaking a project down. They all go to the same project or area; each can have its own details.",
    input: z.object({
      project: projectRef.optional(),
      area: areaRef.optional(),
      tasks: z.array(z.object({ title: z.string(), ...newTaskFields })).min(1).max(50),
    }),
    kind: "create",
  }, async (args) => {
    const place = await placeFor(args.project, args.area);
    // Check every title and date first, so a bad one doesn't leave half the tasks created.
    for (const t of args.tasks) {
      sessionMayCreate(t.status);
      if (!t.title.trim()) fail("Every task needs a title.");
      if (t.due) when(t.due);
      if (t.planned) when(t.planned);
    }
    const created: Task[] = [];
    for (const t of args.tasks) created.push(await createOne(t, place));
    for (const t of created) if (t.status === "done") await afterTaskDone(t.id);
    const n = await names();
    return [`Created ${created.length} tasks:`, ...created.map((t) => taskLine(t, n))].join("\n");
  });

  tool(server, "update_task", {
    title: "Update task",
    description:
      "Change anything about a task: title, description (replace or append), Done when, status, priority, dates, estimate, labels, project or area, agent, where its agent sessions run, their folder and what they need from the computer, and sub-tasks (by number from get_task, or title). Pass null to clear a date, project, area, agent, runs_in or folder.",
    input: z.object({
      task: taskRef,
      title: z.string().optional(),
      description: z.string().optional().describe("Replaces the description (Markdown)"),
      append_to_description: z.string().optional().describe("Adds a paragraph at the end of the description"),
      done_when: doneWhenSchema.optional().describe("Replaces the Done when list; [] clears it"),
      needs: needsSchema.optional().describe("Replaces what its agent needs from the computer its session runs on; [] clears it"),
      status: statusSchema.optional(),
      priority: prioritySchema.optional(),
      due: dateTimeInput.nullable().optional(),
      planned: plannedInput.nullable().optional(),
      related_project: projectRef.nullable().optional().describe("A project it's about without being part of it (it stays in its area), or null to clear"),
      repeat: repeatSchema.nullable().optional().describe("How it comes back once done, or null to stop it repeating"),
      estimate_minutes: z.number().int().min(5).max(24 * 60).optional(),
      labels: z.array(z.string()).optional().describe("Replaces all labels"),
      add_labels: z.array(z.string()).optional(),
      remove_labels: z.array(z.string()).optional(),
      project: projectRef.nullable().optional().describe("Move to this project (and its area), or null to take it out of its project"),
      area: areaRef.nullable().optional().describe('Move to this area without a project, or null / "inbox" for the Inbox'),
      agent: doerSchema.nullable().optional().describe("human makes it the user's own: it never gets an agent session"),
      runs_in: z.enum(["terminal", "desktop", "cloud"]).nullable().optional()
        .describe("Where its agent sessions run: a terminal or the agent's desktop app on the user's computer, or the agent's cloud. null: a terminal when the agent's CLI is installed, else its desktop app"),
      folder: z.string().nullable().optional().describe("Absolute folder its sessions work in, when it isn't the project's; null for the project's folder"),
      add_subtasks: z.array(z.string()).optional(),
      complete_subtasks: z.array(z.string()).optional().describe("Sub-task numbers or titles to tick off"),
      reopen_subtasks: z.array(z.string()).optional(),
      remove_subtasks: z.array(z.string()).optional(),
    }),
    kind: "write",
  }, async (args) => {
    const t = await findTask(args.task);
    sessionMayUpdate(t, args);
    if (args.title !== undefined && !args.title.trim()) fail("The title can't be empty.");
    const folder = args.folder === undefined ? undefined : args.folder?.trim() || null;
    checkFolder(folder);
    const { projectId, areaId } = await moveTarget(t, args.project, args.area);
    let labels = args.labels ? cleanLabels(args.labels) : [...t.labels];
    if (args.add_labels) labels = cleanLabels([...labels, ...args.add_labels]);
    if (args.remove_labels) {
      const drop = new Set(cleanLabels(args.remove_labels));
      labels = labels.filter((l) => !drop.has(l));
    }
    let description = args.description;
    if (args.append_to_description?.trim()) {
      const base = (description ?? t.description).trimEnd();
      description = base ? `${base}\n\n${args.append_to_description.trim()}` : args.append_to_description.trim();
    }
    const complete = pickSubtasks(t, args.complete_subtasks ?? []);
    const reopen = pickSubtasks(t, args.reopen_subtasks ?? []);
    const remove = pickSubtasks(t, args.remove_subtasks ?? []);
    const status = args.status ? statusOf(args.status) : undefined;
    const dueDate = clearable(args.due, (v) => when(v));
    const planned = clearable(args.planned, plannedOf);
    await repo.updateTask(t.id, {
      title: args.title?.trim(),
      description,
      doneWhen: args.done_when,
      needs: args.needs,
      status,
      priority: args.priority ? priorityOf(args.priority) : undefined,
      dueDate,
      plannedDate: planned === undefined ? undefined : planned?.plannedDate ?? null,
      plannedTime: planned === undefined ? undefined : planned?.plannedTime ?? null,
      relatedProjectId: args.related_project === undefined ? undefined : args.related_project === null ? null : (await findProject(args.related_project)).id,
      repeat: args.repeat,
      estimateMin: args.estimate_minutes,
      labels: args.labels || args.add_labels || args.remove_labels ? labels : undefined,
      projectId,
      areaId,
      agent: args.agent,
      runIn: args.runs_in,
      folder,
    });
    for (const s of complete) await repo.setSubtaskDone(s.id, true);
    for (const s of reopen) await repo.setSubtaskDone(s.id, false);
    for (const s of remove) await repo.deleteSubtask(s.id);
    for (const s of args.add_subtasks ?? []) if (s.trim()) await repo.addSubtask(t.id, s);
    // A repeating task comes back first, so the answer can name the new one.
    const again = status === "done" && t.status !== "done" ? await repeatTask(t.id) : null;
    if (status === "done" && t.status !== "done") await afterTaskDone(t.id);
    const started = again ? [`It repeats: ${again.key} is the next one, planned ${fmtWhen(again.plannedDate ?? again.dueDate!)}.`] : [];
    const after = (await repo.getTask(t.id))!;
    const subs = (args.done_when ? ` · ${plural(after.doneWhen.length, "Done when item")}` : "") +
      (after.subtasks.length ? ` · ${after.subtasks.filter((s) => s.done).length}/${after.subtasks.length} sub-tasks done` : "");
    return [`Updated ${taskLine(after, await names())}${subs}.`, ...started].join("\n");
  });

  tool(server, "bulk_update_tasks", {
    title: "Update several tasks",
    description:
      "Apply the same change to several tasks: status, priority, due or planned date, move by a number of days, project or area, labels. Good for rescheduling and triage.",
    input: z.object({
      tasks: z.array(taskRef).min(1).max(100),
      status: statusSchema.optional(),
      priority: prioritySchema.optional(),
      due: dateTimeInput.nullable().optional(),
      planned: plannedInput.nullable().optional(),
      shift_days: z.number().int().min(-365).max(365).optional().describe("Move due and planned dates by this many days (times are kept)"),
      project: projectRef.nullable().optional(),
      area: areaRef.nullable().optional(),
      add_labels: z.array(z.string()).optional(),
      remove_labels: z.array(z.string()).optional(),
    }),
    kind: "write",
  }, async (args) => {
    const tasks = await Promise.all(args.tasks.map(findTask));
    if (args.shift_days && (args.due !== undefined || args.planned !== undefined)) fail("Use either shift_days or due/planned, not both.");
    const due = clearable(args.due, (v) => when(v));
    const planned = clearable(args.planned, plannedOf);
    const status = args.status ? statusOf(args.status) : undefined;
    const drop = new Set(cleanLabels(args.remove_labels ?? []));
    const moves = await Promise.all(tasks.map((t) => moveTarget(t, args.project, args.area)));
    for (const [i, t] of tasks.entries()) {
      const { projectId, areaId } = moves[i];
      const labels = args.add_labels || args.remove_labels
        ? cleanLabels([...t.labels, ...(args.add_labels ?? [])]).filter((l) => !drop.has(l))
        : undefined;
      await repo.updateTask(t.id, {
        status,
        priority: args.priority ? priorityOf(args.priority) : undefined,
        dueDate: args.shift_days ? shiftValue(t.dueDate, args.shift_days) : due,
        // Shifted, a task keeps the time it was put at.
        plannedDate: args.shift_days ? shiftValue(t.plannedDate, args.shift_days) : planned === undefined ? undefined : planned?.plannedDate ?? null,
        plannedTime: args.shift_days || planned === undefined ? undefined : planned?.plannedTime ?? null,
        projectId,
        areaId,
        labels,
      });
    }
    if (status === "done") for (const t of tasks) if (t.status !== "done") await afterTaskDone(t.id);
    const n = await names();
    const after = await Promise.all(tasks.map((t) => repo.getTask(t.id)));
    return [`Updated ${tasks.length} tasks:`, ...after.flatMap((t) => (t ? [taskLine(t, n)] : []))].join("\n");
  });

  tool(server, "delete_task", {
    title: "Delete task",
    description: "Delete a task with its sub-tasks, sessions and dependencies. It can't be undone; status canceled keeps a record instead.",
    input: z.object({ task: taskRef }),
    kind: "delete",
  }, async ({ task }) => {
    const t = await findTask(task);
    await repo.deleteTask(t.id);
    return `Deleted ${t.key} · ${t.title}.`;
  });

  tool(server, "reorder_tasks", {
    title: "Reorder project tasks",
    description: "Set the order of a project's tasks (the roadmap order). List the tasks that should come first, in order; the rest keep their order after them.",
    input: z.object({ project: projectRef, order: z.array(taskRef).min(1) }),
    kind: "write",
  }, async ({ project, order }) => {
    const p = await findProject(project);
    const tasks = await repo.listTasks({ projectId: p.id });
    const first = order.map((key) => {
      const t = tasks.find((x) => x.key.toLowerCase() === key.trim().toLowerCase());
      return t ?? fail(`${key} is not a task in ${p.name}.`);
    });
    const rest = tasks.filter((t) => !first.includes(t)).sort((a, b) => a.sortOrder - b.sortOrder);
    const all = [...new Set([...first, ...rest])];
    await Promise.all(all.map((t, i) => (t.sortOrder !== i + 1 ? repo.updateTask(t.id, { sortOrder: i + 1 }) : null)));
    return `New order in ${p.name}:\n${all.map((t, i) => `${i + 1}. ${t.key} · ${t.title}`).join("\n")}`;
  });
}
