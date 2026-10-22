import "server-only";
import { modelSelectionOf } from "@/lib/agent-models";
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { addDays, addMinutes } from "date-fns";
import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import { requirePlannerAccess, supabase } from "./supabase";
import { attachmentPath, removeImageFiles } from "./attachments";
import {
  areaFolder, commandProblem, deviceConfig, forgetAll, projectFolder, projectServers, setAreaFolder, setProjectFolder, setProjectServers, setTaskFolder,
  taskFolder, updateDevice,
} from "./device";
import { CODEX_ENV, cleanDoneWhen, repoOf } from "./repo";
import { db as localDb, localDbPath } from "./store/local-db";
import { SETTING_KEYS, areaPictureOf, cleanPreference, cleanTopic, deriveKey, diffOf, doneDaysOf, usageOf } from "./store/shared";
import { areaIconOf } from "@/lib/area-icons";
import { CloudReadOnly } from "@/lib/billing";
import { PALETTE, renewColor } from "@/lib/colors";
import { nowStamp, toDateStr, toStamp } from "@/lib/dates";
import { cleanNeeds } from "@/lib/needs";
import { MAX_PREFERENCES, repeatOf, type CopyReason, type DataCopy, type DataSummary } from "@/lib/types";

/*
 * An account's data as a whole: starting over (after keeping a copy, which can be put back), sample data, moving over this computer's own data (what
 * PacedMind keeps without an account, store/local-db.ts), and moving the account's data back to this computer.
 */

type Row = Record<string, unknown>;

function check<T>(res: { data: T; error: PostgrestError | null }): T {
  if (res.error) throw res.error.code === "PT402" ? new CloudReadOnly() : new Error(res.error.message);
  return res.data;
}

/** The areas every account starts with. The database trigger for new accounts (supabase/migrations) makes the same ones. */
export const DEFAULT_AREAS = [
  { name: "Work", key: "WRK", color: "#6A8DC3" },
  { name: "Personal", key: "PER", color: "#70B192" },
  { name: "Health", key: "HLT", color: "#B97C97" },
  { name: "Learning", key: "LRN", color: "#9485C0" },
  { name: "Dev", key: "DEV", color: "#68AAB9" },
];

/**
 * Deletes the account's areas, projects, tasks (with their sessions, reports and connections) and events. Settings stay.
 * `kept`: a copy of them stays in the account, so this computer keeps their images and folders for putting it back.
 */
async function clearAccount(db: SupabaseClient, kept = false) {
  const { id } = (await requirePlannerAccess()).user;
  // Otherwise the images this computer keeps for the account's tasks go with them, and so do its folders.
  const device = deviceConfig().deviceId;
  const files = device && !kept ? (check(await db.from("attachments").select("file").eq("device_id", device)) as Row[]).map((r) => String(r.file)) : [];
  const projects = (check(await db.from("projects").select("id")) as Row[]).map((r) => String(r.id));
  const areas = (check(await db.from("areas").select("id")) as Row[]).map((r) => String(r.id));
  // Deleting tasks takes their sub-tasks, sessions, reports, images and connections along; areas take their projects.
  for (const table of ["tasks", "events", "projects", "areas", "key_counters"]) {
    check(await db.from(table).delete().eq("user_id", id));
  }
  if (kept) return;
  removeImageFiles(files);
  forgetAll("cloud", projects, areas);
}

/**
 * Starts the account over with the default areas, and optionally the sample data. A copy of what was there stays in
 * the account first (save_account_copy), which Settings → Data can put back; without it nothing is deleted.
 */
export async function resetAccount(mode: "sample" | "empty") {
  const db = await supabase();
  check(await db.rpc("save_account_copy", { reason: mode }));
  await clearAccount(db, true);
  const areas = check(await db.from("areas").insert(DEFAULT_AREAS.map((a, i) => ({ ...a, sort: i }))).select("id, key")) as Row[];
  if (mode === "sample") await seedSample(db, new Map(areas.map((a) => [String(a.key), String(a.id)])));
}

/* ---------- copies kept before starting over ---------- */

const COPY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The copies the account keeps of its data (account_copies), newest first. */
export async function accountCopies(): Promise<DataCopy[]> {
  const db = await supabase();
  const rows = check(await db.from("account_copies").select("id, created_at, reason, areas, projects, tasks, events")
    .order("created_at", { ascending: false })) as Row[];
  return rows.map((r) => ({
    id: String(r.id), at: toStamp(new Date(String(r.created_at))), reason: String(r.reason) as CopyReason,
    areas: Number(r.areas), projects: Number(r.projects), tasks: Number(r.tasks), events: Number(r.events),
  }));
}

/**
 * Puts a copy back in place of the account's data, with its ids and keys (restore_account_copy, one transaction); what's
 * there now becomes a copy first. This computer kept the copy's images and folders, so they come back with it.
 */
export async function restoreAccountCopy(id: string) {
  if (!COPY_ID.test(id)) throw new Error("That copy isn't there any more.");
  const db = await supabase();
  check(await db.rpc("restore_account_copy", { copy_id: id }));
}

export async function deleteAccountCopy(id: string) {
  if (!COPY_ID.test(id)) throw new Error("That copy isn't there any more.");
  const db = await supabase();
  check(await db.from("account_copies").delete().eq("id", id));
}

/** How much the account holds. */
export async function accountSummary(): Promise<DataSummary> {
  const db = await supabase();
  const count = async (table: string) => {
    const r = await db.from(table).select("id", { count: "exact", head: true });
    if (r.error) throw new Error(r.error.message);
    return r.count ?? 0;
  };
  const [areas, projects, tasks, events] = await Promise.all([count("areas"), count("projects"), count("tasks"), count("events")]);
  return { areas, projects, tasks, events };
}

/* ---------- sample data ---------- */

