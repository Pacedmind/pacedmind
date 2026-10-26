import { NextResponse } from "next/server";
import { finishGoogleCalendar } from "@/server/google-calendar";
import { MODE } from "@/server/supabase";
import { getTranslation } from "@/server/i18n";

export async function GET(request: Request) {
  const tx = await getTranslation();
  const url = new URL(request.url);
  try {
    await finishGoogleCalendar(url.searchParams.get("state") ?? "", url.searchParams.get("code"));
    if (MODE === "web") return NextResponse.redirect(new URL("/settings/calendar", process.env.ORGANIZER_PUBLIC_ORIGIN));
    return new Response(tx("Google Calendar connected. Return to PacedMind and choose a calendar in Settings."), { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  } catch {
    return new Response(tx("Google Calendar could not connect. Return to PacedMind and try again in Settings."), { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  }
}
