import "server-only";
import { cookies } from "next/headers";
import { EMBED_COOKIE, isEmbedCookie } from "@/lib/embed";

/** Whether this request's page is in embed mode (src/lib/embed.ts). */
export async function embedMode(): Promise<boolean> {
  return isEmbedCookie((await cookies()).get(EMBED_COOKIE)?.value);
}
