import { guardAction } from "@/server/guard";
import { syncGoogleCalendar } from "@/server/google-calendar";

/** POST only: no state changes from cross-site navigation or prefetching. */
export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(request.url).origin) return new Response(null, { status: 403 });
  await guardAction();
  await syncGoogleCalendar();
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}
