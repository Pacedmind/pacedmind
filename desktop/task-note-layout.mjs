const MARGIN = 16;
const GAP = 12;
const MIN_WIDTH = 280;
const MIN_HEIGHT = 200;

export function noteCapacity(area) {
  return Math.max(0, Math.floor((area.width - 2 * MARGIN + GAP) / (MIN_WIDTH + GAP))) *
    Math.max(0, Math.floor((area.height - 2 * MARGIN + GAP) / (MIN_HEIGHT + GAP)));
}

/** A compact grid in the usable desktop, in Electron's DIP coordinates (also on scaled/negative-origin screens). */
export function noteLayout(area, count, size = "medium") {
  if (!Number.isSafeInteger(count) || count < 1 || count > noteCapacity(area)) return null;
  let best = null;
  for (let columns = 1; columns <= count; columns++) {
    const rows = Math.ceil(count / columns);
    const [preferredWidth, preferredHeight] = { small: [280, 200], medium: [360, 280], large: [440, 380] }[size] ?? [360, 280];
    const width = Math.min(preferredWidth, Math.floor((area.width - 2 * MARGIN - (columns - 1) * GAP) / columns));
    const height = Math.min(preferredHeight, Math.floor((area.height - 2 * MARGIN - (rows - 1) * GAP) / rows));
    if (width < MIN_WIDTH || height < MIN_HEIGHT) continue;
    const score = width * height;
    const unused = columns * rows - count;
    if (!best || score > best.score || (score === best.score && (unused < best.unused || (unused === best.unused && rows < best.rows)))) {
      best = { columns, rows, width, height, score, unused };
    }
  }
  if (!best) return null;
  const { columns, width, height } = best;
  const left = area.x + area.width - MARGIN - columns * width - (columns - 1) * GAP;
  return Array.from({ length: count }, (_, i) => ({
    x: left + (i % columns) * (width + GAP), y: area.y + MARGIN + Math.floor(i / columns) * (height + GAP), width, height,
  }));
}
