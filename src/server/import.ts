import "server-only";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dataDir, deviceConfig } from "./device";
import { thisDeviceId } from "./devices";
import { folderProblem } from "./folders";
import { asks, mainCheckout, repoIdentity } from "./git-remote";
import { markProject, markedAround, readMarker } from "./marker";
import { linkFolder, linkProjects, linkWorkspace } from "./project-links";
import * as repo from "./repo";
import { MODE } from "./supabase";
import { nextColor } from "@/lib/colors";
import type { AgentId, Area, Project } from "@/lib/types";

/*
 * Finds the folders you work in with Claude Code and Codex on this computer, so they can become PacedMind
 * projects in one go. It only reads what the tools keep for themselves:
 *   - Claude app: its Code sessions (claude-code-sessions/…/local_*.json, the folder each one ran in);
 *   - Claude Code CLI: the projects in ~/.claude.json, and their transcripts in ~/.claude/projects;
 *   - Codex app: its projects (~/.codex/.codex-global-state.json);
 *   - Codex CLI and app threads: ~/.codex/config.toml trusted projects and ~/.codex/sessions transcripts.
 * The same folder found by both tools becomes one project that both agents worked in.
 */

export type ImportSource = "claude-app" | "claude-cli" | "codex-app" | "codex-cli";

export interface FoundProject {
  /** The folder, spelled the way the file system does. */
  folder: string;
  name: string;
  sources: ImportSource[];
  /** When each agent last worked there, as epoch ms (0 when only known, not when). */
  used: Partial<Record<AgentId, number>>;
  /** The PacedMind project that already has this folder. */
  projectId: string | null;
  /**
   * A project you have (made on another computer, usually) that this folder is a copy of: its pacedmind.md names it,
   * or else the same repository, or else the same name, and no folder here yet. Importing the folder gives it to that
   * project instead of making another.
   */
  joins: { id: string; name: string } | null;
  /** Worth importing without asking: used in the last months, still there, and not a folder that holds other projects. */
  suggested: boolean;
  /** Why it can't become a project's folder, e.g. it was deleted. */
  problem: string | null;
  /** The repository it holds (git-remote.ts), or null. */
  repo: string | null;
  /** When git last saw work in it (its repository's own files), as epoch ms; 0 when unknown. */
  touched: number;
  /** The area folder it's in (FoundArea.folder), when it's in one. */
  area: string | null;
  /** How many repositories it holds, when it's a folder of several that is one project. */
  holds: number;
  /** The project or folder of the same repository it's a copy of: not worth a project of its own. */
  copyOf: string | null;
}

/** A folder that holds projects: an area's workspace. */
export interface FoundArea {
  /** The folder, spelled the way the file system does. */
  folder: string;
  name: string;
  /** The area whose workspace here this folder already is. */
  areaId: string | null;
  /**
   * An area you have (made on another computer, usually) that this folder is, and how that was recognised: its
   * pacedmind.md names it, it holds the area's repository, the projects of yours in it are that area's, or it has the
   * area's name. Null: it would become a new area.
   */
  joins: { id: string; name: string; how: "marker" | "repo" | "projects" | "name" } | null;
  /** A project of yours this whole folder is (by its pacedmind.md or its name), to take it as one project instead. */
  asProject: { id: string; name: string } | null;
  problem: string | null;
  /** Worth setting up without asking: an area you have, or a folder with projects you worked on lately. */
  suggested: boolean;
}

const home = os.homedir();
const DAY = 86_400_000;
const RECENT = 120 * DAY;

/** Comparable form of a folder: resolved, no trailing separator, letter case ignored where the file system does. */
export function keyOf(folder: string): string {
  const p = path.resolve(folder).replace(/[\\/]+$/, "");
  return process.platform === "linux" ? p : p.toLowerCase();
}

/**
 * The project a folder belongs to. Sessions in a git worktree belong to the repository it was made from, wherever the
 * worktree is, and a session in a subfolder to the repository around it (the nearest folder up with a .git, below
 * your home folder).
 */
function mainFolder(folder: string): string {
  const m = folder.match(/^(.*?)[\\/]\.(?:claude|codex)[\\/]worktrees[\\/]/i);
  const start = m ? m[1] : folder;
  const stop = keyOf(home);
  for (let dir = start, i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, ".git"))) return mainCheckout(dir);
    const up = path.dirname(dir);
    if (up === dir || keyOf(up) === stop) break;
    dir = up;
  }
  return start;
}

