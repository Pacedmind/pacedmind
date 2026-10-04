import type { AgentUse } from "./usage";
import type { AreaIcon } from "./area-icons";

export type Status = "backlog" | "todo" | "progress" | "review" | "done" | "canceled";
/** Linear-style priority: 0 none, 1 urgent, 2 high, 3 medium, 4 low. */
export type Priority = 0 | 1 | 2 | 3 | 4;
export type AgentId = "claude" | "codex";
/** Who does a task: an agent, or you ("human"). Tasks that are yours never get an agent session. */
export type Doer = AgentId | "human";

/** How a task comes back once it's done: every day, every weekday (Monday to Friday), every week or every month. */
export type Repeat = "day" | "weekday" | "week" | "month";
export const REPEATS: Repeat[] = ["day", "weekday", "week", "month"];
export const REPEAT_LABEL: Record<Repeat, string> = { day: "Every day", weekday: "Every weekday", week: "Every week", month: "Every month" };
export const repeatOf = (v: unknown): Repeat | null => (REPEATS.includes(v as Repeat) ? (v as Repeat) : null);
export type SessionStatus = "starting" | "running" | "finished" | "done" | "closed" | "failed";
/**
 * Where an agent session runs: in a terminal or the agent's desktop app on a device where PacedMind is
 * installed, or in the provider's cloud (Claude Code on the web, Codex cloud).
 */
export type Surface = "terminal" | "desktop" | "cloud";
/** Whether PacedMind's MCP server is set up for sessions it doesn't configure itself (desktop apps). */
/**
 * Whether an agent's own config reaches this PacedMind: `connected` as "pacedmind" with this computer's token; `old`
 * under its old name, "organizer" (it works, and Connect renames it); `cloud` through PacedMind Cloud's MCP server,
 * signed in with the account (while this computer is signed in to it); `elsewhere` for another PacedMind; `missing`.
 */
export type McpLink = "connected" | "old" | "cloud" | "elsewhere" | "missing";

/** Whether sessions in the agent's desktop app (and those you start yourself) report back to PacedMind. */
export const mcpReaches = (link: McpLink) => link === "connected" || link === "old" || link === "cloud";

/** The MCP server's name in the agents' configs: its tools are mcp__pacedmind__<tool>. */
export const MCP_NAME = "pacedmind";
/** Its name before, which configs set up earlier still have (Connect replaces it). */
export const OLD_MCP_NAME = "organizer";
/** The web app's cookie for Not now on its card about connecting an agent (agent-connect-card.tsx). */
export const CONNECT_CARD_COOKIE = "pm_connect_card";
/** How an agent handed a task back: all of it ready, part of it, or stuck until the user decides something. */
export type ReportOutcome = "done" | "partial" | "blocked";
/** An agent's answer to one "Done when" item. */
export type Verdict = "met" | "partly" | "not_met";

/** A session that is (about to be) at work in a terminal. */
export const isLiveSession = (s: { status: SessionStatus }) => s.status === "starting" || s.status === "running";
export const LIVE_STATUSES: SessionStatus[] = ["starting", "running"];

/**
 * What a desktop app does with a session asked for from elsewhere (the web app, another computer): refuse
 * it, ask you on that computer first, or start it right away. Whether asking takes a fresh 2FA code is the
 * computer's other setting (`remoteCode`).
 */
export type RemoteStart = "off" | "ask" | "auto";

export interface Area {
  id: string;
  /** Default workspace on this computer only; tasks and projects can override it. */
  folder: string | null;
  name: string;
  key: string;
  color: string;
  /** Shown in the area's color instead of its dot; null shows the dot. */
  icon: AreaIcon | null;
  /**
   * A hash of the area's own picture (area-picture.ts), shown instead of the icon and served by
   * /api/areas/[id]/picture, which the hash keeps cacheable; null when it has none. An area has a picture or an icon.
   */
  picture: string | null;
  sort: number;
  /**
   * The git repository its workspace holds, as host/owner/name (and "#subfolder" inside one), like Project.repo: read
   * from its workspace on a computer, so your other computers can offer their copy of it. Null until one saw it.
   */
  repo: string | null;
}

/**
 * A repository's page on the web, from Project.repo or Area.repo: https://host/owner/name, and the subfolder within
 * it on GitHub. The label is the repository as host/owner/name.
 */
