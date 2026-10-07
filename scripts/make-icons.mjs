// Exports PacedMind's connected pd emblem, as solid as the wordmark's first p.
//   desktop/icon.ico, desktop/icon.png  – app, window, tray and shortcut icon on Windows
//   desktop/icon.icns                   – app icon on macOS, on Apple's icon grid
//   desktop/trayTemplate.png (+ @2x)    – macOS menu bar icon: black on clear, so macOS can tint it
//   src/app/favicon.ico                 – browser tab
//   mobile/assets/                      – opaque iOS and padded Android adaptive icons
//   plugins/pacedmind/assets/           – the plugin's listing icons, light and dark
// Run with: npm run icons
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const root = path.resolve(import.meta.dirname, "..");
const geometry = JSON.parse(fs.readFileSync(path.join(root, "src/lib/brand-geometry.json"), "utf8"));

const BACKGROUND = [0, 0, 0];
const INK = [255, 255, 255];

// The first p and last d share their bowl. This emblem stays solid at every size.
const STROKE = geometry.strokeWidth * 4;
const OUTER = { x: 128, y: 128, r: 48 + STROKE / 2 };
const INNER = { x: 128, y: 128, r: 48 - STROKE / 2 };
const STEMS = [
  { x: 80, top: 128, bottom: 256 },
  { x: 176, top: 0, bottom: 128 },
];
// Without a tile to run into, the menu bar glyph's stems end in round caps inside the icon.
const GLYPH_STEMS = STEMS.map(({ x, top, bottom }) => ({ x, top: Math.max(top, STROKE), bottom: Math.min(bottom, 256 - STROKE) }));
// Apple's icon grid keeps the tile to the middle 824 of 1024 pixels. The Windows tile fills 94% of
// its icon, so the macOS icon draws the same tile shrunk by this share of the size on each side.
const MAC_INSET = 0.072;

function insideEmblem(x, y, size, stems = STEMS) {
  x *= 256;
  y *= 256;
  // An optical weight adjustment keeps the entire mark solid at tray sizes.
  const adjust = size <= 32 ? 1.5 : 0;
  const outer = Math.hypot(x - OUTER.x, y - OUTER.y) <= OUTER.r + adjust;
  const stem = stems.some(({ x: cx, top, bottom }) =>
    Math.hypot(x - cx, y - Math.min(Math.max(y, top), bottom)) <= STROKE / 2 + adjust);
  const inner = Math.hypot(x - INNER.x, y - INNER.y) < INNER.r - adjust;
  return (outer || stem) && !inner;
}

function insideRoundedRect(x, y, lo, hi, r) {
  if (x < lo || x > hi || y < lo || y > hi) return false;
  const cx = Math.min(Math.max(x, lo + r), hi - r);
  const cy = Math.min(Math.max(y, lo + r), hi - r);
  return Math.hypot(x - cx, y - cy) <= r;
}

/**
 * RGBA pixels, drawn with 8×8 supersampling so small sizes stay smooth. `inset` shrinks the tile
 * toward the middle by that share of the size on each side; `background` and `ink` swap for a dark theme.
 */
function render(size, inset = 0, background = BACKGROUND, ink = INK) {
  const ss = 8;
  const out = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let inRect = 0;
      let inMark = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = ((px + (sx + 0.5) / ss) / size - inset) / (1 - 2 * inset);
          const y = ((py + (sy + 0.5) / ss) / size - inset) / (1 - 2 * inset);
          if (!insideRoundedRect(x, y, 0.03, 0.97, 0.22)) continue;
          inRect++;
          if (insideEmblem(x, y, size)) inMark++;
        }
      }
      if (!inRect) continue;
      const f = inMark / inRect;
      const o = (py * size + px) * 4;
      for (let i = 0; i < 3; i++) {
        out[o + i] = Math.round(background[i] * (1 - f) + ink[i] * f);
      }
      out[o + 3] = Math.round((255 * inRect) / (ss * ss));
    }
  }
  return out;
}

/** The pd glyph alone, black with its coverage as alpha: a macOS template image for the menu bar. */
function glyph(size) {
  const ss = 8;
  const out = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let inMark = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          if (insideEmblem((px + (sx + 0.5) / ss) / size, (py + (sy + 0.5) / ss) / size, size, GLYPH_STEMS)) inMark++;
        }
      }
      out[(py * size + px) * 4 + 3] = Math.round((255 * inMark) / (ss * ss));
    }
  }
  return out;
}

/** A macOS .icns: PNG images at every size Finder and the Dock ask for, with iconutil's type codes. */
function icns() {
  const types = [["icp4", 16], ["icp5", 32], ["ic11", 32], ["ic12", 64], ["ic07", 128], ["ic13", 256], ["ic08", 256], ["ic14", 512], ["ic09", 512], ["ic10", 1024]];
  const pngs = new Map();
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, "ascii");
    head.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([head, data]);
  };
  const body = Buffer.concat(types.map(([type, size]) => {
    if (!pngs.has(size)) pngs.set(size, png(size, render(size, MAC_INSET)));
    return chunk(type, pngs.get(size));
  }));
  return chunk("icns", body);
}

