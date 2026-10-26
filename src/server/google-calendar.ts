import "server-only";
import publicCalendarClient from "@/lib/google-calendar-client.json";
import crypto from "node:crypto";
import path from "node:path";
import { Temporal } from "@js-temporal/polyfill";
import { authState, readAuthState, MODE, requirePlannerAccess } from "./supabase";
import { canUsePlanner } from "@/lib/auth-access";
import { cloudWritable } from "./billing";
import { dataDir } from "./device";
import { readSecureJson, writeSecureJson } from "./secure-file";
import * as cloud from "./store/cloud";
import * as local from "./store/local";
import type { GoogleCalendarStatus, CalendarConnectionRow } from "@/lib/google-calendar";
import { googleBody, googlePatch, localFields, remoteFields, synchronize, resolveConflict, type EventFields, type GoogleEvent, type SyncIO, type SyncState } from "./google-calendar-engine";

const SCOPES = ["https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/calendar.calendarlist.readonly"];
const API = "https://www.googleapis.com/calendar/v3";
interface Credentials { accessToken: string; refreshToken: string; expiresAt: number }
interface Connection {
  pending?: { stateHash: string; verifier: string; until: number; redirectUri: string };
  credentials?: Credentials;
  calendars?: { id: string; name: string; timeZone: string }[];
  sync?: SyncState;
  calendarName?: string;
  error?: string;
  retryAt?: number;
}
type CalendarStore = Pick<typeof local, "listEvents" | "createEvent" | "changeCalendarEvent">;
export class CalendarHttpError extends Error {
  constructor(public status: number) { super(status === 401 ? "Reconnect Google Calendar to continue syncing." : status === 403 ? "Google Calendar denied access. Check the calendar permissions or reconnect." : status === 412 ? "An event changed during sync. It will be checked again." : "Google Calendar is temporarily unavailable. Sync will retry."); }
}

function key(): Buffer | null {
  const encoded = process.env.GOOGLE_CALENDAR_ENCRYPTION_KEY ?? (MODE === "desktop" ? process.env.ORGANIZER_DATA_KEY : undefined);
  if (encoded) { const k = Buffer.from(encoded, "base64"); return k.length === 32 ? k : null; }
  if (MODE === "web") return null;
  const file = path.join(dataDir(), "google-calendar-key.json");
  let saved = readSecureJson<{ key: string }>(file);
  if (!saved) { saved = { key: crypto.randomBytes(32).toString("base64") }; writeSecureJson(file, saved); }
  return Buffer.from(saved.key, "base64");
}
function encrypt(value: Connection, k: Buffer, scope: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", k, iv);
  cipher.setAAD(Buffer.from(`google-calendar:${scope}`));
  const body = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}
