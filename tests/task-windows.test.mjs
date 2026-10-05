import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { createTaskWindows } from "../desktop/task-windows.mjs";
import { registerTaskNoteControls } from "../desktop/task-note-controls.mjs";
import { noteCapacity, noteLayout } from "../desktop/task-note-layout.mjs";
import { animationDelays, importance, layoutSettings, noteGroups, workspaceLayout } from "../desktop/task-note-workspace.mjs";
import { createNoteMotion } from "../desktop/task-note-motion.mjs";
import { createTaskNoteOpener } from "../desktop/task-note-opener.mjs";

const origin = "http://127.0.0.1:4319";
const createdAt = "2026-10-04T10:00:00";
const account = "11111111-1111-4111-8111-111111111111";

function fixture(platform = "win32") {
  const windows = [];
  const opened = [];
  const preferred = new Map();
  const layouts = new Map();
  const changes = [];
  const displays = [{ id: 1, label: "Left", workArea: { x: -1280, y: 0, width: 1280, height: 720 } }];
  class Window extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.webContents = new EventEmitter();
      this.webContents.mainFrame = { url: "" };
      this.webContents.isDestroyed = () => this.isDestroyed();
      this.webContents.setWindowOpenHandler = (fn) => { this.openHandler = fn; };
      this.webContents.reload = () => { this.reloaded = true; };
      this.messages = [];
      this.webContents.send = (...args) => this.messages.push(args);
      windows.push(this);
    }
    setMenuBarVisibility() {}
    getBounds() { const { x, y, width, height } = this.options; return { x, y, width, height }; }
    setBounds(bounds) { Object.assign(this.options, bounds); }
    setVisibleOnAllWorkspaces(...args) { this.workspaces = args; }
    loadURL(url) { this.webContents.mainFrame.url = url; return Promise.resolve(); }
    isDestroyed() { return !!this.closed; }
    isMinimized() { return !!this.minimized; }
    isVisible() { return !!this.shown; }
    setOpacity(value) { this.opacity = value; }
    getOpacity() { return this.opacity ?? 1; }
    restore() { this.minimized = false; }
    setAlwaysOnTop(value) { this.options.alwaysOnTop = value; }
    moveTop() { this.occluded = false; }
    show() { this.shown = true; }
    showInactive() { this.shown = true; }
    hide() { this.shown = false; }
    focus() { this.focused = true; }
    close() { this.closed = true; this.emit("closed"); }
    setBackgroundColor(color) { this.background = color; }
  }
  const notes = createTaskWindows({
    animate: false,
    readLayout: (scope, id) => layouts.get(`${scope}:${id}`),
    writeLayout: (scope, id, value) => layouts.set(`${scope}:${id}`, value),
    BrowserWindow: Window, origin, preload: "/app/preload.cjs", icon: "icon.ico", platform,
    screen: {
      getCursorScreenPoint: () => ({ x: -500, y: 100 }), getDisplayNearestPoint: () => displays[0],
      getAllDisplays: () => displays, getPrimaryDisplay: () => displays[0],
      getDisplayMatching: (r) => displays.find((d) => r.x >= d.workArea.x && r.x < d.workArea.x + d.workArea.width) ?? displays[0],
    },
    preferredDisplay: (scope) => preferred.get(scope) ?? null,
    rememberDisplay: (scope, display) => preferred.set(scope, display),
    theme: () => ({ name: "dark", background: "#010101" }), showMain: (url) => opened.push(url),
    onChange: (state) => changes.push(state),
  });
  const event = (window) => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
  return { notes, windows, opened, event, displays, preferred, changes, Window, layouts };
}

