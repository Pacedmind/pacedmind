import "server-only";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { readSecureJson, writeSecureJson } from "./secure-file";
import { folderProblem } from "./folders";
import { nowStamp } from "@/lib/dates";
import type { AgentId, RemoteStart, TerminalId } from "@/lib/types";

/*
 * What this computer decides for itself, never the cloud: how agents start (commands, terminal), where each
 * project's and task's sessions run, what happens to sessions requested from elsewhere, and the MCP tokens agents
 * use. It lives in an encrypted file next to the
 * app's data (secure-file.ts), so nothing a browser, another computer or a compromised database writes can
 * change what runs here. Only the desktop app's own window (see proxy.ts) changes it.
 */

export interface DeviceConfig {
  /** The account these settings belong to. Another account signing in starts from the defaults. */
  userId: string | null;
  /** This computer in the account's list (the devices table), once registered. */
  deviceId: string | null;
  /** The auth session the devices row was last pointed at (claim_device). */
  claimedSession: string | null;
  name: string;
  terminal: TerminalId;
  claudeCommand: string;
  codexCommand: string;
  /** Project id → the folder its sessions run in. */
  folders: Record<string, string>;
  /** Area id → default workspace on this computer, inherited by tasks and projects without their own folder. */
  areaFolders: Record<string, string>;
  /**
   * Task → its own folder (a workspace), for tasks that don't run in their project's folder. Keyed by
   * taskFolderKey: the account's tasks and this computer's own (the free plan's) are numbered separately.
   */
  taskFolders: Record<string, string>;
  /**
   * Project id → the MCP servers besides PacedMind its sessions get here, by name (Settings). A project that isn't
   * listed gets all of them, as Claude Code and Codex would give them anyway; an empty list gets PacedMind's alone.
   */
  servers: Record<string, string[]>;
  /**
   * What starting this computer's own data over made it forget (its projects' and areas' folders and MCP servers, its
   * tasks' folders), by the copy of the data kept before it (store/local-db.ts), so putting that copy back brings
   * them back too. Here rather than in the copy, so a file in the data folder can't choose where sessions run.
   */
  copies?: Record<string, KeptSettings>;
  remoteStart: RemoteStart;
  /**
   * Whether sessions asked for from elsewhere need a two-factor code entered in the last five minutes (on by default).
   * Off, any two-factor session of the account can ask: the account's entry for this computer says so (remote_code, which
   * the database takes only from this computer's own sign-in), and requests.ts refuses a request without a code while
   * this is on, whatever that entry said.
   */
  remoteCode: boolean;
  /**
   * Whether the launcher answers Claude Code's and Codex's question whether you trust a session's folder before the
   * session starts there (claude-trust.ts, codex-trust.ts), so a session never waits for it in its terminal.
   */
  trustFolders: boolean;
  /**
   * Whether this computer's sessions wait for your answers in PacedMind on your other devices too (asks.ts): a
   * permission Claude Code asks for waits there for up to ten minutes while its terminal asks as well, and answers
   * from the web app or another computer count. Off, only this computer's window and terminal answer.
   */
  remoteAnswers: boolean;
  /**
   * By agent: the MCP servers its sessions here get from the account its CLI is signed in to (Claude Code's claude.ai
   * connectors), which no config file names, as the last session PacedMind started here without a project's pick
   * reported them (start_task), and when. Each computer's CLI can be signed in to another account, with others.
   */
  fromAccount?: Partial<Record<AgentId, { names: string[]; at: string }>>;
  /**
   * Whether a Codex session here has run PacedMind's hooks (its SessionStart said so): once you've trusted them, which
   * Codex asks the first time. Until then, a Codex session's start says what to answer.
   */
  codexHooksSeen?: boolean;
  /** For Claude Code and Codex that you start yourself (Settings shows it). */
  ownerToken: string;
  /**
   * Tokens of the sessions PacedMind started, by SHA-256 hash: each works for its session's task until the
   * session ends, is finished or done, or a day has passed.
   */
  sessionTokens: Record<string, { sessionId: string; taskId: number; issuedAt: string; expires?: number }>;
  /** Once the import of the folders you work in with Claude Code and Codex was offered here (it opens by itself once). */
  importOffered: boolean;
  /** Copies of projects and areas found here ("id>folder") you said not to link, so the offer doesn't come back for them. */
  linkOfferSeen: string[];
  /**
   * Once connecting Claude Code and Codex to PacedMind Cloud's MCP server was offered here after signing in (it shows
   * by itself once per account; Settings → Connect does the same any time).
   */
  cloudConnectOffered?: boolean;
  /**
   * "Continue without an account" was chosen on the sign-in screen and nobody signed in since, so the app
   * opens with this computer's own data instead of asking. Signing in clears it: after signing out it asks again.
   */
  withoutAccount: boolean;
}

