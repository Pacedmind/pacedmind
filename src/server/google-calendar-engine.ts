import crypto from "node:crypto";
import type { CalEvent } from "@/lib/types";
import { calendarDetails, wallTime, zonedTime } from "@/lib/calendar-sync";

export interface GoogleEvent {
  id: string;
  etag?: string;
  status?: string;
  eventType?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: { date?: string; dateTime?: string; timeZone?: string };
  end?: { date?: string; dateTime?: string; timeZone?: string };
  recurrence?: string[];
  recurringEventId?: string;
  originalStartTime?: { date?: string; dateTime?: string; timeZone?: string };
}
export interface EventFields {
  title: string;
  description: string;
  location: string;
  schedule: { start: string; end: string; allDay: boolean; timeZone: string; recurrence: string[] };
}
export interface EventLink {
  localId: number | null;
  base: EventFields | null;
  remote: GoogleEvent;
  conflict?: { fields: string[]; remote: GoogleEvent };
  replacementId?: string;
  pending?: GoogleEvent;
}
export interface SyncState {
  connectionId: string;
  calendarId: string;
  timeZone: string;
  localTimeZone?: string;
  syncToken?: string;
  links: Record<string, EventLink>;
  /** Events that existed before the user connected, unless export-existing was selected. */
  excluded: number[];
  lastSync?: string;
}
export interface SyncIO {
  list(): Promise<CalEvent[]>;
  create(event: Omit<CalEvent, "id" | "doneOn">): Promise<number>;
  update(id: number, event: Partial<CalEvent>, before?: CalEvent): Promise<unknown>;
  remove(id: number, before?: CalEvent): Promise<unknown>;
  changes(token?: string): Promise<{ events: GoogleEvent[]; token: string; full: boolean }>;
  get(id: string): Promise<GoogleEvent>;
  insert(id: string, fields: EventFields): Promise<GoogleEvent>;
  patch(event: GoogleEvent, fields: EventFields): Promise<GoogleEvent>;
  delete(event: GoogleEvent): Promise<unknown>;
  /** Persist before another side effect; also verifies the connection still owns its lease/scope. */
  save(): Promise<void>;
}

export const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function localFields(e: CalEvent, zone: string): EventFields {
  const c = e.calendar;
  return { title: e.title, description: c?.description ?? "", location: c?.location ?? "", schedule: {
    start: e.start, end: e.end, allDay: c?.allDay === true, timeZone: c?.timeZone ?? zone,
    recurrence: c?.recurrence ?? (e.recurrence === "weekly" ? ["RRULE:FREQ=WEEKLY"] : []),
  } };
}

export function remoteFields(e: GoogleEvent, zone: string): EventFields | null {
  if (e.status === "cancelled") return null;
  if (!e.start || !e.end) throw new Error("Google returned an event without a start or end.");
  const timeZone = e.start.timeZone ?? zone;
  const allDay = !!e.start.date;
  const start = allDay ? `${e.start.date}T00:00` : wallTime(e.start.dateTime!, timeZone);
  const end = allDay ? `${e.end.date}T00:00` : wallTime(e.end.dateTime!, timeZone);
  if (end <= start) throw new Error("Google returned an invalid event duration.");
  return { title: e.summary || "(Untitled)", description: e.description ?? "", location: e.location ?? "",
    schedule: { start, end, allDay, timeZone, recurrence: e.recurrence ?? [] } };
}

export function googleBody(fields: EventFields) {
  const s = fields.schedule;
  return { summary: fields.title, description: fields.description, location: fields.location,
    start: s.allDay ? { date: s.start.slice(0, 10) } : { dateTime: zonedTime(s.start, s.timeZone), timeZone: s.timeZone },
    end: s.allDay ? { date: s.end.slice(0, 10) } : { dateTime: zonedTime(s.end, s.timeZone), timeZone: s.timeZone },
    recurrence: s.recurrence.length ? s.recurrence : null };
}

/** PATCH only changed fields: renaming must preserve seconds, guests, Meet links and reminder settings. */
export function googlePatch(event: GoogleEvent, fields: EventFields, zone: string) {
  const before = remoteFields(event, zone);
  const body = googleBody(fields);
  return { ...(before?.title !== fields.title ? { summary: body.summary } : {}),
    ...(before?.description !== fields.description ? { description: body.description } : {}),
    ...(before?.location !== fields.location ? { location: body.location } : {}),
    ...(!same(before?.schedule, fields.schedule) ? { start: body.start, end: body.end, recurrence: body.recurrence } : {}) };
}

function localBody(f: EventFields, remote: GoogleEvent, state: SyncState, existing?: CalEvent): Omit<CalEvent, "id" | "doneOn"> {
  return { title: f.title, start: f.schedule.start, end: f.schedule.end, areaId: existing?.areaId ?? null,
    recurrence: same(f.schedule.recurrence, ["RRULE:FREQ=WEEKLY"]) ? "weekly" : null,
    calendar: calendarDetails({ ...existing?.calendar, description: f.description, location: f.location,
      ...f.schedule, source: { connectionId: state.connectionId, calendarId: state.calendarId, eventId: remote.id } }) };
}

