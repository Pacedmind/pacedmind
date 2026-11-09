import { AREA_PICTURE_MAX, AREA_PICTURE_PX } from "./area-picture";
import type { Translator } from "./i18n";

export const PICTURE_FILE_TYPES = "image/png,image/jpeg,image/webp,image/gif,image/svg+xml";

/** Fits a chosen image into a small PNG on the client. Only the PNG leaves the browser. */
export async function pictureFromFile(file: File, tx: Translator): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error(tx("Pick a picture: PNG, JPEG, WebP, GIF or SVG."));
  if (file.size > 20_000_000) throw new Error(tx("That file is over 20 MB. Pick a smaller picture."));
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode().catch(() => { throw new Error(tx("That picture couldn't be read.")); });
    // An SVG without a size of its own reports none: draw it at the largest size.
    const [w, h] = img.naturalWidth && img.naturalHeight ? [img.naturalWidth, img.naturalHeight] : [AREA_PICTURE_PX, AREA_PICTURE_PX];
    // Keep small images sharp and reduce the size if a detailed image is too large.
    const largest = Math.min(AREA_PICTURE_PX, Math.max(w, h));
    for (const side of [largest, 48, 32].filter((s) => s <= largest)) {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = side;
      const g = canvas.getContext("2d");
      if (!g) break;
      g.imageSmoothingQuality = "high";
      const scale = Math.min(side / w, side / h);
      g.drawImage(img, (side - w * scale) / 2, (side - h * scale) / 2, w * scale, h * scale);
      const png = canvas.toDataURL("image/png").slice("data:image/png;base64,".length);
      if (png.length <= AREA_PICTURE_MAX) return png;
    }
    throw new Error(tx("That picture has too much detail to keep small. Try a simpler logo."));
  } finally {
    URL.revokeObjectURL(url);
  }
}
