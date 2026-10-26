import assert from "node:assert/strict";
import { test } from "node:test";
import { detailedOccurrences, zonedTime } from "../src/lib/calendar-sync";
import { googleBody, googlePatch, localFields, mergeFields, remoteFields, resolveConflict, synchronize, type GoogleEvent, type SyncIO, type SyncState } from "../src/server/google-calendar-engine";
import type { CalEvent } from "../src/lib/types";

const event = (id = 1): CalEvent => ({ id, title: "Meeting", areaId: null, start: "2026-10-26T10:00", end: "2026-10-26T11:00", recurrence: null, doneOn: [] });
const remote = (id = "google1"): GoogleEvent => ({ id, etag: '"1"', summary: "Meeting", start: { dateTime: "2026-10-26T10:00:00+01:00", timeZone: "Europe/Warsaw" }, end: { dateTime: "2026-10-26T11:00:00+01:00", timeZone: "Europe/Warsaw" } });
function fixture(initial: CalEvent[] = [], initialRemote: GoogleEvent[] = []) {
  const state: SyncState = { connectionId: "conn", calendarId: "primary", timeZone: "Europe/Warsaw", links: {}, excluded: [] };
  const locals = new Map(initial.map((e) => [e.id, e])); const remotes = new Map(initialRemote.map((e) => [e.id, e]));
  let next = Math.max(0, ...locals.keys()) + 1; let writes = 0; let page: GoogleEvent[] | null = null;
  const io: SyncIO = {
    list: async () => [...locals.values()],
    create: async (e) => { const id = next++; locals.set(id, { ...e, id, doneOn: [] }); return id; },
    update: async (id, patch) => { locals.set(id, { ...locals.get(id)!, ...patch }); },
    remove: async (id) => { locals.delete(id); },
    changes: async () => ({ events: page ?? [...remotes.values()], token: "cursor", full: page === null }),
    get: async (id) => remotes.get(id) ?? { id, status: "cancelled" },
    insert: async (id, f) => { if (remotes.has(id)) return remotes.get(id)!; writes++; const r = { id, etag: '"2"', ...googleBody(f) } as GoogleEvent; remotes.set(id, r); return r; },
    patch: async (r, f) => { writes++; const v = { ...r, ...googleBody(f), etag: '"2"' } as GoogleEvent; remotes.set(r.id, v); return v; },
    delete: async (r) => { writes++; remotes.set(r.id, { ...r, status: "cancelled" }); },
    save: async () => {},
  };
  return { state, locals, remotes, io, writes: () => writes, incremental: (values: GoogleEvent[] = []) => { page = values; } };
}

