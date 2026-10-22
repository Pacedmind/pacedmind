import "server-only";
import webpush from "web-push";
import * as repo from "./repo";
import { usesCloud } from "./scope";
import { MODE } from "./supabase";
import { ATTENTION_KINDS, attentionWords, isAttention } from "@/lib/dates";

/*
 * Web push for the moments a session needs you, to the browsers where you turned notifications on (Settings in the
 * web app, also on a phone). The computer a session runs on sends them as it records the event (repo.addSessionEvent),
 * signed with the account's own VAPID key pair (push_keys), so no server holds a key; the push service passes the
 * message on, encrypted for that browser. Only with an account, and only to the push services' own addresses, which
 * is all the database takes too.
 */

/** Session events that notify: the agent waits for you, asks for permission or asks you something, or handed back. */
export const PUSH_KINDS = new Set<string>([...ATTENTION_KINDS, "finished"]);

/** The push services' addresses: Google, Mozilla, Apple and Microsoft (the database checks the same). */
export const PUSH_ENDPOINT =
  /^https:\/\/(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|push\.services\.mozilla\.com|([a-z0-9-]+\.)+push\.apple\.com|([a-z0-9-]+\.)+notify\.windows\.com)\/[A-Za-z0-9_:%./=+?&-]+$/;

/** Who the push services may contact about these messages. */
const SUBJECT = "https://pacedmind.com";

const clip = (s: string, max: number) => {
  const line = s.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max).trimEnd()}…` : line;
};

/** The account's key pair, made the first time a browser asks for notifications (and kept by whoever made it first). */
export async function ensurePushKeys(): Promise<string> {
  const have = await repo.pushKeys();
  if (have) return have.publicKey;
  const made = webpush.generateVAPIDKeys();
  await repo.savePushKeys({ publicKey: made.publicKey, privateKey: made.privateKey });
  return (await repo.pushKeys())?.publicKey ?? made.publicKey;
}

/** What the notification says for a session event. */
async function messageFor(sessionId: string, kind: string, text: string) {
  const session = await repo.getSession(sessionId);
  if (!session) return null;
  const task = await repo.getTask(session.taskId);
  if (task && !(await repo.isTaskVisible(task))) return null;
  const key = task?.key ?? "A session";
  let title: string;
  if (kind === "permission") title = `${key} asks for your permission`;
  else if (kind === "question" || kind === "input") title = `${key} has a question for you`;
  else if (kind === "waiting") title = `${key} is waiting for you`;
  else if (kind === "limit") title = `${key} stopped at a usage limit`;
  else if (isAttention(kind)) title = `${key} · ${attentionWords(kind)}`;
  else {
    const outcome = (await repo.latestSessionReport(sessionId))?.outcome;
    title = outcome === "blocked" ? `${key} is blocked` : outcome === "partial" ? `${key} is partly done` : `${key} is finished`;
  }
  return {
    title,
    body: clip([task?.title, text].filter(Boolean).join(" · "), 240),
    // One notification per session: a newer one replaces it.
    tag: `session-${sessionId}`,
    path: `/sessions?s=${sessionId}`,
  };
}

/**
 * Tells the account's browsers about a session event that needs you, from the computer that records it. Never throws
 * and never holds the caller up: a push that fails is left out, and a browser that went away is forgotten.
 */
export function pushEvent(sessionId: string, kind: string, text: string) {
  if (MODE !== "desktop" || !PUSH_KINDS.has(kind)) return;
  void (async () => {
    if (!(await usesCloud())) return;
    const [keys, subscriptions] = await Promise.all([repo.pushKeys(), repo.listPushSubscriptions()]);
    if (!keys || !subscriptions.length) return;
    const message = await messageFor(sessionId, kind, text);
    if (!message) return;
    const payload = JSON.stringify(message);
    await Promise.all(subscriptions.filter((s) => PUSH_ENDPOINT.test(s.endpoint)).map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, {
          vapidDetails: { subject: SUBJECT, publicKey: keys.publicKey, privateKey: keys.privateKey },
          TTL: 60 * 60, urgency: "high", timeout: 10_000,
        });
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) await repo.removePushSubscription(s.endpoint).catch(() => {});
        else console.error("[organizer] push failed", status ?? (e instanceof Error ? e.message : e));
      }
    }));
  })().catch((e) => console.error("[organizer] push", e));
}