test("each task gets an independent topmost window; repeated clicks restore the existing note", () => {
  const { notes, windows } = fixture();
  assert.equal(notes.open(1, "local", createdAt), true);
  assert.equal(notes.open(2, "local", createdAt), true);
  const [first, second] = windows;
  for (const window of windows) {
    assert.equal(window.options.alwaysOnTop, true);
    assert.equal(window.options.parent, undefined);
    assert.equal(window.options.webPreferences.backgroundThrottling, false);
    assert.equal(window.options.webPreferences.nodeIntegration, false);
    assert.equal(window.options.webPreferences.sandbox, true);
    assert.equal(window.options.webPreferences.contextIsolation, true);
    assert.ok(window.options.x >= -1280 && window.options.x + window.options.width <= 0);
    assert.ok(window.options.y >= 0 && window.options.y + window.options.height <= 720);
  }
  assert.notEqual(first.options.x, second.options.x);
  first.minimized = true;
  first.emit("ready-to-show");
  notes.open(1, "local", createdAt);
  assert.equal(windows.length, 2);
  assert.equal(first.minimized, false);
  assert.equal(first.focused, true);
  first.close();
  assert.equal(second.closed, undefined);
  notes.open(1, "local", createdAt);
  assert.equal(windows.length, 3);
});

test("grids never overlap or leave usable screen bounds, including portrait and scaled negative-origin screens", () => {
  for (const area of [
    { x: -1920, y: -100, width: 1920, height: 1040 }, { x: 0, y: 40, width: 1280, height: 680 },
    { x: 2560, y: -300, width: 720, height: 1240 }, { x: 0, y: 0, width: 400, height: 300 },
  ]) {
    for (let count = 1; count <= noteCapacity(area); count++) {
      const layout = noteLayout(area, count);
      assert.equal(layout.length, count);
      for (const [i, r] of layout.entries()) {
        assert.ok(r.width >= 280 && r.height >= 200);
        assert.ok(r.x >= area.x && r.x + r.width <= area.x + area.width);
        assert.ok(r.y >= area.y && r.y + r.height <= area.y + area.height);
        for (const other of layout.slice(i + 1)) assert.ok(r.x + r.width <= other.x || other.x + other.width <= r.x || r.y + r.height <= other.y || other.y + other.height <= r.y);
      }
    }
    assert.equal(noteLayout(area, noteCapacity(area) + 1), null);
  }
});

test("new and reused notes return above other windows without taking focus", () => {
  const { notes, windows } = fixture();
  notes.show(1, "local", createdAt, "1");
  const note = windows[0];
  note.options.alwaysOnTop = false;
  note.occluded = true;
  note.emit("ready-to-show");
  assert.equal(note.options.alwaysOnTop, true);
  assert.equal(note.shown, true);
  assert.equal(note.occluded, false);
  assert.equal(note.focused, undefined);
  for (const minimized of [false, true]) {
    note.options.alwaysOnTop = false;
    note.occluded = true;
    note.shown = false;
    note.minimized = minimized;
    notes.show(1, "local", createdAt, "1");
    assert.equal(windows.length, 1);
    assert.equal(note.options.alwaysOnTop, true);
    assert.equal(note.shown, true);
    assert.equal(note.occluded, false);
    assert.equal(note.minimized, false);
    assert.equal(note.focused, undefined);
  }
});

test("hide and show preserve notes and bounds; closing the planner hides even loading notes", () => {
  const { notes, windows, changes, Window } = fixture();
  const planner = new Window({});
  notes.bindPlanner(planner);
  notes.show(1, "local", createdAt, "1");
  notes.show(2, "local", createdAt, "1");
  const [first, second] = windows.slice(1);
  first.emit("ready-to-show");
  const bounds = windows.slice(1).map((w) => w.getBounds());
  assert.deepEqual(notes.state(), { count: 2, visible: true });
  planner.emit("close");
  second.emit("ready-to-show");
  assert.equal(first.shown, false);
  assert.equal(second.shown, false); // Loading cannot reopen a hidden note.
  assert.deepEqual(changes.at(-1), { count: 2, visible: false });
  assert.deepEqual(notes.toggle(), { count: 2, visible: true });
  assert.ok(windows.slice(1).every((w) => w.shown && w.options.alwaysOnTop));
  assert.deepEqual(windows.slice(1).map((w) => w.getBounds()), bounds);
  assert.deepEqual(notes.toggle(), { count: 2, visible: false });
  first.close();
  assert.deepEqual(changes.at(-1), { count: 1, visible: false });
  notes.show(2, "local", createdAt, "1");
  assert.equal(second.shown, true);
  assert.deepEqual(notes.state(), { count: 1, visible: true });
  notes.hideAll();
  notes.keepScope(account);
  assert.equal(second.closed, true);
  assert.deepEqual(notes.toggle(), { count: 0, visible: false });
});