export const dataDir = () =>
  process.env.ORGANIZER_DB ? path.dirname(process.env.ORGANIZER_DB) : path.join(/*turbopackIgnore: true*/ process.cwd(), "data");

const file = () => path.join(/*turbopackIgnore: true*/ dataDir(), "device.json");

const newOwnerToken = () => `pm_${crypto.randomBytes(32).toString("base64url")}`;
const hash = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

function defaults(userId: string | null, keep?: DeviceConfig): DeviceConfig {
  return {
    userId,
    deviceId: null,
    claimedSession: null,
    name: keep?.name ?? os.hostname().slice(0, 80) ?? "This computer",
    terminal: keep?.terminal ?? (process.platform === "darwin" ? "terminal" : "wt"),
    claudeCommand: keep?.claudeCommand ?? "claude",
    codexCommand: keep?.codexCommand ?? "codex",
    folders: {},
    areaFolders: {},
    taskFolders: {},
    servers: {},
    remoteStart: "ask",
    remoteCode: true,
    trustFolders: keep?.trustFolders ?? true,
    remoteAnswers: keep?.remoteAnswers ?? false,
    ownerToken: newOwnerToken(),
    sessionTokens: {},
    importOffered: false,
    linkOfferSeen: [],
    withoutAccount: false,
  };
}

const g = globalThis as unknown as { __pacedmindDevice?: DeviceConfig };

export function deviceConfig(): DeviceConfig {
  if (!g.__pacedmindDevice) g.__pacedmindDevice = { ...defaults(null), ...(readSecureJson<Partial<DeviceConfig>>(file()) ?? {}) };
  return g.__pacedmindDevice;
}

function save(next: DeviceConfig) {
  writeSecureJson(file(), next);
  g.__pacedmindDevice = next;
}

export function updateDevice(patch: Partial<DeviceConfig>) {
  save({ ...deviceConfig(), ...patch });
}

/**
 * Makes sure the settings belong to `userId`. The first account to sign in on this computer takes over what
 * was set up here without one (the free plan's folders, agent commands and MCP token), so
 * moving this computer's data to Cloud keeps them; the free plan's sessions lose their tokens, since their
 * sessions stay behind. When another account signs in later, everything starts over, so nothing carries
 * across accounts.
 */
export function deviceFor(userId: string): DeviceConfig {
  const current = deviceConfig();
  if (current.userId === userId) return current;
  const next = current.userId === null
    ? { ...current, userId, deviceId: null, claimedSession: null, sessionTokens: {}, cloudConnectOffered: false }
    : defaults(userId, current);
  save(next);
  return next;
}

/* ---------- commands and terminal ---------- */

/** Characters cmd.exe and sh treat specially; an agent command never needs them. */
const UNSAFE_COMMAND = /[&|<>^%!`$;()\r\n\u0000-\u001f]/;

export function commandProblem(command: string): string | null {
  const c = command.trim();
  if (!c) return "Enter the command that starts the agent, like claude.";
  if (c.length > 300) return "That command is too long.";
  if (UNSAFE_COMMAND.test(c)) return "Use a plain command with its options; & | < > ^ % ! ` $ ; and brackets aren't allowed.";
  return null;
}

export function agentCommandFor(agent: AgentId): string {
  const d = deviceConfig();
  const command = agent === "claude" ? d.claudeCommand : d.codexCommand;
  // The file could have been edited by hand; never run what the settings screen would have refused.
  return commandProblem(command) ? agent : command.trim();
}

/* ---------- folders ---------- */

export const projectFolder = (projectId: string | null | undefined): string | null =>
  (projectId && deviceConfig().folders[projectId]) || null;

export const areaFolder = (areaId: string | null | undefined): string | null =>
  (areaId && deviceConfig().areaFolders?.[areaId]) || null;

/** Changes an area's workspace on this computer. Returns why it can't, or null. */
export function setAreaFolder(areaId: string, folder: string | null): string | null {
  const d = deviceConfig();
  if (folder) {
    const problem = folderProblem(folder);
    if (problem) return problem;
  }
  if (areaFolder(areaId) === folder) return null;
  const areaFolders = { ...d.areaFolders };
  if (folder) areaFolders[areaId] = folder;
  else delete areaFolders[areaId];
  save({ ...d, areaFolders });
  return null;
}

