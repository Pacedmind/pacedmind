import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "pacedmind-google-test-"));
process.env.ORGANIZER_DB = path.join(dir, "organizer.db");
process.env.ORGANIZER_SEED = "empty";
process.env.ORGANIZER_MODE = "desktop";
process.env.GOOGLE_CALENDAR_CLIENT_ID = "calendar-test.apps.googleusercontent.com";
process.env.GOOGLE_CALENDAR_CLIENT_SECRET = "test-secret";
process.env.GOOGLE_CALENDAR_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.PORT = "4320";

test("OAuth, encrypted storage, incremental refresh, conditional writes and disconnect", async () => {
  const { beginGoogleCalendar, finishGoogleCalendar, googleCalendarStatus, selectGoogleCalendar, syncGoogleCalendar, disconnectGoogleCalendar } = await import("../src/server/google-calendar");
  const store = await import("../src/server/store/local");
  const { db, resetLocal } = await import("../src/server/store/local-db");
  const requests: { url: URL; init: RequestInit }[] = [];
  let tokenRequests = 0; let resetCursor = false; let precondition = false;
  const remote = { id: "remote", etag: '"one"', summary: "Remote", start: { dateTime: "2026-10-26T10:00:35+01:00", timeZone: "Europe/Warsaw" }, end: { dateTime: "2026-10-26T11:00:35+01:00", timeZone: "Europe/Warsaw" } };
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input)); requests.push({ url, init });
    if (url.hostname === "oauth2.googleapis.com") { tokenRequests++; return Response.json({ access_token: "private-access-token", refresh_token: "private-refresh-token", expires_in: 3600 }); }
    assert.equal(url.hostname, "www.googleapis.com");
    if (url.pathname.endsWith("calendarList")) return Response.json({ items: [{ id: "primary", summary: "My calendar", accessRole: "owner", timeZone: "Europe/Warsaw" }, { id: "readonly", summary: "No", accessRole: "reader", timeZone: "UTC" }] });
    if (init.method === "POST") return Response.json({ ...JSON.parse(String(init.body)), etag: '"inserted"' });
    if (init.method === "PATCH") {
      assert.equal((init.headers as Record<string, string>)["If-Match"], '"one"');
      const body = JSON.parse(String(init.body)); assert.deepEqual(body, { summary: "Local edit" });
      return precondition ? new Response(null, { status: 412 }) : Response.json({ ...remote, summary: body.summary, etag: '"two"' });
    }
    if (url.pathname.endsWith("/events")) {
      if (resetCursor && url.searchParams.has("syncToken")) { resetCursor = false; return new Response(null, { status: 410 }); }
      return Response.json({ items: url.searchParams.has("syncToken") ? [] : [remote], nextSyncToken: "cursor" });
    }
    return Response.json(remote);
  };
  try {
    const native = await store.createEvent({ title: "Native", start: "2026-10-26T12:00", end: "2026-10-26T13:00" });
    const link = new URL(await beginGoogleCalendar());
    assert.equal(link.hostname, "accounts.google.com"); assert.equal(link.searchParams.get("code_challenge_method"), "S256");
    assert.equal(link.searchParams.get("redirect_uri"), "http://127.0.0.1:4320/api/google-calendar/callback");
    assert.ok(!link.href.includes("test-secret"));
    await assert.rejects(finishGoogleCalendar("wrong", "code")); assert.equal(tokenRequests, 0);
    await finishGoogleCalendar(link.searchParams.get("state")!, "code");
    await assert.rejects(finishGoogleCalendar(link.searchParams.get("state")!, "code")); assert.equal(tokenRequests, 1);
    assert.deepEqual((await googleCalendarStatus()).calendars?.map((c) => c.id), ["primary"]);
    const raw = await store.getCalendarConnection(); assert.ok(raw); assert.ok(!JSON.stringify(raw).includes("private-"));
    assert.ok(!JSON.stringify(await googleCalendarStatus()).includes("private-"));
    await selectGoogleCalendar("primary", false, "Europe/Warsaw");
    assert.equal((await store.listEvents()).length, 2); assert.ok((await store.getEvent(native)));
    assert.equal(requests.filter((r) => r.init.method === "POST" && r.url.hostname === "www.googleapis.com").length, 0);
    const imported = (await store.listEvents()).find((e) => e.title === "Remote")!;
    await store.updateEvent(imported.id, { title: "Local edit" }); precondition = true;
    await assert.rejects(syncGoogleCalendar(true), /changed during sync/);
    assert.equal((await store.getEvent(imported.id))?.title, "Local edit");
    precondition = false; await syncGoogleCalendar(true);
    assert.ok(requests.some((r) => r.url.searchParams.get("syncToken") === "cursor"));
    resetCursor = true; await syncGoogleCalendar(true);
    assert.equal((await store.listEvents()).length, 2);
    // SQLite compare-and-swap protects an edit made during the request.
    const before = (await store.getEvent(native))!; await store.updateEvent(native, { title: "Racing edit" });
    assert.equal(await store.changeCalendarEvent(before, { title: "Stale remote" }), false);
    assert.equal(await store.changeCalendarEvent(before, null), false);
    await disconnectGoogleCalendar(); assert.equal(await store.getCalendarConnection(), null);
    assert.equal((await store.listEvents()).length, 2);
    // Reset clears credentials; backups never restore an active connection.
    await beginGoogleCalendar(); resetLocal("empty"); assert.equal(await store.getCalendarConnection(), null);
    assert.ok(!readFileSync(process.env.ORGANIZER_DB!).includes(Buffer.from("private-access-token")));
    db().close();
  } finally { globalThis.fetch = original; }
});

test("Google connection secrets never reach launched agents", async () => {
  const { agentEnv, HOST_SESSION_VARS } = await import("../src/server/shell");
  const env = agentEnv();
  for (const name of ["GOOGLE_CALENDAR_CLIENT_ID", "GOOGLE_CALENDAR_CLIENT_SECRET", "GOOGLE_CALENDAR_ENCRYPTION_KEY"]) {
    assert.equal(env[name], undefined); assert.ok(HOST_SESSION_VARS.includes(name));
  }
});