function decrypt(payload: string, k: Buffer, scope: string): Connection {
  const raw = Buffer.from(payload, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", k, raw.subarray(0, 12));
  decipher.setAAD(Buffer.from(`google-calendar:${scope}`)); decipher.setAuthTag(raw.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8"));
}
function owner(k: Buffer) { return crypto.createHash("sha256").update(k).digest("hex"); }
function calendarClientId() {
  return process.env.GOOGLE_CALENDAR_CLIENT_ID || (MODE === "desktop" ? publicCalendarClient.desktopClientId : "");
}
function clientConfig() {
  const id = calendarClientId();
  if (!id) throw new Error("Google Calendar has not been configured on this server.");
  return { client_id: id, ...(process.env.GOOGLE_CALENDAR_CLIENT_SECRET ? { client_secret: process.env.GOOGLE_CALENDAR_CLIENT_SECRET } : {}) };
}
function redirectUri() {
  const origin = MODE === "web" ? process.env.ORGANIZER_PUBLIC_ORIGIN : `http://127.0.0.1:${Number(process.env.PORT) || 4320}`;
  if (!origin || (MODE === "web" && !origin.startsWith("https://"))) throw new Error("Google Calendar needs a configured HTTPS public origin.");
  return new URL("/api/google-calendar/callback", origin).href;
}
async function context() {
  const auth = await authState();
  if (auth?.clientId || (auth && !canUsePlanner(auth)) || (!auth && MODE === "web")) throw new Error("Sign in to PacedMind to manage Google Calendar.");
  if (auth) await requirePlannerAccess();
  return { scope: auth?.user.id ?? "local", store: auth ? cloud : local };
}

/** The database lease serializes tabs/processes. Every checkpoint rechecks the live account and CAS revision. */
async function locked<T>(work: (c: Connection, save: () => Promise<void>, store: CalendarStore) => Promise<T>, options: { create?: boolean } = {}): Promise<T | null> {
  const ctx = await context();
  const k = key();
  if (!k) throw new Error("Google Calendar needs a valid encryption key on this server.");
  let row = await ctx.store.getCalendarConnection();
  if (!row && !options.create) return null;
  if (row && row.owner !== owner(k)) throw new Error("This calendar connection runs on another computer. Manage it there, or disconnect it here first.");
  if (row && row.leaseUntil > Date.now()) return null;
  const c: Connection = row ? decrypt(row.payload, k, ctx.scope) : {};
  const first: CalendarConnectionRow = { revision: (row?.revision ?? 0) + 1, owner: owner(k), payload: encrypt(c, k, ctx.scope), leaseUntil: Date.now() + 120_000 };
  if (!(await ctx.store.putCalendarConnection(first, row?.revision ?? null))) return null;
  row = first;
  const save = async (release = false) => {
    const current = await readAuthState();
    if ((current?.user.id ?? "local") !== ctx.scope || current?.clientId || (current && !canUsePlanner(current))) throw new Error("The PacedMind account changed. Calendar sync stopped.");
    const next = { revision: row!.revision + 1, owner: row!.owner, payload: encrypt(c, k, ctx.scope), leaseUntil: release ? 0 : Date.now() + 120_000 };
    if (!(await ctx.store.putCalendarConnection(next, row!.revision))) throw new Error("The calendar connection changed. Sync stopped.");
    row = next;
  };
  try { return await work(c, () => save(), ctx.store); }
  finally { await save(true); }
}

async function tokenRequest(values: Record<string, string>): Promise<Credentials> {
  const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15000),
    headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ...clientConfig(), ...values }) });
  if (!response.ok) throw new CalendarHttpError(response.status === 400 ? 401 : response.status);
  const data = await response.json();
  if (typeof data.access_token !== "string" || !Number.isFinite(data.expires_in)) throw new CalendarHttpError(401);
  if (typeof data.scope === "string" && SCOPES.some((s) => !data.scope.split(" ").includes(s))) throw new Error("Allow both Google Calendar permissions to enable two-way sync.");
  return { accessToken: data.access_token, refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : "", expiresAt: Date.now() + data.expires_in * 1000 };
}
function api(c: Connection, save: () => Promise<void>) {
  return async function request<T>(route: string, init: RequestInit = {}): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!c.credentials) throw new CalendarHttpError(401);
      if (c.credentials.expiresAt < Date.now() + 60000) {
        const old = c.credentials.refreshToken;
        const next = await tokenRequest({ grant_type: "refresh_token", refresh_token: old });
        c.credentials = { ...next, refreshToken: next.refreshToken || old }; await save();
      }
      await save();
      const response = await fetch(`${API}${route}`, { ...init, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15000),
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${c.credentials.accessToken}`, ...init.headers } });
      if (response.status === 401 && attempt === 0) { c.credentials.expiresAt = 0; continue; }
      if ((response.status === 429 || response.status >= 500) && attempt < 2) { await new Promise((r) => setTimeout(r, 300 * 2 ** attempt)); continue; }
      if (!response.ok) throw new CalendarHttpError(response.status);
      return response.status === 204 ? undefined as T : response.json() as Promise<T>;
    }
    throw new CalendarHttpError(503);
  };
}

function ioFor(c: Connection, save: () => Promise<void>, store: CalendarStore): SyncIO {
  const call = api(c, save);
  const base = `/calendars/${encodeURIComponent(c.sync!.calendarId)}/events`;
  const get = async (id: string): Promise<GoogleEvent> => {
    try { return await call(`${base}/${encodeURIComponent(id)}`); }
    catch (e) { if (e instanceof CalendarHttpError && (e.status === 404 || e.status === 410)) return { id, status: "cancelled" }; throw e; }
  };
  return {
    list: store.listEvents, create: store.createEvent,
    update: async (_id, patch, before) => { if (!before || !(await store.changeCalendarEvent(before, patch))) throw new Error("The activity changed during sync. It will be checked again."); },
    remove: async (_id, before) => { if (!before || !(await store.changeCalendarEvent(before, null))) throw new Error("The activity changed during sync. It will be checked again."); },
    save, get,
    changes: async (token) => {
      const read = async (cursor?: string) => {
        const events: GoogleEvent[] = []; let page: string | undefined;
        do {
          const q = new URLSearchParams({ maxResults: "2500", singleEvents: "false", showDeleted: "true", eventTypes: "default" });
          if (cursor) q.set("syncToken", cursor);
          if (page) q.set("pageToken", page);
          const data = await call<{ items?: GoogleEvent[]; nextPageToken?: string; nextSyncToken?: string }>(`${base}?${q}`);
          events.push(...data.items ?? []); page = data.nextPageToken;
          if (!page) { if (!data.nextSyncToken) throw new CalendarHttpError(503); return { events, token: data.nextSyncToken, full: !cursor }; }
        } while (page);
        throw new CalendarHttpError(503);
      };
      try { return await read(token); } catch (e) { if (token && e instanceof CalendarHttpError && e.status === 410) return read(); throw e; }
    },
    insert: async (id: string, fields: EventFields) => {
      try { return await call<GoogleEvent>(`${base}?sendUpdates=none`, { method: "POST", body: JSON.stringify({ id, ...googleBody(fields) }) }); }
      catch (e) { if (e instanceof CalendarHttpError && e.status === 409) return get(id); throw e; }
    },
    patch: (e, fields) => call(`${base}/${encodeURIComponent(e.id)}?sendUpdates=none`, { method: "PATCH", headers: { "If-Match": e.etag ?? "*" }, body: JSON.stringify(googlePatch(e, fields, c.sync!.timeZone)) }),
    delete: async (e) => {
      try { await call(`${base}/${encodeURIComponent(e.id)}?sendUpdates=none`, { method: "DELETE", headers: { "If-Match": e.etag ?? "*" } }); }
      catch (error) { if (!(error instanceof CalendarHttpError && [404, 410].includes(error.status))) throw error; }
    },
  };
}

export async function googleCalendarStatus(): Promise<GoogleCalendarStatus> {
  const ctx = await context(); const k = key();
  let row: CalendarConnectionRow | null;
  try { row = await ctx.store.getCalendarConnection(); }
  catch (error) {
    if (error instanceof Error && /google_calendar_connections/.test(error.message) && /schema cache|does not exist/i.test(error.message)) {
      return { configured: false, connected: false, elsewhere: false, error: "Google Calendar requires a database update before it can connect." };
    }
    throw error;
  }
  const status: GoogleCalendarStatus = { configured: !!calendarClientId() && !!k, connected: !!row, elsewhere: !!row && (!k || row.owner !== owner(k)) };
  if (row && k && !status.elsewhere) {
    try {
      const c = decrypt(row.payload, k, ctx.scope);
      const localEvents = c.sync && Object.values(c.sync.links).some((l) => l.conflict) ? await ctx.store.listEvents() : [];
      const preview = (fields: EventFields | null) => fields ? { title: fields.title, start: fields.schedule.start, end: fields.schedule.end, timeZone: fields.schedule.timeZone, description: fields.description, location: fields.location } : null;
      Object.assign(status, { connected: !!c.credentials, calendarName: c.calendarName, lastSync: c.sync?.lastSync, error: c.error, calendars: c.calendars,
        conflicts: Object.entries(c.sync?.links ?? {}).filter(([, v]) => v.conflict).map(([id, v]) => {
          const event = localEvents.find((e) => e.id === v.localId);
          return { id, title: v.base?.title ?? v.remote.summary ?? "", fields: v.conflict!.fields,
            local: preview(event ? localFields(event, c.sync!.localTimeZone ?? c.sync!.timeZone) : null),
            google: preview(remoteFields(v.conflict!.remote, c.sync!.timeZone)) };
        }) });
    } catch { status.error = "The calendar connection could not be opened. Disconnect it and connect again."; }
  }
  return status;
}

export async function beginGoogleCalendar(): Promise<string> {
  clientConfig();
  if (!(await cloudWritable())) throw new Error("PacedMind Cloud is read-only.");
  const result = await locked(async (c, save) => {
    if (c.credentials) throw new Error("Disconnect the current Google Calendar connection first.");
    const state = crypto.randomBytes(32).toString("base64url");
    const verifier = crypto.randomBytes(48).toString("base64url");
    c.pending = { stateHash: crypto.createHash("sha256").update(state).digest("hex"), verifier, until: Date.now() + 10 * 60_000, redirectUri: redirectUri() };
    await save();
    const q = new URLSearchParams({ client_id: clientConfig().client_id, redirect_uri: c.pending.redirectUri, response_type: "code", scope: SCOPES.join(" "),
      access_type: "offline", prompt: "consent", state, code_challenge: crypto.createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" });
    return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
  }, { create: true });
  if (!result) throw new Error("Calendar sync is busy. Try again in a moment.");
  return result;
}

export async function finishGoogleCalendar(state: string, code: string | null) {
  if (!state || state.length > 200 || (code && code.length > 4096)) throw new Error("That Google Calendar connection link has expired.");
  const done = await locked(async (c, save) => {
    const pending = c.pending;
    const hash = crypto.createHash("sha256").update(state).digest("hex");
    if (!pending || pending.until < Date.now() || !crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(pending.stateHash))) throw new Error("That Google Calendar connection link has expired.");
    delete c.pending; await save(); // Single-use even if Google rejects the code.
    if (!code) { c.error = "Google Calendar connection was cancelled."; throw new Error(c.error); }
    c.credentials = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: pending.redirectUri, code_verifier: pending.verifier });
    if (!c.credentials.refreshToken) { delete c.credentials; throw new Error("Google did not grant offline access. Connect again and allow access."); }
    const call = api(c, save); let page: string | undefined;
    c.calendars = [];
    do {
      const data = await call<{ items?: { id: string; summary: string; accessRole: string; timeZone: string }[]; nextPageToken?: string }>(`/users/me/calendarList?minAccessRole=writer${page ? `&pageToken=${encodeURIComponent(page)}` : ""}`);
      c.calendars.push(...(data.items ?? []).filter((x) => ["owner", "writer"].includes(x.accessRole)).map((x) => ({ id: x.id, name: x.summary, timeZone: x.timeZone })));
      page = data.nextPageToken;
    } while (page);
    delete c.error; return true;
  });
  if (!done) throw new Error("Calendar sync is busy. Open Settings and connect again.");
}

export async function selectGoogleCalendar(id: string, includeExisting: boolean, localTimeZone: string) {
  Temporal.Now.zonedDateTimeISO(localTimeZone);
  if (!(await cloudWritable())) throw new Error("PacedMind Cloud is read-only.");
  const selected = await locked(async (c, save, store) => {
    if (c.sync) throw new Error("Disconnect before choosing another calendar.");
    const chosen = c.calendars?.find((x) => x.id === id);
    if (!chosen || !c.credentials) throw new Error("Choose a calendar you can edit.");
    Temporal.Now.zonedDateTimeISO(chosen.timeZone);
    c.sync = { connectionId: crypto.randomBytes(16).toString("hex"), calendarId: chosen.id, timeZone: chosen.timeZone, localTimeZone, links: {}, excluded: includeExisting ? [] : (await store.listEvents()).map((e) => e.id) };
    c.calendarName = chosen.name; delete c.error; await save(); return true;
  });
  if (!selected) throw new Error("Calendar sync is busy. Try again in a moment.");
  await syncGoogleCalendar(true);
}

export async function syncGoogleCalendar(force = false) {
  if (!calendarClientId() || !key()) return;
  const status = await googleCalendarStatus();
  if (!status.connected || status.elsewhere) return;
  if (!(await cloudWritable())) return;
  const ran = await locked(async (c, save, store) => {
    if (!c.sync || !c.credentials || (!force && (c.retryAt ?? 0) > Date.now())) return;
    if (!force && Date.now() - Date.parse(c.sync.lastSync ?? "1970-01-01") < 60_000) return;
    try { await synchronize(c.sync, ioFor(c, save, store)); delete c.error; delete c.retryAt; }
    catch (e) {
      c.error = e instanceof CalendarHttpError ? e.message : "Calendar sync could not finish. Try again, or reconnect Google Calendar.";
      c.retryAt = Date.now() + (e instanceof CalendarHttpError && [401, 403].includes(e.status) ? 15 * 60_000 : 60_000);
      await save();
      if (force) throw new Error(c.error);
    }
    return true;
  });
  if (force && ran === null) throw new Error("Calendar sync is busy. Try again in a moment.");
}

export async function resolveGoogleConflict(id: string, choice: "local" | "google") {
  if (!["local", "google"].includes(choice)) throw new Error("Choose which version to keep.");
  if (!(await cloudWritable())) throw new Error("PacedMind Cloud is read-only.");
  const result = await locked(async (c, save, store) => {
    if (!c.sync) throw new Error("Choose a Google Calendar first.");
    await resolveConflict(c.sync, id, choice, ioFor(c, save, store)); return true;
  });
  if (!result) throw new Error("Calendar sync is busy. Try again in a moment.");
}

export async function disconnectGoogleCalendar() {
  const ctx = await context(); const row = await ctx.store.getCalendarConnection();
  if (!row) return;
  if (row.leaseUntil > Date.now()) throw new Error("Calendar sync is busy. Try again in a moment.");
  if (!(await ctx.store.deleteCalendarConnection(row.revision))) throw new Error("The calendar connection changed. Try again.");
  // Remove local authorization only. Google's revoke endpoint revokes the whole OAuth grant (possibly other calendars/devices).
}
