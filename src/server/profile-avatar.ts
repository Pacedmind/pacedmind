import "server-only";
import { createHash } from "node:crypto";
import type { ProfileAvatar } from "@/lib/types";

const GOOGLE_AVATAR_HOST = /^lh[0-9]+\.googleusercontent\.com$/;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const MAX_GOOGLE_AVATAR_BYTES = 256 * 1024;

function googleAvatarUrl(value: string | null): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && GOOGLE_AVATAR_HOST.test(url.hostname) && !url.username && !url.password && !url.port
      ? url
      : null;
  } catch {
    return null;
  }
}

export function profileAvatarVersion(avatar: ProfileAvatar): string | null {
  const content = avatar.source === "custom" ? avatar.picture : avatar.source === "google" ? googleAvatarUrl(avatar.googleUrl)?.href : null;
  return content ? createHash("sha256").update(content).digest("hex").slice(0, 16) : null;
}

/** Send Google pictures through PacedMind so a teammate's browser never requests another account's Google URL. */
export async function googleAvatarImage(value: string | null) {
  const url = googleAvatarUrl(value);
  if (!url) return null;
  try {
    const upstream = await fetch(url, { redirect: "error", cache: "no-store", signal: AbortSignal.timeout(4000) });
    const type = upstream.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
    if (!upstream.ok || !IMAGE_TYPES.has(type) || !upstream.body || Number(upstream.headers.get("content-length")) > MAX_GOOGLE_AVATAR_BYTES) {
      await upstream.body?.cancel();
      return null;
    }

    const reader = upstream.body.getReader();
    const data = new Uint8Array(MAX_GOOGLE_AVATAR_BYTES);
    let length = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (length + chunk.value.length > data.length) {
        await reader.cancel();
        return null;
      }
      data.set(chunk.value, length);
      length += chunk.value.length;
    }
    return length > 0 ? { data: data.subarray(0, length), type } : null;
  } catch {
    return null;
  }
}