export function repoLink(repo: string | null | undefined): { label: string; url: string } | null {
  if (!repo) return null;
  const [path, sub] = repo.split("#");
  if (!/^[a-z0-9][a-z0-9.-]*(\/[a-z0-9._~-]+)+$/.test(path)) return null;
  const tree = sub && path.startsWith("github.com/") ? `/tree/HEAD/${sub.split("/").map(encodeURIComponent).join("/")}` : "";
  return { label: path, url: `https://${path}${tree}` };
}

/** A folder on this computer that looks like a project's or an area's copy: the same repository, or else its name. */
export interface FoundFolder {
  folder: string;
  repo: string | null;
  /**
   * How it was recognised: its pacedmind.md names it, it holds the same repository, the projects of yours in it are
   * that area's (an area's folder), or it has the same name.
   */
  how: "marker" | "repo" | "projects" | "name";
}

/**
 * Where your projects and areas are on this computer (desktop app, folder-hints.ts): for those without a folder here,
 * the copies of them found here, and where PacedMind makes a folder for a task that has none.
 */
export interface FolderHints {
  projects: Record<string, FoundFolder[]>;
  areas: Record<string, FoundFolder[]>;
  /** PacedMind's own folders for tasks without one are made in here, one per task (task-folder.ts). */
  workspaces: string;
}

export interface Project {
  id: string;
  areaId: string;
  name: string;
  /** Own color; null means the area's color is used. */
  color: string | null;
  startDate: string | null;
  targetDate: string | null;
  /** Where its sessions run on this computer; set in the desktop app, never stored in the cloud. */
  folder: string | null;
  /** The computer its sessions run on; null means whichever computer starts them. */
  deviceId: string | null;
  /** The Codex cloud environment (its label or id) that tasks sent to Codex cloud run in. */
  codexEnv: string | null;
  /**
   * Its git repository as host/owner/name (and "#subfolder" inside one), read from its folder on a computer, so each
   * computer recognizes the project in its own copy. Null until a computer with its folder saw one.
   */
  repo: string | null;
  agent: AgentId | null;
  afterProjectId: string | null;
  sort: number;
}

export interface Subtask {
  id: number;
  taskId: number;
  title: string;
  done: boolean;
  sort: number;
}

export interface Task {
  /** Explicit settings for the agent account on the selected computer; null preserves its defaults. */
  modelSettings: import("./agent-models").ModelSelection | null;
  id: number;
  key: string;
  areaId: string | null;
  projectId: string | null;
  title: string;
  description: string;
  status: Status;
  priority: Priority;
  /** "YYYY-MM-DD" or "YYYY-MM-DDTHH:mm" (local time). */
  dueDate: string | null;
  /** "YYYY-MM-DD": the day you mean to work on it. */
  plannedDate: string | null;
  /** "HH:mm": when on its planned day, for `estimateMin` minutes (a block in the week calendar). Null lets the auto-planner place it. */
  plannedTime: string | null;
  estimateMin: number;
  /**
   * A project it's about without being part of it (it lives in its area): its page lists it under Related, and it
   * counts nowhere in the project's progress or dates.
   */
  relatedProjectId: string | null;
  /** Done, it comes back as a new task at its next date (ops.ts, repeatTask). */
  repeat: Repeat | null;
  labels: string[];
  /** What must be true when the task is finished, one checkable outcome per item. Agents answer each when they hand it back. */
  doneWhen: string[];
  /**
   * What its agent needs from the computer its session runs on, by name: MCP servers or claude.ai connectors, such as
   * "supabase" or "Gmail" (src/lib/needs.ts). PacedMind offers a computer that has them.
   */
  needs: string[];
  reminder: string | null;
  agent: Doer | null;
  /** Where its agent sessions run; null picks the terminal when the agent's CLI is installed, else its desktop app. */
  runIn: Surface | null;
  /** The computer its sessions run on; null means the project's computer. */
  deviceId: string | null;
  /** Its own working folder on this computer; null inherits the project's, then the area's workspace. Never stored in the cloud. */
  folder: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  subtasks: Subtask[];
}

export interface CalEvent {
  id: number;
  title: string;
  areaId: string | null;
  /** "YYYY-MM-DDTHH:mm" local. For weekly events this is the first occurrence. */
  start: string;
  end: string;
  recurrence: "weekly" | null;
  /** The days ("YYYY-MM-DD") whose occurrence you marked done: one for a one-off activity, any for a weekly one. */
  doneOn: string[];
}

