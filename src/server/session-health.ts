import "server-only";
import * as repo from "./repo";
import { deviceConfig } from "./device";
import { MODE } from "./supabase";
import { readCodexRuntime } from "./codex-runtime";
import { desktopStartText, runtimeEvent, startupEvent, startupSince } from "@/lib/session-health";
import { attentionOf, checkedIn } from "@/lib/dates";
import { isLiveSession, LIVE_STATUSES } from "@/lib/types";

/**
 * Hooks cannot describe a prompt shown before hooks run, and Codex's Stop hook doesn't carry failed-turn errors.
 * Watch this computer's live terminals independently: read Codex's local lifecycle records, then check for a
 * missing MCP check-in. Only fixed status messages go into session events (and Cloud), never transcript contents.
 */
export async function checkSessionHealth(now = Date.now()) {
  if (MODE !== "desktop") return;
  const device = deviceConfig().deviceId;
  const sessions = (await repo.listAllSessions({ status: LIVE_STATUSES })).filter((s) => s.surface !== "cloud" && (!s.deviceId || s.deviceId === device));
  if (!sessions.length) return;
  const histories = await repo.sessionEventsFor(sessions.map((s) => s.id));
  const runtime = readCodexRuntime(sessions.filter((s) => s.agent === "codex" && s.surface === "terminal").map((s) => ({
    id: s.id, cliSessionId: s.cliSessionId, since: startupSince(s.startedAt, histories[s.id] ?? []),
  })));
  for (const before of sessions) {
    const s = await repo.getSession(before.id);
    if (!s || !isLiveSession(s) || s.cliSessionId !== before.cliSessionId) continue;
    // Read again after the filesystem scan: a hook or MCP check-in may have arrived meanwhile.
    const events = await repo.sessionEvents(s.id);
    if (startupSince(s.startedAt, events) !== startupSince(before.startedAt, histories[s.id] ?? [])) continue;
    if (s.surface === "desktop") {
      if (s.status === "starting" && !checkedIn(events) && !attentionOf(events) && !events.some((e) => e.kind === "send_prompt")) {
        await repo.addSessionEvent(s.id, "send_prompt", desktopStartText(s.agent));
      }
      continue;
    }
    const found = runtime.get(s.id);
    if (found?.cli && !s.cliSessionId) await repo.updateSession(s.id, { cliSessionId: found.cli });
    const observed = found?.cli && found.observation ? runtimeEvent(s.agent, s.startedAt, events, found.observation) : null;
    const justStartedTurn = found?.observation?.kind === "working" && now - found.observation.at < 90_000;
    const event = observed ?? (justStartedTurn ? null : startupEvent(s.agent, s.startedAt, events, now));
    if (event) await repo.addSessionEvent(s.id, event.kind, event.text);
  }
}