export const inside = (key: string, parent: string) => key.startsWith(parent + path.sep);

/** Where the system keeps apps' data: the installed PacedMind's is in its Organizer folder there. */
function appDataRoot(): string {
  if (process.platform === "win32") return process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support");
  return process.env.XDG_CONFIG_HOME ?? path.join(home, ".config");
}

/** Folders that aren't projects: your home and its standard folders, temporary and scratch folders, the tools' own. */
function isScratch(folder: string): boolean {
  const key = keyOf(folder);
  const plain = [home, path.join(home, "Documents"), path.join(home, "Desktop"), path.join(home, "Downloads"), path.parse(path.resolve(folder)).root];
  if (plain.some((d) => key === keyOf(d))) return true;
  const scratch = [
    os.tmpdir(), path.join(home, ".claude"), path.join(home, ".codex"), path.join(home, "Documents", "Codex"),
    path.join(dataDir(), "workspaces"), path.join(appDataRoot(), "Organizer", "data", "workspaces"),
  ];
  return scratch.some((d) => key === keyOf(d) || inside(key, keyOf(d))) || /[\\/]claude[\\/]scratch-workspaces[\\/]/i.test(folder);
}

/** Parses the inside of a JSON (or TOML basic) string, or null. */
function unquote(inner: string): string | null {
  try {
    return JSON.parse(`"${inner}"`) as string;
  } catch {
    return null;
  }
}

const readJson = (file: string): unknown => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

const stamp = (v: unknown): number => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(n) ? n : 0;
};

const files = (dir: string, test: (name: string) => boolean): string[] => {
  try {
    return fs.readdirSync(dir).filter(test).map((f) => path.join(dir, f));
  } catch {
    return [];
  }
};

const subdirs = (dir: string): string[] => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(dir, d.name));
  } catch {
    return [];
  }
};

const mtime = (file: string) => {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
};

/** Where the Claude desktop app keeps its data. */
export function claudeAppDir(): string {
  if (process.platform === "win32") return path.join(process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), "Claude");
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "Claude");
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "Claude");
}

const codexHome = () => process.env.CODEX_HOME || path.join(home, ".codex");
const claudeConfigDir = () => process.env.CLAUDE_CONFIG_DIR || home;

type Hit = { folder: string; source: ImportSource; at: number; name?: string };

function claudeAppHits(): Hit[] {
  const hits: Hit[] = [];
  const root = path.join(claudeAppDir(), "claude-code-sessions");
  for (const account of subdirs(root)) {
    for (const org of subdirs(account)) {
      for (const file of files(org, (f) => f.startsWith("local_") && f.endsWith(".json"))) {
        const s = readJson(file) as { originCwd?: string; cwd?: string; lastActivityAt?: unknown; createdAt?: unknown } | null;
        const folder = s?.originCwd || s?.cwd;
        if (folder) hits.push({ folder, source: "claude-app", at: stamp(s?.lastActivityAt) || stamp(s?.createdAt) });
      }
    }
  }
  return hits;
}

function claudeCliHits(): Hit[] {
  const config = readJson(path.join(claudeConfigDir(), ".claude.json")) as { projects?: Record<string, unknown> } | null;
  const transcripts = path.join(/*turbopackIgnore: true*/ claudeConfigDir(), ".claude", "projects");
  return Object.keys(config?.projects ?? {}).map((folder) => {
    // Claude Code names a project's transcript folder after its path, with every other character as "-".
    const dir = path.join(transcripts, folder.replace(/[^a-zA-Z0-9]/g, "-"));
    const at = Math.max(0, ...files(dir, (f) => f.endsWith(".jsonl")).map(mtime));
    return { folder, source: "claude-cli" as const, at };
  });
}

function codexAppHits(): Hit[] {
  const state = readJson(path.join(codexHome(), ".codex-global-state.json")) as {
    "local-projects"?: Record<string, { name?: string; rootPaths?: string[]; updatedAt?: unknown }>;
  } | null;
  return Object.values(state?.["local-projects"] ?? {}).flatMap((p) =>
    (p.rootPaths ?? []).slice(0, 1).map((folder) => ({ folder, source: "codex-app" as const, at: stamp(p.updatedAt), name: p.name })));
}