/** One concrete occurrence of a CalEvent within a range. */
export interface EventOccurrence {
  eventId: number;
  title: string;
  areaId: string | null;
  start: string;
  end: string;
  /** Its event repeats every week, so a change to this occurrence changes every week. */
  weekly: boolean;
  /** You marked this occurrence done (on its own day only, for a weekly one). */
  done: boolean;
}

export interface Session {
  id: string;
  taskId: number;
  agent: AgentId;
  surface: Surface;
  /** The computer it runs on, or the one that sent it to the cloud. */
  deviceId: string | null;
  folder: string | null;
  branch: string | null;
  /** Where to follow it, e.g. claude.ai/code for cloud sessions. */
  url: string | null;
  status: SessionStatus;
  startedAt: string;
  finishedAt: string | null;
  endedAt: string | null;
  note: string | null;
  cliSessionId: string | null;
  /** What its agent used, as the agent reported it (its usage metrics, the usage route); null until it did. */
  usage?: SessionUsage | null;
}

/** Tokens an agent used, as its records count them: read fresh, read from its cache, written to its cache, and written. */
export interface TokenCounts {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

/**
 * What a session's agent used, as Claude Code's usage metrics report it (OpenTelemetry): tokens per conversation it ran,
 * by its own id for it (a request for changes starts a new one), what they'd cost at API prices, how long it worked,
 * and the models it ran, the latest first.
 */
export interface SessionUsage {
  conversations: Record<string, TokenCounts>;
  /** US dollars at API prices, as Claude Code counts them (on a plan, not what you pay). Kept, but not shown. */
  costUsd: number;
  /** Seconds the agent was working (not waiting for you). */
  activeSeconds: number;
  models: string[];
  /** When it last reported. */
  at: string;
}

export interface SessionEvent {
  id: number;
  sessionId: string;
  at: string;
  kind: string;
  text: string;
}

/** An image an agent attached to a task, such as a screenshot of the result. Served at /api/attachments/<id>. */
export interface Attachment {
  id: string;
  taskId: number;
  sessionId: string | null;
  /** The report it belongs to; null while the session is still working. */
  reportId: number | null;
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
  caption: string;
  createdAt: string;
}

/** A "Done when" item as the agent answered it. The text is kept as it was, so later edits don't change old reports. */
export interface ReportCriterion {
  text: string;
  /** Null when the agent didn't answer this item. */
  verdict: Verdict | null;
  note: string;
}

/** What an agent handed back with finish_task: one per hand-back, so a session that is resumed can have several. */
export interface Report {
  id: number;
  sessionId: string;
  taskId: number;
  agent: AgentId;
  outcome: ReportOutcome;
  summary: string;
  /** Markdown. */
  details: string;
  criteria: ReportCriterion[];
  /** Steps the user can follow to check the result. */
  verify: string[];
  questions: string[];
  links: { label: string; url: string }[];
  /** Tasks the agent created for work outside this one. Title and href are null when the task is gone. */
  followUps: { key: string; title: string | null; href: string | null }[];
  createdAt: string;
  images: Attachment[];
  /** What the user asked to change after reading this report; the agent gets it through start_task. */
  changes: string | null;
  changesAt: string | null;
  /** What changed in git in the session's folder since the session started, as PacedMind saw it at the hand-back. */
  diff: ReportDiff | null;
}

/** How a file changed since a session started: in git's terms, or a new file git doesn't track. */
export type DiffFileStatus = "added" | "modified" | "deleted" | "renamed" | "untracked";

/**
 * What changed in git in a session's folder between the session's start and its hand-back (src/server/diff.ts): the
 * commits made since, and every changed file with its lines added and removed, counting what isn't committed yet and
 * new files git doesn't track. The full diff stays on the computer the session ran on (`patchId`, /api/diffs/<id>).
 * `skipped` says why there's none, when PacedMind couldn't look.
 */
export interface ReportDiff {
  /** The commits the session started from and ended on, abbreviated. */
  base: string;
  head: string;
  /** Commits made since the start, newest first; `moreCommits` counts the ones left out. */
  commits: { sha: string; subject: string }[];
  moreCommits: number;
  /** `added` and `removed` are null for a binary file; `from` is a renamed file's old path. */
  files: { path: string; status: DiffFileStatus; added: number | null; removed: number | null; from?: string }[];
  moreFiles: number;
  added: number;
  removed: number;
  /** The folder had changes that weren't committed when the session started: they show here too. */
  dirtyAtStart: boolean;
  /** The full diff's file on the computer the session ran on; null when there was nothing to keep. */
  patchId: string | null;
  /** The full diff was longer than PacedMind keeps, so it's cut short. */
  truncated: boolean;
  /** Why there's no diff: the folder is where macOS asks before PacedMind reads it, or git isn't there or failed. */
  skipped: "asks" | "git" | null;
}

/** A dependency: `toTaskId` waits for `fromTaskId` (the Timeline's arrows). It orders the work; nothing starts by itself. */
export interface Dependency {
  id: number;
  fromTaskId: number;
  toTaskId: number;
}

/** Planning settings, stored with the account. How sessions start is per computer (DeviceSettings). */
export interface Settings {
  workStart: string;
  workEnd: string;
  lunchStart: string;
  lunchEnd: string;
  workDays: number[];
}

/* ---------- preferences: how you like to work, for agents ---------- */

/**
 * Topics to start with: Settings offers them, the MCP tools suggest them, and they're listed first, in this order. The
 * user names their own too: a topic is any short name.
 */
export const SUGGESTED_TOPICS: { name: string; hint: string }[] = [
  { name: "Time and schedule", hint: "When to plan which work, focus time, breaks, days off" },
  { name: "Dates and deadlines", hint: "Due dates and planned days, buffers, reminders" },
  { name: "Writing tasks", hint: "Language, how much detail, estimates, Done when items, labels" },
  { name: "Projects and places", hint: "Which area, project, workspace or computer work goes to" },
  { name: "Agents and sessions", hint: "Which agent does what, models, where sessions run" },
];

export type PreferenceSource = "you" | "agent";

/**
 * One thing about how the user likes to work, in their words: agents read these before they plan, schedule or create
 * tasks, and add to them once the user said so. The user's notes, like task descriptions: preferences, never commands.
 */
export interface Preference {
  id: number;
  /** What it's about: a suggested topic or the user's own, at most PREFERENCE_TOPIC_MAX characters. */
  topic: string;
  text: string;
  /** Who wrote it last: you in PacedMind, or an agent over MCP (after asking you). */
  source: PreferenceSource;
  updatedAt: string;
}

/** At most this many preferences, each one line (the database holds all three). */
export const MAX_PREFERENCES = 100;
export const PREFERENCE_TEXT_MAX = 500;
export const PREFERENCE_TOPIC_MAX = 60;

export const sameTopic = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The hint of a suggested topic, whatever its case; undefined for the user's own. */
export const topicHint = (topic: string) => SUGGESTED_TOPICS.find((s) => sameTopic(s.name, topic))?.hint;

/** Topics in the order they're listed: the suggested ones first, then the user's own by name. */
export function topicOrder(a: string, b: string): number {
  const rank = (t: string) => {
    const i = SUGGESTED_TOPICS.findIndex((s) => sameTopic(s.name, t));
    return i < 0 ? SUGGESTED_TOPICS.length : i;
  };
  return rank(a) - rank(b) || a.localeCompare(b, undefined, { sensitivity: "base" });
}

/** Windows Terminal or Command Prompt on Windows, Terminal or iTerm on macOS (src/lib/terminals.ts). */
export type TerminalId = "wt" | "cmd" | "terminal" | "iterm";

/** What the desktop app on this computer decides for itself (src/server/device.ts), as Settings shows it. */
export interface DeviceSettings {
  name: string;
  terminal: TerminalId;
  claudeCommand: string;
  codexCommand: string;
  remoteStart: RemoteStart;
  /** Whether sessions asked for from elsewhere need a two-factor code from the last five minutes. */
  remoteCode: boolean;
  /** Whether PacedMind answers Claude Code's and Codex's question whether you trust a session's folder, before it starts. */
  trustFolders: boolean;
  /** Whether this computer's sessions wait for answers from PacedMind on your other devices too (asks.ts). */
  remoteAnswers: boolean;
  /** This computer's id in the account's list, once registered. */
  deviceId: string | null;
  /** Whether the app's secrets on disk are encrypted with a key from the OS keychain. */
  encrypted: boolean;
  /** True once the import of Claude Code and Codex projects was offered here (it opens by itself only once). */
  importOffered: boolean;
}

/**
 * Whether an agent's command-line tool is signed in, as the tool itself says (`claude auth status`, `codex login status`):
 * "unknown" when there's no CLI or it didn't say. Only these words travel: never an email, an organization, a path or a key.
 */
export interface AgentLogin {
  state: "in" | "out" | "unknown";
  /** How it signed in, as a short word such as "claude.ai", "api-key" or "chatgpt". */
  method?: string;
  /** The subscription it signed in with, when the CLI says, such as "pro" or "max". */
  plan?: string;
}

/** What PacedMind found on a computer for one agent. */
export interface AgentTools {
  models?: import("./agent-models").ModelCatalog;
  /** The command-line tool, when it answered `--version`; `path` when it isn't on the PATH but was found where installers put it. */
  cli: { version: string; path?: string } | null;
  /** The desktop app, when it's installed. */
  app: { version: string | null } | null;
  /** Whether sessions PacedMind doesn't set up itself (the desktop app) can reach PacedMind's MCP server. */
  mcp: McpLink;
  /** Whether the CLI is signed in (Claude Code on the web and Codex cloud start from it). */
  login: AgentLogin;
  /** What its sessions get besides PacedMind in every folder, as its config files name it (extras.ts); missing until it looked. */
  extras?: AgentExtras;
}

/**
 * What an agent gets on a computer besides PacedMind, by name only (extras.ts): the MCP servers and plugins its config
 * turns on everywhere, how many skills it has, and which of its hooks run. Never a server's command, address or keys.
 */
export interface AgentExtras {
  mcp: string[];
  plugins: string[];
  skills: number;
  hooks: string[];
  /**
   * The MCP servers its sessions get from the account its CLI is signed in to (Claude Code's claude.ai connectors,
   * such as Gmail), which no config file names: as the last session PacedMind started here without a project's
   * pick reported them (start_task), and when. Missing until one did.
   */
  account?: string[];
  accountAt?: string;
}

/** An MCP server a project's folder names for Claude Code (.mcp.json): whether Claude Code may use it there, or asks you first (null). */
export interface FolderServer {
  name: string;
  approved: boolean | null;
}

/**
 * What an agent gets in a project's folder on this computer on top of what it has everywhere (extras.ts), by name only:
 * MCP servers from the folder's own files and Claude Code's servers for this folder alone, skills, hooks and plugins
 * the folder's settings add, and the instruction files the agents read there.
 */
export interface FolderExtras {
  claudeMcp: FolderServer[];
  /** Claude Code's servers for this folder only (local scope, kept in ~/.claude.json). */
  claudeLocal: string[];
  codexMcp: string[];
  skills: number;
  hooks: string[];
  plugins: string[];
  /** CLAUDE.md, AGENTS.md: what the agents read there before they start. */
  instructions: string[];
}

/**
 * A project on this computer as Settings shows it for agents: what they get in its folder (null without one), the MCP
 * servers besides PacedMind its sessions could have, by agent, and the ones they get (null: all of them).
 */
export interface ProjectAgentsView {
  extras: FolderExtras | null;
  choices: Record<AgentId, string[]>;
  servers: string[] | null;
}

export const NO_AGENT_TOOLS: AgentTools = { cli: null, app: null, mcp: "missing", login: { state: "unknown" } };

/** A computer with the desktop app, signed in to the account. Sessions run on it in a terminal or an agent's desktop app. */
export interface Device {
  id: string;
  name: string;
  platform: "windows" | "macos" | "linux";
  /** What it does with sessions asked for from elsewhere, as it last said (it decides on the computer itself). */
  remoteStart: RemoteStart;
  /**
   * Whether asking it for a session needs a two-factor code from the last five minutes, as it last said. The database
   * takes requests without one only while this is off, and the computer checks its own setting again.
   */
  remoteCode: boolean;
  /** What it found for each agent when it last looked; nothing found until the first check finished. */
  agents: Record<AgentId, AgentTools>;
  createdAt: string;
  /** When it last said it's there (every minute while it runs): see deviceOnline. */
  lastSeenAt: string | null;
  /** When it last looked for the agents; null until the first check finished. */
  checkedAt: string | null;
  revokedAt: string | null;
  /** The account's default computer: sessions go there when neither the task nor its project names one. At most one. */
  isDefault: boolean;
  /** PacedMind's version on it, as it last said; null until it did. */
  appVersion: string | null;
  /** The Claude Code and Codex sessions it found that PacedMind didn't start, as it last said (other-sessions.ts). */
  otherSessions: OtherSession[];
}

/** Where a Claude Code or Codex session runs on a computer: the command-line tool in a terminal, or the desktop app. */
export type Harness = "claude-cli" | "claude-app" | "codex-cli" | "codex-app";

export const HARNESS_LABEL: Record<Harness, string> = {
  "claude-cli": "Claude Code", "claude-app": "Claude app", "codex-cli": "Codex CLI", "codex-app": "Codex app",
};

export const harnessAgent = (h: Harness): AgentId => (h.startsWith("claude") ? "claude" : "codex");

/** The conversation a PacedMind session keeps for an outside session attached to a task (Session.cliSessionId). */
export const outsideConversation = (s: Pick<OtherSession, "harness" | "ref" | "cli">): string | null =>
  s.harness === "claude-app" ? s.cli ?? null : s.ref;

/**
 * What a session is doing, as its own record shows: at work right now, waiting for you (its turn ended, or it stopped
 * in the middle of one, such as for a permission), or quiet for hours.
 */
export type OtherSessionState = "working" | "waiting" | "idle";

/** A Claude Code or Codex session on one of your computers that PacedMind didn't start, as that computer found it. */
export interface OtherSession {
  harness: Harness;
  /** The tool's own id for the session. */
  ref: string;
  /** For a Claude app session, the id of the Claude Code conversation it runs. */
  cli?: string;
  /** Its own title, else its first message, on one line and short. */
  title: string;
  /** The name of its folder (never the path). */
  place: string;
  /** The project its folder is, on that computer; null for none. */
  projectId: string | null;
  state: OtherSessionState;
  /** ISO timestamps. */
  startedAt: string;
  activeAt: string;
}

/** A computer counts as online when it said so in the last two minutes (it does every minute while it runs). */
export const DEVICE_ONLINE_MS = 2 * 60_000;

export function deviceOnline(d: { lastSeenAt: string | null; revokedAt: string | null }, now = Date.now()): boolean {
  return !d.revokedAt && !!d.lastSeenAt && now - Date.parse(d.lastSeenAt) < DEVICE_ONLINE_MS;
}

export type LaunchRequestStatus = "pending" | "launched" | "denied" | "expired" | "failed" | "canceled";

/**
 * What a request asks the computer to do: start a session for the task, resume the session `targetSessionId`, or send
 * that session back to its agent with `changes`. Resuming and changes go only to the computer the session ran on.
 */
export type LaunchRequestKind = "start" | "resume" | "changes";

/** What gets a folder on a computer: a project (its folder), an area (its workspace) or a task (its own folder). */
export type FolderTargetKind = "project" | "area" | "task";
export type FolderRequestStatus = "pending" | "done" | "refused" | "failed" | "expired";

/**
 * A folder asked for from outside a computer's window (folder_requests): by an agent, the web app or another computer.
 * Folders are each computer's own settings, so it only suggests one: the computer checks it, and sets it once you allow
 * it there (folder-requests.ts).
 */
export interface FolderRequest {
  id: string;
  deviceId: string;
  target: { kind: FolderTargetKind; id: string };
  /** The folder as it was asked for: untrusted text, which the computer checks and shows you before anything uses it. */
  folder: string;
  /** "web", "desktop" (another computer's app) or "agent" (an approved agent; the database sets it). */
  requestedVia: string;
  requestedAt: string;
  expiresAt: string;
  status: FolderRequestStatus;
  decidedAt: string | null;
  note: string | null;
}

/** A session asked for from elsewhere, waiting for (or decided by) the desktop app on `deviceId`. */
export interface LaunchRequest {
  id: string;
  kind: LaunchRequestKind;
  deviceId: string;
  taskId: number;
  agent: AgentId;
  /**
   * Where it runs. start: null means where the task says. resume: null means where it ran; "desktop" moves a Claude
   * Code conversation from a terminal into the Claude app. changes: always a terminal.
   */
  surface: Surface | null;
  /** The session to resume or send back (resume, changes). */
  targetSessionId: string | null;
  /** What should change, as the user wrote it (changes only). Untrusted: the agent reads it, nothing runs it. */
  changes: string | null;
  /** Whether it came with a two-factor code from the last five minutes, as the database found when it took it. */
  freshCode: boolean;
  requestedVia: string;
  requestedAt: string;
  expiresAt: string;
  status: LaunchRequestStatus;
  decidedAt: string | null;
  /** The session it started, resumed or sent back, once it did. */
  sessionId: string | null;
  note: string | null;
}

/** What a running session's agent waits for you to answer: a permission for a tool, or a question (asks.ts). */
export type AskKind = "permission" | "question";
export type AskStatus = "pending" | "answered" | "expired" | "withdrawn";

/**
 * Something a running session's agent waits for your answer to, held for a few minutes by the computer it runs on:
 * a tool it wants permission for (Claude Code's PermissionRequest hook) or a question (the ask_user tool). Answered
 * once, from that computer, or from elsewhere when that computer takes answers from elsewhere (`remoteOk`).
 */
export interface SessionAsk {
  id: string;
  sessionId: string;
  /** The computer it runs on; null for this computer's own data without an account. */
  deviceId: string | null;
  kind: AskKind;
  /** The tool it wants to use, as the agent names it (Bash, Edit…); null for a question. */
  tool: string | null;
  /** The question, or what the tool would do (the command, the file). */
  text: string;
  /** Whether its computer takes answers from elsewhere, as that computer's setting said when it asked. */
  remoteOk: boolean;
  askedAt: string;
  expiresAt: string;
  status: AskStatus;
  /** "allow" or "deny" for a permission; the answer for a question. */
  answer: string | null;
  answeredAt: string | null;
  /** Whether the answer came from the session's own computer or from elsewhere (the web app, another computer). */
  answeredVia: "computer" | "elsewhere" | null;
}

/** A pending ask as `/api/state` reports it, for the answer card. `here`: this page runs on the session's computer. */
export interface AskView {
  id: string;
  sessionId: string;
  kind: AskKind;
  tool: string | null;
  text: string;
  remoteOk: boolean;
  here: boolean;
  /** When the agent stops waiting (ms since the epoch). */
  expiresAt: number;
}

/** A browser's push subscription (PushSubscription.toJSON), as the account keeps it for notifications (push.ts). */
/** An agent you allowed to use PacedMind Cloud's MCP server (OAuth), as Settings lists it. */
export interface ConnectedAgent {
  id: string;
  /** The name the agent registered itself with (Claude Code, Codex…): plain text, never trusted. */
  name: string;
  /** When you allowed it (ISO). */
  approvedAt: string;
  /** When it signed in with that (ISO); null until it does, within ten minutes. */
  claimedAt: string | null;
}

export interface PushSubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
  /** Which browser or phone it is, in a few words, for Settings. */
  label: string;
}

