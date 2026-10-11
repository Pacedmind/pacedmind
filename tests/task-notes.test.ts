import assert from "node:assert/strict";
import { test } from "node:test";
import { chooseNoteDisplay, noteDisplaysOf, type NoteDisplays } from "../src/lib/task-notes";
import { floatingTaskData } from "../src/lib/floating-task";
import type { Area, Project, Task } from "../src/lib/types";
import type { NoteDisplay, NoteLayoutSettings } from "../src/lib/task-note-workspace";
import { spacePreviews, spaceRegions } from "../src/lib/task-note-preview";
import { layoutSettings, noteGroups, normalRegion, refOf, workspaceLayout } from "../desktop/task-note-workspace.mjs";

const snapshot = (count: number, saved: string | null = null): NoteDisplays => ({
  displays: Array.from({ length: count }, (_, i) => ({
    id: String(i + 1), label: `Display ${i + 1}`, width: 1920, height: 1040, x: i * 1920, y: 0,
    primary: i === 0, capacity: 24, openCount: 0,
  })), defaultDisplay: saved, updatedAt: new Date().toISOString(),
});

test("three displays require both a user's choice and an answer about remembering it", () => {
  assert.throws(() => chooseNoteDisplay(snapshot(3)), /Ask the user which display/);
  assert.throws(() => chooseNoteDisplay(snapshot(3), "2"), /whether to remember/);
  assert.equal(chooseNoteDisplay(snapshot(3), "2", false), "2");
  assert.equal(chooseNoteDisplay(snapshot(3), "2", true), "2");
  assert.throws(() => chooseNoteDisplay(snapshot(3), undefined, true), /Name the display/);
});

test("single displays and remembered choices need no repeated question", () => {
  assert.equal(chooseNoteDisplay(snapshot(1)), "1");
  assert.equal(chooseNoteDisplay(snapshot(3, "2")), "2");
  assert.equal(chooseNoteDisplay(snapshot(3, "2"), "3", false), "3");
});

test("disconnecting a saved or explicitly chosen screen never silently selects another", () => {
  assert.throws(() => chooseNoteDisplay(snapshot(2, "3")), /disconnected/);
  assert.throws(() => chooseNoteDisplay(snapshot(1, "3")), /disconnected/);
  assert.throws(() => chooseNoteDisplay(snapshot(2), "3", false), /no longer connected/);
});

test("untrusted display reports are validated before agents or the desktop bridge use them", () => {
  assert.ok(noteDisplaysOf(snapshot(3)));
  assert.equal(noteDisplaysOf({ displays: [], defaultDisplay: null, updatedAt: "yesterday" }), null);
  assert.equal(noteDisplaysOf({ ...snapshot(1), displays: [{ ...snapshot(1).displays[0], id: "../../bad" }] }), null);
  assert.equal(noteDisplaysOf({ ...snapshot(1), displays: [{ ...snapshot(1).displays[0], width: -1 }] }), null);
});

test("project task notes inherit their project's area for workspace grouping", () => {
  const task = { id: 1, key: "WRK-1", projectId: "project", areaId: null, title: "Review", priority: 2, subtasks: [] } as unknown as Task;
  const project = { id: "project", areaId: "work", name: "Release", color: null } as Project;
  const areas = [{ id: "work", name: "Work", color: "#123456" }] as Area[];
  const data = floatingTaskData("local", task, areas, project, null, [], null);
  assert.equal(data.areaId, "work");
  assert.equal(data.areaName, "Work");
  assert.equal(data.projectName, "Release");
  assert.equal(data.color, "#123456");
  const loose = floatingTaskData("local", { ...task, projectId: null, areaId: "work" }, areas, null, null, [], null);
  assert.equal(loose.areaId, "work");
  assert.equal(loose.projectId, null);
});

function previewDisplay(): NoteDisplay {
  const area = { x: -2560, y: -200, width: 2560, height: 1392 };
  const settings = layoutSettings({ size: "small", group: "priority", arrangement: "columns", order: "deadline", fills: { "priority:high": { corner: "bottom-left", axis: "vertical" } } }) as NoteLayoutSettings;
  const notes = Array.from({ length: 12 }, (_, id) => ({ id, createdAt: "2026-10-11T10:00:00", meta: { title: `Card ${id}`, priority: id < 6 ? "high" : "low", dueDate: `2026-10-${String(30 - id).padStart(2, "0")}` } }));
  const plan = workspaceLayout(area, notes, settings)!;
  return { ...area, id: "1", label: "Left", primary: true, openCount: 12, settings, compact: false, groups: plan.groups, presets: [],
    notes: noteGroups(notes, settings).flatMap(g => g.notes.map((n: (typeof notes)[number]) => ({ ref: refOf(n), groupKey: g.key, title: n.meta.title, ...normalRegion(area, plan.placements.find(p => p.note === n)!.bounds) }))) };
}

test("space preview boxes match the native placement, order, size and corner on a negative-origin display", () => {
  const display = previewDisplay();
  const previews = spacePreviews(display);
  assert.equal(previews.flatMap(g => g.preview.cards).length, display.openCount);
  for (const group of previews) {
    assert.equal(group.preview.fits, true);
    assert.ok(group.preview.clearance!.left >= 16 && group.preview.clearance!.top >= 16);
    for (const [i, box] of group.preview.cards.entries()) {
      const native = group.notes[i];
      assert.equal(box.overflow, false);
      assert.ok(Math.abs(box.x - native.x * display.width) < .001);
      assert.ok(Math.abs(box.y - native.y * display.height) < .001);
      assert.ok(Math.abs(box.width - native.width * display.width) < .001);
      assert.ok(Math.abs(box.height - native.height * display.height) < .001);
    }
  }
  assert.equal(previews[0].notes[0].title, "Card 5");
});

test("live divider previews resize neighbours and show overflow before an invalid edit is committed", () => {
  const display = previewDisplay(), first = display.groups[0], second = display.groups[1];
  const regions = spaceRegions(display, first.key, { ...first, width: .2 });
  assert.equal(regions[second.key].x, .2);
  assert.equal(regions[second.key].width, .8);
  const previews = spacePreviews(display, regions);
  assert.equal(previews[0].preview.capacity, 6);
  assert.equal(previews[0].preview.fits, true);
  const tiny = spaceRegions(display, first.key, { ...first, width: .05 });
  const overflow = spacePreviews(display, tiny)[0];
  assert.equal(overflow.preview.fits, false);
  assert.equal(overflow.preview.capacity, 0);
  assert.equal(overflow.preview.cards.length, first.count);
  assert.ok(overflow.preview.cards.every(c => c.overflow));
  assert.ok(overflow.preview.clearance!.right < 0);
  assert.equal(display.groups[0].width, .5);
});