function codexCliHits(): Hit[] {
  const hits: Hit[] = [];
  try {
    const toml = fs.readFileSync(path.join(/*turbopackIgnore: true*/ codexHome(), "config.toml"), "utf8");
    for (const m of toml.matchAll(/^\[projects\.(?:'([^']+)'|"((?:[^"\\]|\\.)+)")\]/gm)) {
      const folder = m[1] ?? unquote(m[2]);
      if (folder) hits.push({ folder, source: "codex-cli", at: 0 });
    }
  } catch {
    // No config yet.
  }
  // Each transcript starts with a line that names the folder it ran in.
  const walk = (dir: string, depth: number): string[] =>
    depth ? subdirs(dir).flatMap((d) => walk(d, depth - 1)) : files(dir, (f) => f.startsWith("rollout-") && f.endsWith(".jsonl"));
  for (const file of walk(path.join(/*turbopackIgnore: true*/ codexHome(), "sessions"), 3)) {
    let head = "";
    try {
      const fd = fs.openSync(file, "r");
      const buf = Buffer.alloc(4096);
      head = buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, 0)).toString("utf8");
      fs.closeSync(fd);
    } catch {
      continue;
    }
    // Only conversations you had: not `codex exec` runs that scripts start, nor subagents.
    if (/"source":(?:"exec"|\{)/.test(head)) continue;
    const cwd = unquote(head.match(/"cwd":"((?:[^"\\]|\\.)*)"/)?.[1] ?? "");
    if (!cwd) continue;
    const source: ImportSource = /"originator":"Codex Desktop"/.test(head) ? "codex-app" : "codex-cli";
    hits.push({ folder: cwd, source, at: mtime(file) });
  }
  return hits;
}

/** The spelling the file system uses for a folder that exists (Windows paths keep the case they were typed in). */
function realFolder(folder: string): string {
  try {
    return fs.realpathSync.native(folder);
  } catch {
    return path.normalize(folder);
  }
}

/** Folders a search of your folders doesn't go into: hidden ones (worktrees, tools' own), dependencies and build output. */
const SKIP = new Set(["node_modules", "dist", "build", "out", "target", "vendor", "venv", "env", "__pycache__", "coverage", "bin", "obj"]);
/** At most this many folders are read per search, so a huge folder can't hold it up. */
const BUDGET = 4000;

type Scan = { left: number };

/** A folder's folders worth looking into, while the search has budget left; none where macOS would ask first. */
function dirsIn(dir: string, scan: Scan): string[] {
  if (scan.left <= 0 || asks(dir)) return [];
  scan.left--;
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith(".") && !SKIP.has(d.name.toLowerCase()))
      .map((d) => path.join(dir, d.name));
  } catch {
    return [];
  }
}

/**
 * "main": a repository's own checkout; "copy": a worktree or a submodule (its .git is a file); null: none, or a folder
 * where macOS would ask first.
 */
function gitOf(dir: string): "main" | "copy" | null {
  if (asks(dir)) return null;
  try {
    return fs.statSync(path.join(dir, ".git")).isDirectory() ? "main" : "copy";
  } catch {
    return null;
  }
}

/** The repositories' own checkouts in `dir`, at most `depth` levels down, without looking inside one. */
function reposIn(dir: string, depth: number, scan: Scan): string[] {
  return dirsIn(dir, scan).flatMap((d) => {
    const git = gitOf(d);
    return git === "main" ? [d] : !git && depth > 1 ? reposIn(d, depth - 1, scan) : [];
  });
}

/**
 * When a repository was last worked in, as epoch ms (0 when unknown): its last commit, checkout or fetch, from git's
 * own files. Not its index, which anything that runs git status touches.
 */
const gitTouched = (folder: string) => asks(folder) ? 0 :
  Math.max(0, ...["HEAD", "FETCH_HEAD", path.join("logs", "HEAD")].map((f) => mtime(path.join(folder, ".git", f))));

/** A folder in an area's folder: a repository, or a folder holding repositories (two levels down at most). */
type Kid = { folder: string; repos: string[]; repo: boolean };