/** A request of the last half hour as `/api/state` reports it, for "Waiting for X", "Started on X", "Refused by X". */
export interface LaunchRequestView {
  id: string;
  kind: LaunchRequestKind;
  taskId: number;
  agent: AgentId;
  /** Null when the task is gone. */
  taskKey: string | null;
  /** The session it resumes or sends back (resume, changes). */
  targetSessionId: string | null;
  /** The session it started, resumed or sent back, once it did. */
  sessionId: string | null;
  deviceId: string;
  /** Null when the computer is gone from the account's list. */
  deviceName: string | null;
  /** "expired" also for a request still waiting past its time (a computer that was off never answered it). */
  status: LaunchRequestStatus;
  note: string | null;
  /** ISO timestamps. */
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
}

/** What task lists and the detail panel need besides the tasks themselves. */
export interface TaskContext {
  areas: Area[];
  projects: Project[];
  /** Latest session per task id. */
  sessions: Record<number, Session>;
  sessionEvents: Record<string, SessionEvent[]>;
  /** What agents handed back, per task id, newest first. */
  reports: Record<number, Report[]>;
  /** Images a running session attached so far, before it hands the task back, per session id. */
  pending: Record<string, Attachment[]>;
  /** Session ids whose agent can take changes from here now (Request changes). */
  changesOk: Record<string, boolean>;
  /**
   * Session ids whose agent can take changes through a request to the computer the session ran on, with that
   * computer's id: in the web app, or for another computer's session (requestChangesRemoteAction).
   */
  changesVia?: Record<string, string>;
  /** In the desktop app, which keeps this computer's folders and starts sessions here; false in the web app. */
  desktop?: boolean;
  /** The desktop store these tasks came from; floating notes keep this identity across account changes. */
  floatingScope?: string | null;
  /** This computer's id in the account's list (desktop app, signed in and registered); null otherwise. */
  deviceId?: string | null;
  /**
   * Task ids whose Claude Code session here opens in a folder Claude Code doesn't trust yet, so it first asks
   * whether you do (desktop app): the running one's folder, else where the next one would start.
   */
  asksTrust?: Record<number, boolean>;
  /**
   * The MCP servers, claude.ai connectors and plugins the account's computers said their agents have (src/lib/needs.ts),
   * each with the computers that have it: what a task's Needs suggests and says.
   */
  tools?: { name: string; on: string[] }[];
  /** Per task id with sessions: what all its sessions used and how long they ran (src/lib/usage.ts). */
  agentUse?: Record<number, AgentUse>;
}