async function seedSample(db: SupabaseClient, areaId: Map<string, string>) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const D = (offset: number, time?: string) => toDateStr(addDays(today, offset)) + (time ? `T${time}` : "");
  const stamp = toStamp(now);
  const ago = (min: number) => toStamp(addMinutes(now, -min));

  // No folders: sample sessions run in scratch folders, and folders belong to each computer anyway.
  const projectRows: [string, string, number, number, string | null][] = [
    ["Organizer app", "DEV", -3, 22, "claude"],
    ["ChessV2", "DEV", 25, 50, "codex"],
    ["Portfolio site", "DEV", 4, 43, "codex"],
    ["Q4 planning", "WRK", -10, 7, null],
    ["Apartment move", "PER", -3, 21, null],
    ["Half marathon", "HLT", -40, 45, null],
    ["Spanish B1", "LRN", -30, 79, null],
  ];
  const projects = check(await db.from("projects").insert(projectRows.map(([name, area, s, t, agent], i) => ({
    name, area_id: areaId.get(area), start_date: D(s), target_date: D(t), agent, sort: i,
  }))).select("id, name")) as Row[];
  const project = new Map(projects.map((p) => [String(p.name), String(p.id)]));
  check(await db.from("projects").update({ after_project_id: project.get("Organizer app") }).eq("id", project.get("ChessV2")!));

  type Seed = {
    key: string; area: string; project?: string; title: string; desc?: string; status?: string; pr?: number;
    due?: string; planned?: string; est?: number; labels?: string[]; agent?: string; sort?: number;
    subs?: [string, boolean][];
  };
  const tasks: Seed[] = [
    { key: "WRK-27", area: "WRK", project: "Q4 planning", title: "Review Q3 budget draft", status: "progress", pr: 3, due: D(-1), planned: D(-2), est: 90, labels: ["finance"],
      desc: "Check the travel and tooling lines against Q3 actuals before sending comments back.", subs: [["Travel line", true], ["Tooling line", false]] },
    { key: "WRK-31", area: "WRK", project: "Q4 planning", title: "Prepare slides for Q4 planning", status: "progress", pr: 1, due: D(0, "17:00"), planned: D(0), est: 180, labels: ["presentation"],
      desc: "Summarize Q3 results and propose three priorities for Q4. Keep it to ten slides.",
      subs: [["Collect Q3 numbers", true], ["Draft the outline", true], ["Build the charts", false], ["Rehearse once", false]] },
    { key: "WRK-33", area: "WRK", title: "Reply to design feedback", pr: 0, planned: D(0), est: 30, labels: ["email"],
      desc: "Short reply is fine. Agree on the spacing changes, push back on the new colors." },
    { key: "WRK-34", area: "WRK", title: "Send invoice to Acme", pr: 2, due: D(1, "10:00"), planned: D(1), est: 30, labels: ["finance"] },
    { key: "WRK-36", area: "WRK", project: "Q4 planning", title: "Send the Q4 plan to the team", pr: 2, due: D(7), est: 120 },
    { key: "PER-39", area: "PER", title: "Call insurance about the car claim", pr: 3, due: D(4), planned: D(0), est: 30, labels: ["car"],
      desc: "Have the claim number and the photos ready before calling." },
    { key: "PER-41", area: "PER", title: "Pay electricity bill", pr: 2, due: D(-2), planned: D(-2), est: 15, labels: ["bills"],
      desc: "The account number is on the last invoice in the Bills folder." },
    { key: "PER-42", area: "PER", title: "Renew car insurance", pr: 2, due: D(6), est: 30, labels: ["car"] },
    { key: "PER-44", area: "PER", project: "Apartment move", title: "Book movers for moving day", pr: 2, due: D(0), est: 60, labels: ["move"],
      desc: "Get two quotes first. A van and two people for the morning is enough.", subs: [["Ask for two quotes", false], ["Confirm the date", false]] },
    { key: "PER-45", area: "PER", project: "Apartment move", title: "Buy packing boxes", pr: 4, planned: D(2), est: 60 },
    { key: "PER-47", area: "PER", project: "Apartment move", title: "Pack the kitchen", pr: 3, planned: D(9), est: 120 },
    { key: "PER-48", area: "PER", title: "Donate old clothes", status: "backlog", pr: 0 },
    { key: "PER-50", area: "PER", title: "Fix the bike light", status: "backlog", pr: 4, est: 30 },
    { key: "HLT-9", area: "HLT", title: "Refill prescription", status: "done", pr: 3, due: D(0), labels: ["errand"] },
    { key: "HLT-11", area: "HLT", project: "Half marathon", title: "Research running shoes", status: "backlog", pr: 4, est: 45 },
    { key: "LRN-12", area: "LRN", project: "Spanish B1", title: "Finish Spanish unit 6 exercises", pr: 4, due: D(0), est: 60,
      desc: "Exercises 4 to 9, then go through the vocabulary list once." },
    { key: "LRN-14", area: "LRN", project: "Spanish B1", title: "Grammar book, chapter 3", pr: 4, est: 120 },
    { key: "DEV-18", area: "DEV", project: "Organizer app", title: "Project scaffold: Next.js and SQLite", status: "done", pr: 2, agent: "claude", sort: 1 },
    { key: "DEV-19", area: "DEV", project: "Organizer app", title: "Task list and detail views", status: "done", pr: 2, agent: "claude", sort: 2 },
    { key: "DEV-21", area: "DEV", project: "Organizer app", title: "MCP server skeleton", status: "review", pr: 2, due: D(0), agent: "claude", sort: 3, labels: ["mcp"],
      desc: "Expose tasks, projects and time blocks over MCP so Claude Code and Codex can read and update them." },
    { key: "DEV-22", area: "DEV", project: "Organizer app", title: "Start sessions from the app", pr: 2, agent: "claude", sort: 4 },
    { key: "DEV-23", area: "DEV", project: "Organizer app", title: "Session tracking over MCP", pr: 3, agent: "claude", sort: 5 },
    { key: "DEV-24", area: "DEV", project: "Organizer app", title: "Auto-planner for time blocks", pr: 3, agent: "codex", sort: 6 },
    { key: "DEV-25", area: "DEV", project: "Organizer app", title: "Desktop build with Electron", pr: 3, agent: "claude", sort: 7 },
    { key: "DEV-26", area: "DEV", project: "Organizer app", title: "Settings screen", status: "backlog", pr: 4, agent: "claude", sort: 8 },
    { key: "DEV-40", area: "DEV", project: "Portfolio site", title: "Portfolio navigation redesign", status: "done", pr: 3, agent: "codex", sort: 1 },
    { key: "DEV-41", area: "DEV", project: "Portfolio site", title: "Case study page layout", pr: 3, agent: "codex", sort: 2 },
    { key: "DEV-42", area: "DEV", project: "Portfolio site", title: "Contact form with spam check", pr: 4, agent: "codex", sort: 3 },
  ];
  const inserted = check(await db.from("tasks").insert(tasks.map((t) => ({
    key: t.key, area_id: areaId.get(t.area), project_id: t.project ? project.get(t.project) : null, title: t.title, description: t.desc ?? "",
    status: t.status ?? "todo", priority: t.pr ?? 0, due_date: t.due ?? null, planned_date: t.planned ?? null, estimate_min: t.est ?? 60,
    labels: t.labels ?? [], agent: t.agent ?? null, sort_order: t.sort ?? 0,
    created_at: ago(60 * 24 * 3), updated_at: stamp, completed_at: t.status === "done" ? ago(90) : null,
  }))).select("id, key")) as Row[];
  const id = new Map(inserted.map((t) => [String(t.key), Number(t.id)]));

  const subtasks = tasks.flatMap((t) => (t.subs ?? []).map(([title, done], i) => ({ task_id: id.get(t.key), title, done, sort: i })));
  check(await db.from("subtasks").insert(subtasks));

  // Dependencies: the task on the right waits for the one on the left.
  const edges: [string, string][] = [
    ["DEV-18", "DEV-19"], ["DEV-19", "DEV-21"], ["DEV-21", "DEV-22"], ["DEV-21", "DEV-24"], ["DEV-22", "DEV-23"], ["DEV-23", "DEV-25"], ["DEV-24", "DEV-25"],
  ];
  check(await db.from("edges").insert(edges.map(([a, b]) => ({ from_task_id: id.get(a), to_task_id: id.get(b) }))));

  const monday = addDays(today, -((today.getDay() + 6) % 7));
  const W = (weekday: number, time: string) => toDateStr(addDays(monday, weekday)) + `T${time}`;
  const events: [string, string, string, string, string | null][] = [
    ["Gym", "HLT", W(0, "07:30"), W(0, "08:30"), "weekly"],
    ["Gym", "HLT", W(3, "07:30"), W(3, "08:30"), "weekly"],
    ["Spanish class", "LRN", W(2, "19:00"), W(2, "20:30"), "weekly"],
    ["Climbing with Tomek", "HLT", W(4, "18:00"), W(4, "20:00"), "weekly"],
    ["Long run", "HLT", W(5, "08:00"), W(5, "09:30"), "weekly"],
    ["Lunch with Marta", "PER", D(0, "12:30"), D(0, "13:30"), null],
    ["Q4 planning review", "WRK", D(0, "17:30"), D(0, "18:30"), null],
    ["Dentist", "HLT", D(8, "09:00"), D(8, "10:00"), null],
  ];
  check(await db.from("events").insert(events.map(([title, area, start, end, recurrence]) => ({
    title, area_id: areaId.get(area), start_at: start, end_at: end, recurrence,
  }))));

  const sid = () => crypto.randomBytes(8).toString("hex");
  const [s18, s19, s21] = [sid(), sid(), sid()];
  const folder = null;
  check(await db.from("sessions").insert([
    { id: s18, task_id: id.get("DEV-18"), agent: "claude", folder, branch: "agent/dev-18", status: "done", started_at: ago(60 * 72), finished_at: ago(60 * 71), ended_at: ago(60 * 70), note: "Scaffold ready." },
    { id: s19, task_id: id.get("DEV-19"), agent: "claude", folder, branch: "agent/dev-19", status: "done", started_at: ago(240), finished_at: ago(190), ended_at: ago(180), note: "List and detail views work." },
    { id: s21, task_id: id.get("DEV-21"), agent: "claude", folder, branch: "agent/dev-21", status: "finished", started_at: ago(50), finished_at: ago(12), ended_at: null, note: "MCP endpoint added at /api/mcp. Tests pass." },
  ]));
  check(await db.from("session_events").insert([
    { session_id: s21, at: ago(50), kind: "started", text: "Session started in a new terminal" },
    { session_id: s21, at: ago(49), kind: "picked_up", text: "Claude read the task over MCP" },
    { session_id: s21, at: ago(12), kind: "finished", text: "MCP endpoint added at /api/mcp. Tests pass." },
  ]));
}

