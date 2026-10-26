"use server";
import { refresh } from "next/cache";
import { guardAction } from "@/server/guard";
import { beginGoogleCalendar, disconnectGoogleCalendar, googleCalendarStatus, resolveGoogleConflict, selectGoogleCalendar, syncGoogleCalendar } from "@/server/google-calendar";

async function result<T>(work: () => Promise<T>) {
  try { return { ok: true as const, ...await work() }; }
  catch (error) { return { ok: false as const, error: error instanceof Error ? error.message : "Calendar sync could not finish. Try again, or reconnect Google Calendar." }; }
}
export async function connectGoogleCalendarAction() { await guardAction(); return result(async () => ({ url: await beginGoogleCalendar() })); }
export async function googleCalendarStatusAction() { await guardAction(); return googleCalendarStatus(); }
export async function chooseGoogleCalendarAction(id: string, existing: boolean, timeZone: string) { await guardAction(); return result(async () => { await selectGoogleCalendar(id, existing === true, timeZone); refresh(); return {}; }); }
export async function disconnectGoogleCalendarAction() { await guardAction(); return result(async () => { await disconnectGoogleCalendar(); refresh(); return {}; }); }
export async function syncGoogleCalendarAction() { await guardAction(); return result(async () => { await syncGoogleCalendar(true); refresh(); return {}; }); }
export async function resolveGoogleCalendarAction(id: string, choice: "local" | "google") { await guardAction(); return result(async () => { await resolveGoogleConflict(id, choice); refresh(); return {}; }); }