export function forgetArea(areaId: string) {
  const d = deviceConfig();
  if (!d.areaFolders?.[areaId]) return;
  const areaFolders = { ...d.areaFolders };
  delete areaFolders[areaId];
  save({ ...d, areaFolders });
}

/** Sets or clears where a project's sessions run on this computer. Returns why it can't, or null. */
export function setProjectFolder(projectId: string, folder: string | null): string | null {
  const d = deviceConfig();
  const folders = { ...d.folders };
  if (folder) {
    const problem = folderProblem(folder);
    if (problem) return problem;
    folders[projectId] = folder;
  } else {
    delete folders[projectId];
  }
  save({ ...d, folders });
  return null;
}

/** Which tasks a task id belongs to: the signed-in account's (Cloud), or this computer's own. */
export type TaskScope = "cloud" | "local";

/** Both number their tasks from 1, so this computer's own tasks get a prefix. */
const taskFolderKey = (scope: TaskScope, taskId: number) => (scope === "local" ? `local:${taskId}` : String(taskId));

/** A task's own folder on this computer, when it doesn't run in its project's. */
export const taskFolder = (scope: TaskScope, taskId: number): string | null => deviceConfig().taskFolders?.[taskFolderKey(scope, taskId)] ?? null;

/** Sets or clears a task's own folder on this computer. Returns why it can't, or null. */
export function setTaskFolder(scope: TaskScope, taskId: number, folder: string | null): string | null {
  const d = deviceConfig();
  const taskFolders = { ...(d.taskFolders ?? {}) };
  const key = taskFolderKey(scope, taskId);
  if (folder) {
    const problem = folderProblem(folder);
    if (problem) return problem;
    taskFolders[key] = folder;
  } else {
    delete taskFolders[key];
  }
  save({ ...d, taskFolders });
  return null;
}

/** Forgets a deleted task's folder. */
export function forgetTask(scope: TaskScope, taskId: number) {
  const d = deviceConfig();
  const key = taskFolderKey(scope, taskId);
  if (!d.taskFolders?.[key]) return;
  const taskFolders = { ...d.taskFolders };
  delete taskFolders[key];
  save({ ...d, taskFolders });
}

/**
 * Forgets the folders and MCP servers of these projects, and every task folder of `scope`: after the
 * account's data or this computer's own was started over, or this computer's was moved to Cloud.
 */
export function forgetAll(scope: TaskScope, projectIds: string[], areaIds: string[]) {
  const d = deviceConfig();
  const gone = new Set(projectIds);
  const goneAreas = new Set(areaIds);
  const areaFolders = Object.fromEntries(Object.entries(d.areaFolders ?? {}).filter(([id]) => !goneAreas.has(id)));
  const local = (key: string) => key.startsWith("local:");
  const folders = Object.fromEntries(Object.entries(d.folders).filter(([id]) => !gone.has(id)));
  const taskFolders = Object.fromEntries(Object.entries(d.taskFolders ?? {}).filter(([key]) => local(key) !== (scope === "local")));
  const servers = Object.fromEntries(Object.entries(d.servers ?? {}).filter(([id]) => !gone.has(id)));
  save({ ...d, folders, areaFolders, taskFolders, servers });
}

/** This computer's settings for some of its own data's projects, areas and tasks, kept with a copy of that data. */
export type KeptSettings = Pick<DeviceConfig, "folders" | "areaFolders" | "taskFolders" | "servers">;

/**
 * Keeps what forgetAll("local", projectIds, areaIds) is about to drop, with the copy of this computer's own data
 * made before it was started over or replaced.
 */
export function keepForCopy(copy: string, projectIds: string[], areaIds: string[]) {
  const d = deviceConfig();
  const projects = new Set(projectIds);
  const areas = new Set(areaIds);
  const pick = <T>(all: Record<string, T> | undefined, keep: (key: string) => boolean) =>
    Object.fromEntries(Object.entries(all ?? {}).filter(([key]) => keep(key)));
  const kept: KeptSettings = {
    folders: pick(d.folders, (id) => projects.has(id)),
    areaFolders: pick(d.areaFolders, (id) => areas.has(id)),
    taskFolders: pick(d.taskFolders, (key) => key.startsWith("local:")),
    servers: pick(d.servers, (id) => projects.has(id)),
  };
  save({ ...d, copies: { ...(d.copies ?? {}), [copy]: kept } });
}

