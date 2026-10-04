import "server-only";
import { noteDisplaysOf, type NoteDisplays, type TaskNoteInput, type TaskNoteRequest } from "@/lib/task-notes";
import { checkedModelSelection, modelSelectionOf, modelCatalogOf } from "@/lib/agent-models";
import crypto from "node:crypto";
import type { PostgrestError } from "@supabase/supabase-js";
import { MODE, NotSignedIn, authState, supabase } from "../supabase";
import { canUsePlanner } from "@/lib/auth-access";
import { removeImageFiles, type StoredImage } from "../attachments";
import { removeDiffFiles } from "../diff";
import { repoIdentity } from "../git-remote";
import {
  areaFolder, deviceConfig, forgetArea, forgetProject, forgetTask, projectFolder, setProjectFolder, setTaskFolder, taskFolder,
} from "../device";
import {
  DEFAULT_SETTINGS, SESSION_URL, SETTING_KEYS, appVersionOk, areaPictureOf, byTopic, cleanDeviceName, cleanDoneWhen, cleanPreference, codexEnvProblem, criteriaOf,
  deriveKey, doneDaysOf, expandOccurrences, withDoneDay, extrasOf, linksOf, loginOf, otherSessionsOf, pictureHash, renamedKey, repoOf, strings,
  type AskInput, type FolderRequestFilter, type FolderRequestInput, type LaunchRequestFilter, type LaunchRequestInput, type PreferenceInput,
  type PreferencePatch, type PushSubscriptionRow,
  type ReportInput, type SessionFilter, type TaskFilter, type TaskInput, type TaskPatch, preferenceOf, usageOf, diffOf,
} from "./shared";
import { areaIconOf, type AreaIcon } from "@/lib/area-icons";
import { CloudReadOnly } from "@/lib/billing";
import { nowStamp, toDateStr } from "@/lib/dates";
import {
  NO_AGENT_TOOLS, repeatOf, taskHref,
  type AgentId, type AgentTools, type Area, type AskStatus, type Attachment, type CalEvent, type ConnectedAgent, type Dependency, type Device, type Doer, type EventOccurrence,
  type FolderRequest, type FolderRequestStatus,
  type LaunchRequest, type LaunchRequestKind, type LaunchRequestStatus, type OtherSession, type Preference, type Priority, type Project,
  type RemoteStart, type Report, type ReportOutcome, type Session, type SessionEvent, type SessionStatus, type Settings, type Status,
  type PushSubscriptionInput, type SessionAsk, type Subtask, type Surface, type Task,
} from "@/lib/types";
import { cleanNeeds } from "@/lib/needs";

export async function getTaskNoteDisplays(deviceId: string): Promise<NoteDisplays | null> {
  const db = await accountDb();
  const row = one(await db.from("devices").select("note_displays").eq("id", deviceId).is("revoked_at", null).maybeSingle());
  return noteDisplaysOf(row?.note_displays);
}
export async function saveTaskNoteDisplays(deviceId: string, value: NoteDisplays) {
  const db = await accountDb();
  check(await db.from("devices").update({ note_displays: value }).eq("id", deviceId));
}
const toTaskNote = (r: Row): TaskNoteRequest => ({
  id: String(r.id), deviceId: String(r.device_id), taskId: Number(r.task_id), taskCreatedAt: String(r.task_created_at),
  displayId: String(r.display_id), remember: r.remember === true, status: String(r.status) as TaskNoteRequest["status"],
  requestedAt: String(r.requested_at), expiresAt: String(r.expires_at), note: s(r.note),
});
export async function listTaskNoteRequests(deviceId: string): Promise<TaskNoteRequest[]> {
  const db = await accountDb();
  return many(await db.from("task_note_requests").select("*").eq("device_id", deviceId)
    .gte("requested_at", new Date(Date.now() - 10 * 60_000).toISOString()).order("requested_at", { ascending: false }).limit(40)).map(toTaskNote);
}
export async function createTaskNoteRequest(input: TaskNoteInput): Promise<TaskNoteRequest> {
  const db = await accountDb();
  return toTaskNote(one(await db.from("task_note_requests").insert({
    device_id: input.deviceId, task_id: input.taskId, task_created_at: input.taskCreatedAt, display_id: input.displayId, remember: input.remember,
  }).select().single())!);
}
export async function settleTaskNoteRequest(id: string, from: TaskNoteRequest["status"], status: TaskNoteRequest["status"], note: string | null = null): Promise<boolean> {
  const db = await accountDb();
  return !!one(await db.from("task_note_requests").update({ status, note: note?.slice(0, 500) ?? null }).eq("id", id).eq("status", from).select("id").maybeSingle());
}

/*
 * The account's data in PacedMind Cloud (Supabase), used while someone is signed in; repo.ts picks this or
 * local.ts. Every query runs as the signed-in account, and row level security limits it to that account's
 * rows, so nothing here filters by user. New rows get their user_id from the database.
 *
 * A project's folder, and a task's own folder, are this computer's (device.ts), merged in
 * here so the rest of the app sees one Project and one Task. The hosted web app has neither.
 */

type Row = Record<string, unknown>;

/**
 * The client for the account's data. In the desktop app, only after required sign-in steps (MFA if enrolled):
 * the database checks too, but this says so plainly, e.g. to a
 * page that renders alongside a layout that is already sending you to sign in. (The web app's proxy stops
 * signed-out browsers before any page runs.)
 */
async function accountDb() {
  if (MODE === "desktop") {
    const state = await authState();
    if (!canUsePlanner(state)) throw new NotSignedIn();
  }
  return supabase();
}
type Result<T> = { data: T | null; error: PostgrestError | null };
const s = (v: unknown) => (v == null ? null : String(v));
const n = (v: unknown) => (v == null ? null : Number(v));

/** What a failed query throws: CloudReadOnly when the database refused a write because the account's Cloud has ended. */
function failure(error: PostgrestError): Error {
  return error.code === "PT402" ? new CloudReadOnly() : new Error(error.message);
}

function many(res: Result<Row[]>): Row[] {
  if (res.error) throw failure(res.error);
  return res.data ?? [];
}

function one(res: Result<Row>): Row | null {
  if (res.error) throw failure(res.error);
  return res.data;
}

function check(res: { error: PostgrestError | null }) {
  if (res.error) throw failure(res.error);
}

/** Every row of a query, 1000 at a time (the most Supabase returns per request). */
async function all(page: (from: number, to: number) => PromiseLike<Result<Row[]>>): Promise<Row[]> {
  const out: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const rows = many(await page(from, from + 999));
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}

/** The defined fields of a patch, under their column names. */
function columns(patch: object, cols: Record<string, string>): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(patch)) if (k in cols && v !== undefined) out[cols[k]] = v;
  return out;
}

/** Area, project and device ids are UUIDs; anything else (an old link, a typo) can't match one. */
const isUuid = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/** Ids in chunks, so a filter on many of them keeps the request's URL short. */
function chunks<T>(xs: T[], size = 100): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}


/* ---------- areas and projects ---------- */

const toArea = (r: Row): Area => ({
  id: String(r.id), name: String(r.name), key: String(r.key), color: String(r.color), icon: areaIconOf(r.icon),
  picture: pictureHash(r.picture), sort: Number(r.sort), folder: MODE === "desktop" ? areaFolder(String(r.id)) : null, repo: repoOf(r.repo),
});

export async function listAreas(): Promise<Area[]> {
  const db = await accountDb();
  return many(await db.from("areas").select("*").order("sort")).map(toArea);
}

/** An area's own picture, base64 PNG, or null (the picture's route serves it). */
export async function areaPicture(id: string): Promise<string | null> {
  if (!isUuid(id)) return null;
  const db = await accountDb();
  const r = one(await db.from("areas").select("picture").eq("id", id).maybeSingle());
  return areaPictureOf(r?.picture);
}


