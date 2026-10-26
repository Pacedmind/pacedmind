import { guardAction } from "@/server/guard";
import { syncGoogleCalendar } from "@/server/google-calendar";
import { MODE } from "@/server/supabase";

/** POST only: no state changes from cross-site navigation or prefetching. */
export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  const expected = MODE === "web" ? process.env.ORGANIZER_PUBLIC_ORIGIN : new URL(request.url).origin;
  if (!origin || !expected || origin !== new URL(expected).origin) return new Response(null, { status: 403 });
  await guardAction();
  await syncGoogleCalendar();
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}