/** Task counts per area and project, for the sidebar, the overview and delete confirmations. */
export interface Usage {
  /** loose: the open tasks right in the area, without a project (its To-dos). */
  areas: Record<string, { projects: number; tasks: number; open: number; loose: number }>;
  /** pct is the done share of tasks that aren't canceled. */
  projects: Record<string, { tasks: number; open: number; done: number; pct: number }>;
}

export const STATUS_LABEL: Record<Status, string> = {
  backlog: "Backlog",
  todo: "Todo",
  progress: "In progress",
  review: "In review",
  done: "Done",
  canceled: "Canceled",
};

export const PRIORITY_LABEL: Record<Priority, string> = {
  0: "No priority",
  1: "Urgent",
  2: "High",
  3: "Medium",
  4: "Low",
};

export const AGENT_LABEL: Record<AgentId, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

export const DOER_LABEL: Record<Doer, string> = { ...AGENT_LABEL, human: "You" };

export const SURFACE_LABEL: Record<Surface, string> = { terminal: "Terminal", desktop: "Desktop app", cloud: "Cloud" };
/** The agent's desktop app and its cloud, by name. */
export const APP_LABEL: Record<AgentId, string> = { claude: "Claude app", codex: "Codex app" };
export const CLOUD_LABEL: Record<AgentId, string> = { claude: "Claude Code on the web", codex: "Codex cloud" };