/* ---------- this computer's own data ---------- */

/** What this computer's own data holds (the free plan's, or an earlier version's), or null when there is none. */
export async function legacySummary(): Promise<{ file: string; areas: number; projects: number; tasks: number } | null> {
  const file = localDbPath();
  // The user's data file, not part of the app: keep build tracing out of it.
  if (!fs.existsSync(/*turbopackIgnore: true*/ file)) return null;
  const { DatabaseSync } = await import("node:sqlite");
  const conn = new DatabaseSync(file, { readOnly: true });
  try {
    const count = (table: string) => Number((conn.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as Row).n);
    return { file, areas: count("areas"), projects: count("projects"), tasks: count("tasks") };
  } catch {
    return null;
  } finally {
    conn.close();
  }
}

/**
 * Copies this computer's own data into the signed-in account. Only into an account without projects or
 * tasks: its default areas are replaced by the local ones. Task keys, dates, sessions and their reports come
 * along, and the images agents attached stay in this computer's data folder. Project and task folders stay this
 * computer's settings (device.ts) and move to the copies. The data itself stays here too.
 */
export async function importLegacy(): Promise<{ areas: number; projects: number; tasks: number }> {
  const db = await supabase();
  const { id: userId } = (await requirePlannerAccess()).user;
  const busy = check(await db.from("tasks").select("id").limit(1)) as Row[];
  const projectsNow = check(await db.from("projects").select("id").limit(1)) as Row[];
  if (busy.length || projectsNow.length) throw new Error("Your account already has projects or tasks. Importing works on an empty account.");

  const file = localDbPath();
  if (!fs.existsSync(/*turbopackIgnore: true*/ file)) throw new Error("There is no local PacedMind data on this computer.");
  const { DatabaseSync } = await import("node:sqlite");
  const conn = new DatabaseSync(file, { readOnly: true });
  const all = (sql: string) => conn.prepare(sql).all() as Row[];
  // Tables later versions of the local app added (reports and their images) may not be there.
  const has = (table: string) => all(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${table}'`).length > 0;
  try {
    const areas = all("SELECT * FROM areas ORDER BY sort");
    const projects = all("SELECT * FROM projects ORDER BY sort");
    const tasks = all("SELECT * FROM tasks ORDER BY id");
    const subtasks = all("SELECT * FROM subtasks ORDER BY id");
    const events = all("SELECT * FROM events ORDER BY id");
    const sessions = all("SELECT * FROM sessions ORDER BY started_at");
    const sessionEvents = all("SELECT * FROM session_events ORDER BY id");
    const edges = all("SELECT * FROM edges ORDER BY id");
    const reports = has("reports") ? all("SELECT * FROM reports ORDER BY id") : [];
    const attachments = has("attachments") ? all("SELECT * FROM attachments ORDER BY created_at") : [];
    const settings = all("SELECT key, value FROM settings");
    const preferences = has("preferences") ? all("SELECT topic, text, source, updated_at FROM preferences ORDER BY id") : [];

    await clearAccount(db);
    // The local database never checked what it kept: every value is held to what the cloud accepts, so one odd
    // row can't stop the move halfway.
    const s = (v: unknown) => (v == null ? null : String(v));
    const clip = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);
    const match = (v: unknown, re: RegExp) => (typeof v === "string" && re.test(v) ? v : null);
    // An older file may still have the palette's earlier colors.
    const renewOptional = (color: string | null) => (color ? renewColor(color) : null);
    const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): T | null => (allowed.includes(v as T) ? (v as T) : null);
    const int = (v: unknown, min: number, max: number, fallback: number) => {
      const x = Math.round(Number(v));
      return Number.isFinite(x) ? Math.min(max, Math.max(min, x)) : fallback;
    };
    const num = (v: unknown) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
    const jsonList = (v: unknown): unknown[] => {
      try {
        const x = JSON.parse(String(v ?? "[]"));
        return Array.isArray(x) ? x : [];
      } catch {
        return [];
      }
    };
    const texts = (v: unknown, max: number) => jsonList(v).filter((x): x is string => typeof x === "string").map((x) => x.slice(0, max)).slice(0, 50);
    const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
    const MINUTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
    const DAY = /^\d{4}-\d{2}-\d{2}$/;
    const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
    const COLOR = /^#[0-9A-Fa-f]{6}$/;
    const now = nowStamp();
    const SURFACES = ["terminal", "desktop", "cloud"] as const;
    // The local database only knew this computer: a project or task that ran on a chosen computer runs here.
    const here = deviceConfig().deviceId;

    // Areas keep their keys, so tasks keep theirs; a key the cloud can't take gets a new one.
    const keys = new Set<string>();
    const areaRows = areas.map((a) => {
      let key = String(a.key ?? "").toUpperCase();
      if (!/^[A-Z][A-Z0-9]{1,7}$/.test(key) || keys.has(key)) key = deriveKey(String(a.name ?? ""), keys);
      keys.add(key);
      const icon = areaIconOf(a.icon);
      const picture = areaPictureOf(a.picture);
      return {
        old: String(a.id),
        row: {
          name: clip(a.name, 80) || "Area", key, color: renewColor(match(a.color, COLOR) ?? PALETTE[0].value),
          ...(picture ? { picture } : icon ? { icon } : {}), sort: int(a.sort, -1e6, 1e6, 0), repo: repoOf(a.repo),
        },
      };
    });
    const newAreas = check(await db.from("areas").insert(areaRows.map((a) => a.row)).select("id, key")) as Row[];
    const areaByKey = new Map(newAreas.map((a) => [String(a.key), String(a.id)]));
    const areaIds = new Map(areaRows.map((a) => [a.old, areaByKey.get(a.row.key) ?? null]));
    const areaId = (old: unknown) => (old == null ? null : areaIds.get(String(old)) ?? null);
    for (const [old, id] of areaIds) {
      const folder = areaFolder(old);
      if (id && folder) setAreaFolder(id, folder);
    }

    const projectId = new Map<string, string>();
    for (const p of projects) {
      const area = areaId(p.area_id);
      if (!area) continue;
      const env = typeof p.codex_env === "string" ? p.codex_env.trim() : "";
      const r = check(await db.from("projects").insert({
        area_id: area, name: clip(p.name, 120) || "Project", color: renewOptional(match(p.color, COLOR)), start_date: match(p.start_date, DAY),
        hidden: p.hidden === 1,
        target_date: match(p.target_date, DAY), agent: oneOf(p.agent, ["claude", "codex"]), sort: int(p.sort, -1e6, 1e6, 0),
        codex_env: CODEX_ENV.test(env) ? env : null, device_id: p.device_id ? here : null, ...(repoOf(p.repo) ? { repo: repoOf(p.repo) } : {}),
      }).select("id").single()) as Row;
      projectId.set(String(p.id), String(r.id));
      // The folder belonged to this computer all along; it stays here, not in the cloud. An earlier version kept it
      // in its database, this one in this computer's settings.
      const folder = (typeof p.folder === "string" && p.folder.trim()) || projectFolder(String(p.id));
      if (folder) setProjectFolder(String(r.id), folder);
      const servers = projectServers(String(p.id));
      if (servers) setProjectServers(String(r.id), servers);
    }
    for (const p of projects.filter((x) => x.after_project_id != null)) {
      const after = projectId.get(String(p.after_project_id));
      const self = projectId.get(String(p.id));
      if (after && self && after !== self) check(await db.from("projects").update({ after_project_id: after }).eq("id", self));
    }

    const labelsOf = (v: unknown) => {
      const out: string[] = [];
      let size = 0;
      for (const l of texts(v, 100)) {
        if (size + l.length > 2000) break;
        out.push(l);
        size += l.length;
      }
      return out;
    };
    const taskRow = (t: Row, key: string) => {
      let modelSettings = null;
      try { modelSettings = modelSelectionOf(JSON.parse(String(t.model_settings ?? "null"))); } catch { /* Older local data. */ }
      return {
        key, area_id: areaId(t.area_id), project_id: t.project_id == null ? null : projectId.get(String(t.project_id)) ?? null,
        title: clip(t.title, 500) || "Untitled", description: String(t.description ?? "").slice(0, 100000),
        status: oneOf(t.status, ["backlog", "todo", "progress", "review", "done", "canceled"]) ?? "todo", priority: int(t.priority, 0, 4, 0),
        due_date: match(t.due_date, /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/), planned_date: match(t.planned_date, DAY),
        planned_time: match(t.planned_date, DAY) ? match(t.planned_time, TIME) : null,
        related_project_id: t.related_project_id == null ? null : projectId.get(String(t.related_project_id)) ?? null,
        repeat: repeatOf(t.repeat),
        estimate_min: int(t.estimate_min, 0, 10080, 60), labels: labelsOf(t.labels),
        reminder: match(t.reminder, /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/), agent: oneOf(t.agent, ["claude", "codex", "human"]),
        sort_order: int(t.sort_order, -1e9, 1e9, 0),
        created_at: match(t.created_at, STAMP) ?? now, updated_at: match(t.updated_at, STAMP) ?? now, completed_at: match(t.completed_at, STAMP),
        done_when: cleanDoneWhen(texts(t.done_when, 400)), needs: cleanNeeds(texts(t.needs, 48)), run_in: oneOf(t.run_in, SURFACES),
        device_id: t.device_id || modelSettings ? here : null,
        model_settings: modelSettings,
      };
    };
    const KEY = /^[A-Z][A-Z0-9]{1,7}-[1-9][0-9]{0,8}$/;
    const seen = new Set<string>();
    const keyed: Row[] = [];
    const unkeyed: Row[] = [];
    for (const t of tasks) {
      const key = String(t.key ?? "").toUpperCase();
      if (KEY.test(key) && !seen.has(key)) {
        seen.add(key);
        keyed.push(t);
      } else unkeyed.push(t);
    }
    const taskId = new Map<number, number>();
    for (let i = 0; i < keyed.length; i += 200) {
      const chunk = keyed.slice(i, i + 200);
      const rows = check(await db.from("tasks").insert(chunk.map((t) => taskRow(t, String(t.key).toUpperCase()))).select("id, key")) as Row[];
      const byKey = new Map(rows.map((r) => [String(r.key), Number(r.id)]));
      for (const t of chunk) taskId.set(Number(t.id), byKey.get(String(t.key).toUpperCase())!);
    }
    // The database gives a task whose key it can't take a new one, in its area.
    for (const t of unkeyed) taskId.set(Number(t.id), Number((check(await db.from("tasks").insert(taskRow(t, "")).select("id").single()) as Row).id));
    const task = (old: unknown) => taskId.get(Number(old));
    // A task's own folder was this computer's too.
    for (const t of tasks) {
      const id = task(t.id);
      const folder = (typeof t.folder === "string" && t.folder.trim()) || taskFolder("local", Number(t.id));
      if (id && folder) setTaskFolder("cloud", id, folder);
    }

    const subs = subtasks.filter((x) => task(x.task_id) && clip(x.title, 500))
      .map((x) => ({ task_id: task(x.task_id), title: clip(x.title, 500), done: Number(x.done) === 1, sort: int(x.sort, -1e6, 1e6, 0) }));
    for (let i = 0; i < subs.length; i += 500) check(await db.from("subtasks").insert(subs.slice(i, i + 500)));

    const evs = events.filter((e) => match(e.start_at, MINUTE) && match(e.end_at, MINUTE)).map((e) => ({
      title: clip(e.title, 200) || "Event", area_id: areaId(e.area_id), start_at: String(e.start_at), end_at: String(e.end_at),
      recurrence: oneOf(e.recurrence, ["weekly"]), done_on: doneDaysOf(e.done_on),
    }));
    for (let i = 0; i < evs.length; i += 500) check(await db.from("events").insert(evs.slice(i, i + 500)));

    // Sessions get new ids in the shape the cloud accepts, and "same session" links follow them.
    const sessionId = new Map<string, string>();
    const kept = sessions.filter((x) => task(x.task_id) && (x.agent === "claude" || x.agent === "codex"));
    for (const x of kept) sessionId.set(String(x.id), crypto.randomBytes(8).toString("hex"));
    const uuid = (v: unknown) => match(v, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const sessionRows = kept.map((x) => ({
      id: sessionId.get(String(x.id)), task_id: task(x.task_id), agent: String(x.agent), device_id: here,
      surface: oneOf(x.surface, SURFACES) ?? "terminal", url: typeof x.url === "string" && x.url.length <= 1000 && /^https:\/\/[^\s<>"']+$/.test(x.url) ? x.url : null,
      folder: s(x.folder)?.slice(0, 1000) ?? null, branch: s(x.branch)?.slice(0, 200) ?? null,
      status: oneOf(x.status, ["starting", "running", "finished", "done", "closed", "failed"]) ?? "closed",
      started_at: match(x.started_at, STAMP) ?? now, finished_at: match(x.finished_at, STAMP), ended_at: match(x.ended_at, STAMP),
      note: s(x.note)?.slice(0, 2000) ?? null, cli_session_id: uuid(x.cli_session_id),
      usage: usageOf(x.usage),
    }));
    for (let i = 0; i < sessionRows.length; i += 200) check(await db.from("sessions").insert(sessionRows.slice(i, i + 200)));
    const sevs = sessionEvents.filter((e) => sessionId.has(String(e.session_id)) && match(e.at, STAMP) && match(e.kind, /^[a-z_]{1,40}$/)).map((e) => ({
      session_id: sessionId.get(String(e.session_id)), at: String(e.at), kind: String(e.kind), text: String(e.text ?? "").slice(0, 2000),
    }));
    for (let i = 0; i < sevs.length; i += 500) check(await db.from("session_events").insert(sevs.slice(i, i + 500)));

    // Reports, and the images agents attached: the files are in this computer's data folder already.
    const reportId = new Map<number, number>();
    const criteria = (v: unknown) => jsonList(v).filter((c): c is Row => !!c && typeof c === "object" && typeof (c as Row).text === "string").slice(0, 50)
      .map((c) => ({ text: String(c.text).slice(0, 400), verdict: oneOf(c.verdict, ["met", "partly", "not_met"]), note: clip(c.note, 2000) }));
    const links = (v: unknown) => jsonList(v).filter((l): l is Row => !!l && typeof l === "object" && typeof (l as Row).url === "string"
      && /^https?:\/\//i.test(String((l as Row).url))).slice(0, 50).map((l) => ({ label: clip(l.label, 200), url: String(l.url).slice(0, 2000) }));
    for (const r of reports) {
      const sid = sessionId.get(String(r.session_id));
      const tid = task(r.task_id);
      if (!sid || !tid) continue;
      const row = check(await db.from("reports").insert({
        session_id: sid, task_id: tid, outcome: oneOf(r.outcome, ["done", "partial", "blocked"]) ?? "done",
        summary: clip(r.summary, 2000) || "Handed back", details: String(r.details ?? "").slice(0, 100000),
        criteria: criteria(r.criteria), verify: texts(r.verify, 2000), questions: texts(r.questions, 2000), links: links(r.links),
        follow_ups: texts(r.follow_ups, 40).filter((k) => KEY.test(k)), created_at: match(r.created_at, STAMP) ?? now,
        changes: clip(r.changes, 20000) || null, changes_at: clip(r.changes, 20000) ? match(r.changes_at, STAMP) : null,
        diff: diffOf(r.diff),
      }).select("id").single()) as Row;
      reportId.set(Number(r.id), Number(row.id));
    }
    const MIMES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
    const size = (v: unknown) => {
      const x = num(v);
      return x !== null && x >= 1 && x <= 1_000_000 ? Math.round(x) : null;
    };
    const images = attachments.filter((a) => /^[0-9a-f]{16}$/.test(String(a.id)) && task(a.task_id) && /^[0-9a-f]{16}\.(png|jpg|gif|webp)$/.test(String(a.file))
      && oneOf(a.mime, MIMES) && Number(a.bytes) >= 1 && Number(a.bytes) <= 20971520)
      .map((a) => ({
        id: String(a.id), task_id: task(a.task_id), session_id: a.session_id == null ? null : sessionId.get(String(a.session_id)) ?? null,
        report_id: a.report_id == null ? null : reportId.get(Number(a.report_id)) ?? null, device_id: here,
        file: String(a.file), mime: String(a.mime), bytes: Math.round(Number(a.bytes)), width: size(a.width), height: size(a.height),
        caption: clip(a.caption, 500), created_at: match(a.created_at, STAMP) ?? now,
      }));
    for (let i = 0; i < images.length; i += 200) check(await db.from("attachments").insert(images.slice(i, i + 200)));

    // Dependencies come along (an earlier version's flow connections are dependencies now).
    const dependencies = edges.filter((e) => task(e.from_task_id) && task(e.to_task_id) && task(e.from_task_id) !== task(e.to_task_id)).map((e) => ({
      from_task_id: task(e.from_task_id), to_task_id: task(e.to_task_id),
    }));
    for (let i = 0; i < dependencies.length; i += 500) check(await db.from("edges").insert(dependencies.slice(i, i + 500)));
    forgetAll("local", projects.map((p) => String(p.id)), areas.map((a) => String(a.id)));

    // Planning settings go to the account; how sessions start stays on this computer (an earlier version kept
    // that in its database too).
    const old: Record<string, unknown> = Object.fromEntries(settings.map((x) => {
      try {
        return [String(x.key), JSON.parse(String(x.value))];
      } catch {
        return [String(x.key), null];
      }
    }));
    const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
    const values = [
      ...(["workStart", "workEnd", "lunchStart", "lunchEnd"] as const).filter((k) => typeof old[k] === "string" && HHMM.test(old[k] as string))
        .map((key) => ({ user_id: userId, key, value: old[key] })),
      ...(Array.isArray(old.workDays) && old.workDays.length <= 7 ? [{ user_id: userId, key: "workDays", value: old.workDays }] : []),
    ];
    if (values.length) check(await db.from("settings").upsert(values, { onConflict: "user_id,key" }));

    // Preferences join the account's (which a reset keeps), except what it says already, up to the most it takes.
    const known = new Set((check(await db.from("preferences").select("text")) as Row[]).map((r) => String(r.text).toLowerCase()));
    const room = Math.max(0, MAX_PREFERENCES - known.size);
    const joining = preferences.flatMap((p) => {
      const text = cleanPreference(String(p.text ?? ""));
      const topic = cleanTopic(String(p.topic ?? ""));
      if (!topic || !text || known.has(text.toLowerCase())) return [];
      known.add(text.toLowerCase());
      return [{ topic, text, source: p.source === "agent" ? "agent" : "you", updated_at: match(p.updated_at, STAMP) ?? nowStamp() }];
    }).slice(0, room);
    if (joining.length) check(await db.from("preferences").insert(joining));
    updateDevice({
      ...(old.terminal === "wt" || old.terminal === "cmd" || old.terminal === "terminal" || old.terminal === "iterm" ? { terminal: old.terminal } : {}),
      ...(typeof old.claudeCommand === "string" && !commandProblem(old.claudeCommand) ? { claudeCommand: old.claudeCommand } : {}),
      ...(typeof old.codexCommand === "string" && !commandProblem(old.codexCommand) ? { codexCommand: old.codexCommand } : {}),
      ...(old.importOffered === true ? { importOffered: true } : {}),
    });

    return { areas: areas.length, projects: projectId.size, tasks: taskId.size };
  } finally {
    conn.close();
  }
}

/* ---------- the account's data back to this computer ---------- */

/** Every row of a table in the account, 1000 at a time (the most Supabase answers per request). */
async function everyRow(db: SupabaseClient, table: string, order: string): Promise<Row[]> {
  const out: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const rows = check(await db.from(table).select("*").order(order).range(from, from + 999)) as Row[];
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}

/**
 * Copies the signed-in account's data to this computer's own (the free One device plan), for when its PacedMind Cloud
 * has ended or you'd rather keep your plans on one computer. It only reads the account, so it works while Cloud is
 * read-only, and the account keeps its data until it's deleted. This computer's own data is replaced; a copy of the
 * file as it was stays next to it (organizer-before-move-<time>.db). Task keys, sessions and their reports come along,
 * and the images agents attached on this computer; images saved on another computer stay there. Project and task
 * folders, this computer's settings, go to the copies too (the account keeps its own, for signing in again). The
 * caller signs out afterwards.
 */
export async function moveToThisComputer(): Promise<{ areas: number; projects: number; tasks: number }> {
  const db = await supabase();
  await requirePlannerAccess();
  const [areas, projects, tasks, subtasks, events, sessions, sessionEvents, edges, reports, attachments, settings, preferences] = await Promise.all([
    everyRow(db, "areas", "sort"), everyRow(db, "projects", "sort"), everyRow(db, "tasks", "id"), everyRow(db, "subtasks", "id"),
    everyRow(db, "events", "id"), everyRow(db, "sessions", "started_at"), everyRow(db, "session_events", "id"), everyRow(db, "edges", "id"),
    everyRow(db, "reports", "id"), everyRow(db, "attachments", "created_at"), everyRow(db, "settings", "key"), everyRow(db, "preferences", "id"),
  ]);

  const conn = localDb();
  const used = conn.prepare("SELECT (SELECT COUNT(*) FROM projects) + (SELECT COUNT(*) FROM tasks) AS n").get() as Row;
  if (Number(used.n) > 0) {
    const stamp = toStamp(new Date()).replace(/[-:]/g, "").replace("T", "-");
    conn.prepare("VACUUM INTO ?").run(path.join(path.dirname(localDbPath()), `organizer-before-move-${stamp}.db`));
  }
  const localProjects = (conn.prepare("SELECT id FROM projects").all() as Row[]).map((r) => String(r.id));
  const localAreas = (conn.prepare("SELECT id FROM areas").all() as Row[]).map((r) => String(r.id));
  const json = (v: unknown) => JSON.stringify(Array.isArray(v) ? v : []);
  const s = (v: unknown) => (v == null ? null : String(v));
  const slug = (name: unknown, fallback: string) =>
    String(name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || fallback;
  const unique = (base: string, taken: Set<string>) => {
    let id = base;
    for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
    taken.add(id);
    return id;
  };

  const areaId = new Map<string, string>();
  const projectId = new Map<string, string>();
  const taskId = new Map<number, number>();
  const reportId = new Map<number, number>();
  conn.exec("BEGIN");
  try {
    for (const t of ["session_asks", "attachments", "reports", "session_events", "sessions", "edges", "subtasks", "tasks", "events", "projects", "areas"]) {
      conn.exec(`DELETE FROM ${t}`);
    }
    conn.exec("DELETE FROM sqlite_sequence");

    const areaIds = new Set<string>();
    const insArea = conn.prepare("INSERT INTO areas (id, name, key, color, sort, icon, picture, repo) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    for (const a of areas) {
      const id = unique(slug(a.name, "area"), areaIds);
      areaId.set(String(a.id), id);
      insArea.run(id, String(a.name), String(a.key), String(a.color), Number(a.sort ?? 0), s(a.icon), s(a.picture), repoOf(a.repo));
    }
    const area = (v: unknown) => (v == null ? null : areaId.get(String(v)) ?? null);

    const projectIds = new Set<string>();
    const insProject = conn.prepare(`INSERT INTO projects (id, area_id, name, start_date, target_date, agent, sort, color, codex_env, repo, hidden)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const p of projects) {
      const a = area(p.area_id);
      if (!a) continue;
      const id = unique(slug(p.name, "project"), projectIds);
      projectId.set(String(p.id), id);
      insProject.run(id, a, String(p.name), s(p.start_date), s(p.target_date), s(p.agent), Number(p.sort ?? 0), s(p.color), s(p.codex_env), s(p.repo), Number(p.hidden === true));
    }
    const afterProject = conn.prepare("UPDATE projects SET after_project_id = ? WHERE id = ?");
    for (const p of projects) {
      const self = projectId.get(String(p.id));
      const after = p.after_project_id == null ? null : projectId.get(String(p.after_project_id));
      if (self && after && self !== after) afterProject.run(after, self);
    }
    const project = (v: unknown) => (v == null ? null : projectId.get(String(v)) ?? null);

    const insTask = conn.prepare(`INSERT INTO tasks (key, area_id, project_id, title, description, status, priority, due_date, planned_date,
      estimate_min, labels, reminder, agent, sort_order, created_at, updated_at, completed_at, run_in, done_when, needs, model_settings,
      planned_time, related_project_id, repeat) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const t of tasks) {
      const r = insTask.run(
        String(t.key), area(t.area_id), project(t.project_id), String(t.title), String(t.description ?? ""), String(t.status), Number(t.priority ?? 0),
        s(t.due_date), s(t.planned_date), Number(t.estimate_min ?? 60), json(t.labels), s(t.reminder), s(t.agent), Number(t.sort_order ?? 0),
        String(t.created_at), String(t.updated_at),
        s(t.completed_at), s(t.run_in), json(t.done_when), json(cleanNeeds(Array.isArray(t.needs) ? t.needs.filter((x): x is string => typeof x === "string") : [])),
        JSON.stringify(modelSelectionOf(t.model_settings)),
        s(t.planned_date) && /^([01]\d|2[0-3]):[0-5]\d$/.test(String(t.planned_time)) ? String(t.planned_time) : null,
        project(t.related_project_id), repeatOf(t.repeat),
      );
      taskId.set(Number(t.id), Number(r.lastInsertRowid));
    }
    const task = (v: unknown) => (v == null ? null : taskId.get(Number(v)) ?? null);

    const insSub = conn.prepare("INSERT INTO subtasks (task_id, title, done, sort) VALUES (?, ?, ?, ?)");
    for (const x of subtasks) if (task(x.task_id)) insSub.run(task(x.task_id), String(x.title), x.done ? 1 : 0, Number(x.sort ?? 0));
    const insEvent = conn.prepare("INSERT INTO events (title, area_id, start_at, end_at, recurrence, done_on) VALUES (?, ?, ?, ?, ?, ?)");
    for (const e of events) insEvent.run(String(e.title), area(e.area_id), String(e.start_at), String(e.end_at), s(e.recurrence), JSON.stringify(doneDaysOf(e.done_on)));

    // Sessions keep their ids.
    const kept = new Set(sessions.filter((x) => task(x.task_id)).map((x) => String(x.id)));
    const insSession = conn.prepare(`INSERT INTO sessions (id, task_id, agent, folder, branch, status, started_at, finished_at, ended_at, note,
      cli_session_id, surface, url, usage) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const x of sessions) {
      if (!kept.has(String(x.id))) continue;
      insSession.run(String(x.id), task(x.task_id), String(x.agent), s(x.folder), s(x.branch), String(x.status), String(x.started_at),
        s(x.finished_at), s(x.ended_at), s(x.note), s(x.cli_session_id), String(x.surface ?? "terminal"), s(x.url),
        usageOf(x.usage) ? JSON.stringify(usageOf(x.usage)) : null);
    }
    const insEv = conn.prepare("INSERT INTO session_events (session_id, at, kind, text) VALUES (?, ?, ?, ?)");
    for (const e of sessionEvents) if (kept.has(String(e.session_id))) insEv.run(String(e.session_id), String(e.at), String(e.kind), String(e.text ?? ""));

    const insReport = conn.prepare(`INSERT INTO reports (session_id, task_id, outcome, summary, details, criteria, verify, questions, links,
      follow_ups, created_at, changes, changes_at, diff) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const r of reports) {
      if (!kept.has(String(r.session_id)) || !task(r.task_id)) continue;
      const row = insReport.run(String(r.session_id), task(r.task_id), String(r.outcome), String(r.summary), String(r.details ?? ""), json(r.criteria),
        json(r.verify), json(r.questions), json(r.links), json(r.follow_ups), String(r.created_at), s(r.changes), s(r.changes_at),
        diffOf(r.diff) ? JSON.stringify(diffOf(r.diff)) : null);
      reportId.set(Number(r.id), Number(row.lastInsertRowid));
    }
    // Only the images whose files are on this computer.
    const here = (file: unknown) => {
      try {
        return fs.existsSync(/*turbopackIgnore: true*/ attachmentPath(String(file)));
      } catch {
        return false;
      }
    };
    const insImage = conn.prepare(`INSERT INTO attachments (id, task_id, session_id, report_id, file, mime, bytes, width, height, caption, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const a of attachments) {
      if (!task(a.task_id) || !here(a.file)) continue;
      insImage.run(String(a.id), task(a.task_id), a.session_id != null && kept.has(String(a.session_id)) ? String(a.session_id) : null,
        a.report_id == null ? null : reportId.get(Number(a.report_id)) ?? null, String(a.file), String(a.mime), Number(a.bytes),
        a.width == null ? null : Number(a.width), a.height == null ? null : Number(a.height), String(a.caption ?? ""), String(a.created_at));
    }

    const insEdge = conn.prepare("INSERT OR IGNORE INTO edges (from_task_id, to_task_id) VALUES (?, ?)");
    for (const e of edges) {
      const from = task(e.from_task_id);
      const to = task(e.to_task_id);
      if (from && to && from !== to) insEdge.run(from, to);
    }

    const insSetting = conn.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value");
    for (const x of settings) if ((SETTING_KEYS as string[]).includes(String(x.key))) insSetting.run(String(x.key), JSON.stringify(x.value));

    conn.exec("DELETE FROM preferences");
    const insPreference = conn.prepare("INSERT INTO preferences (topic, text, source, updated_at) VALUES (?, ?, ?, ?)");
    for (const p of preferences.slice(0, MAX_PREFERENCES)) {
      const text = cleanPreference(String(p.text ?? ""));
      const topic = cleanTopic(String(p.topic ?? ""));
      if (topic && text) insPreference.run(topic, text, p.source === "agent" ? "agent" : "you", String(p.updated_at ?? nowStamp()));
    }
    conn.exec("COMMIT");
  } catch (e) {
    conn.exec("ROLLBACK");
    throw e;
  }

  // This computer's folders follow the projects and tasks to their copies.
  // The replaced data's settings go first. The account's stay, for signing in again.
  forgetAll("local", localProjects, localAreas);
  for (const [cloud, local] of areaId) {
    const folder = areaFolder(cloud);
    if (folder) setAreaFolder(local, folder);
  }
  for (const [cloud, local] of projectId) {
    const folder = projectFolder(cloud);
    if (folder) setProjectFolder(local, folder);
    const servers = projectServers(cloud);
    if (servers) setProjectServers(local, servers);
  }
  for (const [cloud, local] of taskId) {
    const folder = taskFolder("cloud", cloud);
    if (folder) setTaskFolder("local", local, folder);
  }
  return { areas: areaId.size, projects: projectId.size, tasks: taskId.size };
}
