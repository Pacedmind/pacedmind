import "server-only";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { addDays, addMinutes } from "date-fns";
import { removeImageFiles } from "../attachments";
import {
  commandProblem, dataDir, deviceConfig, forgetAll, setProjectFolder, setTaskFolder, updateDevice,
} from "../device";
import { SETTING_KEYS } from "./shared";
import { EARLIER_PALETTE } from "@/lib/colors";
import { toDateStr, toStamp } from "@/lib/dates";
import type { TerminalId } from "@/lib/types";

/*
 * This computer's own data, for the free One device plan: without an account, PacedMind keeps everything in
 * a SQLite file next to its other data (node:sqlite). It is the file earlier versions used, so their data is
 * here as it was. Signing in to PacedMind Cloud switches to the account's data (cloud.ts), and Settings →
 * Data can copy this file's data into the account (account.ts).
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS areas (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, key TEXT NOT NULL UNIQUE, color TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0, icon TEXT,
  picture TEXT, repo TEXT
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, area_id TEXT NOT NULL REFERENCES areas(id), name TEXT NOT NULL,
  start_date TEXT, target_date TEXT, folder TEXT, agent TEXT, after_project_id TEXT,
  flow_on INTEGER NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0, color TEXT, device_id TEXT, codex_env TEXT, repo TEXT
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE,
  area_id TEXT REFERENCES areas(id), project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'todo',
  priority INTEGER NOT NULL DEFAULT 0, due_date TEXT, planned_date TEXT, planned_time TEXT, related_project_id TEXT, repeat TEXT, estimate_min INTEGER NOT NULL DEFAULT 60,
  labels TEXT NOT NULL DEFAULT '[]', reminder TEXT, agent TEXT, sort_order INTEGER NOT NULL DEFAULT 0,
  flow_x REAL, flow_y REAL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT,
  run_in TEXT, device_id TEXT, folder TEXT, done_when TEXT NOT NULL DEFAULT '[]', needs TEXT NOT NULL DEFAULT '[]', model_settings TEXT
);
CREATE TABLE IF NOT EXISTS subtasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  title TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, area_id TEXT REFERENCES areas(id),
  start_at TEXT NOT NULL, end_at TEXT NOT NULL, recurrence TEXT, done_on TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, agent TEXT NOT NULL,
  folder TEXT, branch TEXT, status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, ended_at TEXT,
  note TEXT, cli_session_id TEXT, continues_session_id TEXT,
  surface TEXT NOT NULL DEFAULT 'terminal', device_id TEXT, url TEXT, usage TEXT
);
CREATE TABLE IF NOT EXISTS session_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  at TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, outcome TEXT NOT NULL DEFAULT 'done', summary TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '', criteria TEXT NOT NULL DEFAULT '[]', verify TEXT NOT NULL DEFAULT '[]',
  questions TEXT NOT NULL DEFAULT '[]', links TEXT NOT NULL DEFAULT '[]', follow_ups TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL,
  changes TEXT, changes_at TEXT, diff TEXT
);
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE, report_id INTEGER REFERENCES reports(id) ON DELETE SET NULL,
  file TEXT NOT NULL, mime TEXT NOT NULL, bytes INTEGER NOT NULL, width INTEGER, height INTEGER,
  caption TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS session_asks (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, kind TEXT NOT NULL, tool TEXT,
  text TEXT NOT NULL, asked_at TEXT NOT NULL, expires_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', answer TEXT,
  answered_at TEXT
);
CREATE INDEX IF NOT EXISTS session_asks_session ON session_asks(session_id);
CREATE INDEX IF NOT EXISTS reports_task ON reports(task_id);
CREATE INDEX IF NOT EXISTS attachments_task ON attachments(task_id);
CREATE TABLE IF NOT EXISTS edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  to_task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'auto', at_time TEXT, UNIQUE(from_task_id, to_task_id)
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS preferences (
  id INTEGER PRIMARY KEY AUTOINCREMENT, topic TEXT NOT NULL, text TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'you', updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS task_note_requests (
  id TEXT PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  task_created_at TEXT NOT NULL, display_id TEXT NOT NULL, remember INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending', requested_at TEXT NOT NULL, expires_at TEXT NOT NULL, note TEXT
);
CREATE INDEX IF NOT EXISTS task_note_requests_pending ON task_note_requests(status, requested_at);
`;

type Row = Record<string, unknown>;

/** The file: where the desktop app points ORGANIZER_DB, else data/ in the project (`npm run dev`). */
export const localDbPath = () => process.env.ORGANIZER_DB ?? path.join(/*turbopackIgnore: true*/ dataDir(), "organizer.db");