export async function createArea(input: { name: string; color: string; icon?: AreaIcon | null }): Promise<Area> {
  const db = await accountDb();
  const areas = await listAreas();
  const icon = areaIconOf(input.icon);
  const r = one(await db.from("areas").insert({
    name: input.name.trim(),
    key: deriveKey(input.name, new Set(areas.map((a) => a.key))),
    color: input.color,
    ...(icon ? { icon } : {}),
    sort: areas.reduce((m, a) => Math.max(m, a.sort), 0) + 1,
  }).select().single());
  return toArea(r!);
}

/**
 * `icon: null` or `picture: null` puts the dot back. An area shows its picture or its icon, so setting one clears
 * the other; `picture` is base64 PNG (area-picture.ts), and one that isn't stays out. A new name can give the area a
 * new key (`renamedKey`), which only its new tasks get.
 */
export async function updateArea(id: string, patch: { name?: string; color?: string; icon?: AreaIcon | null; picture?: string | null; sort?: number }) {
  if (!isUuid(id)) return;
  const values: Row = {};
  const name = patch.name?.trim();
  if (name) {
    values.name = name;
    const areas = await listAreas();
    const current = areas.find((a) => a.id === id);
    if (current) values.key = renamedKey(name, current.key, new Set(areas.filter((a) => a.id !== id).map((a) => a.key)));
  }
  if (patch.color) values.color = patch.color;
  if (patch.sort !== undefined) values.sort = patch.sort;
  if (patch.icon !== undefined) values.icon = areaIconOf(patch.icon);
  if (patch.picture !== undefined) values.picture = areaPictureOf(patch.picture);
  if (values.icon) values.picture = null;
  if (values.picture) values.icon = null;
  if (!Object.keys(values).length) return;
  const db = await accountDb();
  check(await db.from("areas").update(values).eq("id", id));
}

/** Deletes an area and its projects. Tasks are kept and move to the Inbox (the database's references do it). */
export async function deleteArea(id: string) {
  if (!isUuid(id)) return;
  const db = await accountDb();
  check(await db.from("areas").delete().eq("id", id));
  if (MODE === "desktop") forgetArea(id);
}

/** Deletes a project. Its tasks stay in the project's area without a project. */
export async function deleteProject(id: string) {
  if (!isUuid(id)) return;
  const db = await accountDb();
  check(await db.from("projects").delete().eq("id", id));
  if (MODE === "desktop") forgetProject(id);
}

const toProject = (r: Row): Project => ({
  id: String(r.id), areaId: String(r.area_id), name: String(r.name), color: s(r.color), startDate: s(r.start_date), targetDate: s(r.target_date),
  folder: MODE === "desktop" ? projectFolder(String(r.id)) : null, deviceId: s(r.device_id), codexEnv: s(r.codex_env), repo: repoOf(r.repo),
  agent: s(r.agent) as AgentId | null, afterProjectId: s(r.after_project_id),
  sort: Number(r.sort),
});

export async function listProjects(): Promise<Project[]> {
  const db = await accountDb();
  return many(await db.from("projects").select("*").order("sort")).map(toProject);
}

export async function getProject(id: string): Promise<Project | null> {
  if (!isUuid(id)) return null;
  const db = await accountDb();
  const r = one(await db.from("projects").select("*").eq("id", id).maybeSingle());
  return r ? toProject(r) : null;
}

/**
 * Creates a project. A folder only counts on this computer (the desktop app); callers check it with
 * folderProblem first, because the project exists by the time the folder is set.
 */
export async function createProject(input: {
  name: string; areaId: string; folder?: string | null; deviceId?: string | null; agent?: AgentId | null; targetDate?: string | null;
  color?: string | null;
}): Promise<Project> {
  const db = await accountDb();
  const last = many(await db.from("projects").select("sort").order("sort", { ascending: false }).limit(1));
  const repo = input.folder && MODE === "desktop" ? repoIdentity(input.folder) : null;
  const r = one(await db.from("projects").insert({
    area_id: input.areaId, name: input.name.trim(), start_date: toDateStr(new Date()), target_date: input.targetDate ?? null,
    device_id: input.deviceId && isUuid(input.deviceId) ? input.deviceId : null,
    agent: input.agent ?? null, sort: Number(last[0]?.sort ?? 0) + 1, color: input.color ?? null, ...(repo ? { repo } : {}),
  }).select().single());
  if (input.folder && MODE === "desktop") setProjectFolder(String(r!.id), input.folder);
  return toProject(r!);
}

const PROJECT_COLS: Record<string, string> = {
  areaId: "area_id", name: "name", color: "color", startDate: "start_date", targetDate: "target_date", agent: "agent",
  afterProjectId: "after_project_id", sort: "sort", deviceId: "device_id", codexEnv: "codex_env",
};

/**
 * Moving a project to another area moves its tasks too (a trigger in the database does it). `folder` is this
 * computer's setting: only the desktop app may change it (the actions and MCP tools refuse it otherwise).
 */
export async function updateProject(id: string, patch: Partial<Omit<Project, "id">>) {
  if (!isUuid(id)) return;
  if (patch.folder !== undefined) {
    if (MODE !== "desktop") throw new Error("Folders are set in the PacedMind desktop app.");
    const problem = setProjectFolder(id, patch.folder);
    if (problem) throw new Error(`Can't use the folder ${patch.folder}: ${problem}`);
  }
  if (patch.codexEnv !== undefined) {
    const env = patch.codexEnv?.trim() || null;
    const problem = env && codexEnvProblem(env);
    if (problem) throw new Error(problem);
    patch = { ...patch, codexEnv: env };
  }
  if (patch.deviceId !== undefined && patch.deviceId !== null && !isUuid(patch.deviceId)) throw new Error("Unknown computer");
  const values = columns(patch, PROJECT_COLS);
  // The repository of a folder set here, for the other computers; a folder outside one keeps what another computer saw.
  const found = patch.folder ? repoIdentity(patch.folder) : null;
  if (found) values.repo = found;
  if (!Object.keys(values).length) return;
  const db = await accountDb();
  check(await db.from("projects").update(values).eq("id", id));
}

/** Records the repository a project's folder on this computer is in (project-links.ts), for the other computers. */
/** The repository an area's workspace holds (project-links.ts), for your other computers. */
export async function setAreaRepo(id: string, repo: string) {
  const value = repoOf(repo);
  if (!value || !isUuid(id)) return;
  const db = await accountDb();
  check(await db.from("areas").update({ repo: value }).eq("id", id));
}

export async function setProjectRepo(id: string, repo: string) {
  const value = repoOf(repo);
  if (!value || !isUuid(id)) return;
  const db = await accountDb();
  check(await db.from("projects").update({ repo: value }).eq("id", id));
}

/**
 * Merges `fromId` into `intoId`: its tasks move there, after the project's own, into its area, and keep their keys;
 * what `intoId` leaves empty (agent, Codex environment, repository) it takes from `fromId`; projects that started
 * after `fromId` start after `intoId`; then `fromId` is deleted. This computer's folders are project-links.ts's.
 */
export async function mergeProject(fromId: string, intoId: string) {
  if (!isUuid(fromId) || !isUuid(intoId) || fromId === intoId) return;
  const [from, into] = await Promise.all([getProject(fromId), getProject(intoId)]);
  if (!from || !into) return;
  const db = await accountDb();
  const last = many(await db.from("tasks").select("sort_order").eq("project_id", intoId).order("sort_order", { ascending: false }).limit(1));
  const moving = many(await db.from("tasks").select("id, sort_order").eq("project_id", fromId));
  check(await db.from("tasks").update({ project_id: intoId, area_id: into.areaId, updated_at: nowStamp() }).eq("project_id", fromId));
  check(await db.from("tasks").update({ related_project_id: intoId }).eq("related_project_id", fromId));
  // After the project's own tasks, in their order. There's no "sort_order + n" through the API, so one by one.
  const after = Number(last[0]?.sort_order ?? 0);
  for (const batch of chunks(moving, 20)) {
    await Promise.all(batch.map(async (t) => check(await db.from("tasks").update({ sort_order: Number(t.sort_order) + after }).eq("id", Number(t.id)))));
  }
  if (into.afterProjectId === fromId) check(await db.from("projects").update({ after_project_id: null }).eq("id", intoId));
  check(await db.from("projects").update({ after_project_id: intoId }).eq("after_project_id", fromId).neq("id", intoId));
  const fill: Row = {};
  if (!into.agent && from.agent) fill.agent = from.agent;
  if (!into.codexEnv && from.codexEnv) fill.codex_env = from.codexEnv;
  if (!into.repo && from.repo) fill.repo = from.repo;
  if (Object.keys(fill).length) check(await db.from("projects").update(fill).eq("id", intoId));
  check(await db.from("projects").delete().eq("id", fromId));
}

