import "server-only";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { dataDir } from "./device";
import { repoRoot } from "./folders";
import { asks } from "./git-remote";
import { agentEnv } from "./shell";
import type { DiffFileStatus, ReportDiff } from "@/lib/types";

/*
 * What changed in git in a session's folder while the session worked, shown with the agent's report next to what it
 * says it did. When a session starts on this computer (launcher.ts), PacedMind notes the commit the folder is on,
 * whether it had changes that weren't committed, and which files git doesn't track; when the agent hands the task
 * back (ops.finishTask), it compares the folder with that: the commits made since, every changed file with its lines
 * added and removed, and new files git doesn't track. The report keeps that summary; the full diff stays in a file
 * in this computer's data folder (`diffs/`), served only here (/api/diffs/<id>).
 *
 * Git only reads here: no command that changes the repository, its index or its refs, and optional locks are off
 * (GIT_OPTIONAL_LOCKS), so the agent's own git never finds the index locked. Git's own settings can run programs
 * (fsmonitor, external diff tools, text conversions, signature checks), so those are switched off for these commands.
 * The folder is the one the launcher resolved from this computer's settings, noted at the start, never a folder from
 * a session's row. On macOS, a folder in Desktop, Documents, Downloads or a cloud drive isn't read: macOS would stop
 * to ask first (git-remote.ts).
 */

const SESSION_ID = /^[0-9a-f]{16}$/;
const PATCH_ID = /^[0-9a-f]{16}$/;
/** As much of the full diff as PacedMind keeps. */
const MAX_PATCH = 1_000_000;
/** As many files and commits as a report lists; diffOf reads no more. */
const MAX_FILES = 200;
const MAX_COMMITS = 30;
/** Untracked files: how many are noted at the start, and how big a new one may be to go into the diff. */
const MAX_UNTRACKED = 2000;
const MAX_NEW_FILE = 256 * 1024;

const dir = () => path.join(/*turbopackIgnore: true*/ dataDir(), "diffs");
const baseFile = (sessionId: string) => path.join(dir(), `${sessionId}.base.json`);
const patchFile = (patchId: string) => path.join(dir(), `${patchId}.patch`);

/** Where a session's folder stood when it started. */
interface Base {
  folder: string;
  /** The repository's top folder. */
  root: string;
  /** The commit it was on, or the empty tree when it had none yet. */
  commit: string;
  isCommit: boolean;
  dirty: boolean;
  /** Files git doesn't track, by their path from `root`: modification time and size. */
  untracked: Record<string, [number, number]>;
}

type Noted = Base | { folder: string; skipped: "asks" | "git" };

/* ---------- running git ---------- */

let gitPath: string | null = null;

/**
 * Git on this computer. On macOS, /usr/bin/git without Apple's command line tools offers to install them instead of
 * running, so it's only used when they're there (`xcode-select -p`).
 */
function gitBinary(): string | null {
  if (gitPath) return gitPath;
  if (process.platform !== "darwin") return (gitPath = "git");
  for (const p of ["/opt/homebrew/bin/git", "/usr/local/bin/git"]) if (fs.existsSync(p)) return (gitPath = p);
  try {
    execFileSync("/usr/bin/xcode-select", ["-p"], { stdio: "ignore", timeout: 3000 });
    return (gitPath = "/usr/bin/git");
  } catch {
    return null;
  }
}

/** Settings that would make these commands run another program, or change how their output reads. */
const SAFE = [
  "--no-pager", "-c", "core.fsmonitor=false", "-c", "core.quotePath=false", "-c", "color.ui=false", "-c", "log.showSignature=false",
  "-c", "diff.noprefix=false", "-c", "diff.mnemonicPrefix=false", "-c", "diff.relative=false",
];
/** For every diff: no external diff tool, no text conversion. */
const DIFF = ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "-M"];

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...agentEnv(), GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", PAGER: "cat" };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_EXTERNAL_DIFF"]) delete env[k];
  return env;
}

class GitMissing extends Error {}

