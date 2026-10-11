const MARGIN = 16;
const GAP = 12;
export const noteMinimum = size => size === "xs" ? { width: 220, height: 72 } : { width: 280, height: 200 };
export const noteCorner = (screen, area, corner, groupCount) => corner && corner !== "auto" ? corner : groupCount > 1 && area.x + area.width / 2 < screen.x + screen.width / 2 ? "top-left" : "top-right";

export function noteCapacity(area, size = "medium") {
  const { width: MIN_WIDTH, height: MIN_HEIGHT } = noteMinimum(size);
  return Math.max(0, Math.floor((area.width - 2 * MARGIN + GAP) / (MIN_WIDTH + GAP))) *
    Math.max(0, Math.floor((area.height - 2 * MARGIN + GAP) / (MIN_HEIGHT + GAP)));
}

/** A compact grid in the usable desktop, in Electron's DIP coordinates (also on scaled/negative-origin screens). */
export function noteLayout(area, count, size = "medium", flow = "grid", corner = "top-right", axis = "horizontal") {
  if (!Number.isSafeInteger(count) || count < 1 || count > noteCapacity(area, size)) return null;
  const { width: MIN_WIDTH, height: MIN_HEIGHT } = noteMinimum(size);
  let best = null;
  for (let columns = 1; columns <= count; columns++) {
    const rows = Math.ceil(count / columns);
    const [preferredWidth, preferredHeight] = { xs: [280, 88], small: [280, 200], medium: [360, 280], large: [440, 380] }[size] ?? [360, 280];
    const width = Math.min(preferredWidth, Math.floor((area.width - 2 * MARGIN - (columns - 1) * GAP) / columns));
    const height = Math.min(preferredHeight, Math.floor((area.height - 2 * MARGIN - (rows - 1) * GAP) / rows));
    if (width < MIN_WIDTH || height < MIN_HEIGHT) continue;
    const score = width * height - (flow === "columns" ? columns : flow === "rows" ? rows : 0) * 1_000_000;
    const unused = columns * rows - count;
    if (!best || score > best.score || (score === best.score && (unused < best.unused || (unused === best.unused && rows < best.rows)))) {
      best = { columns, rows, width, height, score, unused };
    }
  }
  if (!best) return null;
  const { columns, rows, width, height } = best;
  const right = corner.endsWith("right"), bottom = corner.startsWith("bottom");
  return Array.from({ length: count }, (_, i) => ({
    x: right ? area.x + area.width - MARGIN - width - (axis === "vertical" ? Math.floor(i / rows) : i % columns) * (width + GAP)
      : area.x + MARGIN + (axis === "vertical" ? Math.floor(i / rows) : i % columns) * (width + GAP),
    y: bottom ? area.y + area.height - MARGIN - height - (axis === "vertical" ? i % rows : Math.floor(i / columns)) * (height + GAP)
      : area.y + MARGIN + (axis === "vertical" ? i % rows : Math.floor(i / columns)) * (height + GAP), width, height,
  }));
}

/** The editor uses the native packer. When too small, minimum-sized boxes show where cards spill out. */
export function noteSpacePreview(area, count, size = "medium", flow = "grid", corner = "top-right", axis = "horizontal") {
  const capacity = noteCapacity(area, size);
  const fitted = noteLayout(area, count, size, flow, corner, axis);
  const minimum = noteMinimum(size);
  const columns = Math.max(1, Math.floor((area.width - 2 * MARGIN + GAP) / (minimum.width + GAP)));
  const rows = Math.max(1, Math.floor((area.height - 2 * MARGIN + GAP) / (minimum.height + GAP)));
  const bounds = fitted ?? Array.from({ length: count }, (_, i) => {
    const column = axis === "vertical" ? Math.floor(i / rows) : i % columns;
    const row = axis === "vertical" ? i % rows : Math.floor(i / columns);
    return {
      x: corner.endsWith("right") ? area.x + area.width - MARGIN - minimum.width - column * (minimum.width + GAP) : area.x + MARGIN + column * (minimum.width + GAP),
      y: corner.startsWith("bottom") ? area.y + area.height - MARGIN - minimum.height - row * (minimum.height + GAP) : area.y + MARGIN + row * (minimum.height + GAP), ...minimum,
    };
  });
  const cards = bounds.map(b => ({ ...b, overflow: b.x < area.x + MARGIN || b.y < area.y + MARGIN || b.x + b.width > area.x + area.width - MARGIN || b.y + b.height > area.y + area.height - MARGIN }));
  return { cards, capacity, fits: count === 0 || !!fitted, gap: GAP, clearance: count ? {
    left: Math.min(...bounds.map(b => b.x)) - area.x,
    top: Math.min(...bounds.map(b => b.y)) - area.y,
    right: area.x + area.width - Math.max(...bounds.map(b => b.x + b.width)),
    bottom: area.y + area.height - Math.max(...bounds.map(b => b.y + b.height)),
  } : null };
}
