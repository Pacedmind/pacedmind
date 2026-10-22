import "server-only";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { folderProblem } from "./folders";
import { asks } from "./git-remote";
import * as repo from "./repo";
import { usesCloud } from "./scope";
import { MODE } from "./supabase";
import type { Area, Project } from "@/lib/types";

/*
 * pacedmind.md: a small file PacedMind writes into a folder you link to a project, or make an area's workspace. Its
 * header names them by id, which is the same on all your computers (PacedMind Cloud's), so another computer finds its
 * copy of the folder by the file, even without a repository or a matching name: it offers the folder, and you link it
 * with one click (folder-hints.ts, import.ts). Kept in the repository, it comes with every clone. Its text tells agents
 * where the folder's tasks are. Only ids and names: nothing a computer uses to run anything, and nothing is set from it
 * without you.
 */

export const MARKER = "pacedmind.md";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** More than this isn't one of PacedMind's files. */
const MAX_BYTES = 64 * 1024;

export interface Marker {
  project: { id: string; name: string } | null;
  area: { id: string; name: string } | null;
}

/** A name as the header keeps it: one line, no quotes to break it, not too long. */
const clean = (name: string) => name.replace(/"/g, "'").replace(/\s+/g, " ").trim().slice(0, 200);

const HEAD = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function fields(text: string): Record<string, string> {
  const head = HEAD.exec(text)?.[1] ?? "";
  const out: Record<string, string> = {};
  for (const line of head.split(/\r?\n/)) {
    const m = /^([a-z_]+):\s*(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].replace(/^"(.*)"$/, "$1").trim();
  }
  return out;
}

/** The project and area a folder's pacedmind.md names, or null without one (or where reading would make macOS ask). */
export function readMarker(folder: string): Marker | null {
  const file = path.join(folder, MARKER);
  if (asks(file)) return null;
  try {
    if (fs.statSync(file).size > MAX_BYTES) return null;
    const f = fields(fs.readFileSync(file, "utf8"));
    const project = UUID.test(f.project ?? "") ? { id: f.project.toLowerCase(), name: clean(f.project_name ?? "") } : null;
    const area = UUID.test(f.area ?? "") ? { id: f.area.toLowerCase(), name: clean(f.area_name ?? "") } : null;
    return project || area ? { project, area } : null;
  } catch {
    return null;
  }
}

function header(m: Marker): string {
  const lines = ["---"];
  if (m.project) lines.push(`project: ${m.project.id}`, `project_name: "${clean(m.project.name)}"`);
  if (m.area) lines.push(`area: ${m.area.id}`, `area_name: "${clean(m.area.name)}"`);
  lines.push("---", "");
  return lines.join("\n");
}

function body(m: Marker): string {
  const what = m.project && m.area
    ? `the project **${clean(m.project.name)}** and the workspace of the area **${clean(m.area.name)}**`
    : m.project ? `the project **${clean(m.project.name)}**` : `the workspace of the area **${clean(m.area!.name)}**`;
  return [
    "# PacedMind",
    "",
    `This folder is ${what} in [PacedMind](https://pacedmind.com), which keeps their tasks, deadlines and agent sessions.`,
    "PacedMind finds this folder on your other computers by the ids above, so keep this file in the repository and don't change them.",
    "",
    "For agents: with PacedMind's MCP server, `get_project` (or `list_tasks` with the area) and the id above list the tasks for this folder.",
    "",
  ].join("\n");
}

/**
 * Writes (or updates) the folder's pacedmind.md so it names `m`'s project or area, keeping what's there for the other
 * one and any text of your own. Returns why it couldn't, or null.
 */
export function writeMarker(folder: string, m: Partial<Marker>): string | null {
  const problem = folderProblem(folder);
  if (problem) return problem;
  const file = path.join(folder, MARKER);
  if (asks(file)) return "macOS would ask first";
  let before = "";
  try {
    before = fs.readFileSync(file, "utf8");
  } catch {
    // A new file.
  }
  if (before.length > MAX_BYTES) return `${MARKER} there is too big to be PacedMind's`;
  const had = readMarker(folder) ?? { project: null, area: null };
  const next: Marker = { project: m.project === undefined ? had.project : m.project, area: m.area === undefined ? had.area : m.area };
  if (JSON.stringify(next) === JSON.stringify(had) && before) return null;
  const rest = before.replace(HEAD, "");
  // Our own text follows what it names; text you wrote stays as it is.
  const text = header(next) + (!rest.trim() || rest.startsWith("# PacedMind\n") ? body(next) : rest);
  const temp = `${file}.pacedmind-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(temp, text);
    fs.renameSync(temp, file);
    return null;
  } catch (e) {
    try { fs.rmSync(temp, { force: true }); } catch { /* Nothing to remove. */ }
    return e instanceof Error ? e.message : String(e);
  }
}

const SCANNED = 800;
const skip = (name: string) => name.startsWith(".") || name === "node_modules";

function subdirs(dir: string): string[] {
  if (asks(dir)) return [];
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && !skip(d.name)).map((d) => path.join(dir, d.name));
  } catch {
    return [];
  }
}

/**
 * The folders whose pacedmind.md names a project or an area, among `folders` and the folders next to and inside them
 * (one level each way: where you keep your projects, and an area's workspace with its projects in it). Your home
 * folder and a drive's root aren't looked through, and at most a few hundred folders are.
 */
export function markedAround(folders: string[]): { folder: string; marker: Marker }[] {
  const home = path.resolve(os.homedir()).toLowerCase();
  const tooWide = (dir: string) => { const d = path.resolve(dir); return d.toLowerCase() === home || path.dirname(d) === d; };
  const dirs = new Map<string, string>();
  const add = (d: string) => { const r = path.resolve(d); dirs.set(process.platform === "linux" ? r : r.toLowerCase(), r); };
  for (const f of folders) {
    if (!f || !path.isAbsolute(f)) continue;
    add(f);
    for (const s of subdirs(f)) add(s);
    const up = path.dirname(path.resolve(f));
    if (!tooWide(up)) for (const s of subdirs(up)) add(s);
    if (dirs.size > SCANNED) break;
  }
  const out: { folder: string; marker: Marker }[] = [];
  for (const d of [...dirs.values()].slice(0, SCANNED)) {
    if (asks(d) || !fs.existsSync(path.join(d, MARKER))) continue;
    const marker = readMarker(d);
    if (!marker) continue;
    let folder = d;
    try { folder = fs.realpathSync.native(d); } catch { /* As it was spelled. */ }
    out.push({ folder, marker });
  }
  return out;
}

/** Marks folders only in the desktop app, signed in: this computer's own data has ids no other computer knows. */
async function marking(): Promise<boolean> {
  return MODE === "desktop" && (await usesCloud());
}

/** Names the project in its folder here, if it has one. Never throws: a folder it can't write to just stays as it is. */
export async function markProject(project: Pick<Project, "id" | "name" | "folder">): Promise<void> {
  if (!project.folder || !(await marking())) return;
  const problem = writeMarker(project.folder, { project: { id: project.id, name: project.name } });
  if (problem) console.warn(`[organizer] couldn't write ${MARKER} in ${project.folder}: ${problem}`);
}

/** Names the area in its workspace here, if it has one. */
export async function markArea(area: Pick<Area, "id" | "name" | "folder">): Promise<void> {
  if (!area.folder || !(await marking())) return;
  const problem = writeMarker(area.folder, { area: { id: area.id, name: area.name } });
  if (problem) console.warn(`[organizer] couldn't write ${MARKER} in ${area.folder}: ${problem}`);
}

/** The projects and areas linked to a folder here whose folder doesn't name them yet. */
export async function unmarked(): Promise<{ projects: Project[]; areas: Area[] }> {
  if (!(await marking())) return { projects: [], areas: [] };
  const [projects, areas] = await Promise.all([repo.listAllProjects(), repo.listAllAreas()]);
  const missing = (folder: string | null, id: string, kind: "project" | "area") =>
    !!folder && !folderProblem(folder) && !asks(path.join(folder, MARKER)) && readMarker(folder)?.[kind]?.id !== id.toLowerCase();
  return {
    projects: projects.filter((p) => missing(p.folder, p.id, "project")),
    areas: areas.filter((a) => missing(a.folder, a.id, "area")),
  };
}

/** Writes pacedmind.md into every linked folder here that doesn't have it yet. Returns how many it wrote. */
export async function markAll(): Promise<number> {
  const { projects, areas } = await unmarked();
  for (const p of projects) await markProject(p);
  for (const a of areas) await markArea(a);
  return projects.length + areas.length;
}
