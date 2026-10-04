import "server-only";
import type { NoteDisplays, TaskNoteInput, TaskNoteRequest } from "@/lib/task-notes";
import { localNoteDisplays, publishNoteDisplays } from "../task-note-displays";
import { checkedModelSelection, modelSelectionOf } from "@/lib/agent-models";
import crypto from "node:crypto";
import { removeImageFiles, type StoredImage } from "../attachments";
import { removeDiffFiles } from "../diff";
import {
  areaFolder, forgetArea, forgetProject, forgetTask, projectFolder, setProjectFolder, setTaskFolder, taskFolder,
} from "../device";
import { repoIdentity } from "../git-remote";
import { db, tx } from "./local-db";
import {
  DEFAULT_SETTINGS, SESSION_URL, SETTING_KEYS, areaPictureOf, byTopic, cleanDoneWhen, cleanPreference, codexEnvProblem, criteriaOf, deriveKey, doneDaysOf,
  expandOccurrences, withDoneDay, linksOf, pictureHash, preferenceOf, renamedKey, repoOf, strings,
  type AskInput, type PreferenceInput, type PreferencePatch, type PushSubscriptionRow, type ReportInput, type SessionFilter, type TaskFilter, type TaskInput,
  type TaskPatch, usageOf, diffOf,
} from "./shared";
import { areaIconOf, type AreaIcon } from "@/lib/area-icons";
import { nowStamp, toDateStr } from "@/lib/dates";
import {
  repeatOf, taskHref,
  type AgentId, type Area, type AskStatus, type Attachment, type CalEvent, type ConnectedAgent, type Dependency, type Device, type Doer, type EventOccurrence,
  type FolderRequest, type LaunchRequest, type Preference, type Priority, type Project, type Report, type ReportOutcome, type Session,
  type PushSubscriptionInput, type SessionAsk, type SessionEvent, type SessionStatus, type Settings, type Status, type Subtask, type Surface,
  type Task,
} from "@/lib/types";
import { cleanNeeds } from "@/lib/needs";

/*
 * This computer's own data (the free One device plan), in the SQLite file local-db.ts opens. repo.ts uses it
 * while nobody is signed in to PacedMind Cloud, and it answers like cloud.ts, so the rest of the app doesn't
 * know which it has. There is only this computer: nothing runs on another one, and every image is here.
 * Folders are this computer's settings (device.ts), as with the account's data.
 */

type Row = Record<string, unknown>;