/* ---------- tasks ---------- */

const toSubtask = (r: Row): Subtask => ({ id: Number(r.id), taskId: Number(r.task_id), title: String(r.title), done: r.done === true, sort: Number(r.sort) });

const toTask = (r: Row): Task => ({
  id: Number(r.id), key: String(r.key), areaId: s(r.area_id), projectId: s(r.project_id), title: String(r.title),
  description: String(r.description ?? ""), status: String(r.status) as Status, priority: Number(r.priority) as Priority,
  dueDate: s(r.due_date), plannedDate: s(r.planned_date), plannedTime: r.planned_date ? s(r.planned_time) : null, estimateMin: Number(r.estimate_min),
  relatedProjectId: s(r.related_project_id), repeat: repeatOf(r.repeat), labels: (r.labels as string[] | null) ?? [],
  doneWhen: (r.done_when as string[] | null) ?? [], needs: cleanNeeds(strings(r.needs)), reminder: s(r.reminder), agent: s(r.agent) as Doer | null,
  runIn: s(r.run_in) as Surface | null, deviceId: s(r.device_id), folder: MODE === "desktop" ? taskFolder("cloud", Number(r.id)) : null,
  modelSettings: modelSelectionOf(r.model_settings),
  sortOrder: Number(r.sort_order),
  createdAt: String(r.created_at), updatedAt: String(r.updated_at), completedAt: s(r.completed_at),
  subtasks: ((r.subtasks as Row[] | undefined) ?? []).map(toSubtask).sort((a, b) => a.sort - b.sort || a.id - b.id),
});

const TASK_SELECT = "*, subtasks(*)";


export async function listTasks(filter: TaskFilter = {}): Promise<Task[]> {
  if ((filter.areaId && !isUuid(filter.areaId)) || (filter.projectId && !isUuid(filter.projectId))) return [];
  const db = await accountDb();
  const rows = await all((from, to) => {
    let q = db.from("tasks").select(TASK_SELECT);
    if (filter.areaId !== undefined) q = filter.areaId === null ? q.is("area_id", null) : q.eq("area_id", filter.areaId);
    if (filter.projectId !== undefined) q = filter.projectId === null ? q.is("project_id", null) : q.eq("project_id", filter.projectId);
    return q.order("sort_order").order("id").range(from, to);
  });
  return rows.map(toTask);
}

/** A task by id, or by key ("DEV-12", any case). */
export async function getTask(idOrKey: number | string): Promise<Task | null> {
  const db = await accountDb();
  const byKey = typeof idOrKey === "string" && !/^\d+$/.test(idOrKey);
  const q = db.from("tasks").select(TASK_SELECT);
  const r = one(await (byKey ? q.eq("key", String(idOrKey).toUpperCase()) : q.eq("id", Number(idOrKey))).maybeSingle());
  return r ? toTask(r) : null;
}

/** Creates a task at the end of its project (or of the loose tasks). The database gives it its key. */
export async function createTask(input: TaskInput): Promise<Task> {
  if (input.deviceId != null && !isUuid(input.deviceId)) throw new Error("Unknown computer");
  if (input.relatedProjectId != null && !isUuid(input.relatedProjectId)) throw new Error("Unknown project");
  const db = await accountDb();
  const project = input.projectId ? await getProject(input.projectId) : null;
  const areaId = input.areaId ?? project?.areaId ?? null;
  const stamp = nowStamp();
  const lastQuery = db.from("tasks").select("sort_order");
  const last = many(await (input.projectId ? lastQuery.eq("project_id", input.projectId) : lastQuery.is("project_id", null))
    .order("sort_order", { ascending: false }).limit(1));
  const r = one(await db.from("tasks").insert({
    key: "", area_id: areaId, project_id: input.projectId ?? null, title: input.title.trim(), description: input.description ?? "",
    status: input.status ?? "todo", priority: input.priority ?? 0, due_date: input.dueDate ?? null, planned_date: input.plannedDate ?? null,
    ...(input.plannedDate && input.plannedTime ? { planned_time: input.plannedTime } : {}),
    ...(input.relatedProjectId ? { related_project_id: input.relatedProjectId } : {}),
    ...(input.repeat ? { repeat: input.repeat } : {}),
    estimate_min: input.estimateMin ?? 60, labels: input.labels ?? [], done_when: cleanDoneWhen(input.doneWhen ?? []), needs: cleanNeeds(input.needs ?? []),
    agent: input.agent ?? project?.agent ?? null, sort_order: Number(last[0]?.sort_order ?? 0) + 1, created_at: stamp, updated_at: stamp,
    run_in: input.agent === "human" ? null : input.runIn ?? null,
    model_settings: checkedModelSelection(input.modelSettings),
    device_id: input.agent === "human" ? null : input.deviceId ?? null,
  }).select(TASK_SELECT).single());
  return toTask(r!);
}

const TASK_COLS: Record<string, string> = {
  areaId: "area_id", projectId: "project_id", title: "title", description: "description", status: "status", priority: "priority",
  dueDate: "due_date", plannedDate: "planned_date", plannedTime: "planned_time", estimateMin: "estimate_min", labels: "labels", doneWhen: "done_when",
  relatedProjectId: "related_project_id", repeat: "repeat",
  reminder: "reminder", agent: "agent", runIn: "run_in", deviceId: "device_id", sortOrder: "sort_order",
};


/** `folder` is this computer's setting (device.ts), like a project's folder: the desktop app sets it (the web app can't). */
export async function updateTask(id: number, patch: TaskPatch) {
  if (patch.folder !== undefined) {
    if (MODE !== "desktop") throw new Error("Folders are set in the PacedMind desktop app.");
    const problem = setTaskFolder("cloud", id, patch.folder);
    if (problem) throw new Error(`Can't use the folder ${patch.folder}: ${problem}`);
  }
  if (patch.deviceId !== undefined && patch.deviceId !== null && !isUuid(patch.deviceId)) throw new Error("Unknown computer");
  if (patch.relatedProjectId != null && !isUuid(patch.relatedProjectId)) throw new Error("Unknown project");
  const values = columns(patch, TASK_COLS);
  if (patch.modelSettings !== undefined) values.model_settings = checkedModelSelection(patch.modelSettings);
  if (patch.plannedDate === null) values.planned_time = null;
  if (patch.doneWhen) values.done_when = cleanDoneWhen(patch.doneWhen);
  if (patch.needs) values.needs = cleanNeeds(patch.needs);
  if (patch.status) values.completed_at = patch.status === "done" ? nowStamp() : null;
  if (!Object.keys(values).length) return;
  values.updated_at = nowStamp();
  const db = await accountDb();
  check(await db.from("tasks").update(values).eq("id", id));
}

/** Deletes a task with its sub-tasks, sessions, reports and images (the files this computer keeps too). */
export async function deleteTask(id: number) {
  const db = await accountDb();
  const files = await localImageFiles(id);
  // Its sessions' starting points and its reports' diffs on this computer go too (diff.ts).
  const sessions = many(await db.from("sessions").select("id").eq("task_id", id)).map((r) => String(r.id));
  const patches = many(await db.from("reports").select("diff").eq("task_id", id).not("diff", "is", null)).map((r) => diffOf(r.diff)?.patchId);
  check(await db.from("tasks").delete().eq("id", id));
  if (MODE === "desktop") {
    removeImageFiles(files);
    removeDiffFiles(sessions, patches);
    forgetTask("cloud", id);
  }
}