test("imports and exports once, and incremental sync never duplicates", async () => {
  const f = fixture([event()], [remote()]);
  await synchronize(f.state, f.io);
  assert.equal(f.locals.size, 2); assert.equal(f.remotes.size, 2); assert.equal(f.writes(), 1);
  f.incremental(); await synchronize(f.state, f.io); await synchronize(f.state, f.io);
  assert.equal(f.locals.size, 2); assert.equal(f.remotes.size, 2); assert.equal(f.writes(), 1);
});
test("existing events stay private unless selected, while new events export", async () => {
  const f = fixture([event()]); f.state.excluded = [1]; await synchronize(f.state, f.io);
  assert.equal(f.remotes.size, 0); f.locals.set(2, event(2)); await synchronize(f.state, f.io);
  assert.equal(f.remotes.size, 1);
});
test("Google changes and local changes propagate without touching area or done state", async () => {
  const f = fixture([], [remote()]); await synchronize(f.state, f.io);
  const local = [...f.locals.values()][0]; local.areaId = "area"; local.doneOn = ["2026-10-26"];
  f.remotes.set("google1", { ...remote(), summary: "Renamed" }); await synchronize(f.state, f.io);
  assert.equal(f.locals.get(local.id)?.title, "Renamed"); assert.equal(f.locals.get(local.id)?.areaId, "area");
  assert.deepEqual(f.locals.get(local.id)?.doneOn, ["2026-10-26"]);
  f.locals.get(local.id)!.title = "Local rename"; f.incremental(); await synchronize(f.state, f.io);
  assert.equal(f.remotes.get("google1")?.summary, "Local rename");
});
test("simultaneous different fields merge; same field conflicts need a choice", async () => {
  const f = fixture([], [remote()]); await synchronize(f.state, f.io);
  const local = [...f.locals.values()][0]; local.title = "Local";
  f.remotes.set("google1", { ...remote(), location: "Room" }); await synchronize(f.state, f.io);
  assert.equal(f.locals.get(local.id)?.calendar?.location, "Room"); assert.equal(f.remotes.get("google1")?.summary, "Local");
  f.locals.get(local.id)!.title = "New local";
  f.remotes.set("google1", { ...f.remotes.get("google1")!, summary: "New Google" }); await synchronize(f.state, f.io);
  assert.deepEqual(f.state.links.google1.conflict?.fields, ["title"]);
  assert.equal(f.locals.get(local.id)?.title, "New local");
  await resolveConflict(f.state, "google1", "google", f.io);
  assert.equal(f.locals.get(local.id)?.title, "New Google"); assert.equal(f.state.links.google1.conflict, undefined);
});
test("deletions propagate both ways; edit versus deletion becomes a conflict", async () => {
  const f = fixture([], [remote()]); await synchronize(f.state, f.io);
  f.locals.clear(); await synchronize(f.state, f.io); assert.equal(f.remotes.get("google1")?.status, "cancelled");
  const g = fixture([], [remote()]); await synchronize(g.state, g.io);
  g.remotes.set("google1", { id: "google1", status: "cancelled" }); await synchronize(g.state, g.io); assert.equal(g.locals.size, 0);
  const h = fixture([], [remote()]); await synchronize(h.state, h.io);
  [...h.locals.values()][0].title = "Edited"; h.remotes.set("google1", { id: "google1", status: "cancelled" }); await synchronize(h.state, h.io);
  assert.deepEqual(h.state.links.google1.conflict?.fields, ["deletion"]);
  await resolveConflict(h.state, "google1", "local", h.io);
  assert.equal(h.locals.size, 1); assert.equal([...h.remotes.values()].filter((e) => e.status !== "cancelled").length, 1);
});
test("retry after a failed checkpoint recovers imported events by source id", async () => {
  const f = fixture([], [remote()]);
  const save = f.io.save; let fail = true;
  f.io.create = async (e) => { f.locals.set(1, { ...e, id: 1, doneOn: [] }); if (fail) { fail = false; throw new Error("crash"); } return 1; };
  await assert.rejects(synchronize(f.state, f.io));
  f.io.save = save; await synchronize(f.state, f.io); assert.equal(f.locals.size, 1);
});
test("all-day events retain exclusive end dates and appear on each occupied day", () => {
  const r: GoogleEvent = { id: "day", summary: "Holiday", start: { date: "2026-10-26" }, end: { date: "2026-10-29" } };
  const fields = remoteFields(r, "Europe/Warsaw")!; assert.equal(fields.schedule.allDay, true);
  assert.deepEqual(googleBody(fields).end, { date: "2026-10-29" });
  const e = { ...event(), start: fields.schedule.start, end: fields.schedule.end, calendar: { allDay: true } };
  const dates = detailedOccurrences(e, "2026-10-25", "2026-10-30", "America/Los_Angeles").map((o) => o.start.slice(0, 10));
  assert.deepEqual(dates, ["2026-10-26", "2026-10-27", "2026-10-28"]);
});
test("weekly recurrence holds wall time across DST and converts for another zone", () => {
  const e: CalEvent = { ...event(), start: "2026-10-19T10:00", end: "2026-10-19T11:00", recurrence: "weekly", calendar: { timeZone: "Europe/Warsaw" } };
  const times = detailedOccurrences(e, "2026-10-19", "2026-11-02", "UTC").map((o) => o.start);
  assert.deepEqual(times, ["2026-10-19T08:00", "2026-10-26T09:00", "2026-11-02T09:00"]);
  assert.match(zonedTime("2026-10-26T10:00", "Europe/Warsaw"), /\+01:00$/);
});
test("monthly rules, cancelled instances and moved exceptions do not duplicate", async () => {
  const parent = { ...remote(), recurrence: ["RRULE:FREQ=MONTHLY;COUNT=3"] };
  const cancelled: GoogleEvent = { id: "exception", status: "cancelled", recurringEventId: parent.id, originalStartTime: parent.start };
  const f = fixture([], [parent, cancelled]); await synchronize(f.state, f.io); f.incremental(); await synchronize(f.state, f.io);
  const e = [...f.locals.values()][0]; assert.deepEqual(e.calendar?.excludedStarts, ["2026-10-26T10:00"]);
  const dates = detailedOccurrences(e, "2026-10-01", "2026-12-31", "Europe/Warsaw").map((o) => o.start);
  assert.deepEqual(dates, ["2026-11-26T10:00", "2026-12-26T10:00"]);
});
test("a full resync reconciles mappings without reimporting or re-exporting", async () => {
  const f = fixture([], [remote()]); await synchronize(f.state, f.io); delete f.state.syncToken;
  await synchronize(f.state, f.io); assert.equal(f.locals.size, 1); assert.equal(f.writes(), 0);
});
test("schedule conflicts include time zones and recurrence", () => {
  const base = localFields(event(), "Europe/Warsaw");
  assert.deepEqual(mergeFields(base, { ...base, schedule: { ...base.schedule, timeZone: "UTC" } }, { ...base, schedule: { ...base.schedule, recurrence: ["RRULE:FREQ=DAILY"] } }).conflicts, ["schedule"]);
});