/**
 * How your answers to an agent's questions start when they go back to it, like changes (AnswerForm in report.tsx):
 * requestChanges tells them apart by it, also when they come from another computer.
 */
export const ANSWERS_HEADING = "My answers to your questions:";
export const isAnswers = (text: string) => text.startsWith(ANSWERS_HEADING);

/** The answer Claude Code needs the first time it starts in a folder, before it reads its first message (claude-trust.ts). */
export const TRUST_ANSWER = "Yes, I trust this folder";
export const TRUST_FIRST = `Claude Code first asks whether you trust the folder: choose “${TRUST_ANSWER}” in its terminal.`;
export const TRUST_WAITING = `Claude Code is asking whether you trust this folder. Choose “${TRUST_ANSWER}” in its terminal.`;

/** What Reopen in terminal asks first (reopenSessionAction): only for a running session whose terminal is gone. */
export const REOPEN_CONFIRM = "Reopen this session in a new terminal? Do it when its terminal is gone. If it's still open, close it first: two terminals on one conversation get in each other's way.";

/**
 * Where a task's sessions run when the task doesn't say: in a terminal when the agent's CLI is on the device,
 * else in its desktop app when that is. Until the device was checked, in a terminal.
 */
export function surfaceOf(runIn: Surface | null, tools: AgentTools | undefined): Surface {
  if (runIn) return runIn;
  return tools && !tools.cli && tools.app ? "desktop" : "terminal";
}

