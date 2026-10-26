import assert from "node:assert/strict";
import { test } from "node:test";
import crypto from "node:crypto";
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
  const { beginGoogleCalendar, finishGoogleCalendar, googleCalendarStatus, selectGoogleCalendar, syncGoogleCalendar, disconnectGoogleCalendar, defaultGoogleCalendar } = await import("../src/server/google-calendar");
  const store = await import("../src/server/store/local");
  const { db, resetLocal } = await import("../src/server/store/local-db");
  const requests: { url: URL; init: RequestInit }[] = [];
  let tokenRequests = 0; let resetCursor = false; let precondition = false; let account = 1; let rejectToken = false;
  const remote = { id: "remote", etag: '"one"', summary: "Remote", start: { dateTime: "2026-10-26T10:00:35+01:00", timeZone: "Europe/Warsaw" }, end: { dateTime: "2026-10-26T11:00:35+01:00", timeZone: "Europe/Warsaw" } };
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input)); requests.push({ url, init });
    if (url.hostname === "oauth2.googleapis.com") {
      tokenRequests++;
      if (rejectToken) return Response.json({ error: "invalid_request", error_description: "client_secret is missing." }, { status: 400 });
      assert.equal(new URLSearchParams(String(init.body)).get("client_secret"), "test-secret");
      return Response.json({ access_token: `private-access-token-${account}`, refresh_token: "private-refresh-token", expires_in: 3600 });
    }
    assert.equal(url.hostname, "www.googleapis.com");
    if (url.pathname.endsWith("calendarList")) return Response.json({ items: account === 1
      ? [{ id: "primary", summary: "My calendar", accessRole: "owner", timeZone: "Europe/Warsaw", primary: true }, { id: "work", summary: "Work", accessRole: "writer", timeZone: "UTC" }, { id: "readonly", summary: "No", accessRole: "reader", timeZone: "UTC" }]
      : [{ id: "secondary", summary: "Other account", accessRole: "owner", timeZone: "UTC", primary: true }] });
    if (init.method === "POST") return Response.json({ ...JSON.parse(String(init.body)), etag: '"inserted"' });
    if (init.method === "PATCH" && url.pathname.includes("/secondary/")) {
      const body = JSON.parse(String(init.body));
      assert.equal(body.summary, "Other edit");
      return Response.json({ ...remote, summary: "Other edit", etag: '"other-edit"' });
    }
    if (init.method === "PATCH") {
      assert.equal((init.headers as Record<string, string>)["If-Match"], '"one"');
      const body = JSON.parse(String(init.body)); assert.deepEqual(body, { summary: "Local edit" });
      return precondition ? new Response(null, { status: 412 }) : Response.json({ ...remote, summary: body.summary, etag: '"two"' });
    }
    if (url.pathname.endsWith("/events")) {
      if (resetCursor && url.searchParams.has("syncToken")) { resetCursor = false; return new Response(null, { status: 410 }); }
      return Response.json({ items: url.searchParams.has("syncToken") ? [] : [{ ...remote, summary: url.pathname.includes("/secondary/") ? "Other remote" : url.pathname.includes("/work/") ? "Work remote" : remote.summary }], nextSyncToken: "cursor" });
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
    assert.deepEqual((await googleCalendarStatus()).calendars?.map((c) => c.id), ["primary", "work"]);
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
    // Migrate a legacy encrypted single-calendar payload without reconnecting.
    const legacyRow = (await store.getCalendarConnection())!;
    const key = Buffer.from(process.env.GOOGLE_CALENDAR_ENCRYPTION_KEY!, "base64");
    const rawCipher = Buffer.from(legacyRow.payload, "base64");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, rawCipher.subarray(0, 12));
    decipher.setAAD(Buffer.from("google-calendar:local")); decipher.setAuthTag(rawCipher.subarray(12, 28));
    const bundle = JSON.parse(Buffer.concat([decipher.update(rawCipher.subarray(28)), decipher.final()]).toString());
    const legacy = bundle.connections[0]; delete legacy.id;
    const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv("aes-256-gcm", key, iv); cipher.setAAD(Buffer.from("google-calendar:local"));
    const bytes = Buffer.concat([cipher.update(JSON.stringify(legacy)), cipher.final()]);
    await store.putCalendarConnection({ ...legacyRow, revision: legacyRow.revision + 1, payload: Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString("base64") }, legacyRow.revision);
    assert.equal((await googleCalendarStatus()).connections?.length, 1);
    await syncGoogleCalendar(true); assert.equal((await store.listEvents()).length, 2);

    // A failed additional authorization preserves the first account and gives a safe useful error.
    const failed = new URL(await beginGoogleCalendar()); rejectToken = true;
    await assert.rejects(finishGoogleCalendar(failed.searchParams.get("state")!, "bad-code"), /client configuration/);
    assert.match((await googleCalendarStatus()).error!, /client configuration/);
    assert.equal((await googleCalendarStatus()).connections?.length, 1); rejectToken = false;
    account = 2;
    const secondLink = new URL(await beginGoogleCalendar());
    await finishGoogleCalendar(secondLink.searchParams.get("state")!, "second-code");
    let status = await googleCalendarStatus();
    const firstId = status.connections![0].id; const secondId = status.connections![1].id;
    await selectGoogleCalendar("secondary", false, "UTC", secondId);
    assert.equal((await store.listEvents()).length, 3);
    const other = (await store.listEvents()).find((e) => e.title === "Other remote")!;
    assert.equal(other.calendar?.source?.calendarId, "secondary");
    assert.notEqual(other.id, imported.id); // Identical provider event ids belong to different calendars.
    const native2 = await store.createEvent({ title: "First destination", start: "2026-10-27T10:00", end: "2026-10-27T11:00" });
    await syncGoogleCalendar(true);
    assert.equal((await store.getEvent(native2))?.calendar?.source?.calendarId, "primary");
    await defaultGoogleCalendar(secondId);
    const native3 = await store.createEvent({ title: "Second destination", start: "2026-10-27T12:00", end: "2026-10-27T13:00" });
    await store.updateEvent(other.id, { title: "Other edit" });
    await syncGoogleCalendar(true);
    assert.equal((await store.getEvent(native3))?.calendar?.source?.calendarId, "secondary");
    assert.equal((await store.getEvent(native2))?.calendar?.source?.calendarId, "primary");
    await selectGoogleCalendar("work", false, "UTC", firstId);
    await assert.rejects(selectGoogleCalendar("work", false, "UTC", firstId), /already connected/);
    status = await googleCalendarStatus(); assert.equal(status.connections?.length, 3);
    const posts = requests.filter((r) => r.url.hostname === "www.googleapis.com" && r.init.method === "POST");
    assert.deepEqual(posts.map((r) => [r.url.pathname.split("/")[4], JSON.parse(String(r.init.body)).summary]), [["primary", "First destination"], ["secondary", "Second destination"]]);
    await disconnectGoogleCalendar(secondId);
    assert.equal((await googleCalendarStatus()).connections?.length, 2);
    assert.equal((await googleCalendarStatus()).defaultId, firstId);
    assert.ok(await store.getEvent(other.id));
    // Reconnecting the same calendar reuses imported rows even with a new connection id.
    const thirdLink = new URL(await beginGoogleCalendar()); await finishGoogleCalendar(thirdLink.searchParams.get("state")!, "third-code");
    const thirdId = (await googleCalendarStatus()).connections!.at(-1)!.id;
    await selectGoogleCalendar("secondary", false, "UTC", thirdId);
    assert.equal((await store.listEvents()).filter((e) => e.calendar?.source?.calendarId === "secondary" && e.calendar.source.eventId === "remote").length, 1);
    const beforeDisconnect = (await store.listEvents()).length;
    await disconnectGoogleCalendar(); assert.equal(await store.getCalendarConnection(), null);
    assert.equal((await store.listEvents()).length, beforeDisconnect);
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