function kidsOf(dir: string, scan: Scan): Kid[] {
  return dirsIn(dir, scan).flatMap((k): Kid[] => {
    const git = gitOf(k);
    if (git === "copy") return [];
    if (git === "main") return [{ folder: k, repos: [k], repo: true }];
    const repos = reposIn(k, 2, scan);
    return repos.length ? [{ folder: k, repos, repo: false }] : [];
  });
}

/** Near the top of your folders, where a folder of areas is (like Documents/Projects): two levels below home at most. */
function shallow(folder: string): boolean {
  const rel = path.relative(home, path.resolve(folder));
  const parts = rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel.split(path.sep) : path.resolve(folder).split(path.sep).slice(1);
  return parts.filter(Boolean).length <= 2;
}

const plain = (name: string) => name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** A folder named like an archive (in English or Polish): what's in it is shown, but not picked. */
const ARCHIVE = /^[_.\s-]*(archives?|archived|archiwum|archiv|old|backups?|stare)[_.\s-]*$/i;
const archived = (folder: string, box: string | null) =>
  [folder, box ?? ""].some((d) => d && path.relative(home, d).split(path.sep).some((part) => ARCHIVE.test(part)));

const lastOf = (f: { used: Partial<Record<AgentId, number>>; touched?: number }) =>
  Math.max(f.touched ?? 0, ...Object.values(f.used).map((v) => v ?? 0));

/** A folder that may become a project. */
type Cand = {
  folder: string;
  name: string;
  sources: Set<ImportSource>;
  used: Partial<Record<AgentId, number>>;
  touched: number;
  /** Its area's folder, by key, when it's in one. */
  area: string | null;
  /** The repositories it holds, when it's a folder of several (a project that spans them, like a web and an API repository). */
  repos: string[];
};

/** A folder that may be an area's workspace, with the folders in it. */
type Box = { folder: string; source: "work" | "root" | "linked" | "parent" | "marker"; kids: Kid[]; areaId: string | null };

/**
 * What is on this computer, most recently used first: the folders you work in with Claude Code and Codex, and the
 * repositories in and around them, as projects; and the folders that hold them, as areas. A folder that isn't a
 * repository but holds some is an area, and each folder in it a project: a repository, or a folder of repositories
 * that is one project (a folder with one repository in it stands for that repository). A folder near the top of your
 * folders whose folders are areas themselves (like Documents/Projects) is a folder of areas: its areas are areas, and
 * the repositories right in it projects of no area. Each found area and project is one you already have when it can
 * be: by the pacedmind.md in it, its repository, the projects in it (for an area), or its name. `link` first brings
 * the projects' repositories up to date (linkProjects), which the background loop does every minute anyway.
 */
