import assert from "node:assert/strict";
import { test } from "node:test";
import { chooseNoteDisplay, noteDisplaysOf, type NoteDisplays } from "../src/lib/task-notes";
import { floatingTaskData } from "../src/lib/floating-task";
import type { Area, Project, Task } from "../src/lib/types";

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
