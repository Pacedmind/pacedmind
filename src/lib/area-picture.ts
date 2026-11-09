// Area icons and custom profile pictures use the same small PNG format. The browser draws the image you
// pick into a PNG (picture-file.ts), and the database keeps it in base64 without markup or scripts.

/** A picture's side, in pixels at most: the mark it replaces is 16 at most, so this stays sharp at 4x. */
export const AREA_PICTURE_PX = 64;

/** The most base64 a picture may take: about 24 KB of PNG. */
export const AREA_PICTURE_MAX = 32768;

/** Why `b64` can't be an area's picture, or null when it can: base64 of a PNG no bigger than AREA_PICTURE_PX. */
export function areaPictureProblem(b64: string): string | null {
  if (b64.length > AREA_PICTURE_MAX) return "That picture is too big.";
  if (b64.length % 4 || !/^iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(b64)) return "That isn't a PNG picture.";
  // The first 24 bytes: PNG's signature, then the IHDR chunk with the width and the height.
  const head = atob(b64.slice(0, 32));
  const u32 = (i: number) => ((head.charCodeAt(i) << 24) | (head.charCodeAt(i + 1) << 16) | (head.charCodeAt(i + 2) << 8) | head.charCodeAt(i + 3)) >>> 0;
  if (head.slice(12, 16) !== "IHDR") return "That isn't a PNG picture.";
  const [w, h] = [u32(16), u32(20)];
  if (!w || !h || w > AREA_PICTURE_PX || h > AREA_PICTURE_PX) return `A picture is ${AREA_PICTURE_PX} pixels wide and high at most.`;
  return null;
}