/** Brings back what was kept with a copy, once its data is back in place (after forgetAll for the data it replaced). */
export function bringBackForCopy(copy: string) {
  const d = deviceConfig();
  const kept = d.copies?.[copy];
  if (!kept) return;
  save({
    ...d,
    folders: { ...d.folders, ...kept.folders },
    areaFolders: { ...(d.areaFolders ?? {}), ...kept.areaFolders },
    taskFolders: { ...(d.taskFolders ?? {}), ...kept.taskFolders },
    servers: { ...(d.servers ?? {}), ...kept.servers },
  });
}

/** Lets go of what was kept with copies that are gone. */
export function keepOnlyCopies(names: string[]) {
  const d = deviceConfig();
  const still = new Set(names);
  const copies = Object.fromEntries(Object.entries(d.copies ?? {}).filter(([name]) => still.has(name)));
  if (Object.keys(copies).length !== Object.keys(d.copies ?? {}).length) save({ ...d, copies });
}

/** Forgets a deleted project's folder and MCP servers. */
export function forgetProject(projectId: string) {
  const d = deviceConfig();
  if (!(projectId in d.folders) && !(projectId in (d.servers ?? {}))) return;
  const folders = { ...d.folders };
  delete folders[projectId];
  const servers = { ...(d.servers ?? {}) };
  delete servers[projectId];
  save({ ...d, folders, servers });
}

/** The MCP servers besides PacedMind that a project's sessions get on this computer, by name: null for all of them. */
export const projectServers = (projectId: string | null | undefined): string[] | null =>
  (projectId && deviceConfig().servers?.[projectId]) || null;

/** Sets which MCP servers a project's sessions get here (null: all of them). Names only; the launcher reads the rest. */
export function setProjectServers(projectId: string, names: string[] | null) {
  const d = deviceConfig();
  const servers = { ...(d.servers ?? {}) };
  if (names) servers[projectId] = [...new Set(names.filter((n) => /^[\w.@:+-]{1,48}$/.test(n)))].sort().slice(0, 40);
  else delete servers[projectId];
  save({ ...d, servers });
}

/* ---------- MCP tokens ---------- */

/** Who an MCP request acts for: you (your own agents) or one session PacedMind started. */
export type Principal = { kind: "owner" } | { kind: "session"; sessionId: string; taskId: number };

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(hash(a), "hex");
  const y = Buffer.from(hash(b), "hex");
  return crypto.timingSafeEqual(x, y);
}

export function principalFor(token: string): Principal | null {
  if (!token || token.length > 200) return null;
  const d = deviceConfig();
  if (d.ownerToken && sameToken(token, d.ownerToken)) return { kind: "owner" };
  const s = d.sessionTokens[hash(token)];
  if (!s) return null;
  if (!s.expires || s.expires <= Date.now()) {
    revokeSessionTokens([s.sessionId]);
    return null;
  }
  return { kind: "session", sessionId: s.sessionId, taskId: s.taskId };
}

const SESSION_TOKEN_TTL = 24 * 60 * 60_000;

export function rotateOwnerToken(): string {
  const token = newOwnerToken();
  updateDevice({ ownerToken: token });
  return token;
}

/** A token for one session's agent: it works for that session's tools until the session ends. */
export function issueSessionToken(sessionId: string, taskId: number): string {
  const token = `pms_${crypto.randomBytes(32).toString("base64url")}`;
  const d = deviceConfig();
  // Keep the file small: a session only ever needs its latest token.
  const sessionTokens = Object.fromEntries(Object.entries(d.sessionTokens).filter(([, v]) => v.sessionId !== sessionId));
  sessionTokens[hash(token)] = { sessionId, taskId, issuedAt: nowStamp(), expires: Date.now() + SESSION_TOKEN_TTL };
  save({ ...d, sessionTokens });
  return token;
}

/** Called when a session's terminal closes or you close the session: its agent loses access. */
export function revokeSessionTokens(sessionIds: string[]) {
  const d = deviceConfig();
  const ids = new Set(sessionIds);
  const sessionTokens = Object.fromEntries(Object.entries(d.sessionTokens).filter(([, v]) => !ids.has(v.sessionId)));
  if (Object.keys(sessionTokens).length !== Object.keys(d.sessionTokens).length) save({ ...d, sessionTokens });
}

/** Every session token at once: signing out, or this computer being signed out elsewhere. */
export function revokeAllSessionTokens() {
  const d = deviceConfig();
  if (Object.keys(d.sessionTokens).length) save({ ...d, sessionTokens: {} });
}

export function thisPlatform(): "windows" | "macos" | "linux" {
  return process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
}
