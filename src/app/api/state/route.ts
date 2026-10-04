import crypto from "node:crypto";
import * as repo from "@/server/repo";
import { MODE, authState } from "@/server/supabase";
import { nextStep } from "@/server/auth-flow";
import { approvalItems } from "@/server/requests";
import { codeFreshUntil } from "@/server/step-up";
import { askedHere } from "@/server/asks";
import { readPlan } from "@/server/billing";
import { floatingTaskScope } from "@/server/floating-tasks";
import { attentionOf } from "@/lib/dates";
import { LIVE_STATUSES, type AskView, type LaunchRequestView } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Changes when this server process starts, so a restart also counts as "something changed". */
const boot = crypto.randomBytes(4).toString("hex");

/** How far back `requests` goes. */
const RECENT_MS = 30 * 60_000;

/**
 * Polled by open pages (to refresh when an agent changed something over MCP) and by the desktop app (to
 * notify when a session finishes, waits for you in its terminal, or waits to be allowed). `version` changes after any write to the
 * account's data, and when someone signs in, verifies a code or signs out. In the desktop app only its own
 * window and main process can ask (proxy.ts); in the web app, only a signed-in browser.
 *
 * Besides that: `attention`, the running sessions whose agent waits for you (its turn ended in its terminal, it asks
 * for your permission or asked you a question: attentionOf), with the event that says so; `requests`, the account's requests to its computers from the last half hour, newest first (for
 * "Waiting for X", "Started on X", "Refused by X"; empty without an account), and `codeFreshUntil`, until when (ms
 * since the epoch) a request may skip asking for a two-factor code because one was entered in this session (a hint:
 * the database decides); `plan`, the account's PacedMind Cloud plan once billing is on (its state, whether it may still
 * write, when its trial ends), else null.
 */
export async function GET() {
  const noStore = { headers: { "Cache-Control": "no-store" } };
  const state = await authState();
  // Without an account, the desktop app shows this computer's own data; signing in counts as a change.
  const step = state || MODE === "web" ? nextStep(state) : null;
  if (step) {
    return Response.json({ version: `${boot}-${step}`, waiting: [], attention: [], asks: [], approvals: [], requests: [], codeFreshUntil: null, signedIn: false, plan: null, floatingScope: null }, noStore);
  }
  const [version, finished, live, tasks, recent, plan] = await Promise.all([
    repo.stateVersion(), repo.listSessions({ status: ["finished"] }), repo.listSessions({ status: LIVE_STATUSES }), repo.listTasks(),
    repo.listLaunchRequests({ since: new Date(Date.now() - RECENT_MS).toISOString(), limit: 50 }), readPlan(),
  ]);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const briefs = await repo.reportBriefs(finished.map((s) => s.id));
  const waiting = finished.map((s) => {
    const task = byId.get(s.taskId);
    const report = briefs.get(s.id);
    return {
      id: s.id, key: task?.key ?? null, title: task?.title ?? null, note: s.note, finishedAt: s.finishedAt,
      outcome: report?.outcome ?? null, questions: report?.questions ?? 0,
    };
  });
  const liveEvents = live.length ? await repo.sessionEventsFor(live.map((s) => s.id)) : {};
  const attention = live.flatMap((s) => {
    const e = attentionOf(liveEvents[s.id] ?? []);
    const task = byId.get(s.taskId);
    return e ? [{ id: s.id, eventId: e.id, kind: e.kind, text: e.text, at: e.at, agent: s.agent, key: task?.key ?? null, title: task?.title ?? null }] : [];
  });
  // What running sessions' agents wait for you to answer, with whether this page runs on their computer.
  const pending = live.length ? await repo.listAsks({ sessionIds: live.map((s) => s.id), status: ["pending"] }) : [];
  const asks: AskView[] = [];
  for (const a of pending) {
    if (Date.parse(a.expiresAt) <= Date.now()) continue;
    asks.push({
      id: a.id, sessionId: a.sessionId, kind: a.kind, tool: a.tool, text: a.text, remoteOk: a.remoteOk, here: await askedHere(a),
      expiresAt: Date.parse(a.expiresAt),
    });
  }
  const names = recent.length ? new Map((await repo.listDevices()).map((d) => [d.id, d.name])) : new Map<string, string>();
  const now = Date.now();
  const requests: LaunchRequestView[] = recent.map((r) => ({
    id: r.id, kind: r.kind, taskId: r.taskId, agent: r.agent, taskKey: byId.get(r.taskId)?.key ?? null, targetSessionId: r.targetSessionId, sessionId: r.sessionId,
    deviceId: r.deviceId, deviceName: names.get(r.deviceId) ?? null,
    // A computer that was off never answered: past its time, a waiting request is as good as expired.
    status: r.status === "pending" && Date.parse(r.expiresAt) <= now ? "expired" : r.status,
    note: r.note, createdAt: r.requestedAt, expiresAt: r.expiresAt, decidedAt: r.decidedAt,
  }));
  const approvals = MODE === "desktop" ? approvalItems(tasks) : [];
  const approvalKey = approvals.map((a) => a.id).join(",");
  return Response.json(
    {
      version: `${boot}-${state ? state.user.id.slice(0, 8) : "local"}-${version}-${crypto.createHash("sha1").update(approvalKey).digest("hex").slice(0, 8)}`,
      waiting,
      attention,
      asks,
      approvals: approvals.map((a) => ({ id: a.id, kind: a.kind, key: a.key, title: a.title, agent: a.agent, from: a.from, ...(a.kind === "folder" ? { folder: a.folder } : {}) })),
      requests,
      codeFreshUntil: state ? codeFreshUntil(state) : null,
      signedIn: !!state,
      floatingScope: floatingTaskScope(state),
      plan: plan?.enforced ? { state: plan.state, writable: plan.writable, trialEndsAt: plan.trialEndsAt } : null,
    },
    noStore,
  );
}
