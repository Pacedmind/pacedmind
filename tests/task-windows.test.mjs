import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { createTaskWindows } from "../desktop/task-windows.mjs";
import { registerTaskNoteControls } from "../desktop/task-note-controls.mjs";
import { noteCapacity, noteLayout } from "../desktop/task-note-layout.mjs";

const origin = "http://127.0.0.1:4319";
const createdAt = "2026-10-04T10:00:00";
const account = "11111111-1111-4111-8111-111111111111";

function fixture(platform = "win32") {
  const windows = [];
  const opened = [];
  const preferred = new Map();
  const changes = [];
  const displays = [{ id: 1, label: "Left", workArea: { x: -1280, y: 0, width: 1280, height: 720 } }];
  class Window extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.webContents = new EventEmitter();
      this.webContents.mainFrame = { url: "" };
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
  return { notes, windows, opened, event, displays, preferred, changes, Window };
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
  registerTaskNoteControls({ ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, taskWindows: notes,
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

test("Show notes starts a fresh set when none are open, then toggles that set", async () => {
  const { notes, windows, event, Window } = fixture();
  const planner = new Window({});
  await planner.loadURL(`${origin}/today`);
  const handlers = new Map();
  let calls = 0;
  registerTaskNoteControls({ ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, taskWindows: notes,
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