export async function addSubtask(taskId: number, title: string) {
  const db = await accountDb();
  const last = many(await db.from("subtasks").select("sort").eq("task_id", taskId).order("sort", { ascending: false }).limit(1));
  check(await db.from("subtasks").insert({ task_id: taskId, title: title.trim(), sort: Number(last[0]?.sort ?? 0) + 1 }));
}

export async function setSubtaskDone(id: number, done: boolean) {
  const db = await accountDb();
  check(await db.from("subtasks").update({ done }).eq("id", id));
}

export async function deleteSubtask(id: number) {
  const db = await accountDb();
  check(await db.from("subtasks").delete().eq("id", id));
}

/* ---------- calendar events ---------- */

const toEvent = (r: Row): CalEvent => ({
  id: Number(r.id), title: String(r.title), areaId: s(r.area_id), start: String(r.start_at), end: String(r.end_at),
  recurrence: s(r.recurrence) as CalEvent["recurrence"], doneOn: doneDaysOf(r.done_on),
});

export async function listEvents(): Promise<CalEvent[]> {
  const db = await accountDb();
  return (await all((from, to) => db.from("events").select("*").order("start_at").order("id").range(from, to))).map(toEvent);
}

export async function createEvent(input: { title: string; areaId?: string | null; start: string; end: string; recurrence?: "weekly" | null }): Promise<number> {
  const db = await accountDb();
  const r = one(await db.from("events").insert({
    title: input.title.trim(), area_id: input.areaId ?? null, start_at: input.start, end_at: input.end, recurrence: input.recurrence ?? null,
  }).select("id").single());
  return Number(r!.id);
}

export async function getEvent(id: number): Promise<CalEvent | null> {
  const db = await accountDb();
  const r = one(await db.from("events").select("*").eq("id", id).maybeSingle());
  return r ? toEvent(r) : null;
}

export async function updateEvent(id: number, patch: Partial<Omit<CalEvent, "id">>) {
  const values = columns(patch, { title: "title", areaId: "area_id", start: "start_at", end: "end_at", recurrence: "recurrence" });
  if (typeof values.title === "string") values.title = values.title.trim();
  if (!Object.keys(values).length) return;
  const db = await accountDb();
  check(await db.from("events").update(values).eq("id", id));
}

export async function deleteEvent(id: number) {
  const db = await accountDb();
  check(await db.from("events").delete().eq("id", id));
}

/** Marks one day's occurrence of an activity done, or not done. */
export async function setEventDone(id: number, day: string, done: boolean) {
  const db = await accountDb();
  const r = one(await db.from("events").select("done_on").eq("id", id).maybeSingle());
  if (!r) return;
  check(await db.from("events").update({ done_on: withDoneDay(doneDaysOf(r.done_on), day, done) }).eq("id", id));
}

/** Expands events (including weekly ones) into occurrences between from and to (inclusive dates). */
export async function occurrences(from: string, to: string): Promise<EventOccurrence[]> {
  return expandOccurrences(await listEvents(), from, to);
}

/* ---------- sessions ---------- */

const toSession = (r: Row): Session => ({
  id: String(r.id), taskId: Number(r.task_id), agent: String(r.agent) as AgentId, surface: (s(r.surface) ?? "terminal") as Surface,
  deviceId: s(r.device_id), folder: s(r.folder), branch: s(r.branch), url: s(r.url),
  status: String(r.status) as SessionStatus, startedAt: String(r.started_at), finishedAt: s(r.finished_at), endedAt: s(r.ended_at),
  note: s(r.note), cliSessionId: s(r.cli_session_id), usage: usageOf(r.usage),
});



/** Sessions, newest first. */
export async function listSessions(filter: SessionFilter = {}): Promise<Session[]> {
  const db = await accountDb();
  const rows = await all((from, to) => {
    let q = db.from("sessions").select("*");
    if (filter.taskId !== undefined) q = q.eq("task_id", filter.taskId);
    if (filter.status) q = q.in("status", filter.status);
    if (filter.surface) q = q.eq("surface", filter.surface);
    if (filter.agent) q = q.eq("agent", filter.agent);
    if (filter.deviceId) q = q.eq("device_id", filter.deviceId);
    return q.order("started_at", { ascending: false }).order("id").range(from, to);
  });
  return rows.map(toSession);
}

export async function getSession(id: string): Promise<Session | null> {
  const db = await accountDb();
  const r = one(await db.from("sessions").select("*").eq("id", id).maybeSingle());
  return r ? toSession(r) : null;
}

/** The newest session for a task, if any. */
export async function latestSession(taskId: number): Promise<Session | null> {
  const db = await accountDb();
  const r = one(await db.from("sessions").select("*").eq("task_id", taskId).order("started_at", { ascending: false }).limit(1).maybeSingle());
  return r ? toSession(r) : null;
}

export async function createSession(input: {
  taskId: number; agent: AgentId; folder: string | null; deviceId?: string | null; branch?: string | null; status?: SessionStatus;
  surface?: Surface; cliSessionId?: string | null; startedAt?: string; finishedAt?: string | null;
}): Promise<Session> {
  const db = await accountDb();
  const r = one(await db.from("sessions").insert({
    id: crypto.randomBytes(8).toString("hex"), task_id: input.taskId, agent: input.agent, surface: input.surface ?? "terminal",
    device_id: input.deviceId ?? null, folder: input.folder, branch: input.branch ?? null, status: input.status ?? "starting",
    started_at: input.startedAt ?? nowStamp(), finished_at: input.finishedAt ?? null,
    cli_session_id: input.cliSessionId ?? null,
  }).select().single());
  return toSession(r!);
}

export async function updateSession(
  id: string, patch: Partial<Pick<Session, "status" | "folder" | "finishedAt" | "endedAt" | "note" | "branch" | "cliSessionId" | "url" | "usage">>,
) {
  const values = columns(patch, {
    status: "status", folder: "folder", finishedAt: "finished_at", endedAt: "ended_at", note: "note", branch: "branch", cliSessionId: "cli_session_id",
    url: "url", usage: "usage",
  });
  if (typeof values.url === "string" && !SESSION_URL.test(values.url)) delete values.url;
  if (!Object.keys(values).length) return;
  const db = await accountDb();
  check(await db.from("sessions").update(values).eq("id", id));
}

export async function addSessionEvent(sessionId: string, kind: string, text = "") {
  const db = await accountDb();
  check(await db.from("session_events").insert({ session_id: sessionId, at: nowStamp(), kind, text }));
}

export async function sessionEvents(sessionId: string): Promise<SessionEvent[]> {
  const db = await accountDb();
  return many(await db.from("session_events").select("*").eq("session_id", sessionId).order("at").order("id")).map(toSessionEvent);
}

const toSessionEvent = (r: Row): SessionEvent => ({ id: Number(r.id), sessionId: String(r.session_id), at: String(r.at), kind: String(r.kind), text: String(r.text) });

/** The events of many sessions at once, by session id (every id gets a list). */
export async function sessionEventsFor(sessionIds: string[]): Promise<Record<string, SessionEvent[]>> {
  const out: Record<string, SessionEvent[]> = Object.fromEntries(sessionIds.map((id) => [id, []]));
  const db = await accountDb();
  // A few dozen ids per request keeps the URL short.
  for (let i = 0; i < sessionIds.length; i += 50) {
    const ids = sessionIds.slice(i, i + 50);
    for (const r of await all((from, to) => db.from("session_events").select("*").in("session_id", ids).order("at").order("id").range(from, to))) {
      out[String(r.session_id)]?.push(toSessionEvent(r));
    }
  }
  return out;
}

/** When each session was last marked done, by session id. */
export async function doneTimes(): Promise<Map<string, string>> {
  const db = await accountDb();
  const out = new Map<string, string>();
  for (const r of await all((from, to) => db.from("session_events").select("session_id, at").eq("kind", "done").order("id").range(from, to))) {
    const id = String(r.session_id);
    const at = String(r.at);
    if (!out.has(id) || at > out.get(id)!) out.set(id, at);
  }
  return out;
}