const g = globalThis as unknown as { __pacedmindLocalDb?: DatabaseSync };

/** Per module instance, so a code reload in dev also runs new migrations on the cached connection. */
let migrated = false;

/** The open database, created (with the default areas, or the sample data in development) on first use. */
export function db(): DatabaseSync {
  if (!g.__pacedmindLocalDb) {
    const file = localDbPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const conn = new DatabaseSync(file);
    conn.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;");
    conn.exec(SCHEMA);
    if (!conn.prepare("SELECT value FROM meta WHERE key = 'seeded'").get()) {
      // The desktop app starts empty (just the default areas); development starts with sample data.
      seed(conn, process.env.ORGANIZER_SEED === "empty" ? "empty" : "sample");
      conn.prepare("INSERT INTO meta (key, value) VALUES ('seeded', ?)").run(toStamp(new Date()));
    }
    g.__pacedmindLocalDb = conn;
  }
  if (!migrated) {
    migrate(g.__pacedmindLocalDb);
    migrated = true;
  }
  return g.__pacedmindLocalDb;
}

export function tx<T>(fn: () => T): T {
  const conn = db();
  conn.exec("BEGIN");
  try {
    const out = fn();
    conn.exec("COMMIT");
    return out;
  } catch (e) {
    conn.exec("ROLLBACK");
    throw e;
  }
}