/** Runs git in `cwd`; `cut` when its output was longer than `maxBuffer` and was cut short. */
function git(cwd: string, args: string[], maxBuffer = 4 << 20): Promise<{ out: string; cut: boolean }> {
  const bin = gitBinary();
  if (!bin) return Promise.reject(new GitMissing());
  return new Promise((resolve, reject) => {
    const child = execFile(/*turbopackIgnore: true*/ bin, [...SAFE, ...args], { cwd, env: gitEnv(), maxBuffer, timeout: 20_000, windowsHide: true, encoding: "utf8" },
      (err, stdout) => {
        if (err && (err as NodeJS.ErrnoException).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return resolve({ out: stdout, cut: true });
        if (err && (err as NodeJS.ErrnoException).code === "ENOENT") return reject(new GitMissing());
        if (err) return reject(err);
        resolve({ out: stdout, cut: false });
      });
    child.stdin?.end();
  });
}

const out = async (cwd: string, args: string[]) => (await git(cwd, args)).out;
const tryOut = (cwd: string, args: string[]) => out(cwd, args).catch((e) => (e instanceof GitMissing ? Promise.reject(e) : null));

/** Files git doesn't track in `folder`, as paths from the repository's top, with their time and size. */
async function untrackedIn(folder: string, root: string, max: number): Promise<Map<string, [number, number]>> {
  const found = new Map<string, [number, number]>();
  const list = await tryOut(folder, ["ls-files", "-o", "--exclude-standard", "-z", "--full-name", "--", "."]);
  for (const rel of (list ?? "").split("\0").filter(Boolean).slice(0, max)) {
    try {
      const st = fs.statSync(path.join(root, rel));
      if (st.isFile()) found.set(rel, [Math.round(st.mtimeMs), st.size]);
    } catch {
      // Gone already.
    }
  }
  return found;
}

/* ---------- the start ---------- */

function writeNoted(sessionId: string, noted: Noted) {
  fs.mkdirSync(dir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(baseFile(sessionId), JSON.stringify(noted), { mode: 0o600 });
}

function readNoted(sessionId: string): Noted | null {
  if (!SESSION_ID.test(sessionId)) return null;
  try {
    const v = JSON.parse(fs.readFileSync(baseFile(sessionId), "utf8")) as Noted;
    return v && typeof v.folder === "string" ? v : null;
  } catch {
    return null;
  }
}

/**
 * Notes where a session's folder stands as it starts. `folder` is the one the launcher resolved from this computer's
 * settings. Once per session: reopening it for changes or resuming it keeps its start. Nothing for a folder that
 * isn't in a git repository. Never throws: a session starts whatever git says.
 */
export async function noteStart(sessionId: string, folder: string): Promise<void> {
  if (!SESSION_ID.test(sessionId) || readNoted(sessionId)) return;
  try {
    if (asks(folder)) return writeNoted(sessionId, { folder, skipped: "asks" });
    const root = repoRoot(folder);
    if (!root) return;
    const head = await tryOut(folder, ["rev-parse", "--verify", "-q", "HEAD"]);
    const commit = head?.trim() || (await out(folder, ["hash-object", "-t", "tree", "--stdin"])).trim();
    const changed = head ? await tryOut(folder, [...DIFF, "--name-only", "-z", "HEAD", "--", "."]) : null;
    const untracked = await untrackedIn(folder, root, MAX_UNTRACKED);
    writeNoted(sessionId, { folder, root, commit, isCommit: !!head?.trim(), dirty: !!changed, untracked: Object.fromEntries(untracked) });
  } catch (e) {
    if (e instanceof GitMissing) writeNoted(sessionId, { folder, skipped: "git" });
    else console.error("[organizer] noting a session's start in git", e);
  }
}

/** A session that continues another in the same terminal starts where that one's folder stands now. */
export async function noteContinued(fromId: string, toId: string): Promise<void> {
  const from = readNoted(fromId);
  if (from) await noteStart(toId, from.folder);
}

/* ---------- the hand-back ---------- */

const STATUS: Record<string, DiffFileStatus> = { A: "added", C: "added", D: "deleted", R: "renamed" };

type FileRow = ReportDiff["files"][number];

/** `git diff --name-status -z` and `--numstat -z`, joined by path. */
function trackedFiles(names: string, stats: string): FileRow[] {
  const counts = new Map<string, [number | null, number | null]>();
  const s = stats.split("\0");
  for (let i = 0; i < s.length; i++) {
    if (!s[i]) continue;
    const [a, r, p] = s[i].split("\t");
    const file = p || s[(i += 2)];
    if (file) counts.set(file, [a === "-" ? null : Number(a) || 0, r === "-" ? null : Number(r) || 0]);
  }
  const rows: FileRow[] = [];
  const n = names.split("\0");
  for (let i = 0; i < n.length; i++) {
    const code = n[i];
    if (!code) continue;
    const letter = code[0];
    const from = letter === "R" || letter === "C" ? n[++i] : undefined;
    const file = n[++i];
    if (!file) break;
    const [added, removed] = counts.get(file) ?? [null, null];
    rows.push({ path: file, status: STATUS[letter] ?? "modified", added, removed, ...(from && letter === "R" ? { from } : {}) });
  }
  return rows;
}

/** A new file git doesn't track, as a diff of its own: its lines, or null when it's binary or too big to read. */
function newFilePatch(root: string, rel: string, size: number): { lines: number | null; patch: string } {
  const head = `diff --git a/${rel} b/${rel}\nnew file, not tracked by git\n`;
  if (size > MAX_NEW_FILE) return { lines: null, patch: `${head}(${Math.round(size / 1024)} KB, not shown)\n` };
  let buf: Buffer;
  try {
    buf = fs.readFileSync(path.join(root, rel));
  } catch {
    return { lines: null, patch: "" };
  }
  if (buf.includes(0)) return { lines: null, patch: `${head}Binary file\n` };
  const text = buf.toString("utf8");
  if (!text) return { lines: 0, patch: `${head}(empty)\n` };
  const lines = text.split("\n");
  const last = lines[lines.length - 1] === "" ? lines.pop() ?? "" : null;
  const body = lines.map((l) => `+${l}`).join("\n");
  return {
    lines: lines.length,
    patch: `${head}--- /dev/null\n+++ b/${rel}\n@@ -0,0 +1,${lines.length} @@\n${body}\n${last === null ? "\\ No newline at end of file\n" : ""}`,
  };
}

/**
 * What changed in a session's folder since it started, for its report: the summary, with the full diff saved in this
 * computer's data folder. Null when PacedMind didn't note the session's start here (it started elsewhere, before this
 * version, or not in a git repository) or git failed.
 */
export async function takeDiff(sessionId: string): Promise<ReportDiff | null> {
  const noted = readNoted(sessionId);
  if (!noted) return null;
  const none = { base: "", head: "", commits: [], moreCommits: 0, files: [], moreFiles: 0, added: 0, removed: 0, dirtyAtStart: false, patchId: null, truncated: false };
  if ("skipped" in noted) return { ...none, skipped: noted.skipped };
  const { folder, root, commit } = noted;
  if (!fs.existsSync(folder)) return null;
  try {
    const head = (await tryOut(folder, ["rev-parse", "--verify", "-q", "HEAD"]))?.trim() ?? "";
    const short = async (sha: string) => (await tryOut(folder, ["rev-parse", "--short", sha]))?.trim() ?? sha.slice(0, 7);
    // The commits made since: those reachable from where it is now and not from where it started.
    const range = head ? (noted.isCommit ? [`${commit}..HEAD`] : ["HEAD"]) : null;
    const log = range ? await tryOut(folder, ["log", `--format=%h%x1f%s%x1e`, `-n`, String(MAX_COMMITS), ...range]) : null;
    const commits = (log ?? "").split("\x1e").map((x) => x.trim()).filter(Boolean)
      .map((x) => { const [sha, subject = ""] = x.split("\x1f"); return { sha, subject: subject.slice(0, 200) }; });
    const total = range ? Number((await tryOut(folder, ["rev-list", "--count", ...range]))?.trim()) || commits.length : 0;

    const [names, stats, patch] = await Promise.all([
      out(folder, [...DIFF, "--name-status", "-z", commit, "--", "."]),
      out(folder, [...DIFF, "--numstat", "-z", commit, "--", "."]),
      git(folder, [...DIFF, commit, "--", "."], MAX_PATCH + 1024),
    ]);
    const files = trackedFiles(names, stats);
    let text = patch.out;
    let truncated = patch.cut;

    // New files git doesn't track, unless they were there, unchanged, when it started.
    const now = await untrackedIn(folder, root, MAX_UNTRACKED);
    for (const [rel, [mtime, size]] of now) {
      const was = noted.untracked[rel];
      if (was && was[0] === mtime && was[1] === size) continue;
      const one = newFilePatch(root, rel, size);
      files.push({ path: rel, status: "untracked", added: one.lines, removed: 0 });
      if (text.length + one.patch.length <= MAX_PATCH) text += one.patch;
      else truncated = true;
    }
    if (text.length > MAX_PATCH) {
      text = text.slice(0, MAX_PATCH);
      truncated = true;
    }
    let patchId: string | null = null;
    if (text) {
      patchId = crypto.randomBytes(8).toString("hex");
      fs.mkdirSync(dir(), { recursive: true, mode: 0o700 });
      fs.writeFileSync(patchFile(patchId), text, { mode: 0o600 });
    }
    return {
      base: await short(commit), head: head ? await short(head) : "",
      commits, moreCommits: Math.max(0, total - commits.length),
      files: files.slice(0, MAX_FILES).map((f) => ({ ...f, path: f.path.slice(0, 500), ...(f.from ? { from: f.from.slice(0, 500) } : {}) })),
      moreFiles: Math.max(0, files.length - MAX_FILES),
      added: files.reduce((n, f) => n + (f.added ?? 0), 0), removed: files.reduce((n, f) => n + (f.removed ?? 0), 0),
      dirtyAtStart: noted.dirty, patchId, truncated, skipped: null,
    };
  } catch (e) {
    if (e instanceof GitMissing) return { ...none, skipped: "git" };
    console.error("[organizer] taking a session's diff", e);
    return null;
  }
}

/* ---------- the files ---------- */

/** A report's full diff, when it's on this computer. */
export function readPatch(patchId: string): string | null {
  if (!PATCH_ID.test(patchId)) return null;
  try {
    return fs.readFileSync(patchFile(patchId), "utf8");
  } catch {
    return null;
  }
}

/** Removes what this computer keeps for these sessions and reports' diffs, e.g. after their task was deleted. */
export function removeDiffFiles(sessionIds: string[], patchIds: (string | null | undefined)[]) {
  for (const id of sessionIds) if (SESSION_ID.test(id)) fs.rmSync(baseFile(id), { force: true });
  for (const id of patchIds) if (id && PATCH_ID.test(id)) fs.rmSync(patchFile(id), { force: true });
}