/* ---------- reports (what agents hand back) and their images ---------- */

const toAttachment = (r: Row): Attachment => ({
  id: String(r.id), taskId: Number(r.task_id), sessionId: s(r.session_id), reportId: n(r.report_id), mime: String(r.mime),
  bytes: Number(r.bytes), width: n(r.width), height: n(r.height), caption: String(r.caption ?? ""), createdAt: String(r.created_at),
});

const ATTACHMENT_COLS = "id, task_id, session_id, report_id, mime, bytes, width, height, caption, created_at";

/** The images of these reports, or of these sessions (with `pending`, only the ones no report took yet). */
async function attachmentsWhere(column: "report_id" | "session_id", ids: (string | number)[], pending = false): Promise<Attachment[]> {
  if (!ids.length) return [];
  const db = await accountDb();
  const out: Attachment[] = [];
  for (const part of chunks(ids)) {
    let q = db.from("attachments").select(ATTACHMENT_COLS).in(column, part);
    if (pending) q = q.is("report_id", null);
    out.push(...many(await q.order("created_at").order("id")).map(toAttachment));
  }
  return out;
}

/** How many images a session attached, reported or not. */
export async function countSessionImages(sessionId: string): Promise<number> {
  const db = await accountDb();
  const { count, error } = await db.from("attachments").select("id", { count: "exact", head: true }).eq("session_id", sessionId);
  if (error) throw failure(error);
  return count ?? 0;
}

/**
 * An attachment's file name and type, and whether this computer keeps the file: images stay on the computer
 * the agent saved them on.
 */
export async function attachmentFile(id: string): Promise<{ file: string; mime: string; here: boolean } | null> {
  const db = await accountDb();
  const r = one(await db.from("attachments").select("file, mime, device_id").eq("id", id).maybeSingle());
  if (!r) return null;
  const device = MODE === "desktop" ? deviceConfig().deviceId : null;
  return { file: String(r.file), mime: String(r.mime), here: !!device && s(r.device_id) === device };
}

/** The files of a task's images that this computer keeps, to delete them with the task. */
async function localImageFiles(taskId: number): Promise<string[]> {
  const device = MODE === "desktop" ? deviceConfig().deviceId : null;
  if (!device) return [];
  const db = await accountDb();
  return many(await db.from("attachments").select("file").eq("task_id", taskId).eq("device_id", device)).map((r) => String(r.file));
}

/** Records an image this computer stored (attachments.ts). If the database refuses it, the copy goes too. */
export async function addAttachment(
  img: StoredImage, to: { taskId: number; sessionId: string | null; reportId?: number | null; caption?: string },
): Promise<Attachment> {
  const db = await accountDb();
  const res = await db.from("attachments").insert({
    id: img.id, task_id: to.taskId, session_id: to.sessionId, report_id: to.reportId ?? null, device_id: deviceConfig().deviceId,
    file: img.file, mime: img.mime, bytes: img.bytes, width: img.width, height: img.height,
    caption: (to.caption ?? "").trim().slice(0, 500), created_at: nowStamp(),
  }).select(ATTACHMENT_COLS).single();
  if (res.error) {
    removeImageFiles([img.file]);
    throw failure(res.error);
  }
  return toAttachment(res.data as Row);
}

/** Images each session attached while it worked, not yet part of a report, by session id. */
export async function pendingImages(sessionIds: string[]): Promise<Map<string, Attachment[]>> {
  const map = new Map<string, Attachment[]>();
  for (const a of await attachmentsWhere("session_id", sessionIds, true)) map.set(a.sessionId!, [...(map.get(a.sessionId!) ?? []), a]);
  return map;
}


/** Records a hand-back. Images the session attached while it worked become part of it. */
export async function createReport(input: ReportInput): Promise<number> {
  const db = await accountDb();
  const r = one(await db.from("reports").insert({
    session_id: input.sessionId, task_id: input.taskId, outcome: input.outcome, summary: input.summary.trim(),
    details: (input.details ?? "").trim(), criteria: input.criteria ?? [], verify: input.verify ?? [], questions: input.questions ?? [],
    links: input.links ?? [], follow_ups: input.followUps ?? [], created_at: input.createdAt ?? nowStamp(), diff: input.diff ?? null,
  }).select("id").single());
  const id = Number(r!.id);
  check(await db.from("attachments").update({ report_id: id }).eq("session_id", input.sessionId).is("report_id", null));
  return id;
}


const REPORT_SELECT = "*, session:sessions(agent)";

/** Report rows with their images, agent and follow-up tasks filled in, in the order given. */
async function toReports(rows: Row[]): Promise<Report[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => Number(r.id));
  const images = await attachmentsWhere("report_id", ids);
  const keys = [...new Set(rows.flatMap((r) => strings(r.follow_ups)))];
  const tasks = new Map<string, { title: string; href: string }>();
  if (keys.length) {
    const db = await accountDb();
    for (const part of chunks(keys)) {
      for (const t of many(await db.from("tasks").select("key, title, project_id, area_id").in("key", part))) {
        tasks.set(String(t.key), { title: String(t.title), href: taskHref({ key: String(t.key), projectId: s(t.project_id), areaId: s(t.area_id) }) });
      }
    }
  }
  return rows.map((r) => ({
    id: Number(r.id), sessionId: String(r.session_id), taskId: Number(r.task_id),
    agent: (s((r.session as Row | null)?.agent) ?? "claude") as AgentId,
    outcome: String(r.outcome) as ReportOutcome, summary: String(r.summary), details: String(r.details ?? ""),
    criteria: criteriaOf(r.criteria), verify: strings(r.verify), questions: strings(r.questions), links: linksOf(r.links),
    followUps: strings(r.follow_ups).map((key) => ({ key, title: tasks.get(key)?.title ?? null, href: tasks.get(key)?.href ?? null })),
    createdAt: String(r.created_at),
    images: images.filter((a) => a.reportId === Number(r.id)),
    changes: s(r.changes),
    changesAt: s(r.changes_at),
    diff: diffOf(r.diff),
  }));
}

/** What the user asked to change after reading a report; null takes the request back. */
export async function setReportChanges(reportId: number, changes: string | null, at: string | null) {
  const db = await accountDb();
  check(await db.from("reports").update({ changes, changes_at: at }).eq("id", reportId));
}

/** Takes back a report that turned out not to be needed. The images it took wait for the next one again. */
export async function deleteReport(reportId: number) {
  const db = await accountDb();
  check(await db.from("attachments").update({ report_id: null }).eq("report_id", reportId));
  check(await db.from("reports").delete().eq("id", reportId));
}

/** Every report of these tasks or sessions, newest first. */
async function reportRows(column: "task_id" | "session_id", ids: (string | number)[], select = REPORT_SELECT): Promise<Row[]> {
  if (!ids.length) return [];
  const db = await accountDb();
  const out: Row[] = [];
  for (const part of chunks(ids)) {
    out.push(...await all((from, to) => db.from("reports").select(select).in(column, part).order("id", { ascending: false }).range(from, to)
      .returns<Row[]>()));
  }
  return out.sort((a, b) => Number(b.id) - Number(a.id));
}

/** Each task's latest reports (at most `perTask`), newest first. */
export async function reportsForTasks(taskIds: number[], perTask = 5): Promise<Map<number, Report[]>> {
  const seen = new Map<number, number>();
  const rows = (await reportRows("task_id", taskIds)).filter((r) => {
    const count = (seen.get(Number(r.task_id)) ?? 0) + 1;
    seen.set(Number(r.task_id), count);
    return count <= perTask;
  });
  const map = new Map<number, Report[]>();
  for (const rep of await toReports(rows)) map.set(rep.taskId, [...(map.get(rep.taskId) ?? []), rep]);
  return map;
}

