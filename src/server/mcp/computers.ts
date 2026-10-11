import "server-only";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import * as repo from "../repo";
import { thisDevice } from "../devices";
import { askForFolder, type FolderTarget } from "../folder-requests";
import { usesCloud } from "../scope";
import { MODE } from "../supabase";
import { REMOTE_START_LABEL } from "@/lib/from-elsewhere";
import { AGENT_LABEL, APP_LABEL, deviceOnline, type AgentId, type AgentTools, type Device } from "@/lib/types";
import { areaRef, fail, findArea, findProject, findTask, plural, projectRef, taskRef, tool } from "./common";

/*
 * The user's computers over MCP: what each has and does (list_computers), and folders on them (set_folder). Sessions on
 * them are start_session's (agents.ts). Nothing here changes a computer by itself: a folder is only asked for, and the
 * computer sets it once the user allows it there (folder-requests.ts).
 */

/** PacedMind Cloud's MCP server (the hosted app) knows no computer of its own: every one is elsewhere. */
const HOSTED = MODE === "web";

/**
 * The account's signed-in computers, this one first with what it found itself (fresher than its entry's copy); without
 * an account, this one alone (its id is ""). `hereId` is this computer's, or null in the hosted app and before this
 * computer joined the account's list.
 */
export async function computers(): Promise<{ list: Device[]; hereId: string | null }> {
  if (HOSTED) return { list: (await repo.listDevices()).filter((d) => !d.revokedAt), hereId: null };
  const me = await thisDevice();
  if (!(await usesCloud())) return { list: [me], hereId: me.id };
  const all = (await repo.listDevices()).filter((d) => !d.revokedAt);
  return me.id ? { list: [me, ...all.filter((d) => d.id !== me.id)], hereId: me.id } : { list: all, hereId: null };
}

/** A computer by its id or name (whatever the case, or the start of one name), or a failure that lists them. */
export function findComputer(query: string, list: Device[]): Device {
  const q = query.trim().toLowerCase();
  const hit = list.find((d) => d.id === query.trim()) ?? list.find((d) => d.name.toLowerCase() === q)
    ?? (list.filter((d) => d.name.toLowerCase().startsWith(q)).length === 1 ? list.find((d) => d.name.toLowerCase().startsWith(q)) : undefined);
  if (hit) return hit;
  fail(list.length
    ? `No computer named ${query}. The user's computers: ${list.map((d) => d.name).join(", ")}.`
    : "None of the user's computers is signed in to PacedMind.");
}

/** When a computer was last there, in words. */
function seen(d: Device, now: number): string {
  if (deviceOnline(d, now)) return "online";
  if (!d.lastSeenAt) return "not seen yet";
  const min = Math.round((now - Date.parse(d.lastSeenAt)) / 60_000);
  return min < 120 ? `last seen ${min} min ago` : min < 48 * 60 ? `last seen ${Math.round(min / 60)} h ago` : `last seen ${d.lastSeenAt.slice(0, 10)}`;
}

/** What a computer does with a session you ask it for (start_session with `computer`). */
export function sessionsText(d: Device, here: boolean): string {
  if (here) return "Sessions you ask for here wait for the user to allow them in PacedMind on this computer.";
  if (d.remoteStart === "off") return "Refuses sessions asked for from elsewhere.";
  if (d.remoteCode) {
    return "Takes sessions from elsewhere only with the user's two-factor code, so you can't ask it: the user starts them there, " +
      "or switches its Two-factor code off in PacedMind on that computer (Settings → General).";
  }
  return d.remoteStart === "auto"
    ? "Starts the sessions you ask for right away (one in the agent's cloud waits for the user there)."
    : "Asks the user there before a session you ask for starts.";
}

/** One agent on a computer: its CLI and sign-in, its desktop app, and what its sessions get besides PacedMind. */
function agentText(agent: AgentId, t: AgentTools): string {
  if (!t.cli && !t.app) return `${AGENT_LABEL[agent]}: not found`;
  const parts: string[] = [];
  if (t.cli) {
    const how = [t.login.method, t.login.plan].filter(Boolean).join(", ");
    const login = t.login.state === "in" ? `, signed in${how ? ` (${how})` : ""}` : t.login.state === "out" ? ", not signed in" : "";
    parts.push(`CLI ${t.cli.version}${login}`);
  }
  if (t.app) parts.push(`${APP_LABEL[agent]}${t.app.version ? ` ${t.app.version}` : ""}`);
  const x = t.extras;
  if (x) {
    parts.push(x.mcp.length ? `MCP servers: ${x.mcp.join(", ")}` : "no other MCP servers");
    if (x.account?.length) parts.push(`claude.ai connectors: ${x.account.join(", ")}`);
    if (x.plugins.length) parts.push(`plugins: ${x.plugins.join(", ")}`);
    if (x.skills) parts.push(plural(x.skills, "skill"));
  }
  return `${AGENT_LABEL[agent]}: ${parts.join(" · ")}`;
}