export async function findWork({ link = true } = {}): Promise<{ projects: FoundProject[]; areas: FoundArea[] }> {
  const hits = [...codexAppHits(), ...claudeAppHits(), ...claudeCliHits(), ...codexCliHits()];
  const cands = new Map<string, Cand>();
  for (const h of hits) {
    // Folders that were moved or deleted since can't become projects.
    if (!path.isAbsolute(h.folder.trim()) || !fs.existsSync(h.folder.trim())) continue;
    const folder = mainFolder(h.folder.trim());
    if (isScratch(folder)) continue;
    const key = keyOf(folder);
    const entry = cands.get(key) ?? { folder: realFolder(folder), name: "", sources: new Set<ImportSource>(), used: {}, touched: 0, area: null, repos: [] };
    const agent: AgentId = h.source.startsWith("claude") ? "claude" : "codex";
    entry.sources.add(h.source);
    entry.used[agent] = Math.max(entry.used[agent] ?? 0, h.at);
    // A name you gave the project in the Codex app beats the folder's name.
    if (h.name && !entry.name) entry.name = h.name.trim();
    cands.set(key, entry);
  }

  // Projects from your other computers should know their repositories before folders here are matched to them.
  if (link) await linkProjects().catch((e) => console.error("[organizer] project links failed", e));
  const [projects, areas] = await Promise.all([repo.listAllProjects(), repo.listAllAreas()]);
  const scan: Scan = { left: BUDGET };
  const projectAt = new Map(projects.flatMap((p) => (p.folder ? [[keyOf(p.folder), p] as const] : [])));
  const areaAt = new Map(areas.flatMap((a) => (a.folder ? [[keyOf(a.folder), a] as const] : [])));
  const open = projects.filter((p) => !p.folder);
  const markerOf = (folder: string) => readMarker(folder);
  /** An area you have that this folder is surely or by its name, before its projects are known. */
  const areaFor = (folder: string): Area | undefined => {
    const m = markerOf(folder)?.area?.id;
    return areaAt.get(keyOf(folder)) ?? (m ? areas.find((a) => a.id.toLowerCase() === m) : undefined)
      ?? areas.find((a) => plain(a.name) === plain(path.basename(folder)));
  };
  /** A project you have that this whole folder is, by its pacedmind.md or its name. */
  const projectFor = (folder: string): Project | undefined => {
    const m = markerOf(folder)?.project?.id;
    return projectAt.get(keyOf(folder)) ?? (m ? open.find((p) => p.id.toLowerCase() === m) : undefined)
      ?? open.find((p) => plain(p.name) === plain(path.basename(folder)));
  };
  // What a folder you work in knew, once it was taken for an area, for when it turns out to be a project after all.
  const worked = new Map<string, Cand>();
  const addCand = (folder: string, name: string, area: string | null, repos: string[] = []) => {
    const key = keyOf(folder);
    const had = cands.get(key) ?? worked.get(key);
    if (had) {
      had.area ??= area;
      if (!had.repos.length) had.repos = repos;
      cands.set(key, had);
      return;
    }
    cands.set(key, { folder: realFolder(folder), name, sources: new Set(), used: {}, touched: 0, area, repos });
  };

  // 1. Where your areas may be: the folders you work in that aren't repositories but hold some (unless a project of
  //    yours is that folder), this computer's area workspaces, the folders around the repositories you work in, and the
  //    folders whose pacedmind.md names an area.
  const boxes = new Map<string, Box>();
  const box = (folder: string, source: Box["source"], kids?: Kid[]) => {
    const key = keyOf(folder);
    if (boxes.has(key) || isScratch(folder) || gitOf(folder) === "copy") return;
    const list = kids ?? kidsOf(folder, scan);
    if (!list.length && source !== "linked") return;
    boxes.set(key, { folder: realFolder(folder), source, kids: list, areaId: areaAt.get(key)?.id ?? null });
  };
  for (const [key, c] of [...cands]) {
    if (gitOf(c.folder)) continue;
    const kids = kidsOf(c.folder, scan);
    if (!kids.length) continue;
    const mine = projectFor(c.folder);
    if (mine && !areaAt.has(key)) {
      // A project of yours spanning the repositories in it; one repository stands for itself.
      const repos = kids.flatMap((k) => k.repos);
      if (repos.length === 1 && !projectAt.has(key)) {
        cands.delete(key);
        addCand(repos[0], c.name || path.basename(c.folder), null);
        const moved = cands.get(keyOf(repos[0]))!;
        for (const s of c.sources) moved.sources.add(s);
        Object.assign(moved.used, c.used);
      } else {
        c.repos = repos;
      }
      continue;
    }
    box(c.folder, "work", kids);
    worked.set(key, c);
    cands.delete(key);
  }
  for (const a of areas) if (a.folder && !gitOf(a.folder)) box(a.folder, "linked");
  for (const c of [...cands.values()]) {
    const up = path.dirname(c.folder);
    if (gitOf(c.folder) !== "main" || up === c.folder || gitOf(up) || isScratch(up)) continue;
    const kids = kidsOf(up, scan);
    if (kids.length >= 2) box(up, "parent", kids);
  }
  const d = deviceConfig();
  const marked = markedAround([...Object.values(d.folders), ...Object.values(d.areaFolders), ...[...cands.values()].map((c) => c.folder)]);
  for (const m of marked) if (m.marker.area && !gitOf(m.folder)) box(m.folder, "marker");

  // 2. A folder of areas: near the top, with two or more areas in it (folders holding two or more repositories, or
  //    areas you have). Its areas become areas; the repositories right in it, projects of no area.
  const areaLike = (k: Kid) => !k.repo && (k.repos.length >= 2 || !!areaFor(k.folder));
  for (const [key, b] of [...boxes]) {
    if (b.source === "linked" || areaFor(b.folder) || !shallow(b.folder) || b.kids.filter(areaLike).length < 2) continue;
    boxes.delete(key);
    for (const k of b.kids) {
      if (areaLike(k)) box(k.folder, "root");
      else if (k.repo) addCand(k.folder, path.basename(k.folder), null);
      else addCand(k.repos[0], path.basename(k.repos[0]), null);
    }
  }
  // An area inside another is one of its projects: areas don't nest.
  const outer = [...boxes.keys()].sort((a, b) => a.length - b.length);
  for (const key of outer) if (outer.some((o) => o !== key && boxes.has(o) && inside(key, o))) boxes.delete(key);

  // 3. The projects in each area: its repositories, and its folders of repositories (one repository stands for itself).
  for (const [key, b] of boxes) {
    for (const k of b.kids) {
      if (k.repo) addCand(k.folder, path.basename(k.folder), key);
      else if (k.repos.length === 1) {
        const r = k.repos[0];
        addCand(r, plain(path.basename(k.folder)) === plain(path.basename(r)) ? path.basename(k.folder) : path.basename(r), key);
      } else addCand(k.folder, path.basename(k.folder), key, k.repos);
    }
  }
  // Folders you work in inside an area are its projects; inside a project of several repositories, part of it.
  const spans = [...cands.entries()].filter(([, c]) => c.repos.length > 1).map(([k]) => k);
  for (const [key, c] of [...cands]) {
    if (spans.some((s) => inside(key, s)) && !projectAt.has(key)) {
      cands.delete(key);
      continue;
    }
    c.area ??= [...boxes.keys()].find((b) => inside(key, b)) ?? null;
  }

  // 4. Each folder once, as it is on disk, and a project you have when it's one.
  const now = Date.now();
  const found = [...cands.entries()].map(([key, c]) => {
    const problem = folderProblem(c.folder);
    const git = gitOf(c.folder);
    const touched = git === "main" ? gitTouched(c.folder) : Math.max(0, ...c.repos.slice(0, 40).map(gitTouched));
    return {
      folder: c.folder,
      name: c.name || path.basename(c.folder),
      sources: [...c.sources].sort(),
      used: c.used,
      touched,
      projectId: projectAt.get(key)?.id ?? null,
      joins: null as FoundProject["joins"],
      suggested: false,
      problem,
      repo: problem || git !== "main" ? null : repoIdentity(c.folder),
      area: c.area ? boxes.get(c.area)?.folder ?? null : null,
      holds: c.repos.length > 1 ? c.repos.length : 0,
      copyOf: null as string | null,
    };
  }).sort((a, b) => lastOf(b) - lastOf(a) || a.name.localeCompare(b.name));

  // The projects without a folder here, each for one folder at most: the one whose pacedmind.md names it, else the most
  // recently used one of its repository, else of its name. Another copy of a repository isn't worth a project of its own.
  const joined = new Set<string>();
  const firstOfRepo = new Map<string, string>();
  for (const f of found.filter((x) => !x.projectId && !x.problem)) {
    const free = open.filter((p) => !joined.has(p.id));
    const named = markerOf(f.folder)?.project?.id;
    const match = (named && free.find((p) => p.id.toLowerCase() === named))
      || (f.repo && free.find((p) => p.repo === f.repo))
      || free.find((p) => plain(p.name) === plain(f.name) && (!p.repo || !f.repo || p.repo === f.repo));
    if (match) {
      joined.add(match.id);
      f.joins = { id: match.id, name: match.name };
    } else if (f.repo && (firstOfRepo.has(f.repo) || open.some((p) => p.repo === f.repo))) {
      f.copyOf = firstOfRepo.get(f.repo) ?? open.find((p) => p.repo === f.repo)!.name;
    }
    if (f.repo && !firstOfRepo.has(f.repo)) firstOfRepo.set(f.repo, f.joins?.name ?? f.name);
    f.suggested = !f.copyOf && (!!f.joins || (now - lastOf(f) < RECENT && !archived(f.folder, f.area)));
  }
  // Folders you haven't opened in Claude Code or Codex here, but whose pacedmind.md names one of your projects.
  const seen = new Set([...found.map((x) => keyOf(x.folder)), ...projectAt.keys()]);
  for (const m of marked) {
    const p = m.marker.project && open.find((x) => x.id.toLowerCase() === m.marker.project!.id && !joined.has(x.id));
    if (!p || seen.has(keyOf(m.folder))) continue;
    const problem = folderProblem(m.folder);
    joined.add(p.id);
    seen.add(keyOf(m.folder));
    found.push({
      folder: m.folder, name: p.name, sources: [], used: {}, touched: 0, projectId: null, joins: { id: p.id, name: p.name }, suggested: !problem,
      problem, repo: problem ? null : repoIdentity(m.folder), area: [...boxes.values()].find((b) => inside(keyOf(m.folder), keyOf(b.folder)))?.folder ?? null,
      holds: 0, copyOf: null,
    });
  }

  // 5. Each area folder is an area you have when it can be: its pacedmind.md, its repository, the area of the projects of
  //    yours in it, or its name; each of yours once. Else it would be a new area.
  const taken = new Set<string>();
  type How = NonNullable<FoundArea["joins"]>["how"];
  const foundAreas = [...boxes.values()].map((b) => {
    const inIt = found.filter((f) => f.area === b.folder);
    const theirs = inIt.flatMap((f) => {
      const id = f.joins?.id ?? f.projectId;
      const p = id ? projects.find((x) => x.id === id) : undefined;
      return p ? [p.areaId] : [];
    });
    const most = theirs.length ? [...new Set(theirs)].map((id) => [id, theirs.filter((x) => x === id).length] as const).sort((x, y) => y[1] - x[1])[0] : null;
    const byMarker = markerOf(b.folder)?.area?.id;
    const byRepo = gitOf(b.folder) === "main" ? repoIdentity(b.folder) : null;
    const candidates: [How, Area | undefined][] = [
      ["marker", byMarker ? areas.find((a) => a.id.toLowerCase() === byMarker) : undefined],
      ["repo", byRepo ? areas.find((a) => a.repo === byRepo) : undefined],
      ["projects", most && most[1] >= 2 && most[1] * 2 > theirs.length ? areas.find((a) => a.id === most[0]) : undefined],
      ["name", areas.find((a) => plain(a.name) === plain(path.basename(b.folder)))],
    ];
    const hit = b.areaId ? undefined : candidates.find(([, a]) => a && !taken.has(a.id));
    if (hit?.[1]) taken.add(hit[1].id);
    const joins = hit?.[1] ? { id: hit[1].id, name: hit[1].name, how: hit[0] } : null;
    const recent = inIt.some((f) => f.suggested);
    const named = markerOf(b.folder)?.project?.id;
    const asProject = projectAt.get(keyOf(b.folder)) ?? (named ? open.find((p) => p.id.toLowerCase() === named) : undefined)
      ?? open.find((p) => plain(p.name) === plain(path.basename(b.folder)) && !joined.has(p.id));
    return {
      folder: b.folder,
      name: path.basename(b.folder),
      areaId: b.areaId,
      joins,
      asProject: asProject ? { id: asProject.id, name: asProject.name } : null,
      problem: folderProblem(b.folder),
      suggested: !b.areaId && !folderProblem(b.folder) && (joins ? joins.how !== "name" || recent : b.source !== "parent" && recent && !archived(b.folder, null)),
      last: Math.max(0, ...inIt.map(lastOf)),
    };
  }).sort((a, b) => Number(!!b.areaId) - Number(!!a.areaId) || b.last - a.last || a.name.localeCompare(b.name));

  return {
    projects: found.map((f): FoundProject => ({
      folder: f.folder, name: f.name, sources: f.sources, used: f.used, touched: f.touched, projectId: f.projectId, joins: f.joins,
      suggested: f.suggested && !f.problem && !f.projectId, problem: f.problem, repo: f.repo, area: f.area, holds: f.holds, copyOf: f.copyOf,
    })),
    areas: foundAreas.map((a): FoundArea => ({
      folder: a.folder, name: a.name, areaId: a.areaId, joins: a.joins, asProject: a.asProject, problem: a.problem, suggested: a.suggested,
    })),
  };
}