/** Each session's newest report in brief: its outcome and how many questions it asks (for notifications). */
export async function reportBriefs(sessionIds: string[]): Promise<Map<string, { outcome: ReportOutcome; questions: number }>> {
  const map = new Map<string, { outcome: ReportOutcome; questions: number }>();
  for (const r of await reportRows("session_id", sessionIds, "id, session_id, outcome, questions")) {
    if (!map.has(String(r.session_id))) map.set(String(r.session_id), { outcome: String(r.outcome) as ReportOutcome, questions: strings(r.questions).length });
  }
  return map;
}

/** Each session's reports, newest first. */
export async function reportsForSessions(sessionIds: string[]): Promise<Map<string, Report[]>> {
  const map = new Map<string, Report[]>();
  for (const rep of await toReports(await reportRows("session_id", sessionIds))) map.set(rep.sessionId, [...(map.get(rep.sessionId) ?? []), rep]);
  return map;
}

export async function latestReport(taskId: number): Promise<Report | null> {
  const db = await accountDb();
  const rows = many(await db.from("reports").select(REPORT_SELECT).eq("task_id", taskId).order("id", { ascending: false }).limit(1));
  return (await toReports(rows))[0] ?? null;
}

export async function latestSessionReport(sessionId: string): Promise<Report | null> {
  const db = await accountDb();
  const rows = many(await db.from("reports").select(REPORT_SELECT).eq("session_id", sessionId).order("id", { ascending: false }).limit(1));
  return (await toReports(rows))[0] ?? null;
}

/**
 * Tasks whose latest hand-back was partial or blocked, with that outcome. What waits for them waits until the user
 * marks them done. The report has to come from the task's latest session: a later session that was marked finished,
 * or finished in the cloud, brings no report of its own, and moves the task on.
 */
export async function heldOutcomes(): Promise<Map<number, Exclude<ReportOutcome, "done">>> {
  const db = await accountDb();
  const held = new Map<number, Exclude<ReportOutcome, "done">>();
  // Only tasks with a partial or blocked hand-back at all can be held: usually a handful.
  const candidates = [...new Set(
    (await all((from, to) => db.from("reports").select("task_id").neq("outcome", "done").order("id").range(from, to))).map((r) => Number(r.task_id)),
  )];
  if (!candidates.length) return held;
  const latest = new Map<number, Row>();
  for (const r of await reportRows("task_id", candidates, "id, task_id, outcome, session_id")) if (!latest.has(Number(r.task_id))) latest.set(Number(r.task_id), r);
  const newest = new Map<number, string>();
  for (const part of chunks(candidates)) {
    const rows = await all((from, to) => db.from("sessions").select("id, task_id, started_at").in("task_id", part)
      .order("started_at", { ascending: false }).order("id").range(from, to));
    for (const r of rows) if (!newest.has(Number(r.task_id))) newest.set(Number(r.task_id), String(r.id));
  }
  for (const [taskId, r] of latest) {
    if (r.outcome !== "done" && newest.get(taskId) === String(r.session_id)) held.set(taskId, String(r.outcome) as Exclude<ReportOutcome, "done">);
  }
  return held;
}

/* ---------- dependencies ---------- */

// The edges table was made for flows too: its mode and at_time columns stay at their defaults now.
const toEdge = (r: Row): Dependency => ({ id: Number(r.id), fromTaskId: Number(r.from_task_id), toTaskId: Number(r.to_task_id) });

export async function listEdges(): Promise<Dependency[]> {
  const db = await accountDb();
  return (await all((from, to) => db.from("edges").select("id, from_task_id, to_task_id").order("id").range(from, to))).map(toEdge);
}

/** Makes `toTaskId` wait for `fromTaskId`; the same dependency twice is one. */
export async function createEdge(fromTaskId: number, toTaskId: number): Promise<Dependency | null> {
  if (fromTaskId === toTaskId) return null;
  const db = await accountDb();
  check(await db.from("edges").upsert({ from_task_id: fromTaskId, to_task_id: toTaskId }, { onConflict: "from_task_id,to_task_id", ignoreDuplicates: true }));
  const r = one(await db.from("edges").select("id, from_task_id, to_task_id").eq("from_task_id", fromTaskId).eq("to_task_id", toTaskId).maybeSingle());
  return r ? toEdge(r) : null;
}

export async function deleteEdge(id: number) {
  const db = await accountDb();
  check(await db.from("edges").delete().eq("id", id));
}

/* ---------- settings ---------- */