test("group controls accept only the current planner and clear hidden notes after switching accounts", async () => {
  const { notes, windows, event, Window } = fixture();
  const planner = new Window({});
  await planner.loadURL(`${origin}/today`);
  let scope = "local";
  const handlers = new Map();
  registerTaskNoteControls({ ipcMain: { on() {}, handle: (name, fn) => handlers.set(name, fn) }, taskWindows: notes,
    planner: () => planner, origin, readScope: async () => scope });
  const toggle = handlers.get("pacedmind:toggle-task-notes");
  const state = handlers.get("pacedmind:task-notes-state");
  notes.show(1, "local", createdAt, "1");
  const note = windows[1];
  assert.equal(await toggle(event(note)), null);
  assert.equal(await state(event(note)), null);
  assert.equal(await toggle({ ...event(planner), senderFrame: { url: `${origin}/today` } }), null);
  planner.webContents.mainFrame.url = "https://example.com/today";
  assert.equal(await toggle(event(planner)), null);
  planner.webContents.mainFrame.url = `${origin}/today`;
  assert.deepEqual(await toggle(event(planner)), { count: 1, visible: false });
  scope = undefined; // A server restart must not discard hidden cards.
  assert.equal(await toggle(event(planner)), null);
  assert.equal(note.closed, undefined);
  scope = account;
  assert.deepEqual(await toggle(event(planner)), { count: 0, visible: false });
  assert.equal(note.closed, true);
});

test("Hide notes and the header state work without a server response", async () => {
  const { notes, windows, event, Window } = fixture();
  const planner = new Window({});
  await planner.loadURL(`${origin}/today`);
  const handlers = new Map();
  let reads = 0;
  registerTaskNoteControls({ ipcMain: { on() {}, handle: (name, fn) => handlers.set(name, fn) }, taskWindows: notes,
    planner: () => planner, origin, readScope: async () => { reads++; return undefined; } });
  notes.show(1, "local", createdAt, "1");
  windows[1].emit("ready-to-show");
  assert.deepEqual(await handlers.get("pacedmind:task-notes-state")(event(planner)), { count: 1, visible: true });
  assert.deepEqual(await handlers.get("pacedmind:toggle-task-notes")(event(planner)), { count: 1, visible: false });
  assert.equal(windows[1].shown, false);
  assert.equal(reads, 0);
  assert.equal(await handlers.get("pacedmind:toggle-task-notes")(event(planner)), null);
  assert.equal(windows[1].shown, false); // Showing still requires the current account.
  assert.equal(reads, 1);
});

test("Show notes starts a fresh set when none are open, then toggles that set", async () => {
  const { notes, windows, event, Window } = fixture();
  const planner = new Window({});
  await planner.loadURL(`${origin}/today`);
  const handlers = new Map();
  let calls = 0;
  registerTaskNoteControls({ ipcMain: { on() {}, handle: (name, fn) => handlers.set(name, fn) }, taskWindows: notes,
    planner: () => planner, origin, readScope: async () => "local", openNotes: async (_event, scope) => {
      calls++;
      notes.show(1, scope, createdAt, "1");
      notes.show(2, scope, createdAt, "1");
      return { ok: true };
    } });
  const toggle = handlers.get("pacedmind:toggle-task-notes");
  assert.deepEqual(await handlers.get("pacedmind:task-notes-state")(event(planner)), { count: 0, visible: false });
  assert.equal(calls, 0);
  assert.deepEqual(await toggle(event(planner)), { count: 2, visible: true, ok: true });
  assert.deepEqual(await toggle(event(planner)), { count: 2, visible: false });
  assert.deepEqual(await toggle(event(planner)), { count: 2, visible: true });
  assert.equal(calls, 1);
  windows.slice(1).forEach((w) => w.close());
  await toggle(event(planner));
  assert.equal(calls, 2);
});