/** The folders that may become projects (findWork), for the callers that don't group them into areas. */
export async function findProjects({ link = true } = {}): Promise<FoundProject[]> {
  return (await findWork({ link })).projects;
}

export interface ImportItem {
  folder: string;
  name: string;
  agent: AgentId | null;
  /** The project the folder joins (FoundProject.joins), instead of becoming a new one. */
  projectId?: string | null;
  /** The area it goes to, by its folder (an area set up in the same import, or one with that workspace here); else the import's area. */
  area?: string | null;
}

/** An area folder to set up: as the workspace here of an area you have (`areaId`), or as a new area named `name`. */
export interface ImportArea {
  folder: string;
  name: string;
  areaId: string | null;
}

/**
 * Makes projects from found folders on this computer (their folders are this computer's), or gives a folder to the
 * project it joins; each goes to its area (`areaOf`, by its item). Folders that already are a project here are
 * skipped, and so is a project that got a folder here meanwhile.
 */
export async function importProjects(items: ImportItem[], areaOf: (item: ImportItem) => string | null): Promise<{ created: Project[]; linked: Project[]; skipped: string[] }> {
  const created: Project[] = [];
  const linked: Project[] = [];
  const skipped: string[] = [];
  const projects = await repo.listAllProjects();
  const taken = new Set(projects.flatMap((p) => (p.folder ? [keyOf(p.folder)] : [])));
  const deviceId = thisDeviceId();
  for (const item of items) {
    const folder = item.folder.trim();
    const key = keyOf(folder);
    const joins = item.projectId ? projects.find((p) => p.id === item.projectId && !p.folder) : undefined;
    const areaId = joins ? null : areaOf(item);
    if (taken.has(key) || folderProblem(folder) || (item.projectId ? !joins : !item.name.trim() || !areaId)) {
      skipped.push(joins?.name || item.name || folder);
      continue;
    }
    taken.add(key);
    if (joins) {
      await linkFolder(joins, folder);
      joins.folder = folder;
      linked.push(joins);
    } else {
      const p = await repo.createProject({ name: item.name.trim(), areaId: areaId!, folder, deviceId, agent: item.agent });
      await markProject(p);
      created.push(p);
    }
  }
  return { created, linked, skipped };
}