/** Three-way field merge. Conflicting time/recurrence changes are atomic; neither side silently wins. */
export function mergeFields(base: EventFields, local: EventFields, remote: EventFields): { value: EventFields; conflicts: string[] } {
  const value = { ...remote };
  const conflicts: string[] = [];
  for (const key of ["title", "description", "location", "schedule"] as const) {
    if (same(local[key], base[key])) continue;
    if (!same(remote[key], base[key]) && !same(local[key], remote[key])) conflicts.push(key);
    else Object.assign(value, { [key]: local[key] });
  }
  return { value, conflicts };
}

/** Idempotent pull/merge/push with a checkpoint after every mutation, before advancing Google's cursor. */
export async function synchronize(state: SyncState, io: SyncIO): Promise<void> {
  const locals = new Map((await io.list()).map((e) => [e.id, e]));
  const batch = await io.changes(state.syncToken);
  const changed = new Map(batch.events.filter((e) => !e.eventType || e.eventType === "default").map((e) => [e.id, e]));
  if (batch.full) {
    for (const id of Object.keys(state.links)) if (!changed.has(id)) changed.set(id, await io.get(id));
  }
  const ids = [...new Set([...Object.keys(state.links), ...changed.keys()])];
  const removedParents = new Set<string>();
  // Series before exceptions; deleting a series also deletes its exceptions remotely.
  ids.sort((a, b) => Number(!!(changed.get(a) ?? state.links[a]?.remote)?.recurringEventId) - Number(!!(changed.get(b) ?? state.links[b]?.remote)?.recurringEventId));
  for (const id of ids) {
    const link = state.links[id];
    const received = changed.get(id) ?? link?.pending ?? link?.conflict?.remote ?? link?.remote;
    if (!received) continue;
    // A deleted resource may contain only its id; retain exception identity from the prior snapshot.
    const remote = received.status === "cancelled" && link ? { ...link.remote, ...received } : received;
    const r = remoteFields(remote, state.timeZone);
    const existing = link?.localId != null ? locals.get(link.localId) : [...locals.values()].find((e) =>
      e.calendar?.source?.calendarId === state.calendarId && e.calendar.source.eventId === id);
    const l = existing ? localFields(existing, state.localTimeZone ?? state.timeZone) : null;
    if (link && remote.recurringEventId && state.links[remote.recurringEventId]?.conflict) {
      link.pending = remote; await io.save(); continue;
    }
    if (remote.recurringEventId && removedParents.has(remote.recurringEventId)) {
      await io.save();
      if (existing) { await io.remove(existing.id, existing); locals.delete(existing.id); }
      delete state.links[id]; await io.save(); continue;
    }
    // An incremental poll usually changes only a few events. Keep checking local
    // edits/deletions, but don't rewrite the encrypted collection for every
    // unchanged mapping: each checkpoint is a round trip to the cloud store.
    const currentSource = existing?.calendar?.source;
    if (link && !changed.has(id) && !link.pending && !link.conflict && l && r && same(l, link.base)
      && currentSource?.eventId === id && currentSource.calendarId === state.calendarId
      && currentSource.connectionId === state.connectionId) continue;
    if (!link) {
      if (!r && !remote.recurringEventId) removedParents.add(id);
      let localId: number | null = existing?.id ?? null;
      if (r && !existing) { await io.save(); localId = await io.create(localBody(r, remote, state)); }
      state.links[id] = { localId, base: r, remote };
      await io.save();
      continue;
    }
    if (!l && !r) {
      removedParents.add(id);
      if (remote.recurringEventId) state.links[id] = { localId: null, base: null, remote };
      else delete state.links[id];
      await io.save(); continue;
    }
    if (!l || !r) {
      const survivor = l ?? r;
      if (!same(survivor, link.base)) {
        link.conflict = { fields: ["deletion"], remote }; await io.save(); continue;
      }
      await io.save();
      if (l && existing) { await io.remove(existing.id, existing); locals.delete(existing.id); }
      else if (r) await io.delete(remote);
      removedParents.add(id);
      // Keep cancelled recurring exceptions so the parent occurrence stays excluded.
      if (remote.recurringEventId) state.links[id] = { localId: null, base: null, remote: { ...remote, status: "cancelled" } };
      else delete state.links[id];
      await io.save();
      continue;
    }
    const merged = mergeFields(link.base ?? r, l, r);
    if (merged.conflicts.length) { link.conflict = { fields: merged.conflicts, remote }; await io.save(); continue; }
    let finalRemote = remote;
    if (!same(merged.value, r)) { await io.save(); finalRemote = await io.patch(remote, merged.value); }
    const source = existing!.calendar?.source;
    if (!same(merged.value, l) || source?.eventId !== id || source.calendarId !== state.calendarId || source.connectionId !== state.connectionId) {
      await io.save(); await io.update(existing!.id, localBody(merged.value, finalRemote, state, existing), existing);
    }
    state.links[id] = { localId: existing!.id, base: merged.value, remote: finalRemote };
    await io.save();
  }
  const linked = new Set(Object.values(state.links).map((l) => l.localId));
  for (const event of locals.values()) {
    if (linked.has(event.id) || state.excluded.includes(event.id)) continue;
    // An import recovered during this pass is already linked by its provider id.
    if (event.calendar?.source?.calendarId === state.calendarId && state.links[event.calendar.source.eventId]) continue;
    const id = `pm${crypto.createHash("sha256").update(`${state.connectionId}:${event.id}`).digest("hex")}`;
    const fields = localFields(event, state.localTimeZone ?? state.timeZone);
    await io.save();
    const remote = await io.insert(id, fields);
    if (remote.status === "cancelled") {
      state.links[id] = { localId: event.id, base: fields, remote, conflict: { fields: ["deletion"], remote } };
      await io.save(); continue;
    }
    state.links[remote.id] = { localId: event.id, base: fields, remote };
    await io.update(event.id, localBody(fields, remote, state, event), event);
    await io.save();
  }
  // Exception timestamps are in the master's timezone, regardless of where an exception moved.
  const currentEvents = new Map((await io.list()).map((e) => [e.id, e]));
  for (const [id, link] of Object.entries(state.links)) {
    if (link.localId == null || link.remote.recurringEventId) continue;
    const event = currentEvents.get(link.localId);
    if (!event) continue;
    const exclusions = Object.values(state.links).filter((l) => l.remote.recurringEventId === id).flatMap((l) => {
      const o = l.remote.originalStartTime;
      return o?.date ? [o.date] : o?.dateTime ? [wallTime(o.dateTime, event.calendar?.timeZone ?? state.timeZone)] : [];
    }).sort();
    if (!same(event.calendar?.excludedStarts ?? [], exclusions)) {
      await io.save(); await io.update(event.id, { calendar: { ...event.calendar, excludedStarts: exclusions } }, event);
    }
  }
  state.syncToken = batch.token;
  state.lastSync = new Date().toISOString();
  await io.save();
}

