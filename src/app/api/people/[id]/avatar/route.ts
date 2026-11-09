import { googleAvatarImage, profileAvatarVersion } from "@/server/profile-avatar";
import * as repo from "@/server/repo";

const notFound = () => new Response("Not found", { status: 404, headers: { "Cache-Control": "private, no-store" } });

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const avatar = await repo.profileAvatar(id).catch(() => null);
  if (!avatar) return notFound();
  const version = profileAvatarVersion(avatar);
  if (!version) return notFound();

  // Recheck membership even when the browser already has the image.
  const etag = `"${version}"`;
  const headers = { "Cache-Control": "private, no-cache", ETag: etag, "X-Content-Type-Options": "nosniff" };
  if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });

  const image = avatar.source === "custom" && avatar.picture
    ? { data: new Uint8Array(Buffer.from(avatar.picture, "base64")), type: "image/png" }
    : await googleAvatarImage(avatar.googleUrl);
  if (!image) return notFound();
  return new Response(image.data, {
    headers: { ...headers, "Content-Type": image.type, "Content-Length": String(image.data.byteLength) },
  });
}