test("removing a series removes its moved exceptions even when Google only returns the master", async () => {
  const parent = { ...remote(), recurrence: ["RRULE:FREQ=WEEKLY"] };
  const exception = { ...remote("moved"), recurringEventId: parent.id, originalStartTime: parent.start, start: { ...parent.start, dateTime: "2026-10-27T10:00:00+01:00" }, end: { ...parent.end, dateTime: "2026-10-27T11:00:00+01:00" } };
  const f = fixture([], [parent, exception]); await synchronize(f.state, f.io); assert.equal(f.locals.size, 2);
  f.incremental([{ id: parent.id, status: "cancelled" }]); await synchronize(f.state, f.io);
  assert.equal(f.locals.size, 0); assert.deepEqual(f.state.links, {});
});
test("reconnecting the same calendar reuses the imported events", async () => {
  const f = fixture([], [remote()]); await synchronize(f.state, f.io);
  f.state.connectionId = "new-connection"; f.state.links = {}; delete f.state.syncToken;
  await synchronize(f.state, f.io); assert.equal(f.locals.size, 1); assert.equal(f.writes(), 0);
});
test("renaming preserves Google's sub-minute times and non-managed properties", () => {
  const r = { ...remote(), start: { dateTime: "2026-10-26T10:00:35+01:00", timeZone: "Europe/Warsaw" } };
  const f = remoteFields(r, "Europe/Warsaw")!;
  assert.deepEqual(googlePatch(r, { ...f, title: "Renamed" }, "Europe/Warsaw"), { summary: "Renamed" });
});
test("UTC UNTIL and EXDATE are interpreted in the series timezone", () => {
  const e: CalEvent = { ...event(), start: "2026-10-19T10:00", end: "2026-10-19T11:00", recurrence: null,
    calendar: { timeZone: "Europe/Warsaw", recurrence: ["RRULE:FREQ=WEEKLY;UNTIL=20261102T083000Z", "EXDATE:20261026T090000Z"] } };
  assert.deepEqual(detailedOccurrences(e, "2026-10-01", "2026-11-30", "Europe/Warsaw").map((o) => o.start), ["2026-10-19T10:00"]);
});

test("a series deletion conflict preserves its moved exceptions until the user chooses", async () => {
  const parent = { ...remote(), recurrence: ["RRULE:FREQ=WEEKLY"] };
  const child = { ...remote("moved"), recurringEventId: parent.id, originalStartTime: parent.start, start: { ...parent.start, dateTime: "2026-10-27T10:00:00+01:00" }, end: { ...parent.end, dateTime: "2026-10-27T11:00:00+01:00" } };
  const f = fixture([], [parent, child]); await synchronize(f.state, f.io);
  f.locals.get(f.state.links.google1.localId!)!.title = "Edited series";
  f.remotes.set("google1", { ...parent, status: "cancelled" }); f.remotes.set("moved", { ...child, status: "cancelled" });
  await synchronize(f.state, f.io); assert.equal(f.locals.size, 2);
  assert.ok(f.state.links.google1.conflict); assert.ok(f.state.links.moved.pending);
  await resolveConflict(f.state, "google1", "google", f.io);
  assert.equal(f.locals.size, 0); assert.deepEqual(f.state.links, {});
});