/** Adds tables and columns introduced after a database was first created. */
function migrate(conn: DatabaseSync) {
  // Again here, because in development a code reload keeps the open connection, which ran an older schema.
  conn.exec(SCHEMA);
  const added: Record<string, [string, string][]> = {
    areas: [["icon", "TEXT"], ["picture", "TEXT"], ["repo", "TEXT"]],
    projects: [["color", "TEXT"], ["device_id", "TEXT"], ["codex_env", "TEXT"], ["repo", "TEXT"]],
    tasks: [["run_in", "TEXT"], ["device_id", "TEXT"], ["folder", "TEXT"], ["done_when", "TEXT NOT NULL DEFAULT '[]'"], ["needs", "TEXT NOT NULL DEFAULT '[]'"], ["model_settings", "TEXT"], ["planned_time", "TEXT"], ["related_project_id", "TEXT"], ["repeat", "TEXT"]],
    sessions: [["surface", "TEXT NOT NULL DEFAULT 'terminal'"], ["device_id", "TEXT"], ["url", "TEXT"], ["usage", "TEXT"]],
    reports: [["changes", "TEXT"], ["changes_at", "TEXT"], ["diff", "TEXT"]],
    events: [["done_on", "TEXT NOT NULL DEFAULT '[]'"]],
  };
  for (const [table, columns] of Object.entries(added)) {
    const have = (conn.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    for (const [name, type] of columns) if (!have.includes(name)) conn.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }
  // Colors saved from the palette's earlier, paler values move to the ones they became (colors.ts), once.
  if (!conn.prepare("SELECT 1 FROM meta WHERE key = 'stronger-colors'").get()) {
    const areas = conn.prepare("UPDATE areas SET color = ? WHERE upper(color) = ?");
    const projects = conn.prepare("UPDATE projects SET color = ? WHERE upper(color) = ?");
    for (const [earlier, now] of Object.entries(EARLIER_PALETTE)) {
      areas.run(now, earlier);
      projects.run(now, earlier);
    }
    conn.prepare("INSERT INTO meta (key, value) VALUES ('stronger-colors', ?)").run(toStamp(new Date()));
  }
  adopt(conn);
}

const TERMINALS = new Set<string>(["wt", "cmd", "terminal", "iterm"]);
const SESSION_ID = /^[0-9a-f]{16}$/;

function parse(v: unknown): unknown {
  try {
    return JSON.parse(String(v));
  } catch {
    return null;
  }
}

/**
 * Once per file: what earlier versions kept in the database but this computer's settings keep now (device.ts,
 * encrypted in the desktop app), so they can't be changed through the data. That's how sessions start and
 * the MCP token, and project and task folders. Sessions also get ids of the length the launcher and the session
 * hooks expect.
 */
function adopt(conn: DatabaseSync) {
  if (conn.prepare("SELECT 1 FROM meta WHERE key = 'adopted'").get()) return;
  // A copy of the file as it was comes first, next to it, in case anything below goes wrong.
  const used = conn.prepare("SELECT (SELECT COUNT(*) FROM projects) + (SELECT COUNT(*) FROM tasks) AS n").get() as Row;
  if (Number(used.n) > 0) {
    const stamp = toStamp(new Date()).replace(/[-:]/g, "").replace("T", "-");
    conn.prepare("VACUUM INTO ?").run(path.join(path.dirname(localDbPath()), `organizer-before-upgrade-${stamp}.db`));
  }
  const old =Object.fromEntries((conn.prepare("SELECT key, value FROM settings").all() as Row[]).map((r) => [String(r.key), parse(r.value)]));
  // Only onto settings no account has taken over yet: those carry the account's own.
  if (deviceConfig().userId === null) {
    const token = typeof old.mcpToken === "string" && /^[A-Za-z0-9_-]{24,200}$/.test(old.mcpToken) ? old.mcpToken : null;
    updateDevice({
      ...(typeof old.terminal === "string" && TERMINALS.has(old.terminal) ? { terminal: old.terminal as TerminalId } : {}),
      ...(typeof old.claudeCommand === "string" && !commandProblem(old.claudeCommand) ? { claudeCommand: old.claudeCommand } : {}),
      ...(typeof old.codexCommand === "string" && !commandProblem(old.codexCommand) ? { codexCommand: old.codexCommand } : {}),
      ...(old.importOffered === true ? { importOffered: true } : {}),
      // Agents you connected keep working with the token they have.
      ...(token ? { ownerToken: token } : {}),
    });
  }

  const tasks = conn.prepare("SELECT id, folder FROM tasks").all() as Row[];
  for (const p of conn.prepare("SELECT id, folder FROM projects").all() as Row[]) {
    const folder = typeof p.folder === "string" ? p.folder.trim() : "";
    if (folder) setProjectFolder(String(p.id), folder);
  }
  for (const t of tasks) if (typeof t.folder === "string" && t.folder.trim()) setTaskFolder("local", Number(t.id), t.folder.trim());

  const renamed = (conn.prepare("SELECT id FROM sessions").all() as Row[]).map((r) => String(r.id)).filter((id) => !SESSION_ID.test(id));
  conn.exec("BEGIN");
  try {
    // Every reference to a session moves with it; the foreign keys are checked at COMMIT.
    conn.exec("PRAGMA defer_foreign_keys = ON");
    for (const id of renamed) {
      const next = crypto.randomBytes(8).toString("hex");
      for (const [table, column] of [["sessions", "id"], ["sessions", "continues_session_id"], ["session_events", "session_id"], ["reports", "session_id"], ["attachments", "session_id"]]) {
        conn.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`).run(next, id);
      }
    }
    conn.exec("UPDATE projects SET folder = NULL, flow_on = 0, device_id = NULL");
    conn.exec("UPDATE tasks SET folder = NULL, device_id = NULL");
    conn.exec("UPDATE sessions SET device_id = NULL");
    // What's left in settings is planning; the token and the commands went to this computer's settings.
    conn.prepare(`DELETE FROM settings WHERE key NOT IN (${SETTING_KEYS.map(() => "?").join(",")})`).run(...SETTING_KEYS);
    conn.prepare("INSERT INTO meta (key, value) VALUES ('adopted', ?)").run(toStamp(new Date()));
    conn.exec("COMMIT");
  } catch (e) {
    conn.exec("ROLLBACK");
    throw e;
  }
}

/** Starts this computer's data over, empty (the default areas) or with the sample data. */
export function resetLocal(mode: "sample" | "empty") {
  const conn = db();
  const files = (conn.prepare("SELECT file FROM attachments").all() as Row[]).map((r) => String(r.file));
  const projects = (conn.prepare("SELECT id FROM projects").all() as Row[]).map((r) => String(r.id));
  const areas = (conn.prepare("SELECT id FROM areas").all() as Row[]).map((r) => String(r.id));
  conn.exec("BEGIN");
  try {
    for (const t of ["session_asks", "attachments", "reports", "session_events", "sessions", "edges", "subtasks", "tasks", "events", "projects", "areas"]) {
      conn.exec(`DELETE FROM ${t}`);
    }
    conn.exec("DELETE FROM sqlite_sequence");
    seed(conn, mode);
    conn.exec("COMMIT");
  } catch (e) {
    conn.exec("ROLLBACK");
    throw e;
  }
  // Only this data's images: the account's, if you use Cloud here too, stay.
  removeImageFiles(files);
  forgetAll("local", projects, areas);
}

export const DEFAULT_AREAS = [
  { id: "work", name: "Work", key: "WRK", color: "#6A8DC3" },
  { id: "personal", name: "Personal", key: "PER", color: "#70B192" },
  { id: "health", name: "Health", key: "HLT", color: "#B97C97" },
  { id: "learning", name: "Learning", key: "LRN", color: "#9485C0" },
  { id: "dev", name: "Dev", key: "DEV", color: "#68AAB9" },
];

function seed(conn: DatabaseSync, mode: "sample" | "empty") {
  const insArea = conn.prepare("INSERT INTO areas (id, name, key, color, sort) VALUES (?, ?, ?, ?, ?)");
  DEFAULT_AREAS.forEach((a, i) => insArea.run(a.id, a.name, a.key, a.color, i));
  if (mode === "empty") return;

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const D = (offset: number, time?: string) => toDateStr(addDays(today, offset)) + (time ? `T${time}` : "");
  const stamp = toStamp(now);
  const ago = (min: number) => toStamp(addMinutes(now, -min));

  // No folders: sample sessions run in scratch folders, and folders are this computer's settings anyway.
  const insProject = conn.prepare(
    `INSERT INTO projects (id, area_id, name, start_date, target_date, agent, after_project_id, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const projects: [string, string, string, number, number, string | null, string | null][] = [
    ["organizer", "dev", "Organizer app", -3, 22, "claude", null],
    ["chessv2", "dev", "ChessV2", 25, 50, "codex", "organizer"],
    ["portfolio", "dev", "Portfolio site", 4, 43, "codex", null],
    ["q4", "work", "Q4 planning", -10, 7, null, null],
    ["move", "personal", "Apartment move", -3, 21, null, null],
    ["marathon", "health", "Half marathon", -40, 45, null, null],
    ["spanish", "learning", "Spanish B1", -30, 79, null, null],
  ];
  projects.forEach(([id, area, name, s, t, agent, after], i) => insProject.run(id, area, name, D(s), D(t), agent, after, i));

  const insTask = conn.prepare(
    `INSERT INTO tasks (key, area_id, project_id, title, description, status, priority, due_date, planned_date,
       estimate_min, labels, agent, sort_order, created_at, updated_at, completed_at, done_when)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insSub = conn.prepare("INSERT INTO subtasks (task_id, title, done, sort) VALUES (?, ?, ?, ?)");
  const ids: Record<string, number> = {};
  type Seed = {
    key: string; area: string; project?: string; title: string; desc?: string; status?: string; pr?: number;
    due?: string; planned?: string; est?: number; labels?: string[]; agent?: string; sort?: number;
    subs?: [string, boolean][]; doneWhen?: string[];
  };
  const tasks: Seed[] = [
    { key: "WRK-27", area: "work", project: "q4", title: "Review Q3 budget draft", status: "progress", pr: 3, due: D(-1), planned: D(-2), est: 90, labels: ["finance"],
      desc: "Check the travel and tooling lines against Q3 actuals before sending comments back.", subs: [["Travel line", true], ["Tooling line", false]] },
    { key: "WRK-31", area: "work", project: "q4", title: "Prepare slides for Q4 planning", status: "progress", pr: 1, due: D(0, "17:00"), planned: D(0), est: 180, labels: ["presentation"],
      desc: "Summarize Q3 results and propose three priorities for Q4. Keep it to ten slides.",
      subs: [["Collect Q3 numbers", true], ["Draft the outline", true], ["Build the charts", false], ["Rehearse once", false]] },
    { key: "WRK-33", area: "work", title: "Reply to design feedback", pr: 0, planned: D(0), est: 30, labels: ["email"],
      desc: "Short reply is fine. Agree on the spacing changes, push back on the new colors." },
    { key: "WRK-34", area: "work", title: "Send invoice to Acme", pr: 2, due: D(1, "10:00"), planned: D(1), est: 30, labels: ["finance"] },
    { key: "WRK-36", area: "work", project: "q4", title: "Send the Q4 plan to the team", pr: 2, due: D(7), est: 120 },
    { key: "PER-39", area: "personal", title: "Call insurance about the car claim", pr: 3, due: D(4), planned: D(0), est: 30, labels: ["car"],
      desc: "Have the claim number and the photos ready before calling." },
    { key: "PER-41", area: "personal", title: "Pay electricity bill", pr: 2, due: D(-2), planned: D(-2), est: 15, labels: ["bills"],
      desc: "The account number is on the last invoice in the Bills folder." },
    { key: "PER-42", area: "personal", title: "Renew car insurance", pr: 2, due: D(6), est: 30, labels: ["car"] },
    { key: "PER-44", area: "personal", project: "move", title: "Book movers for moving day", pr: 2, due: D(0), est: 60, labels: ["move"],
      desc: "Get two quotes first. A van and two people for the morning is enough.", subs: [["Ask for two quotes", false], ["Confirm the date", false]] },
    { key: "PER-45", area: "personal", project: "move", title: "Buy packing boxes", pr: 4, planned: D(2), est: 60 },
    { key: "PER-47", area: "personal", project: "move", title: "Pack the kitchen", pr: 3, planned: D(9), est: 120 },
    { key: "PER-48", area: "personal", title: "Donate old clothes", status: "backlog", pr: 0 },
    { key: "PER-50", area: "personal", title: "Fix the bike light", status: "backlog", pr: 4, est: 30 },
    { key: "HLT-9", area: "health", title: "Refill prescription", status: "done", pr: 3, due: D(0), labels: ["errand"] },
    { key: "HLT-11", area: "health", project: "marathon", title: "Research running shoes", status: "backlog", pr: 4, est: 45 },
    { key: "LRN-12", area: "learning", project: "spanish", title: "Finish Spanish unit 6 exercises", pr: 4, due: D(0), est: 60,
      desc: "Exercises 4 to 9, then go through the vocabulary list once." },
    { key: "LRN-14", area: "learning", project: "spanish", title: "Grammar book, chapter 3", pr: 4, est: 120 },
    { key: "DEV-18", area: "dev", project: "organizer", title: "Project scaffold: Next.js and SQLite", status: "done", pr: 2, agent: "claude", sort: 1 },
    { key: "DEV-19", area: "dev", project: "organizer", title: "Task list and detail views", status: "done", pr: 2, agent: "claude", sort: 2 },
    { key: "DEV-21", area: "dev", project: "organizer", title: "MCP server skeleton", status: "review", pr: 2, due: D(0), agent: "claude", sort: 3, labels: ["mcp"],
      desc: "Expose tasks, projects and time blocks over MCP so Claude Code and Codex can read and update them.",
      doneWhen: ["/api/mcp answers tools/list with the task tools", "Requests without the token get 401", "Claude Code can create a task through it"] },
    { key: "DEV-22", area: "dev", project: "organizer", title: "Start sessions from the app", pr: 2, agent: "claude", sort: 4,
      desc: "A Start button on a task opens a terminal with Claude Code or Codex working on it, in the project's folder.",
      doneWhen: ["Start in Claude Code opens a terminal in the project folder", "The session shows as running on the task", "A screenshot of the task panel with the running session"] },
    { key: "DEV-23", area: "dev", project: "organizer", title: "Session tracking over MCP", pr: 3, agent: "claude", sort: 5 },
    { key: "DEV-24", area: "dev", project: "organizer", title: "Auto-planner for time blocks", pr: 3, agent: "codex", sort: 6 },
    { key: "DEV-25", area: "dev", project: "organizer", title: "Desktop build with Electron", pr: 3, agent: "claude", sort: 7 },
    { key: "DEV-26", area: "dev", project: "organizer", title: "Settings screen", status: "backlog", pr: 4, agent: "claude", sort: 8 },
    { key: "DEV-40", area: "dev", project: "portfolio", title: "Portfolio navigation redesign", status: "done", pr: 3, agent: "codex", sort: 1 },
    { key: "DEV-41", area: "dev", project: "portfolio", title: "Case study page layout", pr: 3, agent: "codex", sort: 2 },
    { key: "DEV-42", area: "dev", project: "portfolio", title: "Contact form with spam check", pr: 4, agent: "codex", sort: 3 },
  ];
  for (const t of tasks) {
    const done = t.status === "done";
    const r = insTask.run(
      t.key, t.area, t.project ?? null, t.title, t.desc ?? "", t.status ?? "todo", t.pr ?? 0, t.due ?? null, t.planned ?? null,
      t.est ?? 60, JSON.stringify(t.labels ?? []), t.agent ?? null, t.sort ?? 0,
      ago(60 * 24 * 3), stamp, done ? ago(90) : null, JSON.stringify(t.doneWhen ?? []),
    );
    ids[t.key] = Number(r.lastInsertRowid);
    (t.subs ?? []).forEach(([title, d], i) => insSub.run(ids[t.key], title, d ? 1 : 0, i));
  }

  // Dependencies: the task on the right waits for the one on the left.
  const insEdge = conn.prepare("INSERT INTO edges (from_task_id, to_task_id) VALUES (?, ?)");
  const edges: [string, string][] = [
    ["DEV-18", "DEV-19"], ["DEV-19", "DEV-21"], ["DEV-21", "DEV-22"], ["DEV-21", "DEV-24"], ["DEV-22", "DEV-23"], ["DEV-23", "DEV-25"], ["DEV-24", "DEV-25"],
  ];
  edges.forEach(([a, b]) => insEdge.run(ids[a], ids[b]));

  const insEvent = conn.prepare("INSERT INTO events (title, area_id, start_at, end_at, recurrence) VALUES (?, ?, ?, ?, ?)");
  const monday = addDays(today, -((today.getDay() + 6) % 7));
  const W = (weekday: number, time: string) => toDateStr(addDays(monday, weekday)) + `T${time}`;
  const events: [string, string, string, string, string | null][] = [
    ["Gym", "health", W(0, "07:30"), W(0, "08:30"), "weekly"],
    ["Gym", "health", W(3, "07:30"), W(3, "08:30"), "weekly"],
    ["Spanish class", "learning", W(2, "19:00"), W(2, "20:30"), "weekly"],
    ["Climbing with Tomek", "health", W(4, "18:00"), W(4, "20:00"), "weekly"],
    ["Long run", "health", W(5, "08:00"), W(5, "09:30"), "weekly"],
    ["Lunch with Marta", "personal", D(0, "12:30"), D(0, "13:30"), null],
    ["Q4 planning review", "work", D(0, "17:30"), D(0, "18:30"), null],
    ["Dentist", "health", D(8, "09:00"), D(8, "10:00"), null],
  ];
  events.forEach((e) => insEvent.run(...e));

  const sid = () => crypto.randomBytes(8).toString("hex");
  const [s18, s19, s21] = [sid(), sid(), sid()];
  const insSession = conn.prepare(
    `INSERT INTO sessions (id, task_id, agent, folder, branch, status, started_at, finished_at, ended_at, note)
     VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
  );
  const insEv = conn.prepare("INSERT INTO session_events (session_id, at, kind, text) VALUES (?, ?, ?, ?)");
  insSession.run(s18, ids["DEV-18"], "claude", "agent/dev-18", "done", ago(60 * 72), ago(60 * 71), ago(60 * 70), "Scaffold ready.");
  insSession.run(s19, ids["DEV-19"], "claude", "agent/dev-19", "done", ago(240), ago(190), ago(180), "List and detail views work.");
  insSession.run(s21, ids["DEV-21"], "claude", "agent/dev-21", "finished", ago(50), ago(12), null, "MCP endpoint added at /api/mcp. Tests pass.");
  insEv.run(s21, ago(50), "started", "Session started in a new terminal");
  insEv.run(s21, ago(49), "picked_up", "Claude read the task over MCP");
  insEv.run(s21, ago(12), "finished", "MCP endpoint added at /api/mcp. Tests pass.");
  conn.prepare(
    `INSERT INTO reports (session_id, task_id, outcome, summary, details, criteria, verify, questions, links, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    s21, ids["DEV-21"], "done", "MCP endpoint added at /api/mcp. Tests pass.",
    "- `src/app/api/mcp/route.ts` serves the MCP server with **mcp-handler**.\n- Tools for tasks, projects and time blocks live in `src/server/mcp/`.\n- Every request needs the bearer token from Settings.",
    JSON.stringify([
      { text: "/api/mcp answers tools/list with the task tools", verdict: "met", note: "12 tools listed." },
      { text: "Requests without the token get 401", verdict: "met", note: "" },
      { text: "Claude Code can create a task through it", verdict: "partly", note: "Tried with the MCP inspector, not with Claude Code yet." },
    ]),
    JSON.stringify(["Run npm run dev", "Open Settings → MCP server and copy the connect command", "Ask Claude Code to list your tasks"]),
    JSON.stringify(["Should agents be allowed to delete tasks without asking?"]),
    "[]", ago(12),
  );

  // How the user likes to work (Settings → How you work), which agents read before they plan or write tasks.
  const insPreference = conn.prepare("INSERT INTO preferences (topic, text, source, updated_at) VALUES (?, ?, ?, ?)");
  const preferences: [string, string, "you" | "agent"][] = [
    ["Time and schedule", "Deep work in the mornings; calls and meetings after 13:00", "you"],
    ["Time and schedule", "Keep Friday afternoons free of new work", "agent"],
    ["Dates and deadlines", "Plan work two days before its deadline", "you"],
    ["Writing tasks", "Titles start with a verb, and every agent task gets Done when items", "agent"],
    ["Agents and sessions", "Codex takes the refactors and tests, Claude Code the UI work", "you"],
  ];
  preferences.forEach(([topic, text, source]) => insPreference.run(topic, text, source, stamp));
}
