import type { NoteDisplay, NoteRegion } from "./task-note-workspace";
import { noteCorner, noteSpacePreview } from "../../desktop/task-note-layout.mjs";

export function spaceRegions(display: NoteDisplay, id: string, bounds: NoteRegion) {
  const previous = display.groups.find(g => g.key === id);
  const regions = { ...display.settings.regions, ...Object.fromEntries(display.groups.map(g => [g.key, { x: g.x, y: g.y, width: g.width, height: g.height }])), [id]: bounds };
  if (previous && (previous.width !== bounds.width || previous.height !== bounds.height)) for (const other of display.groups) {
    if (other.key === id) continue;
    const next = { ...regions[other.key] }, close = (a: number, b: number) => Math.abs(a - b) < .001;
    if (close(other.y, previous.y) && close(other.height, previous.height)) {
      if (close(other.x, previous.x + previous.width)) { const right = next.x + next.width; next.x = bounds.x + bounds.width; next.width = right - next.x; }
      if (close(other.x + other.width, previous.x)) next.width = bounds.x - next.x;
    }
    if (close(other.x, previous.x) && close(other.width, previous.width)) {
      if (close(other.y, previous.y + previous.height)) { const bottom = next.y + next.height; next.y = bounds.y + bounds.height; next.height = bottom - next.y; }
      if (close(other.y + other.height, previous.y)) next.height = bounds.y - next.y;
    }
    regions[other.key] = next;
  }
  return regions;
}

export function spacePreviews(display: NoteDisplay, regions: Record<string, NoteRegion> = {}) {
  const screen = { x: 0, y: 0, width: display.width, height: display.height };
  const groups = display.groups.map(g => ({ ...g, region: regions[g.key] ?? g }));
  return groups.map(g => {
    const r = g.region, fill = display.settings.fills[g.key];
    const area = { x: Math.round(r.x * display.width), y: Math.round(r.y * display.height), width: Math.floor(r.width * display.width), height: Math.floor(r.height * display.height) };
    const corner = noteCorner(screen, area, fill?.corner, groups.length);
    const preview = noteSpacePreview(area, g.count, display.settings.size, display.settings.arrangement, corner, fill?.axis ?? (display.settings.arrangement === "columns" ? "vertical" : "horizontal"));
    const overlap = groups.some(other => other.key !== g.key && r.x < other.region.x + other.region.width - .001 && other.region.x < r.x + r.width - .001 && r.y < other.region.y + other.region.height - .001 && other.region.y < r.y + r.height - .001);
    return { ...g, preview, overlap, notes: display.notes.filter(n => n.groupKey === g.key) };
  });
}