export async function getSettings(): Promise<Settings> {
  const db = await accountDb();
  const stored = Object.fromEntries(many(await db.from("settings").select("key, value"))
    .filter((r) => SETTING_KEYS.includes(r.key as keyof Settings)).map((r) => [String(r.key), r.value]));
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function setSettings(patch: Partial<Settings>) {
  const rows = SETTING_KEYS.filter((k) => patch[k] !== undefined).map((key) => ({ key, value: patch[key] }));
  if (!rows.length) return;
  const db = await accountDb();
  check(await db.from("settings").upsert(rows, { onConflict: "user_id,key" }));
}

/* ---------- preferences ---------- */

const PREFERENCE_COLS = "id, topic, text, source, updated_at";

export async function listPreferences(): Promise<Preference[]> {
  const db = await accountDb();
  return many(await db.from("preferences").select(PREFERENCE_COLS).order("id")).flatMap((r) => preferenceOf(r) ?? []).sort(byTopic);
}

export async function addPreference(input: PreferenceInput): Promise<Preference> {
  const db = await accountDb();
  const r = one(await db.from("preferences")
    .insert({ topic: input.topic, text: cleanPreference(input.text), source: input.source, updated_at: nowStamp() })
    .select(PREFERENCE_COLS).single());
  return preferenceOf(r!)!;
}

export async function updatePreference(id: number, patch: PreferencePatch): Promise<Preference | null> {
  const values: Row = { source: patch.source, updated_at: nowStamp() };
  if (patch.topic) values.topic = patch.topic;
  if (patch.text !== undefined) values.text = cleanPreference(patch.text);
  const db = await accountDb();
  const r = one(await db.from("preferences").update(values).eq("id", id).select(PREFERENCE_COLS).maybeSingle());
  return r ? preferenceOf(r) : null;
}

export async function deletePreference(id: number): Promise<boolean> {
  const db = await accountDb();
  return many(await db.from("preferences").delete().eq("id", id).select("id")).length > 0;
}

/* ---------- computers and requests to start sessions ---------- */

const DEVICE_COLS = "id, name, platform, remote_start, remote_code, agents, created_at, last_seen_at, checked_at, revoked_at, is_default, app_version, other_sessions";

/**
 * What a computer found of one agent, as the cloud has it: for display only. The launcher uses what this
 * computer found itself (devices.ts), so a path from here never reaches a command line; it isn't even kept.
 */
function toolsOf(v: unknown): AgentTools {
  if (!v || typeof v !== "object") return NO_AGENT_TOOLS;
  const t = v as Row;
  const cli = t.cli && typeof t.cli === "object" && typeof (t.cli as Row).version === "string" ? { version: String((t.cli as Row).version) } : null;
  const app = t.app && typeof t.app === "object" ? { version: s((t.app as Row).version) } : null;
  const mcp = t.mcp === "connected" || t.mcp === "old" || t.mcp === "cloud" || t.mcp === "elsewhere" ? t.mcp : "missing";
  const extras = extrasOf(t.extras);
  return { cli, app, mcp, login: loginOf(t.login), models: modelCatalogOf(t.models), ...(extras ? { extras } : {}) };
}

const toDevice = (r: Row): Device => {
  const agents = (r.agents && typeof r.agents === "object" ? r.agents : {}) as Row;
  return {
    id: String(r.id), name: String(r.name), platform: String(r.platform) as Device["platform"], remoteStart: String(r.remote_start) as RemoteStart,
    remoteCode: r.remote_code !== false,
    agents: { claude: toolsOf(agents.claude), codex: toolsOf(agents.codex) },
    createdAt: String(r.created_at), lastSeenAt: s(r.last_seen_at), checkedAt: s(r.checked_at), revokedAt: s(r.revoked_at),
    isDefault: r.is_default === true, appVersion: s(r.app_version),
    otherSessions: otherSessionsOf(r.other_sessions),
  };
};

/**
 * Records what this computer found of the agents, for Settings on every computer: versions, whether the apps reach
 * PacedMind, whether each CLI is signed in (the state, and the method and plan as single words), and the names of
 * what else its sessions get (MCP servers, plugins, hooks, how many skills), and their account's model capabilities.
 * Never where the tools are, what a server runs or where it points, and never an email, an organization or a key. The database keeps it under 64 KiB, so
 * long lists get shorter.
 */
export async function saveDeviceTools(id: string, agents: Device["agents"]) {
  if (!isUuid(id)) return;
  const shape = (max: number, includeModels = true) => Object.fromEntries(Object.entries(agents).map(([agent, t]) => {
    const extras = max > 0 ? extrasOf(t.extras, max) : undefined;
    const models = modelCatalogOf(t.models);
    return [agent, { cli: t.cli ? { version: t.cli.version } : null, app: t.app, mcp: t.mcp, login: loginOf(t.login),
      models: includeModels ? models : models ? { ...models, available: false, models: [] } : undefined, ...(extras ? { extras } : {}) }];
  }));
  const plain = [12, 6, 3, 0].map((max) => shape(max)).find((p) => Buffer.byteLength(JSON.stringify(p)) <= 60_000) ?? shape(0, false);
  const db = await accountDb();
  check(await db.from("devices").update({ agents: plain, checked_at: new Date().toISOString() }).eq("id", id));
}

/** The account's computers, signed-in ones first. */
export async function listDevices(): Promise<Device[]> {
  const db = await accountDb();
  return many(await db.from("devices").select(DEVICE_COLS).order("revoked_at", { ascending: false, nullsFirst: true }).order("created_at"))
    .map(toDevice);
}

export async function getDevice(id: string): Promise<Device | null> {
  if (!isUuid(id)) return null;
  const db = await accountDb();
  const r = one(await db.from("devices").select(DEVICE_COLS).eq("id", id).maybeSingle());
  return r ? toDevice(r) : null;
}

/** Adds this computer to the account's list, pointing at the current auth session (so revoking ends it). */
export async function registerDevice(name: string, platform: Device["platform"]): Promise<string> {
  const db = await accountDb();
  const { data, error } = await db.rpc("register_device", { device_name: cleanDeviceName(name) || "Computer", device_platform: platform });
  if (error) throw failure(error);
  return String(data);
}

/** Renames one of the account's computers, from any of its sessions (the web app, another computer). The computer takes the name over. */
export async function renameDevice(id: string, name: string) {
  const clean = cleanDeviceName(name);
  if (!isUuid(id)) throw new Error("Unknown computer");
  if (!clean) throw new Error("Give the computer a name");
  const db = await accountDb();
  const r = one(await db.from("devices").update({ name: clean }).eq("id", id).is("revoked_at", null).select("id").maybeSingle());
  if (!r) throw new Error("That computer isn't signed in to PacedMind.");
}

/** Makes a signed-in computer the account's default; the one that was the default stops being it (a database trigger). */
export async function setDefaultDevice(id: string) {
  if (!isUuid(id)) throw new Error("Unknown computer");
  const db = await accountDb();
  const r = one(await db.from("devices").update({ is_default: true }).eq("id", id).is("revoked_at", null).select("id").maybeSingle());
  if (!r) throw new Error("That computer isn't signed in to PacedMind.");
}

/** Points this computer's entry at the current auth session, after signing in again. */
export async function claimDevice(id: string) {
  const db = await accountDb();
  const { error } = await db.rpc("claim_device", { device: id });
  if (error) throw failure(error);
}

/** Signs a computer out: its session ends at once and its waiting requests are canceled. */
export async function revokeDevice(id: string) {
  if (!isUuid(id)) throw new Error("Unknown computer");
  const db = await accountDb();
  const { error } = await db.rpc("revoke_device", { device: id });
  if (error) throw failure(error);
}

/**
 * What this computer reports about its own entry (the database takes these only from the computer's own sign-in):
 * its name as set in its window, its settings for requests from elsewhere (whether asking needs a code, which the
 * database checks requests against), that it's still there, and PacedMind's version.
 * Values in the wrong shape are left out rather than failing the rest.
 */
export async function updateDeviceRow(id: string, patch: {
  name?: string; remoteStart?: RemoteStart; remoteCode?: boolean; lastSeen?: boolean; appVersion?: string;
  otherSessions?: OtherSession[];
}) {
  const values: Row = {};
  if (patch.otherSessions) values.other_sessions = otherSessionsOf(patch.otherSessions);
  const name = patch.name === undefined ? "" : cleanDeviceName(patch.name);
  if (name) values.name = name;
  if (patch.remoteStart) values.remote_start = patch.remoteStart;
  if (typeof patch.remoteCode === "boolean") values.remote_code = patch.remoteCode;
  if (patch.lastSeen) values.last_seen_at = new Date().toISOString();
  if (patch.appVersion !== undefined && appVersionOk(patch.appVersion)) values.app_version = patch.appVersion;
  if (!Object.keys(values).length || !isUuid(id)) return;
  const db = await accountDb();
  check(await db.from("devices").update(values).eq("id", id));
}

const KINDS = new Set<string>(["start", "resume", "changes"]);
const SURFACES = new Set<string>(["terminal", "desktop", "cloud"]);

const toRequest = (r: Row): LaunchRequest => ({
  id: String(r.id), kind: (KINDS.has(String(r.kind)) ? String(r.kind) : "start") as LaunchRequestKind,
  deviceId: String(r.device_id), taskId: Number(r.task_id), agent: String(r.agent) as AgentId,
  surface: SURFACES.has(String(r.surface)) ? (String(r.surface) as Surface) : null,
  targetSessionId: s(r.target_session_id), changes: s(r.changes),
  // Set by the database. One without the column (before the remote_code migration) took requests only with a fresh code.
  freshCode: r.fresh_code !== false,
  requestedVia: String(r.requested_via), requestedAt: String(r.requested_at), expiresAt: String(r.expires_at),
  status: String(r.status) as LaunchRequestStatus, decidedAt: s(r.decided_at), sessionId: s(r.session_id), note: s(r.note),
});

/** The account's requests to its computers, newest first (at most 200). */
export async function listLaunchRequests(filter: LaunchRequestFilter = {}): Promise<LaunchRequest[]> {
  const db = await accountDb();
  let q = db.from("launch_requests").select("*");
  if (filter.deviceId) q = q.eq("device_id", filter.deviceId);
  if (filter.status) q = q.in("status", filter.status);
  if (filter.taskId !== undefined) q = q.eq("task_id", filter.taskId);
  if (filter.since) q = q.gte("requested_at", filter.since);
  return many(await q.order("requested_at", { ascending: false }).limit(filter.limit ?? 200)).map(toRequest);
}

/**
 * Asks a computer to start a session, resume one, or send one back with changes. The database only accepts it from
 * a session whose second factor was verified in the last five minutes, unless that computer takes requests without a
 * code, only for a session that ran on that computer (resume, changes), and sets its status, expiry and whether it came
 * with a fresh code itself.
 */
export async function createLaunchRequest(input: LaunchRequestInput): Promise<LaunchRequest> {
  const db = await accountDb();
  const r = one(await db.from("launch_requests").insert({
    device_id: input.deviceId, task_id: input.taskId, agent: input.agent, requested_via: input.via, kind: input.kind ?? "start",
    surface: input.surface ?? null, target_session_id: input.targetSessionId ?? null, changes: input.changes ?? null,
  }).select().single());
  return toRequest(r!);
}

/** Records what the desktop app did with a request. Only a pending one changes. */
export async function settleLaunchRequest(
  id: string, status: Exclude<LaunchRequestStatus, "pending">, extra: { sessionId?: string | null; note?: string | null } = {},
) {
  const db = await accountDb();
  check(await db.from("launch_requests").update({
    status, decided_at: new Date().toISOString(), session_id: extra.sessionId ?? null, note: extra.note?.slice(0, 500) ?? null,
  }).eq("id", id).eq("status", "pending"));
}

/* ---------- folders asked of a computer (folder-requests.ts) ---------- */

const FOLDER_TARGETS = [["project_id", "project"], ["area_id", "area"], ["task_id", "task"]] as const;

const toFolderRequest = (r: Row): FolderRequest => {
  const [column, kind] = FOLDER_TARGETS.find(([col]) => r[col] != null) ?? FOLDER_TARGETS[0];
  return {
    id: String(r.id), deviceId: String(r.device_id), target: { kind, id: String(r[column]) }, folder: String(r.folder),
    requestedVia: String(r.requested_via), requestedAt: String(r.requested_at), expiresAt: String(r.expires_at),
    status: String(r.status) as FolderRequestStatus, decidedAt: s(r.decided_at), note: s(r.note),
  };
};

/** Asks a computer to use a folder: the database takes it for a signed-in computer of the account, and sets the rest. */
export async function createFolderRequest(input: FolderRequestInput): Promise<FolderRequest> {
  const db = await accountDb();
  const column = FOLDER_TARGETS.find(([, kind]) => kind === input.target.kind)![0];
  const r = one(await db.from("folder_requests").insert({
    device_id: input.deviceId, [column]: input.target.kind === "task" ? Number(input.target.id) : input.target.id, folder: input.folder,
    requested_via: input.via,
  }).select().single());
  return toFolderRequest(r!);
}

export async function listFolderRequests(filter: FolderRequestFilter = {}): Promise<FolderRequest[]> {
  const db = await accountDb();
  let q = db.from("folder_requests").select("*");
  if (filter.deviceId) q = q.eq("device_id", filter.deviceId);
  if (filter.status) q = q.in("status", filter.status);
  if (filter.ids) q = q.in("id", filter.ids);
  return many(await q.order("requested_at", { ascending: false }).limit(100)).map(toFolderRequest);
}

/** What this computer did with a folder request (the database takes it only from the computer asked, once). */
export async function settleFolderRequest(id: string, status: Exclude<FolderRequestStatus, "pending">, note?: string | null) {
  const db = await accountDb();
  check(await db.from("folder_requests").update({ status, note: note?.slice(0, 500) ?? null }).eq("id", id).eq("status", "pending"));
}

/* ---------- what a running session waits for you to answer (asks.ts) ---------- */

const ASK_COLS = "id, session_id, device_id, kind, tool, text, remote_ok, asked_at, expires_at, status, answer, answered_at, answered_via";

const toAsk = (r: Row): SessionAsk => ({
  id: String(r.id), sessionId: String(r.session_id), deviceId: s(r.device_id), kind: r.kind === "permission" ? "permission" : "question",
  tool: s(r.tool), text: String(r.text), remoteOk: r.remote_ok === true, askedAt: String(r.asked_at), expiresAt: String(r.expires_at),
  status: String(r.status) as AskStatus, answer: s(r.answer), answeredAt: s(r.answered_at),
  answeredVia: r.answered_via === "computer" || r.answered_via === "elsewhere" ? r.answered_via : null,
});

/** Asks for this computer's own session (the database takes it only from the session's computer). */
export async function createAsk(input: AskInput): Promise<SessionAsk> {
  const db = await accountDb();
  const r = one(await db.from("session_asks").insert({
    session_id: input.sessionId, device_id: input.deviceId, kind: input.kind, tool: input.tool, text: input.text,
    remote_ok: input.remoteOk, expires_at: input.expiresAt,
  }).select(ASK_COLS).single());
  return toAsk(r!);
}

export async function getAsk(id: string): Promise<SessionAsk | null> {
  if (!isUuid(id)) return null;
  const db = await accountDb();
  const r = one(await db.from("session_asks").select(ASK_COLS).eq("id", id).maybeSingle());
  return r ? toAsk(r) : null;
}

export async function listAsks(filter: { sessionIds?: string[]; status?: AskStatus[] } = {}): Promise<SessionAsk[]> {
  const db = await accountDb();
  if (filter.sessionIds && !filter.sessionIds.length) return [];
  const out: SessionAsk[] = [];
  for (const ids of filter.sessionIds ? chunks(filter.sessionIds) : [null]) {
    let q = db.from("session_asks").select(ASK_COLS).order("asked_at", { ascending: false }).limit(200);
    if (ids) q = q.in("session_id", ids);
    if (filter.status) q = q.in("status", filter.status);
    out.push(...many(await q).map(toAsk));
  }
  return out;
}

/**
 * Answers an ask. The database takes it once, before the agent stops waiting: from the session's computer, or from
 * elsewhere with a two-factor code from the last five minutes.
 */
export async function answerAsk(id: string, answer: string): Promise<SessionAsk> {
  const db = await accountDb();
  const r = one(await db.from("session_asks").update({ status: "answered", answer }).eq("id", id).select(ASK_COLS).single());
  return toAsk(r!);
}

/** The computer stopped waiting for an answer, or took the question back. Only a pending one changes. */
export async function settleAsk(id: string, status: "expired" | "withdrawn") {
  const db = await accountDb();
  check(await db.from("session_asks").update({ status }).eq("id", id).eq("status", "pending"));
}

/* ---------- web push (push.ts) ---------- */

/** The account's VAPID key pair, or null before a browser first asked for notifications. */
export async function pushKeys(): Promise<{ publicKey: string; privateKey: string } | null> {
  const db = await accountDb();
  const r = one(await db.from("push_keys").select("public_key, private_key").maybeSingle());
  return r ? { publicKey: String(r.public_key), privateKey: String(r.private_key) } : null;
}

/** Keeps the account's key pair, unless another device made one first (then that one counts). */
export async function savePushKeys(keys: { publicKey: string; privateKey: string }) {
  const db = await accountDb();
  const { error } = await db.from("push_keys").insert({ public_key: keys.publicKey, private_key: keys.privateKey });
  if (error && error.code !== "23505") throw failure(error);
}

export async function listPushSubscriptions(): Promise<PushSubscriptionRow[]> {
  const db = await accountDb();
  return many(await db.from("push_subscriptions").select("endpoint, p256dh, auth, label, created_at").order("created_at")).map((r) => ({
    endpoint: String(r.endpoint), p256dh: String(r.p256dh), auth: String(r.auth), label: String(r.label), createdAt: String(r.created_at),
  }));
}

/** Adds a browser; one that's there already is replaced (its keys change when it subscribes again). */
export async function addPushSubscription(sub: PushSubscriptionInput) {
  const db = await accountDb();
  check(await db.from("push_subscriptions").delete().eq("endpoint", sub.endpoint));
  check(await db.from("push_subscriptions").insert({ endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth, label: sub.label }));
}

export async function removePushSubscription(endpoint: string) {
  const db = await accountDb();
  check(await db.from("push_subscriptions").delete().eq("endpoint", endpoint));
}

/* ---------- agents signed in to PacedMind Cloud's MCP server ---------- */

/** The agents you allowed (connected_agents): those signed in, and those you allowed in the last ten minutes. */
export async function listConnectedAgents(): Promise<ConnectedAgent[]> {
  const db = await accountDb();
  const { data, error } = await db.rpc("connected_agents");
  if (error) throw new Error(error.message);
  return ((data ?? []) as Record<string, unknown>[])
    .map((r) => ({ id: String(r.id), name: String(r.client_name ?? "").slice(0, 200), approvedAt: String(r.approved_at), claimedAt: s(r.claimed_at) }));
}

/** Disconnects an agent: its sign-in ends at once (revoke_agent_login). */
export async function disconnectAgent(id: string): Promise<void> {
  const db = await accountDb();
  const { error } = await db.rpc("revoke_agent_login", { login: id });
  if (error) throw new Error(/already disconnected/i.test(error.message) ? "That agent is already disconnected." : error.message);
}

/* ---------- live refresh ---------- */

/** A number that grows with every write to the account's rows. */
export async function stateVersion(): Promise<number> {
  const db = await accountDb();
  const r = one(await db.from("user_state").select("version").maybeSingle());
  return Number(r?.version ?? 0);
}