export async function getTaskNoteDisplays(): Promise<NoteDisplays | null> { return localNoteDisplays("local"); }
export async function saveTaskNoteDisplays(_deviceId: string, value: NoteDisplays) { publishNoteDisplays("local", value); }
const toTaskNote = (r: Row): TaskNoteRequest => ({
  id: String(r.id), deviceId: "", taskId: Number(r.task_id), taskCreatedAt: String(r.task_created_at), displayId: String(r.display_id),
  remember: !!r.remember, status: String(r.status) as TaskNoteRequest["status"], requestedAt: String(r.requested_at),
  expiresAt: String(r.expires_at), note: r.note == null ? null : String(r.note),
});
export async function listTaskNoteRequests(): Promise<TaskNoteRequest[]> {
  return db().prepare("SELECT * FROM task_note_requests WHERE requested_at > ? ORDER BY requested_at DESC LIMIT 40")
    .all(new Date(Date.now() - 10 * 60_000).toISOString()).map((r) => toTaskNote(r));
}
export async function createTaskNoteRequest(input: TaskNoteInput): Promise<TaskNoteRequest> {
  return tx(() => {
    const now = new Date().toISOString();
    db().prepare("DELETE FROM task_note_requests WHERE expires_at < ?").run(new Date(Date.now() - 86400_000).toISOString());
    const waiting = db().prepare("SELECT count(*) AS n FROM task_note_requests WHERE status IN ('pending', 'dispatched') AND expires_at > ?").get(now);
    if (Number(waiting?.n) >= 24) throw new Error("Too many notes are waiting to be opened. Wait for the desktop app.");
    const id = crypto.randomUUID();
    db().prepare("INSERT INTO task_note_requests (id, task_id, task_created_at, display_id, remember, requested_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, input.taskId, input.taskCreatedAt, input.displayId, +input.remember, now, new Date(Date.now() + 120_000).toISOString());
    return toTaskNote(db().prepare("SELECT * FROM task_note_requests WHERE id = ?").get(id)!);
  });
}
export async function settleTaskNoteRequest(id: string, from: TaskNoteRequest["status"], status: TaskNoteRequest["status"], note: string | null = null): Promise<boolean> {
  return db().prepare("UPDATE task_note_requests SET status = ?, note = ? WHERE id = ? AND status = ?").run(status, note?.slice(0, 500) ?? null, id, from).changes > 0;
}
type Value = string | number | null;
const s = (v: unknown) => (v == null ? null : String(v));
const n = (v: unknown) => (v == null ? null : Number(v));
const marks = (xs: unknown[]) => xs.map(() => "?").join(",");
const SURFACES = new Set<string>(["terminal", "desktop", "cloud"]);

/** A JSON column, or the fallback when it's empty or unreadable. */
function json<T>(v: unknown, fallback: T): T {
  try {
    return v == null || v === "" ? fallback : (JSON.parse(String(v)) as T);
  } catch {
    return fallback;
  }
}

const all = (sql: string, ...params: Value[]) => db().prepare(sql).all(...params) as Row[];
const get = (sql: string, ...params: Value[]) => db().prepare(sql).get(...params) as Row | undefined;
const run = (sql: string, ...params: Value[]) => db().prepare(sql).run(...params);

/** "UPDATE … SET" for the defined fields of a patch, under their column names. */
function update(table: string, id: Value, values: Record<string, Value>) {
  const keys = Object.keys(values);
  if (!keys.length) return;
  run(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, ...keys.map((k) => values[k]), id);
}

function columns(patch: object, cols: Record<string, string>): Record<string, Value> {
  const out: Record<string, Value> = {};
  for (const [k, v] of Object.entries(patch)) if (k in cols && v !== undefined) out[cols[k]] = v as Value;
  return out;
}

const slug = (name: string, fallback: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || fallback;

/* ---------- areas and projects ---------- */

const toArea = (r: Row): Area => ({
  id: String(r.id), name: String(r.name), key: String(r.key), color: String(r.color), icon: areaIconOf(r.icon),
  picture: pictureHash(r.picture), sort: Number(r.sort), folder: areaFolder(String(r.id)), repo: repoOf(r.repo),
});
const areasNow = () => all("SELECT * FROM areas ORDER BY sort").map(toArea);

export async function listAreas(): Promise<Area[]> {
  return areasNow();
}

/** An area's own picture, base64 PNG, or null (the picture's route serves it). */
export async function areaPicture(id: string): Promise<string | null> {
  return areaPictureOf(get("SELECT picture FROM areas WHERE id = ?", id)?.picture);
}

export async function createArea(input: { name: string; color: string; icon?: AreaIcon | null }): Promise<Area> {
  const areas = areasNow();
  const base = slug(input.name, "area");
  const ids = new Set(areas.map((a) => a.id));
  let id = base;
  for (let i = 2; ids.has(id); i++) id = `${base}-${i}`;
  run("INSERT INTO areas (id, name, key, color, icon, sort) VALUES (?, ?, ?, ?, ?, ?)",
    id, input.name.trim(), deriveKey(input.name, new Set(areas.map((a) => a.key))), input.color, areaIconOf(input.icon),
    areas.reduce((m, a) => Math.max(m, a.sort), 0) + 1);
  return areasNow().find((a) => a.id === id)!;
}

/**
 * `icon: null` or `picture: null` puts the dot back. An area shows its picture or its icon, so setting one clears
 * the other; `picture` is base64 PNG (area-picture.ts), and one that isn't stays out. A new name can give the area a
 * new key (`renamedKey`), which only its new tasks get.
 */
export async function updateArea(id: string, patch: { name?: string; color?: string; icon?: AreaIcon | null; picture?: string | null; sort?: number }) {
  const values: Record<string, Value> = {};
  const name = patch.name?.trim();
  if (name) {
    values.name = name;
    const areas = areasNow();
    const current = areas.find((a) => a.id === id);
    if (current) values.key = renamedKey(name, current.key, new Set(areas.filter((a) => a.id !== id).map((a) => a.key)));
  }
  if (patch.color) values.color = patch.color;
  if (patch.sort !== undefined) values.sort = patch.sort;
  if (patch.icon !== undefined) values.icon = areaIconOf(patch.icon);
  if (patch.picture !== undefined) values.picture = areaPictureOf(patch.picture);
  if (values.icon) values.picture = null;
  if (values.picture) values.icon = null;
  update("areas", id, values);
}

/** Deletes an area and its projects. Tasks are kept and move to the Inbox. */
export async function deleteArea(id: string) {
  const projects = all("SELECT id FROM projects WHERE area_id = ?", id).map((r) => String(r.id));
  tx(() => {
    run("UPDATE tasks SET area_id = NULL, project_id = NULL WHERE area_id = ? OR project_id IN (SELECT id FROM projects WHERE area_id = ?)", id, id);
    run("UPDATE events SET area_id = NULL WHERE area_id = ?", id);
    run("UPDATE projects SET after_project_id = NULL WHERE after_project_id IN (SELECT id FROM projects WHERE area_id = ?)", id);
    run("DELETE FROM projects WHERE area_id = ?", id);
    run("DELETE FROM areas WHERE id = ?", id);
  });
  for (const p of projects) forgetProject(p);
  forgetArea(id);
}

/** Deletes a project. Its tasks stay in the project's area without a project. */
export async function deleteProject(id: string) {
  tx(() => {
    run("UPDATE projects SET after_project_id = NULL WHERE after_project_id = ?", id);
    run("UPDATE tasks SET project_id = NULL WHERE project_id = ?", id);
    run("UPDATE tasks SET related_project_id = NULL WHERE related_project_id = ?", id);
    run("DELETE FROM projects WHERE id = ?", id);
  });
  forgetProject(id);
}

const toProject = (r: Row): Project => ({
  id: String(r.id), areaId: String(r.area_id), name: String(r.name), color: s(r.color), startDate: s(r.start_date), targetDate: s(r.target_date),
  folder: projectFolder(String(r.id)), deviceId: null, codexEnv: s(r.codex_env), repo: repoOf(r.repo), agent: s(r.agent) as AgentId | null,
  afterProjectId: s(r.after_project_id), sort: Number(r.sort),
});

export async function listProjects(): Promise<Project[]> {
  return all("SELECT * FROM projects ORDER BY sort").map(toProject);
}

const projectNow = (id: string) => {
  const r = get("SELECT * FROM projects WHERE id = ?", id);
  return r ? toProject(r) : null;
};

export async function getProject(id: string): Promise<Project | null> {
  return projectNow(id);
}

/** Creates a project. Callers check a folder with folderProblem first, because the project exists by the time the folder is set. */
export async function createProject(input: {
  name: string; areaId: string; folder?: string | null; deviceId?: string | null; agent?: AgentId | null; targetDate?: string | null;
  color?: string | null;
}): Promise<Project> {
  const base = slug(input.name, "project");
  let id = base;
  for (let i = 2; get("SELECT 1 FROM projects WHERE id = ?", id); i++) id = `${base}-${i}`;
  const sort = Number(get("SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM projects")!.n);
  run("INSERT INTO projects (id, area_id, name, start_date, target_date, agent, sort, color, repo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    id, input.areaId, input.name.trim(), toDateStr(new Date()), input.targetDate ?? null, input.agent ?? null, sort, input.color ?? null,
    input.folder ? repoIdentity(input.folder) : null);
  if (input.folder) setProjectFolder(id, input.folder);
  return projectNow(id)!;
}

const PROJECT_COLS: Record<string, string> = {
  areaId: "area_id", name: "name", color: "color", startDate: "start_date", targetDate: "target_date", agent: "agent",
  afterProjectId: "after_project_id", sort: "sort", codexEnv: "codex_env",
};

/**
 * Moving a project to another area moves its tasks too. `folder` is this computer's setting. There is one computer,
 * so a project has no other to run on.
 */
export async function updateProject(id: string, patch: Partial<Omit<Project, "id">>) {
  if (patch.folder !== undefined) {
    const problem = setProjectFolder(id, patch.folder);
    if (problem) throw new Error(`Can't use the folder ${patch.folder}: ${problem}`);
  }
  if (patch.codexEnv !== undefined) {
    const env = patch.codexEnv?.trim() || null;
    const problem = env && codexEnvProblem(env);
    if (problem) throw new Error(problem);
    patch = { ...patch, codexEnv: env };
  }
  const values = columns(patch, PROJECT_COLS);
  // The repository of a folder set here; a folder outside one keeps what another computer saw.
  const found = patch.folder ? repoIdentity(patch.folder) : null;
  if (found) values.repo = found;
  update("projects", id, values);
  // A project's tasks always live in the project's area.
  if (patch.areaId) run("UPDATE tasks SET area_id = ? WHERE project_id = ?", patch.areaId, id);
}

/** Records the repository a project's folder on this computer is in (project-links.ts). */
/** The repository an area's workspace holds (project-links.ts), for your other computers. */
export async function setAreaRepo(id: string, repo: string) {
  const value = repoOf(repo);
  if (value) run("UPDATE areas SET repo = ? WHERE id = ?", value, id);
}

export async function setProjectRepo(id: string, repo: string) {
  const value = repoOf(repo);
  if (value) run("UPDATE projects SET repo = ? WHERE id = ?", value, id);
}

/**
 * Merges `fromId` into `intoId`: its tasks move there, after the project's own, into its area, and keep their keys;
 * what `intoId` leaves empty (agent, Codex environment, repository) it takes from `fromId`; projects that started
 * after `fromId` start after `intoId`; then `fromId` is deleted. This computer's folders are project-links.ts's.
 */
export async function mergeProject(fromId: string, intoId: string) {
  const from = projectNow(fromId);
  const into = projectNow(intoId);
  if (!from || !into || fromId === intoId) return;
  const last = Number(get("SELECT COALESCE(MAX(sort_order), 0) AS n FROM tasks WHERE project_id = ?", intoId)!.n);
  tx(() => {
    run("UPDATE tasks SET project_id = ?, area_id = ?, sort_order = sort_order + ?, updated_at = ? WHERE project_id = ?",
      intoId, into.areaId, last, nowStamp(), fromId);
    run("UPDATE tasks SET related_project_id = ? WHERE related_project_id = ?", intoId, fromId);
    run("UPDATE projects SET after_project_id = NULL WHERE id = ? AND after_project_id = ?", intoId, fromId);
    run("UPDATE projects SET after_project_id = ? WHERE after_project_id = ?", intoId, fromId);
    run("UPDATE projects SET agent = COALESCE(agent, ?), codex_env = COALESCE(codex_env, ?), repo = COALESCE(repo, ?) WHERE id = ?",
      from.agent, from.codexEnv, from.repo, intoId);
    run("DELETE FROM projects WHERE id = ?", fromId);
  });
}

/* ---------- tasks ---------- */

function subtasksFor(ids: number[]): Map<number, Subtask[]> {
  const map = new Map<number, Subtask[]>();
  if (!ids.length) return map;
  for (const r of all(`SELECT * FROM subtasks WHERE task_id IN (${marks(ids)}) ORDER BY sort, id`, ...ids)) {
    const st: Subtask = { id: Number(r.id), taskId: Number(r.task_id), title: String(r.title), done: Number(r.done) === 1, sort: Number(r.sort) };
    map.set(st.taskId, [...(map.get(st.taskId) ?? []), st]);
  }
  return map;
}

const toTask = (r: Row, subs: Subtask[]): Task => ({
  id: Number(r.id), key: String(r.key), areaId: s(r.area_id), projectId: s(r.project_id), title: String(r.title),
  description: String(r.description ?? ""), status: String(r.status) as Status, priority: Number(r.priority) as Priority,
  dueDate: s(r.due_date), plannedDate: s(r.planned_date), plannedTime: r.planned_date ? s(r.planned_time) : null, estimateMin: Number(r.estimate_min),
  relatedProjectId: s(r.related_project_id), repeat: repeatOf(r.repeat), labels: strings(json(r.labels, [])),
  doneWhen: strings(json(r.done_when, [])), needs: cleanNeeds(strings(json(r.needs, []))), reminder: s(r.reminder), agent: s(r.agent) as Doer | null,
  runIn: SURFACES.has(String(r.run_in)) ? (String(r.run_in) as Surface) : null, deviceId: null, folder: taskFolder("local", Number(r.id)),
  modelSettings: modelSelectionOf(json(r.model_settings, null)),
  sortOrder: Number(r.sort_order),
  createdAt: String(r.created_at), updatedAt: String(r.updated_at), completedAt: s(r.completed_at), subtasks: subs,
});

function tasksWhere(where: string, ...params: Value[]): Task[] {
  const rows = all(`SELECT * FROM tasks WHERE ${where} ORDER BY sort_order, id`, ...params);
  const subs = subtasksFor(rows.map((r) => Number(r.id)));
  return rows.map((r) => toTask(r, subs.get(Number(r.id)) ?? []));
}

export async function listTasks(filter: TaskFilter = {}): Promise<Task[]> {
  const where: string[] = ["1 = 1"];
  const params: Value[] = [];
  if (filter.areaId === null) where.push("area_id IS NULL");
  else if (filter.areaId !== undefined) {
    where.push("area_id = ?");
    params.push(filter.areaId);
  }
  if (filter.projectId === null) where.push("project_id IS NULL");
  else if (filter.projectId !== undefined) {
    where.push("project_id = ?");
    params.push(filter.projectId);
  }
  return tasksWhere(where.join(" AND "), ...params);
}

function taskNow(idOrKey: number | string): Task | null {
  const byKey = typeof idOrKey === "string" && !/^\d+$/.test(idOrKey);
  return tasksWhere(byKey ? "key = ? COLLATE NOCASE" : "id = ?", byKey ? String(idOrKey) : Number(idOrKey))[0] ?? null;
}

/** A task by id, or by key ("DEV-12", any case). */
export async function getTask(idOrKey: number | string): Promise<Task | null> {
  return taskNow(idOrKey);
}

/** The next key in an area ("DEV-43"); tasks without an area are INB-. */
function nextKey(areaId: string | null): string {
  const prefix = areaId ? String(get("SELECT key FROM areas WHERE id = ?", areaId)?.key ?? "TSK") : "INB";
  const max = all("SELECT key FROM tasks WHERE key LIKE ?", `${prefix}-%`).reduce((m, r) => Math.max(m, Number(String(r.key).split("-")[1]) || 0), 0);
  return `${prefix}-${max + 1}`;
}

/** Creates a task at the end of its project (or of the loose tasks). */
export async function createTask(input: TaskInput): Promise<Task> {
  const project = input.projectId ? projectNow(input.projectId) : null;
  const areaId = input.areaId ?? project?.areaId ?? null;
  const stamp = nowStamp();
  const sort = Number(get("SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM tasks WHERE project_id IS ?", input.projectId ?? null)!.n);
  const r = run(
    `INSERT INTO tasks (key, area_id, project_id, title, description, status, priority, due_date, planned_date, planned_time, estimate_min,
       labels, done_when, needs, agent, run_in, sort_order, created_at, updated_at, model_settings, related_project_id, repeat)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    nextKey(areaId), areaId, input.projectId ?? null, input.title.trim(), input.description ?? "", input.status ?? "todo", input.priority ?? 0,
    input.dueDate ?? null, input.plannedDate ?? null, (input.plannedDate && input.plannedTime) || null, input.estimateMin ?? 60, JSON.stringify(input.labels ?? []),
    JSON.stringify(cleanDoneWhen(input.doneWhen ?? [])), JSON.stringify(cleanNeeds(input.needs ?? [])), input.agent ?? project?.agent ?? null,
    input.agent === "human" ? null : input.runIn ?? null, sort, stamp, stamp, JSON.stringify(checkedModelSelection(input.modelSettings)),
    input.relatedProjectId ?? null, input.repeat ?? null,
  );
  return taskNow(Number(r.lastInsertRowid))!;
}

const TASK_COLS: Record<string, string> = {
  areaId: "area_id", projectId: "project_id", title: "title", description: "description", status: "status", priority: "priority",
  dueDate: "due_date", plannedDate: "planned_date", plannedTime: "planned_time", estimateMin: "estimate_min",
  relatedProjectId: "related_project_id", repeat: "repeat", reminder: "reminder", agent: "agent", runIn: "run_in",
  sortOrder: "sort_order",
};

/** `folder` is this computer's setting (device.ts). There is no other computer to run on. */
export async function updateTask(id: number, patch: TaskPatch) {
  if (patch.folder !== undefined) {
    const problem = setTaskFolder("local", id, patch.folder);
    if (problem) throw new Error(`Can't use the folder ${patch.folder}: ${problem}`);
  }
  const values = columns(patch, TASK_COLS);
  if (patch.modelSettings !== undefined) values.model_settings = JSON.stringify(checkedModelSelection(patch.modelSettings));
  if (patch.plannedDate === null) values.planned_time = null;
  if (patch.labels) values.labels = JSON.stringify(patch.labels);
  if (patch.doneWhen) values.done_when = JSON.stringify(cleanDoneWhen(patch.doneWhen));
  if (patch.needs) values.needs = JSON.stringify(cleanNeeds(patch.needs));
  if (patch.status) values.completed_at = patch.status === "done" ? nowStamp() : null;
  if (!Object.keys(values).length) return;
  values.updated_at = nowStamp();
  update("tasks", id, values);
}

/** Deletes a task with its sub-tasks, sessions, reports, images and diffs. */
export async function deleteTask(id: number) {
  const files = all("SELECT file FROM attachments WHERE task_id = ?", id).map((r) => String(r.file));
  const sessions = all("SELECT id FROM sessions WHERE task_id = ?", id).map((r) => String(r.id));
  const patches = all("SELECT diff FROM reports WHERE task_id = ? AND diff IS NOT NULL", id).map((r) => diffOf(r.diff)?.patchId);
  run("DELETE FROM tasks WHERE id = ?", id);
  removeImageFiles(files);
  removeDiffFiles(sessions, patches);
  forgetTask("local", id);
}

export async function addSubtask(taskId: number, title: string) {
  const sort = Number(get("SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM subtasks WHERE task_id = ?", taskId)!.n);
  run("INSERT INTO subtasks (task_id, title, sort) VALUES (?, ?, ?)", taskId, title.trim(), sort);
}

export async function setSubtaskDone(id: number, done: boolean) {
  run("UPDATE subtasks SET done = ? WHERE id = ?", done ? 1 : 0, id);
}

export async function deleteSubtask(id: number) {
  run("DELETE FROM subtasks WHERE id = ?", id);
}

/* ---------- calendar events ---------- */

const toEvent = (r: Row): CalEvent => ({
  id: Number(r.id), title: String(r.title), areaId: s(r.area_id), start: String(r.start_at), end: String(r.end_at),
  recurrence: s(r.recurrence) as CalEvent["recurrence"], doneOn: doneDaysOf(r.done_on),
});
const eventsNow = () => all("SELECT * FROM events ORDER BY start_at, id").map(toEvent);

export async function listEvents(): Promise<CalEvent[]> {
  return eventsNow();
}

export async function createEvent(input: { title: string; areaId?: string | null; start: string; end: string; recurrence?: "weekly" | null }): Promise<number> {
  const r = run("INSERT INTO events (title, area_id, start_at, end_at, recurrence) VALUES (?, ?, ?, ?, ?)",
    input.title.trim(), input.areaId ?? null, input.start, input.end, input.recurrence ?? null);
  return Number(r.lastInsertRowid);
}

export async function getEvent(id: number): Promise<CalEvent | null> {
  const r = get("SELECT * FROM events WHERE id = ?", id);
  return r ? toEvent(r) : null;
}

export async function updateEvent(id: number, patch: Partial<Omit<CalEvent, "id">>) {
  const values = columns(patch, { title: "title", areaId: "area_id", start: "start_at", end: "end_at", recurrence: "recurrence" });
  if (typeof values.title === "string") values.title = values.title.trim();
  update("events", id, values);
}

export async function deleteEvent(id: number) {
  run("DELETE FROM events WHERE id = ?", id);
}

/** Marks one day's occurrence of an activity done, or not done. */
export async function setEventDone(id: number, day: string, done: boolean) {
  const r = get("SELECT done_on FROM events WHERE id = ?", id);
  if (!r) return;
  run("UPDATE events SET done_on = ? WHERE id = ?", JSON.stringify(withDoneDay(doneDaysOf(r.done_on), day, done)), id);
}

/** Expands events (including weekly ones) into occurrences between from and to (inclusive dates). */
export async function occurrences(from: string, to: string): Promise<EventOccurrence[]> {
  return expandOccurrences(eventsNow(), from, to);
}

/* ---------- sessions ---------- */

const toSession = (r: Row): Session => ({
  id: String(r.id), taskId: Number(r.task_id), agent: String(r.agent) as AgentId, surface: (s(r.surface) ?? "terminal") as Surface,
  deviceId: null, folder: s(r.folder), branch: s(r.branch), url: s(r.url),
  status: String(r.status) as SessionStatus, startedAt: String(r.started_at), finishedAt: s(r.finished_at), endedAt: s(r.ended_at),
  note: s(r.note), cliSessionId: s(r.cli_session_id), usage: usageOf(r.usage),
});

/** Sessions, newest first. They all ran on this computer: asking for another's finds none. */
export async function listSessions(filter: SessionFilter = {}): Promise<Session[]> {
  if (filter.deviceId) return [];
  if (filter.status && !filter.status.length) return [];
  const where: string[] = ["1 = 1"];
  const params: Value[] = [];
  const add = (sql: string, ...values: Value[]) => {
    where.push(sql);
    params.push(...values);
  };
  if (filter.taskId !== undefined) add("task_id = ?", filter.taskId);
  if (filter.status) add(`status IN (${marks(filter.status)})`, ...filter.status);
  if (filter.surface) add("surface = ?", filter.surface);
  if (filter.agent) add("agent = ?", filter.agent);
  return all(`SELECT * FROM sessions WHERE ${where.join(" AND ")} ORDER BY started_at DESC, id`, ...params).map(toSession);
}

export async function getSession(id: string): Promise<Session | null> {
  const r = get("SELECT * FROM sessions WHERE id = ?", id);
  return r ? toSession(r) : null;
}

/** The newest session for a task, if any. */
export async function latestSession(taskId: number): Promise<Session | null> {
  const r = get("SELECT * FROM sessions WHERE task_id = ? ORDER BY started_at DESC LIMIT 1", taskId);
  return r ? toSession(r) : null;
}

export async function createSession(input: {
  taskId: number; agent: AgentId; folder: string | null; deviceId?: string | null; branch?: string | null; status?: SessionStatus;
  surface?: Surface; cliSessionId?: string | null; startedAt?: string; finishedAt?: string | null;
}): Promise<Session> {
  const id = crypto.randomBytes(8).toString("hex");
  run(
    `INSERT INTO sessions (id, task_id, agent, surface, folder, branch, status, started_at, finished_at, cli_session_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, input.taskId, input.agent, input.surface ?? "terminal", input.folder, input.branch ?? null, input.status ?? "starting",
    input.startedAt ?? nowStamp(), input.finishedAt ?? null, input.cliSessionId ?? null,
  );
  return (await getSession(id))!;
}

export async function updateSession(
  id: string, patch: Partial<Pick<Session, "status" | "folder" | "finishedAt" | "endedAt" | "note" | "branch" | "cliSessionId" | "url" | "usage">>,
) {
  const values = columns(patch, {
    status: "status", folder: "folder", finishedAt: "finished_at", endedAt: "ended_at", note: "note", branch: "branch", cliSessionId: "cli_session_id",
    url: "url",
  });
  if (patch.usage !== undefined) values.usage = patch.usage ? JSON.stringify(patch.usage) : null;
  if (typeof values.url === "string" && !SESSION_URL.test(values.url)) delete values.url;
  update("sessions", id, values);
}

export async function addSessionEvent(sessionId: string, kind: string, text = "") {
  run("INSERT INTO session_events (session_id, at, kind, text) VALUES (?, ?, ?, ?)", sessionId, nowStamp(), kind, text);
}

const toSessionEvent = (r: Row): SessionEvent => ({ id: Number(r.id), sessionId: String(r.session_id), at: String(r.at), kind: String(r.kind), text: String(r.text) });

export async function sessionEvents(sessionId: string): Promise<SessionEvent[]> {
  return all("SELECT * FROM session_events WHERE session_id = ? ORDER BY at, id", sessionId).map(toSessionEvent);
}

/** The events of many sessions at once, by session id (every id gets a list). */
export async function sessionEventsFor(sessionIds: string[]): Promise<Record<string, SessionEvent[]>> {
  const out: Record<string, SessionEvent[]> = Object.fromEntries(sessionIds.map((id) => [id, []]));
  if (!sessionIds.length) return out;
  for (const r of all(`SELECT * FROM session_events WHERE session_id IN (${marks(sessionIds)}) ORDER BY at, id`, ...sessionIds)) {
    out[String(r.session_id)]?.push(toSessionEvent(r));
  }
  return out;
}

/** When each session was last marked done, by session id. */
export async function doneTimes(): Promise<Map<string, string>> {
  return new Map(all("SELECT session_id, MAX(at) AS at FROM session_events WHERE kind = 'done' GROUP BY session_id").map((r) => [String(r.session_id), String(r.at)]));
}

/* ---------- reports (what agents hand back) and their images ---------- */

const toAttachment = (r: Row): Attachment => ({
  id: String(r.id), taskId: Number(r.task_id), sessionId: s(r.session_id), reportId: n(r.report_id), mime: String(r.mime),
  bytes: Number(r.bytes), width: n(r.width), height: n(r.height), caption: String(r.caption ?? ""), createdAt: String(r.created_at),
});

const attachmentsWhere = (where: string, ...params: Value[]) =>
  all(`SELECT * FROM attachments WHERE ${where} ORDER BY created_at, id`, ...params).map(toAttachment);

/** How many images a session attached, reported or not. */
export async function countSessionImages(sessionId: string): Promise<number> {
  return Number(get("SELECT COUNT(*) AS n FROM attachments WHERE session_id = ?", sessionId)!.n);
}

/** An attachment's file name and type. Its file is on this computer, like all of them. */
export async function attachmentFile(id: string): Promise<{ file: string; mime: string; here: boolean } | null> {
  const r = get("SELECT file, mime FROM attachments WHERE id = ?", id);
  return r ? { file: String(r.file), mime: String(r.mime), here: true } : null;
}

/** Records an image this computer stored (attachments.ts). If the database refuses it, the copy goes too. */
export async function addAttachment(
  img: StoredImage, to: { taskId: number; sessionId: string | null; reportId?: number | null; caption?: string },
): Promise<Attachment> {
  try {
    run(
      `INSERT INTO attachments (id, task_id, session_id, report_id, file, mime, bytes, width, height, caption, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      img.id, to.taskId, to.sessionId, to.reportId ?? null, img.file, img.mime, img.bytes, img.width, img.height,
      (to.caption ?? "").trim().slice(0, 500), nowStamp(),
    );
  } catch (e) {
    removeImageFiles([img.file]);
    throw e;
  }
  return attachmentsWhere("id = ?", img.id)[0];
}

/** Images each session attached while it worked, not yet part of a report, by session id. */
export async function pendingImages(sessionIds: string[]): Promise<Map<string, Attachment[]>> {
  const map = new Map<string, Attachment[]>();
  if (!sessionIds.length) return map;
  for (const a of attachmentsWhere(`report_id IS NULL AND session_id IN (${marks(sessionIds)})`, ...sessionIds)) {
    map.set(a.sessionId!, [...(map.get(a.sessionId!) ?? []), a]);
  }
  return map;
}

/** Records a hand-back. Images the session attached while it worked become part of it. */
export async function createReport(input: ReportInput): Promise<number> {
  return tx(() => {
    const r = run(
      `INSERT INTO reports (session_id, task_id, outcome, summary, details, criteria, verify, questions, links, follow_ups, created_at, diff)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.sessionId, input.taskId, input.outcome, input.summary.trim(), (input.details ?? "").trim(), JSON.stringify(input.criteria ?? []),
      JSON.stringify(input.verify ?? []), JSON.stringify(input.questions ?? []), JSON.stringify(input.links ?? []),
      JSON.stringify(input.followUps ?? []), input.createdAt ?? nowStamp(), input.diff ? JSON.stringify(input.diff) : null,
    );
    const id = Number(r.lastInsertRowid);
    run("UPDATE attachments SET report_id = ? WHERE session_id = ? AND report_id IS NULL", id, input.sessionId);
    return id;
  });
}

/** Report rows with their images, agent and follow-up tasks filled in, in the order given. */
function toReports(rows: Row[]): Report[] {
  if (!rows.length) return [];
  const ids = rows.map((r) => Number(r.id));
  const images = attachmentsWhere(`report_id IN (${marks(ids)})`, ...ids);
  const keys = [...new Set(rows.flatMap((r) => strings(json(r.follow_ups, []))))];
  const tasks = new Map(
    keys.length
      ? all(`SELECT key, title, project_id, area_id FROM tasks WHERE key IN (${marks(keys)})`, ...keys)
        .map((t) => [String(t.key), { title: String(t.title), href: taskHref({ key: String(t.key), projectId: s(t.project_id), areaId: s(t.area_id) }) }] as const)
      : [],
  );
  return rows.map((r) => ({
    id: Number(r.id), sessionId: String(r.session_id), taskId: Number(r.task_id), agent: (s(r.agent) ?? "claude") as AgentId,
    outcome: String(r.outcome) as ReportOutcome, summary: String(r.summary), details: String(r.details ?? ""),
    criteria: criteriaOf(json(r.criteria, [])), verify: strings(json(r.verify, [])), questions: strings(json(r.questions, [])),
    links: linksOf(json(r.links, [])),
    followUps: strings(json(r.follow_ups, [])).map((key) => ({ key, title: tasks.get(key)?.title ?? null, href: tasks.get(key)?.href ?? null })),
    createdAt: String(r.created_at),
    images: images.filter((a) => a.reportId === Number(r.id)),
    changes: s(r.changes),
    changesAt: s(r.changes_at),
    diff: diffOf(r.diff),
  }));
}

/** What the user asked to change after reading a report; null takes the request back. */
export async function setReportChanges(reportId: number, changes: string | null, at: string | null) {
  run("UPDATE reports SET changes = ?, changes_at = ? WHERE id = ?", changes, at, reportId);
}

/** Takes back a report that turned out not to be needed. The images it took wait for the next one again. */
export async function deleteReport(reportId: number) {
  tx(() => {
    run("UPDATE attachments SET report_id = NULL WHERE report_id = ?", reportId);
    run("DELETE FROM reports WHERE id = ?", reportId);
  });
}

const REPORTS = "SELECT reports.*, sessions.agent AS agent FROM reports JOIN sessions ON sessions.id = reports.session_id";

/** Each task's latest reports (at most `perTask`), newest first. */
export async function reportsForTasks(taskIds: number[], perTask = 5): Promise<Map<number, Report[]>> {
  const map = new Map<number, Report[]>();
  if (!taskIds.length) return map;
  const rows = all(
    `SELECT * FROM (SELECT r.*, ROW_NUMBER() OVER (PARTITION BY r.task_id ORDER BY r.id DESC) AS nth FROM (${REPORTS}) r
     WHERE r.task_id IN (${marks(taskIds)})) WHERE nth <= ? ORDER BY id DESC`,
    ...taskIds, perTask,
  );
  for (const rep of toReports(rows)) map.set(rep.taskId, [...(map.get(rep.taskId) ?? []), rep]);
  return map;
}

/** Each session's newest report in brief: its outcome and how many questions it asks (for notifications). */
export async function reportBriefs(sessionIds: string[]): Promise<Map<string, { outcome: ReportOutcome; questions: number }>> {
  const map = new Map<string, { outcome: ReportOutcome; questions: number }>();
  if (!sessionIds.length) return map;
  for (const r of all(`SELECT session_id, outcome, questions FROM reports WHERE session_id IN (${marks(sessionIds)}) ORDER BY id DESC`, ...sessionIds)) {
    if (!map.has(String(r.session_id))) map.set(String(r.session_id), { outcome: String(r.outcome) as ReportOutcome, questions: strings(json(r.questions, [])).length });
  }
  return map;
}

/** Each session's reports, newest first. */
export async function reportsForSessions(sessionIds: string[]): Promise<Map<string, Report[]>> {
  const map = new Map<string, Report[]>();
  if (!sessionIds.length) return map;
  for (const rep of toReports(all(`${REPORTS} WHERE reports.session_id IN (${marks(sessionIds)}) ORDER BY reports.id DESC`, ...sessionIds))) {
    map.set(rep.sessionId, [...(map.get(rep.sessionId) ?? []), rep]);
  }
  return map;
}

export async function latestReport(taskId: number): Promise<Report | null> {
  return toReports(all(`${REPORTS} WHERE reports.task_id = ? ORDER BY reports.id DESC LIMIT 1`, taskId))[0] ?? null;
}

export async function latestSessionReport(sessionId: string): Promise<Report | null> {
  return toReports(all(`${REPORTS} WHERE reports.session_id = ? ORDER BY reports.id DESC LIMIT 1`, sessionId))[0] ?? null;
}

/**
 * Tasks whose latest hand-back was partial or blocked, with that outcome. What waits for them waits until the user
 * marks them done. The report has to come from the task's latest session: a later session that was marked finished,
 * or finished in the cloud, brings no report of its own, and moves the task on.
 */
export async function heldOutcomes(): Promise<Map<number, Exclude<ReportOutcome, "done">>> {
  const rows = all(
    `SELECT r.task_id, r.outcome FROM reports r
     WHERE r.id IN (SELECT MAX(id) FROM reports GROUP BY task_id) AND r.outcome != 'done'
       AND r.session_id = (SELECT s.id FROM sessions s WHERE s.task_id = r.task_id ORDER BY s.started_at DESC, s.id LIMIT 1)`,
  );
  return new Map(rows.map((r) => [Number(r.task_id), String(r.outcome) as Exclude<ReportOutcome, "done">]));
}

/* ---------- dependencies ---------- */

// The edges table was made for flows too: its mode and at_time columns stay at their defaults now.
const toEdge = (r: Row): Dependency => ({ id: Number(r.id), fromTaskId: Number(r.from_task_id), toTaskId: Number(r.to_task_id) });

export async function listEdges(): Promise<Dependency[]> {
  return all("SELECT id, from_task_id, to_task_id FROM edges ORDER BY id").map(toEdge);
}

/** Makes `toTaskId` wait for `fromTaskId`; the same dependency twice is one. */
export async function createEdge(fromTaskId: number, toTaskId: number): Promise<Dependency | null> {
  if (fromTaskId === toTaskId) return null;
  run("INSERT OR IGNORE INTO edges (from_task_id, to_task_id) VALUES (?, ?)", fromTaskId, toTaskId);
  const r = get("SELECT id, from_task_id, to_task_id FROM edges WHERE from_task_id = ? AND to_task_id = ?", fromTaskId, toTaskId);
  return r ? toEdge(r) : null;
}

export async function deleteEdge(id: number) {
  run("DELETE FROM edges WHERE id = ?", id);
}

/* ---------- settings ---------- */

export async function getSettings(): Promise<Settings> {
  const stored = Object.fromEntries(all("SELECT key, value FROM settings")
    .filter((r) => SETTING_KEYS.includes(r.key as keyof Settings)).map((r) => [String(r.key), json(r.value, null)]).filter(([, v]) => v !== null));
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function setSettings(patch: Partial<Settings>) {
  tx(() => {
    for (const key of SETTING_KEYS) {
      if (patch[key] === undefined) continue;
      run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, JSON.stringify(patch[key]));
    }
  });
}

/* ---------- preferences ---------- */

const preferenceRow = (id: number) => {
  const r = get("SELECT id, topic, text, source, updated_at FROM preferences WHERE id = ?", id);
  return r ? preferenceOf(r) : null;
};

export async function listPreferences(): Promise<Preference[]> {
  return all("SELECT id, topic, text, source, updated_at FROM preferences ORDER BY id").flatMap((r) => preferenceOf(r) ?? []).sort(byTopic);
}

export async function addPreference(input: PreferenceInput): Promise<Preference> {
  const r = run("INSERT INTO preferences (topic, text, source, updated_at) VALUES (?, ?, ?, ?)", input.topic, cleanPreference(input.text), input.source, nowStamp());
  return preferenceRow(Number(r.lastInsertRowid))!;
}

export async function updatePreference(id: number, patch: PreferencePatch): Promise<Preference | null> {
  const values: Record<string, Value> = { source: patch.source, updated_at: nowStamp() };
  if (patch.topic) values.topic = patch.topic;
  if (patch.text !== undefined) values.text = cleanPreference(patch.text);
  update("preferences", id, values);
  return preferenceRow(id);
}

export async function deletePreference(id: number): Promise<boolean> {
  return Number(run("DELETE FROM preferences WHERE id = ?", id).changes) > 0;
}

/* ---------- computers and requests: PacedMind Cloud's ---------- */

const CLOUD_ONLY = "Sign in to PacedMind Cloud to use PacedMind on more than one computer.";

/** What this computer found of the agents stays in memory (devices.ts); there's no list of computers to keep it in. */
export async function saveDeviceTools() {}

/**
 * Other computers: none, without an account. This one is thisDevice() in devices.ts (Settings and the Computers page show
 * it from there): the default by being the only one, named in this computer's settings.
 */
export async function listDevices(): Promise<Device[]> {
  return [];
}

export async function getDevice(): Promise<Device | null> {
  return null;
}

export async function registerDevice(): Promise<string> {
  throw new Error(CLOUD_ONLY);
}

export async function claimDevice() {
  throw new Error(CLOUD_ONLY);
}

export async function revokeDevice() {
  throw new Error(CLOUD_ONLY);
}

/** This computer's name is its own setting (device.ts), which renameDeviceAction changes; there's no list to rename it in. */
export async function renameDevice() {}

/** The only computer is the default already. */
export async function setDefaultDevice() {
  throw new Error(CLOUD_ONLY);
}

export async function updateDeviceRow() {}

/** Sessions asked for from another computer or the web app: there are none without an account. */
export async function listLaunchRequests(): Promise<LaunchRequest[]> {
  return [];
}

export async function createLaunchRequest(): Promise<LaunchRequest> {
  throw new Error(CLOUD_ONLY);
}

export async function settleLaunchRequest() {}

/** Folders asked of other computers: there are none without an account. */
export async function createFolderRequest(): Promise<FolderRequest> {
  throw new Error("Sign in to PacedMind Cloud to use your other computers.");
}

export async function listFolderRequests(): Promise<FolderRequest[]> {
  return [];
}

export async function settleFolderRequest() {}

/* ---------- what a running session waits for you to answer (asks.ts) ---------- */

// Without an account there's only this computer, so every answer comes from it and nothing comes from elsewhere.

const toAsk = (r: Row): SessionAsk => ({
  id: String(r.id), sessionId: String(r.session_id), deviceId: null, kind: r.kind === "permission" ? "permission" : "question",
  tool: r.tool == null ? null : String(r.tool), text: String(r.text), remoteOk: false, askedAt: String(r.asked_at),
  expiresAt: String(r.expires_at), status: String(r.status) as AskStatus, answer: r.answer == null ? null : String(r.answer),
  answeredAt: r.answered_at == null ? null : String(r.answered_at), answeredVia: r.status === "answered" ? "computer" : null,
});

export async function createAsk(input: AskInput): Promise<SessionAsk> {
  const id = crypto.randomUUID();
  run(
    "INSERT INTO session_asks (id, session_id, kind, tool, text, asked_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    id, input.sessionId, input.kind, input.tool, input.text, new Date().toISOString(), input.expiresAt,
  );
  return (await getAsk(id))!;
}

export async function getAsk(id: string): Promise<SessionAsk | null> {
  const r = get("SELECT * FROM session_asks WHERE id = ?", id);
  return r ? toAsk(r) : null;
}

export async function listAsks(filter: { sessionIds?: string[]; status?: AskStatus[] } = {}): Promise<SessionAsk[]> {
  if (filter.sessionIds && !filter.sessionIds.length) return [];
  const where: string[] = [];
  const args: string[] = [];
  if (filter.sessionIds) {
    where.push(`session_id IN (${marks(filter.sessionIds)})`);
    args.push(...filter.sessionIds);
  }
  if (filter.status) {
    where.push(`status IN (${marks(filter.status)})`);
    args.push(...filter.status);
  }
  return all(`SELECT * FROM session_asks${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY asked_at DESC LIMIT 200`, ...args).map(toAsk);
}

/** Answers an ask once, before the agent stops waiting. */
export async function answerAsk(id: string, answer: string): Promise<SessionAsk> {
  const now = new Date().toISOString();
  const r = run(
    "UPDATE session_asks SET status = 'answered', answer = ?, answered_at = ? WHERE id = ? AND status = 'pending' AND expires_at > ?",
    answer, now, id, now,
  );
  if (!Number(r.changes)) throw new Error("This was answered already, or the agent stopped waiting for it.");
  return (await getAsk(id))!;
}

export async function settleAsk(id: string, status: "expired" | "withdrawn") {
  run("UPDATE session_asks SET status = ? WHERE id = ? AND status = 'pending'", status, id);
}

/* ---------- web push: only with an account, whose web app gets the notifications ---------- */

export async function pushKeys(): Promise<{ publicKey: string; privateKey: string } | null> {
  return null;
}

export async function savePushKeys(keys: { publicKey: string; privateKey: string }): Promise<void> {
  void keys;
  throw new Error("Notifications on your phone and in the browser come with PacedMind Cloud.");
}

export async function listPushSubscriptions(): Promise<PushSubscriptionRow[]> {
  return [];
}

export async function addPushSubscription(sub: PushSubscriptionInput): Promise<void> {
  void sub;
  throw new Error("Notifications on your phone and in the browser come with PacedMind Cloud.");
}

export async function removePushSubscription(endpoint: string) {
  void endpoint;
}

/* ---------- agents signed in to PacedMind Cloud's MCP server ---------- */

/** Agents reach this computer's own data through its own MCP server, with its token: none sign in to the cloud. */
export async function listConnectedAgents(): Promise<ConnectedAgent[]> {
  return [];
}

export async function disconnectAgent(id: string): Promise<void> {
  void id;
  throw new Error("Agents sign in to PacedMind Cloud's MCP server with an account.");
}

/* ---------- live refresh ---------- */

/** A number that grows with every write to this computer's data (all of them go through this one connection). */
export async function stateVersion(): Promise<number> {
  return Number(get("SELECT total_changes() AS n")!.n);
}