/** "Windows", "macOS" or "Linux" for a device's platform (or a Node platform name). */
export function platformName(platform: string): string {
  if (platform === "windows" || platform === "win32") return "Windows";
  if (platform === "macos" || platform === "darwin") return "macOS";
  return platform === "linux" ? "Linux" : platform;
}

/** Whether a device can run an agent's sessions that way; cloud sessions need the CLI to start them. */
export function canRun(tools: AgentTools | undefined, surface: Surface): boolean {
  if (!tools) return surface === "terminal";
  return surface === "desktop" ? !!tools.app : !!tools.cli;
}

/** The agent that runs a task: its own, else the project's, else Claude Code. Null for a task that is yours. */
export function agentOf(task: { agent: Doer | null }, projectAgent?: AgentId | null): AgentId | null {
  if (task.agent === "human") return null;
  return task.agent ?? projectAgent ?? "claude";
}

/** Where a task opens in the app: its project, else its area, else the inbox. */
export function taskHref(t: { key: string; projectId: string | null; areaId: string | null }): string {
  if (t.projectId) return `/project/${t.projectId}?task=${t.key}`;
  if (t.areaId) return `/area/${t.areaId}?task=${t.key}`;
  return `/inbox?task=${t.key}`;
}

export const OUTCOME_LABEL: Record<ReportOutcome, string> = {
  done: "Done",
  partial: "Partly done",
  blocked: "Blocked",
};

export const VERDICT_LABEL: Record<Verdict, string> = {
  met: "Met",
  partly: "Partly met",
  not_met: "Not met",
};