test("three displays, one remembered choice per account, one-off overrides and disconnected screens", () => {
  const { notes, displays, preferred, windows } = fixture();
  displays.push({ id: 2, label: "Centre", workArea: { x: 0, y: 0, width: 1920, height: 1040 } });
  displays.push({ id: 3, label: "Right", workArea: { x: 1920, y: -200, width: 1440, height: 900 } });
  assert.equal(notes.displays("local").displays.length, 3);
  assert.equal(notes.displays("local").defaultDisplay, null);
  assert.equal(notes.show(1, "local", createdAt, "3", true).status, "opened");
  assert.equal(notes.show(2, "local", createdAt, "3").status, "opened");
  assert.equal(notes.displays("local").displays[2].openCount, 2);
  assert.equal(preferred.get("local"), "3");
  assert.equal(notes.displays(account).defaultDisplay, null);
  assert.equal(notes.show(3, "local", createdAt, "2", false).status, "opened");
  assert.equal(preferred.get("local"), "3");
  assert.equal(windows[0].getBounds().x >= 1920, true);
  const before = windows.length;
  displays.pop();
  assert.equal(notes.show(4, "local", createdAt, "3", true).status, "failed");
  assert.equal(windows.length, before);
});

test("full displays refuse an extra note without saving a preference or moving existing notes", () => {
  const { notes, windows, displays, preferred } = fixture();
  displays[0].workArea = { x: 0, y: 0, width: 400, height: 300 };
  assert.equal(notes.show(1, "local", createdAt, "1").status, "opened");
  const before = windows[0].getBounds();
  assert.equal(notes.show(2, "local", createdAt, "1", true).status, "failed");
  assert.equal(windows.length, 1);
  assert.deepEqual(windows[0].getBounds(), before);
  assert.equal(preferred.size, 0);
  assert.equal(notes.show(1, "local", createdAt, "1", true).status, "opened");
  assert.equal(preferred.get("local"), "1");
});

test("note controls accept only their own main frame and only planner destinations", () => {
  const { notes, windows, opened, event } = fixture();
  notes.open(1, "local", createdAt);
  const window = windows[0];
  const owner = event(window);
  const subframe = { ...owner, senderFrame: { url: owner.senderFrame.url } };
  assert.equal(notes.close(subframe), false);
  assert.equal(notes.showInPlanner(subframe, "/inbox?task=WRK-1"), false);
  assert.equal(notes.close({ sender: {}, senderFrame: owner.senderFrame }), false);
  for (const href of ["https://example.com", "//example.com", "/auth/callback?code=x", "/inbox?task=x&next=//example.com", "/project/../login"]) {
    assert.equal(notes.showInPlanner(owner, href), false);
  }
  assert.equal(notes.showInPlanner(owner, "/area/work/todos?task=WRK-1"), true);
  assert.deepEqual(opened, [`${origin}/area/work/todos?task=WRK-1`]);
  const url = window.webContents.mainFrame.url;
  window.webContents.mainFrame.url = "https://example.com";
  assert.equal(notes.close(owner), false);
  window.webContents.mainFrame.url = url;
  assert.equal(notes.close(owner), true);
  assert.equal(window.closed, true);
});

