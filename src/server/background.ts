import "server-only";
import { cloudWritable } from "./billing";
import { syncGoogleCalendar } from "./google-calendar";
import { checkCodexCloud } from "./cloud";
import { checkThisDevice, refreshAgentModels, saveToolsOnce } from "./devices";
import { refreshFolders } from "./folder-hints";
import { mcpUrl } from "./launcher";
import { linkProjects } from "./project-links";
import * as repo from "./repo";
import { syncDevice } from "./requests";
import { usesCloud } from "./scope";
import { MODE, NotSignedIn, authState } from "./supabase";
import { checkSessionHealth } from "./session-health";
import { canUsePlanner } from "@/lib/auth-access";
import { computerAccessProblem } from "./computer-access";

const CHECK_EVERY = 30 * 60_000;

/** Background work of the desktop app's server (and `npm run dev`), started once from src/instrumentation.ts. */
export function startBackground() {
  const g = globalThis as unknown as {
    __organizerSync?: NodeJS.Timeout; __organizerCloud?: NodeJS.Timeout; __organizerLinks?: NodeJS.Timeout; __organizerAgents?: NodeJS.Timeout;
  };
  if (MODE !== "desktop" || g.__organizerSync) return;

  // Started by the desktop app: stop when the app goes away, even if it crashed and could not stop us.
  if (process.env.ORGANIZER_EXIT_WITH_PARENT === "1") {
    process.stdin.on("end", () => process.exit(0));
    process.stdin.on("error", () => process.exit(0));
    process.stdin.resume();
  }

  // Which agents this computer has; again now and then, since tools get installed and updated. Needs no sign-in.
  const check = () => checkThisDevice(mcpUrl()).catch((e) => console.error("[organizer] device check failed", e));
  setTimeout(check, 3_000);
  // The folders you work in with the agents, so the first page that offers them doesn't wait for the read.
  setTimeout(() => void refreshFolders(), 1_000);
  setInterval(check, CHECK_EVERY);

  /**
   * Runs `work` for the data in use: the signed-in account's once it passed its second factor (nothing while
   * someone is still signing in), or without an account this computer's own. Work that `writes` waits while the
   * account's PacedMind Cloud has ended: the database would refuse it (read-only), and nothing should start.
   */
  const every = (ms: number, name: string, work: () => Promise<unknown>, { writes = false, planner = false } = {}) => {
    let busy = false;
    return setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        const state = await authState();
        const allowed = !state || (planner ? canUsePlanner(state) : !(await computerAccessProblem()));
        if (allowed && (!writes || (await cloudWritable()))) await work();
      } catch (e) {
        // Signed out halfway (e.g. from another device): the next round simply waits for a sign-in.
        if (!(e instanceof NotSignedIn)) console.error(`[organizer] ${name} failed`, e);
      } finally {
        busy = false;
      }
    }, ms);
  };
  // Other computers get current account capabilities, even when nobody opens this computer's task picker.
  every(10_000, "session health", checkSessionHealth, { writes: true });
  every(5 * 60_000, "agent models", () => Promise.all([refreshAgentModels("claude"), refreshAgentModels("codex")]));
  // What the agents here reach depends on the sign-in (PacedMind Cloud's MCP server counts only with it), so they're
  // checked again when that changes.
  let signedIn: boolean | null = null;
  // This computer in the account (registration, sign-out from elsewhere, requests to start sessions, what it
  // found of the agents; each does nothing without one).
  g.__organizerSync = every(5_000, "account sync", async () => {
    const now = (await authState()) !== null;
    if (signedIn !== null && now !== signedIn) void check();
    signedIn = now;
    await syncDevice();
    await saveToolsOnce();
  });
  // Codex cloud tasks don't report back; asking Codex tells which are ready.
  g.__organizerCloud = every(60_000, "Codex cloud check", checkCodexCloud, { writes: true });
  // Which repository each project is, for your other computers, and this computer's folders after merges elsewhere.
  g.__organizerLinks = every(60_000, "project links", linkProjects, { writes: true });
  // Agents you allowed on PacedMind Cloud's MCP server: asking for them binds each approval to the sign-in that came of
  // it, also for an agent that signed in (codex mcp login) without calling the server yet. Nothing without an account.
  g.__organizerAgents = every(60_000, "agent sign-ins", async () => {
    if (await usesCloud()) await repo.listConnectedAgents();
  }, { planner: true });
  every(60_000, "Google Calendar", syncGoogleCalendar, { writes: true, planner: true });
}