function png(size, rgba) {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A 32-bit BMP icon image (bottom-up BGRA plus an AND mask), the most compatible form for small sizes. */
function bmp(size, rgba) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(size * size * 4, 20);
  const pixels = Buffer.alloc(size * size * 4);
  const maskStride = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskStride * size);
  for (let y = 0; y < size; y++) {
    const srcRow = size - 1 - y;
    for (let x = 0; x < size; x++) {
      const s = (srcRow * size + x) * 4;
      const d = (y * size + x) * 4;
      pixels[d] = rgba[s + 2];
      pixels[d + 1] = rgba[s + 1];
      pixels[d + 2] = rgba[s];
      pixels[d + 3] = rgba[s + 3];
      if (rgba[s + 3] === 0) mask[y * maskStride + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return Buffer.concat([header, pixels, mask]);
}

function ico(sizes) {
  const images = sizes.map((size) => {
    const rgba = render(size);
    return { size, data: size >= 128 ? png(size, rgba) : bmp(size, rgba) };
  });
  const head = Buffer.alloc(6);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(images.length, 4);
  const dir = Buffer.alloc(16 * images.length);
  let offset = head.length + dir.length;
  images.forEach(({ size, data }, i) => {
    const o = i * 16;
    dir[o] = size >= 256 ? 0 : size;
    dir[o + 1] = size >= 256 ? 0 : size;
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(data.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += data.length;
  });
  return Buffer.concat([head, dir, ...images.map((im) => im.data)]);
}

// A file that already holds the same thing is left alone (a text file in either line ending), so a build doesn't
// leave the checkout looking changed: the builds that publish refuse uncommitted changes (landed.mjs).
const write = (rel, data) => {
  const file = path.join(root, rel);
  const old = fs.existsSync(file) ? fs.readFileSync(file) : null;
  if (old && (typeof data === "string" ? old.toString("utf8").replace(/\r\n/g, "\n") === data : old.equals(data))) {
    console.log(`kept ${rel}`);
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  console.log(`wrote ${rel} (${data.length} bytes)`);
};

write("desktop/icon.ico", ico([16, 20, 24, 32, 40, 48, 64, 128, 256]));
write("desktop/icon.png", png(256, render(256)));
write("desktop/icon.icns", icns());
write("desktop/trayTemplate.png", png(16, glyph(16)));
write("desktop/trayTemplate@2x.png", png(32, glyph(32)));
write("src/app/favicon.ico", ico([16, 32, 48]));
write("public/brand/pacedmind-emblem.png", png(512, render(512)));
// The plugin's listing icons (plugins/pacedmind): the black tile, and a white one for dark themes, where the
// directories ask for contrast against their dark background.
write("plugins/pacedmind/assets/logo.png", png(512, render(512)));
write("plugins/pacedmind/assets/logo-dark.png", png(512, render(512, 0, INK, BACKGROUND)));

// iOS supplies its own mask and requires an opaque icon. Composite on the brand's black background.
const mobileIcon = render(1024, 0.06);
for (let pixel = 0; pixel < mobileIcon.length; pixel += 4) {
  const alpha = mobileIcon[pixel + 3] / 255;
  for (let channel = 0; channel < 3; channel++) mobileIcon[pixel + channel] = Math.round(mobileIcon[pixel + channel] * alpha);
  mobileIcon[pixel + 3] = 255;
}
write("mobile/assets/icon.png", png(1024, mobileIcon));
// Keep the visible mark within Android's adaptive-icon safe zone, whichever mask the launcher uses.
write("mobile/assets/adaptive-icon.png", png(1024, render(1024, 0.2)));

// An editable vector export, using the same circles and stems as render().
const emblem = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
  <title>PacedMind</title>
  <defs><clipPath id="tile"><rect x="7.68" y="7.68" width="240.64" height="240.64" rx="56.32"/></clipPath>
  <mask id="pd"><rect width="256" height="256" fill="black"/>
    <circle cx="${OUTER.x}" cy="${OUTER.y}" r="${OUTER.r}" fill="white"/>
${STEMS.map(({ x, top, bottom }) => `    <path d="M${x} ${top}V${bottom}" stroke="white" stroke-width="${STROKE}" stroke-linecap="round"/>`).join("\n")}
    <circle cx="${INNER.x}" cy="${INNER.y}" r="${INNER.r}" fill="black"/>
  </mask></defs>
  <rect x="7.68" y="7.68" width="240.64" height="240.64" rx="56.32" fill="#000000"/>
  <rect width="256" height="256" fill="#ffffff" mask="url(#pd)" clip-path="url(#tile)"/>
</svg>\n`;
write("public/brand/pacedmind-emblem.svg", emblem);