test("notes refuse navigation, popups and malformed task references", () => {
  const { notes, windows } = fixture();
  for (const id of [0, -1, 1.5, "1", NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.equal(notes.open(id, "local", createdAt), false);
  for (const scope of ["", "https://example.com", "local/../other", null]) assert.equal(notes.open(1, scope, createdAt), false);
  assert.equal(notes.open(1, "local", "wrong"), false);
  assert.equal(windows.length, 0);
  notes.open(1, "local", createdAt);
  const window = windows[0];
  assert.deepEqual(window.openHandler({ url: "https://example.com" }), { action: "deny" });
  for (const type of ["will-navigate", "will-redirect"]) {
    for (const url of ["https://example.com", `${origin}/today`, "data:text/html,bad"]) {
      let blocked = false;
      window.webContents.emit(type, { preventDefault: () => { blocked = true; } }, url);
      assert.equal(blocked, true);
    }
  }
});

test("switching accounts closes old notes and resetting a task cannot reuse its old window", () => {
  const { notes, windows } = fixture();
  notes.open(1, "local", createdAt);
  notes.open(1, account, createdAt);
  notes.keepScope(account);
  assert.equal(windows[0].closed, true);
  assert.equal(windows[1].closed, undefined);
  notes.open(1, account, "2026-10-05T10:00:00");
  assert.equal(windows[1].closed, true);
  assert.equal(windows[2].closed, undefined);
  notes.keepScope(null);
  assert.equal(windows[2].closed, true);
});

test("Mac notes cover workspaces; theme changes and server restarts reach every open note", () => {
  const { notes, windows } = fixture("darwin");
  notes.open(1, "local", createdAt);
  notes.open(2, "local", createdAt);
  notes.setBackgroundColor("#f5f5f6");
  notes.reload();
  for (const window of windows) {
    assert.deepEqual(window.workspaces, [true, { visibleOnFullScreen: true }]);
    assert.equal(window.options.icon, undefined);
    assert.equal(window.background, "#f5f5f6");
    assert.equal(window.reloaded, true);
  }
});

test("46 notes share one inventory; version messages cannot cross accounts or replaced tasks", () => {
  const { notes, windows, displays } = fixture();
  displays[0].workArea = { x: -2560, y: 0, width: 2560, height: 1392 };
  for (let id = 1; id <= 46; id++) assert.equal(notes.show(id, "local", createdAt, "1").status, "opened");
  assert.equal(notes.tasks("local").length, 46);
  assert.deepEqual(notes.tasks(account), []);
  windows.forEach(w => { w.messages.length = 0; });
  const version = "a".repeat(64);
  notes.updateVersions(account, [{ id: 1, createdAt, version }]);
  notes.updateVersions("local", [{ id: 1, createdAt: "2000-01-01T00:00:00", version }]);
  notes.updateVersions("local", [{ id: 1, createdAt, version: "invalid" }]);
  assert.ok(windows.every((w) => w.messages.length === 0));
  notes.updateVersions("local", [{ id: 1, createdAt, version }]);
  assert.deepEqual(windows[0].messages, [["pacedmind:task-note-version", version]]);
  assert.ok(windows.slice(1).every((w) => w.messages.length === 0));
  windows[0].close();
  assert.equal(notes.tasks("local").length, 45);
  notes.updateVersions("local", [{ id: 1, createdAt, version }]);
  assert.equal(windows[0].messages.length, 1);
});

test("layout settings and custom spaces cannot put cards outside a display or overlap groups", () => {
  const area = { x: -2560, y: -200, width: 2560, height: 1392 };
  const notes = Array.from({ length: 23 }, (_, i) => ({ id: i + 1, createdAt, meta: { priority: i % 3 ? "medium" : "high", projectId: String(i % 3), projectName: `Project ${i % 3}` } }));
  for (const size of ["small", "medium", "large"]) for (const group of ["none", "project", "priority", "focus"]) {
    const plan = workspaceLayout(area, notes, layoutSettings({ size, group }));
    assert.equal(plan.placements.length, 23);
    for (const { bounds: r } of plan.placements) {
      assert.ok(r.width >= 280 && r.height >= 200);
      assert.ok(r.x >= area.x && r.y >= area.y && r.x + r.width <= area.x + area.width && r.y + r.height <= area.y + area.height);
    }
  }
  const settings = layoutSettings({ group: "project" });
  const groups = workspaceLayout(area, notes, settings).groups;
  settings.regions = Object.fromEntries(groups.map(g => [g.key, { x: 0, y: 0, width: 1, height: 1 }]));
  assert.equal(workspaceLayout(area, notes, settings), null);
  assert.deepEqual(layoutSettings({ size: "huge", regions: { evil: { x: -1, y: 0, width: 10, height: 10 } } }), layoutSettings(null));
});

test("changing screens is atomic, saved per account, and keeps hidden cards hidden", () => {
  const { notes, windows, displays, preferred, layouts } = fixture();
  displays.push({ id: 2, label: "Right", workArea: { x: 1280, y: 0, width: 1920, height: 1080 } });
  notes.show(1, "local", createdAt, "1"); notes.show(2, "local", createdAt, "1");
  windows.forEach(w => w.emit("ready-to-show")); notes.hideAll();
  const result = notes.configure("local", { displayId: "2", move: true, settings: { size: "large", animation: "right" } });
  assert.equal(result.ok, true); assert.equal(preferred.get("local"), "2");
  assert.ok(windows.every(w => w.getBounds().x >= 1280 && !w.shown));
  assert.equal(layouts.get("local:2").size, "large");
  assert.equal(notes.workspace(account).displays[1].settings.size, "medium");
  const before = windows.map(w => w.getBounds());
  assert.equal(notes.configure("local", { displayId: "lost", move: true }).ok, false);
  assert.deepEqual(windows.map(w => w.getBounds()), before);
});

test("manual card positions survive a screen round-trip and reopening, until an explicit rearrange", () => {
  const { notes, windows, displays, layouts } = fixture();
  displays.push({ id: 2, label: "Right", workArea: { x: 1280, y: 0, width: 1920, height: 1080 } });
  notes.show(1, "local", createdAt, "1");
  const ref = `1:${createdAt}`;
  const left = { x: .3, y: .2, width: .4, height: .5 };
  assert.equal(notes.moveNote("local", "1", ref, left).ok, true);
  const before = windows[0].getBounds();
  notes.configure("local", { displayId: "2", move: true });
  const right = { x: .5, y: .3, width: .3, height: .4 };
  assert.equal(notes.moveNote("local", "2", ref, right).ok, true);
  const other = windows[0].getBounds();
  notes.configure("local", { displayId: "1", move: true });
  assert.deepEqual(windows[0].getBounds(), before);
  notes.configure("local", { displayId: "1", settings: { emphasis: false, animation: "none" } });
  assert.deepEqual(windows[0].getBounds(), before);
  windows[0].close(); notes.show(1, "local", createdAt, "1");
  assert.deepEqual(windows[1].getBounds(), before);
  notes.configure("local", { displayId: "2", move: true });
  assert.deepEqual(windows[1].getBounds(), other);
  notes.configure("local", { displayId: "2", settings: { size: "small" } });
  assert.deepEqual(layouts.get("local:2").positions, {});
  assert.notDeepEqual(windows[1].getBounds(), other);
  assert.equal(layouts.has(`${account}:2`), false);
});

test("metadata maps numeric priorities and ignores another frame", () => {
  const { notes, windows, event } = fixture();
  notes.show(1, "local", createdAt, "1");
  const owner = event(windows[0]);
  notes.report(owner, { title: "Urgent", priority: 1, status: "todo" });
  assert.equal(windows[0].messages.at(-1)[1].emphasis, "strong");
  assert.equal(notes.report({ ...owner, senderFrame: { url: owner.senderFrame.url } }, { priority: 4 }), false);
  notes.report(owner, { title: "Low", priority: 4, status: "todo" });
  assert.equal(windows[0].messages.at(-1)[1].emphasis, "quiet");
});

test("motion sequencing is spatial, bounded for 46 notes, and urgency uses local dates", () => {
  const notes = Array.from({ length: 46 }, (_, id) => ({ id, window: { getBounds: () => ({ x: (id % 8) * 300 - 2560, y: Math.floor(id / 8) * 210 }) } }));
  const right = animationDelays(notes, "right"), diagonal = animationDelays(notes, "diagonal");
  assert.ok(right.get(notes[7]) < right.get(notes[0]));
  assert.ok(diagonal.get(notes[0]) < diagonal.get(notes[45]));
  for (const kind of ["right", "diagonal", "shuffle", "together", "none"]) assert.ok(Math.max(...animationDelays(notes, kind).values()) <= 180);
  assert.equal(importance({ status: "todo", priority: "low", plannedDate: "2026-10-05" }, new Date(2026, 9, 5)), "strong");
  assert.equal(importance({ status: "done", priority: "urgent" }), "quiet");
});

test("interrupting an animation cannot execute an old hide callback", async () => {
  const { Window } = fixture(), window = new Window({ x: 0, y: 0, width: 280, height: 200 });
  const note = { window, ready: true }, motion = createNoteMotion();
  let hidden = false;
  motion.run(note, { opacity: 0, delay: 80, done: () => { hidden = true; } });
  motion.run(note, { opacity: 1 });
  await new Promise(r => setTimeout(r, 360));
  assert.equal(hidden, false); assert.equal(window.opacity, 1);
  note.reducedMotion = true;
  motion.run(note, { opacity: 0, delay: 100, done: () => { hidden = true; } });
  assert.equal(hidden, true); assert.equal(window.opacity, 0);
});

test("layout IPC refuses foreign windows, subframes, missing scopes, and oversize payloads", async () => {
  const { notes, Window, event } = fixture(), planner = new Window({});
  await planner.loadURL(`${origin}/today`);
  const handlers = new Map(); let scope = "local";
  registerTaskNoteControls({ ipcMain: { on() {}, handle: (key, fn) => handlers.set(key, fn) }, taskWindows: notes, planner: () => planner, origin, readScope: async () => scope });
  const change = handlers.get("pacedmind:set-task-note-layout");
  assert.equal(await change({ ...event(planner), senderFrame: { url: `${origin}/today` } }, {}), null);
  assert.equal((await change(event(planner), { displayId: "1", settings: { size: "large" } })).ok, true);
  assert.equal((await change(event(planner), { payload: "x".repeat(33000) })).ok, false);
  scope = undefined;
  assert.equal(await change(event(planner), { displayId: "1" }), null);
});

test("in-app monitor choice binds to the planner frame, remembers only explicit answers, and rechecks scope", async () => {
  const { notes, Window, event, displays, preferred } = fixture(), planner = new Window({});
  displays.push({ id: 2, label: "Other", workArea: { x: 0, y: 0, width: 1920, height: 1080 } });
  await planner.loadURL(`${origin}/today`);
  const handlers = new Map(); let scope = "local";
  const open = createTaskNoteOpener({ ipcMain: { handle: (key, fn) => handlers.set(key, fn) }, taskWindows: notes, planner: () => planner, origin, readScope: async () => scope });
  const answer = handlers.get("pacedmind:choose-task-note-display");
  const task = [{ id: 1, createdAt }];
  const begin = async () => { const result = open(event(planner), task, "local"); await new Promise(setImmediate); return { result, prompt: planner.messages.at(-1)[1] }; };
  const first = await begin();
  assert.equal(notes.state().count, 0);
  assert.equal(await open(event(planner), task, "local"), false);
  assert.equal(answer({ ...event(planner), senderFrame: { url: `${origin}/today` } }, first.prompt.requestId, { displayId: "2", remember: true }), false);
  assert.equal(answer(event(planner), "stale", { displayId: "2", remember: true }), false);
  assert.equal(answer(event(planner), first.prompt.requestId, { displayId: "2" }), false);
  assert.equal(answer(event(planner), first.prompt.requestId, null), true);
  assert.deepEqual(await first.result, { ok: true }); assert.equal(preferred.size, 0);
  const second = await begin(); scope = account;
  assert.equal(answer(event(planner), second.prompt.requestId, { displayId: "2", remember: true }), true);
  assert.equal(await second.result, false); assert.equal(notes.state().count, 0); assert.equal(preferred.size, 0);
  scope = "local";
  const third = await begin();
  answer(event(planner), third.prompt.requestId, { displayId: "2", remember: true });
  assert.deepEqual(await third.result, { ok: true }); assert.equal(preferred.get("local"), "2");
  assert.equal(answer(event(planner), third.prompt.requestId, { displayId: "1", remember: true }), false);
});

test("screen choice cancels on closing the planner and never saves a disconnected display", async () => {
  const { notes, Window, event, displays, preferred } = fixture(), planner = new Window({});
  displays.push({ id: 2, label: "Other", workArea: { x: 0, y: 0, width: 1920, height: 1080 } });
  await planner.loadURL(`${origin}/today`);
  const handlers = new Map();
  const open = createTaskNoteOpener({ ipcMain: { handle: (key, fn) => handlers.set(key, fn) }, taskWindows: notes, planner: () => planner, origin, readScope: async () => "local" });
  const first = open(event(planner), [{ id: 1, createdAt }], "local"); await new Promise(setImmediate);
  planner.emit("close"); assert.deepEqual(await first, { ok: true });
  const second = open(event(planner), [{ id: 1, createdAt }], "local"); await new Promise(setImmediate);
  const prompt = planner.messages.at(-1)[1]; displays.pop();
  handlers.get("pacedmind:choose-task-note-display")(event(planner), prompt.requestId, { displayId: "2", remember: true });
  assert.equal((await second).ok, false); assert.equal(preferred.size, 0); assert.equal(notes.state().count, 0);
});

test("XS cards, rows and columns stay readable without overlap on different screen geometries", () => {
  for (const area of [{ x: -2560, y: 0, width: 2560, height: 1392 }, { x: 0, y: -1920, width: 1080, height: 1920 }]) {
    const small = noteLayout(area, 46, "xs");
    assert.equal(small.length, 46);
    const notes = Array.from({ length: 18 }, (_, id) => ({ id, createdAt, meta: { status: id % 2 ? "todo" : "in_progress" } }));
    for (const arrangement of ["grid", "columns", "rows"]) {
      const plan = workspaceLayout(area, notes, layoutSettings({ size: "xs", group: "status", arrangement }));
      assert.equal(plan.placements.length, 18);
      for (const [i, { bounds: a }] of plan.placements.entries()) {
        assert.ok(a.width >= 220 && a.height >= 72);
        assert.ok(a.x >= area.x && a.y >= area.y && a.x + a.width <= area.x + area.width && a.y + a.height <= area.y + area.height);
        for (const { bounds: b } of plan.placements.slice(i + 1)) assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);
      }
    }
  }
  const { notes, windows } = fixture();
  notes.configure("local", { displayId: "1", settings: { size: "xs" } }); notes.show(1, "local", createdAt, "1");
  assert.equal(windows[0].options.minHeight, 72); assert.ok(windows[0].getBounds().height < 100);
  notes.configure("local", { displayId: "1", settings: { size: "large" } }); assert.ok(windows[0].getBounds().height >= 200);
});

test("each computer keeps its own monitor layout even for the same account and screen id", () => {
  const first = fixture(), second = fixture();
  second.displays[0].workArea = { x: 0, y: -1080, width: 1920, height: 1080 };
  first.notes.configure(account, { displayId: "1", move: true, settings: { size: "xs", arrangement: "columns", group: "priority" } });
  assert.equal(first.preferred.get(account), "1");
  assert.equal(second.preferred.size, 0);
  assert.deepEqual(second.notes.workspace(account).displays[0].settings, layoutSettings(null));
  second.notes.configure(account, { displayId: "1", move: true, settings: { size: "large", arrangement: "rows" } });
  assert.equal(first.notes.workspace(account).displays[0].settings.size, "xs");
  assert.equal(second.notes.workspace(account).displays[0].settings.arrangement, "rows");
});

test("deadline groups are chronological and XS cannot exceed the shared refresh inventory", () => {
  const tasks = [null, "2026-10-20", "2026-10-05", "2026-10-01", "2026-10-10"].map((dueDate, id) => ({ id, meta: { dueDate } }));
  assert.deepEqual(noteGroups(tasks, layoutSettings({ group: "deadline" }), new Date(2026, 9, 5)).map(g => g.key), ["overdue", "today", "week", "later", "no-date"]);
  const { notes, displays } = fixture();
  displays[0].workArea = { x: 0, y: 0, width: 3840, height: 2160 };
  notes.configure("local", { displayId: "1", settings: { size: "xs" } });
  for (let id = 1; id <= 200; id++) assert.equal(notes.show(id, "local", createdAt, "1").status, "opened");
  assert.equal(notes.show(201, "local", createdAt, "1").status, "failed");
  assert.equal(notes.displays("local").displays[0].capacity, 200);
  assert.equal(notes.tasks("local").length, 200);
});
