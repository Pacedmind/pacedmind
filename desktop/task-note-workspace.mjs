import { noteLayout, noteMinimum } from "./task-note-layout.mjs";

export const DEFAULT_LAYOUT = { size: "medium", group: "none", arrangement: "grid", order: "manual", emphasis: true, animation: "shuffle", regions: {} };
const choices = { size: ["xs", "small", "medium", "large"], group: ["none", "focus", "project", "area", "priority", "status", "deadline"], arrangement: ["grid", "columns", "rows"], order: ["manual", "relevance", "deadline"], animation: ["shuffle", "right", "diagonal", "together", "none"] };
export const refOf = (n) => `${n.id}:${n.createdAt}`;
export function layoutSettings(raw) {
  const result = { ...DEFAULT_LAYOUT, regions: {} };
  for (const [key, values] of Object.entries(choices)) if (values.includes(raw?.[key])) result[key] = raw[key];
  if (typeof raw?.emphasis === "boolean") result.emphasis = raw.emphasis;
  for (const [key, r] of Object.entries(raw?.regions ?? {}).slice(0, 100)) {
    if (key.length <= 180 && validRegion(r)) result.regions[key] = { x: r.x, y: r.y, width: r.width, height: r.height };
  }
  return result;
}
export function validRegion(r) {
  return r && [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.x >= 0 && r.y >= 0 &&
    r.width > 0 && r.height > 0 && r.x + r.width <= 1.001 && r.y + r.height <= 1.001;
}
const rank = { urgent: 4, high: 3, medium: 2, low: 1, none: 0 };
function day(now) { return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`; }
export function importance(meta, now = new Date()) {
  if (!meta || ["done", "canceled"].includes(meta.status)) return "quiet";
  const today = day(now);
  if (rank[meta.priority] >= 3 || (meta.dueDate && meta.dueDate.slice(0, 10) <= today) || meta.plannedDate === today) return "strong";
  return meta.priority === "low" || meta.status === "backlog" ? "quiet" : "normal";
}
export function noteGroups(notes, settings, now = new Date()) {
  const groups = new Map();
  for (const n of notes) {
    const m = n.meta ?? {}, mode = settings.group;
    let key = "all", name = "All notes";
    if (mode === "project") { key = `project:${m.projectId ?? "none"}`; name = m.projectName || "No project"; }
    if (mode === "area") { key = `area:${m.areaId ?? "none"}`; name = m.areaName || "Inbox"; }
    if (mode === "priority") { key = `priority:${m.priority ?? "none"}`; name = ({ urgent: "Urgent", high: "High priority", medium: "Medium priority", low: "Low priority", none: "No priority" })[m.priority ?? "none"]; }
    if (mode === "focus") {
      const focus = importance(m, now) === "strong";
      key = focus ? "focus" : ["in_progress", "in_review"].includes(m.status) ? "progress" : "later";
      name = { focus: "Focus", progress: "In progress", later: "Later" }[key];
    }
    if (mode === "status") { key = `status:${m.status ?? "todo"}`; name = ({ backlog: "Backlog", todo: "To do", in_progress: "In progress", in_review: "In review", done: "Done", canceled: "Canceled" })[m.status] ?? "To do"; }
    if (mode === "deadline") {
      const due = m.dueDate?.slice(0, 10), today = day(now), week = new Date(now); week.setDate(week.getDate() + 7);
      key = !due ? "no-date" : due < today ? "overdue" : due === today ? "today" : due <= day(week) ? "week" : "later";
      name = { "no-date": "No deadline", overdue: "Overdue", today: "Today", week: "Next 7 days", later: "Later" }[key];
    }
    if (!groups.has(key)) groups.set(key, { key, name, notes: [] });
    groups.get(key).notes.push(n);
  }
  for (const g of groups.values()) {
    if (settings.order === "deadline") g.notes.sort((a, b) => (a.meta?.dueDate ?? "9999").localeCompare(b.meta?.dueDate ?? "9999") || a.id - b.id);
    if (settings.order === "relevance") g.notes.sort((a, b) =>
      Number(importance(b.meta, now) === "strong") - Number(importance(a.meta, now) === "strong") ||
      (rank[b.meta?.priority] ?? 0) - (rank[a.meta?.priority] ?? 0) || (a.meta?.dueDate ?? "9999").localeCompare(b.meta?.dueDate ?? "9999") || a.id - b.id);
  }
  const sequence = settings.group === "focus" ? ["focus", "progress", "later"] : settings.group === "status" ? ["status:backlog", "status:todo", "status:in_progress", "status:in_review", "status:done", "status:canceled"] : settings.group === "deadline" ? ["overdue", "today", "week", "later", "no-date"] : null;
  return [...groups.values()].sort((a, b) => sequence ? sequence.indexOf(a.key) - sequence.indexOf(b.key) : settings.group === "priority" ? (rank[b.key.split(":")[1]] ?? 0) - (rank[a.key.split(":")[1]] ?? 0) : a.name.localeCompare(b.name));
}
export function pixelRegion(area, r) {
  return { x: area.x + Math.round(r.x * area.width), y: area.y + Math.round(r.y * area.height), width: Math.floor(r.width * area.width), height: Math.floor(r.height * area.height) };
}
export function normalRegion(area, r) {
  return { x: (r.x - area.x) / area.width, y: (r.y - area.y) / area.height, width: r.width / area.width, height: r.height / area.height };
}
const overlaps = (a, b) => a.x < b.x + b.width - .001 && b.x < a.x + a.width - .001 && a.y < b.y + b.height - .001 && b.y < a.y + a.height - .001;

/** Partition along whole rows/columns, choosing only splits that keep every group readable. */
function partition(groups, area, size, budget = { left: 500 }) {
  if (--budget.left < 0) return null;
  if (groups.length === 1) return noteLayout(area, groups[0].notes.length, size) ? [{ group: groups[0], area }] : null;
  const total = groups.reduce((s, g) => s + g.notes.length, 0);
  for (const axis of (area.width > area.height ? ["x", "y"] : ["y", "x"])) {
    const dimension = axis === "x" ? "width" : "height";
    for (let split = 1; split < groups.length; split++) {
      const left = groups.slice(0, split), right = groups.slice(split);
      const ratio = left.reduce((s, g) => s + g.notes.length, 0) / total;
      for (const fraction of [ratio, .5, ratio - .08, ratio + .08]) {
        const distance = Math.round(area[dimension] * fraction);
        const minimum = noteMinimum(size)[dimension] + 32;
        if (distance < minimum || area[dimension] - distance < minimum) continue;
        const a = { ...area, [dimension]: distance }, b = { ...area, [axis]: area[axis] + distance, [dimension]: area[dimension] - distance };
        const first = partition(left, a, size, budget);
        if (!first) continue;
        const last = partition(right, b, size, budget);
        if (last) return [...first, ...last];
      }
    }
  }
  return null;
}
export function workspaceLayout(area, notes, settings) {
  if (!notes.length) return { groups: [], placements: [] };
  const groups = noteGroups(notes, settings);
  // Bound the search for very fragmented project lists. A single grid keeps every note reachable.
  let regions;
  if (settings.arrangement === "columns" || settings.arrangement === "rows") {
    const axis = settings.arrangement === "columns" ? "x" : "y", dimension = axis === "x" ? "width" : "height";
    regions = groups.map((group, i) => {
      const start = Math.round(area[dimension] * i / groups.length), end = Math.round(area[dimension] * (i + 1) / groups.length);
      return { group, area: { ...area, [axis]: area[axis] + start, [dimension]: end - start } };
    });
    if (regions.some(r => !noteLayout(r.area, r.group.notes.length, settings.size, settings.arrangement))) regions = null;
  } else regions = groups.length <= 10 ? partition(groups, area, settings.size) : null;
  if (!regions) {
    const layout = noteLayout(area, notes.length, settings.size);
    if (!layout) return null;
    return { groups: [], placements: groups.flatMap(g => g.notes).map((n, i) => ({ note: n, bounds: layout[i] })), compact: true };
  }
  regions = regions.map(({ group, area: a }) => ({ group, area: settings.regions[group.key] ? pixelRegion(area, settings.regions[group.key]) : a }));
  if (regions.some((r, i) => regions.slice(i + 1).some(other => overlaps(r.area, other.area)))) return null;
  const placements = [];
  for (const r of regions) {
    const layout = noteLayout(r.area, r.group.notes.length, settings.size, settings.arrangement);
    if (!layout) return null;
    r.group.notes.forEach((note, i) => placements.push({ note, bounds: layout[i] }));
  }
  return { groups: regions.map(r => ({ key: r.group.key, name: r.group.name, count: r.group.notes.length, ...normalRegion(area, r.area) })), placements };
}

/** Whole wave stays under 180 ms even on a monitor with dozens of notes. */
export function animationDelays(notes, mode, random = Math.random) {
  const list = [...notes];
  if (mode === "shuffle") for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
  const bounds = n => n.window.getBounds();
  if (mode === "right") list.sort((a, b) => bounds(b).x - bounds(a).x || bounds(a).y - bounds(b).y);
  if (mode === "diagonal") list.sort((a, b) => bounds(a).x + bounds(a).y - bounds(b).x - bounds(b).y);
  return new Map(list.map((n, i) => [n, ["none", "together"].includes(mode) ? 0 : Math.round(i * Math.min(32, 180 / Math.max(1, list.length - 1)))]));
}