const PLATFORM = { windows: "Windows", macos: "macOS", linux: "Linux" } as const;

function computerText(d: Device, here: boolean, now: number): string {
  const head = [
    `${d.name}${d.id ? ` (id ${d.id})` : ""}`, PLATFORM[d.platform], here ? "this computer" : seen(d, now), d.isDefault ? "default" : null,
    d.appVersion ? `PacedMind ${d.appVersion}` : null,
  ].filter(Boolean).join(" · ");
  const lines = [
    sessionsText(d, here),
    here ? null : `From elsewhere: ${REMOTE_START_LABEL[d.remoteStart]}${d.remoteCode ? ", with a two-factor code" : ", without a code"}.`,
    d.checkedAt ? agentText("claude", d.agents.claude) : "Hasn't looked for Claude Code and Codex yet.",
    d.checkedAt ? agentText("codex", d.agents.codex) : null,
  ].filter(Boolean);
  return `${head}\n${lines.map((l) => `- ${l}`).join("\n")}`;
}

export function registerComputerTools(server: McpServer) {
  tool(server, "list_computers", {
    title: "List computers",
    description:
      "The user's computers with the PacedMind desktop app: online or when last seen, the default one" + (HOSTED ? "" : " and this one") +
      "; what each has of Claude Code and Codex (the CLI and its sign-in, the desktop app, MCP servers, claude.ai connectors, plugins, skills); and what it does with a session you ask it for (start_session with `computer`). Read only: the user changes these in PacedMind on each computer.",
    input: z.object({}),
    kind: "read",
  }, async () => {
    const { list, hereId } = await computers();
    if (!list.length) return "None of the user's computers is signed in to PacedMind yet. Sessions run on a computer with the PacedMind desktop app.";
    const now = Date.now();
    const intro = HOSTED ? "" : !(await usesCloud()) ? "Without an account there's only this computer.\n\n" : "";
    return intro + list.map((d) => computerText(d, !HOSTED && d.id === hereId, now)).join("\n\n");
  });

  tool(server, "set_folder", {
    title: "Set a folder on a computer",
    description:
      "Ask to use a folder on one of the user's computers for a project (its folder), an area (its workspace, which its projects without a folder of their own share) or a task (its own folder): where agent sessions for it start on that computer. Folders are each computer's own settings, so this only asks: the user allows it in PacedMind on that computer, which first checks that the folder is there. The folder is an absolute path on that computer.",
    input: z.object({
      project: projectRef.optional(),
      area: areaRef.optional(),
      task: taskRef.optional(),
      folder: z.string().min(1).max(1000).describe("The folder's absolute path on that computer"),
      computer: z.string().max(200).optional()
        .describe(HOSTED ? "The computer's name or id (list_computers); without it, the only one signed in" : "The computer's name or id (list_computers); without it, this computer"),
    }),
    kind: "create",
    openWorld: true,
  }, async ({ project, area, task, folder, computer }) => {
    const named = [project, area, task].filter((x) => x !== undefined);
    if (named.length !== 1) fail("Name one of project, area or task.");
    let target: FolderTarget;
    let label: string;
    if (project !== undefined) {
      const p = await findProject(project);
      target = { kind: "project", id: p.id };
      label = `the project ${p.name}`;
    } else if (area !== undefined) {
      const a = await findArea(area);
      target = { kind: "area", id: a.id };
      label = `the area ${a.name}'s workspace`;
    } else {
      const t = await findTask(task!);
      target = { kind: "task", id: String(t.id) };
      label = t.key;
    }
    const path = folder.trim();
    const { list, hereId } = await computers();

    // This computer: it checks the folder now, and asks the user in its window.
    if (!HOSTED && (!computer || findComputer(computer, list).id === hereId)) {
      const asked = await askForFolder(target, path, "agent", null);
      if (typeof asked === "string") fail(asked);
      return `Asked the user to use ${path} for ${label} on this computer: PacedMind shows it in its window, and sets it once they allow it (within 30 minutes). Tell the user to look at PacedMind; don't ask again.`;
    }

    // Another computer: it checks the folder when it sees the request, and asks the user there.
    if (!HOSTED && !(await usesCloud())) fail("Without an account there's only this computer.");
    let d: Device;
    if (computer) d = findComputer(computer, list);
    else if (list.length === 1) d = list[0];
    else fail(list.length ? `Which computer? ${list.map((x) => x.name).join(", ")}.` : "None of the user's computers is signed in to PacedMind.");
    await repo.createFolderRequest({ deviceId: d.id, target, folder: path, via: "agent" });
    return `Asked ${d.name} to use ${path} for ${label}. It waits for the user to allow it in PacedMind on ${d.name} (up to a day)` +
      `${deviceOnline(d) ? "" : `; ${d.name} hasn't been online in the last few minutes`}. That computer checks the folder is there first. Tell the user; don't ask again.`;
  });
}