/** Resolving a conflict updates the baseline; the next pass applies the chosen side with current etags. */
export async function resolveConflict(state: SyncState, id: string, choice: "local" | "google", io: SyncIO) {
  const link = state.links[id];
  if (!link?.conflict) throw new Error("That conflict has already been resolved.");
  const remote = await io.get(id);
  if (remote.etag && link.conflict.remote.etag && remote.etag !== link.conflict.remote.etag) {
    link.conflict.remote = remote; await io.save();
    throw new Error("This event changed again in Google. Review the new version before choosing.");
  }
  const r = remoteFields(remote, state.timeZone);
  const local = (await io.list()).find((e) => e.id === link.localId);
  const removeChildren = async () => {
    const locals = await io.list();
    for (const [childId, child] of Object.entries(state.links)) {
      if (child.remote.recurringEventId !== id) continue;
      const event = locals.find((e) => e.id === child.localId);
      await io.save(); if (event) await io.remove(event.id, event);
      delete state.links[childId]; await io.save();
    }
  };
  if (choice === "google") {
    await io.save();
    if (r) {
      if (local) await io.update(local.id, localBody(r, remote, state, local), local);
      else link.localId = await io.create(localBody(r, remote, state));
      link.base = r; link.remote = remote; delete link.conflict;
    } else {
      if (local) await io.remove(local.id, local);
      await removeChildren();
      if (remote.recurringEventId) { link.localId = null; link.base = null; link.remote = remote; delete link.conflict; }
      else delete state.links[id];
    }
  } else if (local && r) {
    await io.save();
    const l = localFields(local, state.localTimeZone ?? state.timeZone);
    link.remote = await io.patch(remote, l); link.base = l; delete link.conflict;
  } else if (!local && r) {
    await io.save(); await io.delete(remote); await removeChildren(); delete state.links[id];
  } else if (local) {
    // Google tombstones cannot be reused; create a fresh id, checkpointed by its stable source tag.
    const newId = link.replacementId ??= `pm${crypto.randomBytes(20).toString("hex")}`;
    const l = localFields(local, state.localTimeZone ?? state.timeZone);
    if (l.schedule.recurrence.length && local.calendar?.excludedStarts?.length) {
      const exclusions = local.calendar.excludedStarts.map((s) => l.schedule.allDay ? s.slice(0, 10).replace(/-/g, "") : s.replace(/[-:]/g, "") + "00");
      l.schedule.recurrence = [...l.schedule.recurrence, `EXDATE${l.schedule.allDay ? ";VALUE=DATE" : `;TZID=${l.schedule.timeZone}`}:${exclusions.join(",")}`];
    }
    await io.save();
    const created = await io.insert(newId, l);
    state.links[created.id] = { localId: local.id, base: l, remote: created }; delete state.links[id];
    await io.update(local.id, localBody(l, created, state, local), local);
    // Restore moved exceptions as one-off events, with the original slots excluded in the restored series.
    const events = await io.list();
    for (const [childId, child] of Object.entries(state.links)) {
      if (child.remote.recurringEventId !== id) continue;
      const event = events.find((e) => e.id === child.localId);
      await io.save();
      if (event) await io.update(event.id, { calendar: { ...event.calendar, source: undefined } }, event);
      delete state.links[childId]; await io.save();
    }
  }
  await io.save();
}