/**
 * Sets up the area folders picked in an import: each one the workspace here of an area you have (when that area has
 * none here yet), or a new area with it as its workspace. Returns the area each folder stands for, by folder, with
 * the areas that already have their workspace here.
 */
export async function importAreas(list: ImportArea[]): Promise<{ areaOf: Map<string, string>; created: string[]; linked: string[]; skipped: string[] }> {
  const areas = await repo.listAllAreas();
  const areaOf = new Map(areas.flatMap((a) => (a.folder ? [[keyOf(a.folder), a.id] as const] : [])));
  const created: string[] = [];
  const linked: string[] = [];
  const skipped: string[] = [];
  for (const item of list) {
    const folder = typeof item?.folder === "string" ? item.folder.trim() : "";
    const name = typeof item?.name === "string" ? item.name.trim() : "";
    let area = item?.areaId ? areas.find((a) => a.id === item.areaId) : undefined;
    if (!folder || folderProblem(folder) || (item.areaId ? !area : !name)) {
      skipped.push(area?.name || name || folder || "an area");
      continue;
    }
    if (!area) {
      area = await repo.createArea({ name, color: nextColor(areas.map((a) => a.color)) });
      areas.push(area);
      created.push(area.name);
    }
    if (!area.folder) {
      const problem = await linkWorkspace(area, folder);
      if (problem) {
        skipped.push(area.name);
      } else {
        area.folder = folder;
        if (!created.includes(area.name)) linked.push(area.name);
      }
    }
    areaOf.set(keyOf(folder), area.id);
  }
  return { areaOf, created, linked, skipped };
}

/**
 * This computer's copies of these repositories, for picking an area's workspace here: the folders of projects here
 * and the folders you work in with Claude Code and Codex (import.ts) that hold one of them, by repository.
 */
export async function foldersOfRepos(repos: string[]): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  if (MODE !== "desktop" || !repos.length) return out;
  const wanted = new Set(repos);
  const seen = new Set<string>();
  const found = await findProjects().catch((): FoundProject[] => []);
  for (const folder of [...(await repo.listAllProjects()).flatMap((p) => (p.folder ? [p.folder] : [])), ...found.map((f) => f.folder)]) {
    if (seen.has(folder)) continue;
    seen.add(folder);
    const id = repoIdentity(folder);
    if (id && wanted.has(id)) (out[id] ??= []).push(folder);
  }
  return out;
}
