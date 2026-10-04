import { app, BrowserWindow, ipcMain, session } from "electron";
import { spawn } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTaskWindows } from "../desktop/task-windows.mjs";

const root = path.resolve(import.meta.dirname, "..");
fs.mkdirSync(path.join(root, "dist"), { recursive: true });
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pacedmind-note-check-"));
const dirs = Object.fromEntries(["data", "home", "appdata", "claude", "codex", "electron"].map((d) => [d, path.join(temp, d)]));
for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
const key = randomBytes(32).toString("base64url");
const ownerToken = `pm_${randomBytes(32).toString("hex")}`;
const limitedToken = `pm_${randomBytes(32).toString("hex")}`;
const limitedSession = "11111111-1111-4111-8111-111111111111";
fs.writeFileSync(path.join(dirs.data, "device.json"), JSON.stringify({ name: "Notes test", withoutAccount: true, importOffered: true, ownerToken,
  sessionTokens: { [createHash("sha256").update(limitedToken).digest("hex")]: { sessionId: limitedSession, taskId: 4, issuedAt: new Date().toISOString(), expires: Date.now() + 600000 } },
}));
app.setPath("userData", dirs.electron);
app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.on("window-all-closed", () => {});
const origin = "http://127.0.0.1:4361";
const serverLog = fs.openSync(path.join(temp, "server.log"), "a");
const child = spawn(process.execPath, [path.join(root, "node_modules/next/dist/bin/next"), "start", "-p", "4361", "-H", "127.0.0.1"], {
  cwd: root, windowsHide: true, stdio: ["pipe", serverLog, serverLog],
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ORGANIZER_MODE: "desktop", ORGANIZER_DATA_KEY: "", ORGANIZER_DB: path.join(dirs.data, "organizer.db"), ORGANIZER_SEED: "empty", ORGANIZER_UI_SECRET: key,
    ORGANIZER_EXIT_WITH_PARENT: "1", USERPROFILE: dirs.home, HOME: dirs.home, APPDATA: dirs.appdata, CLAUDE_CONFIG_DIR: dirs.claude, CODEX_HOME: dirs.codex, NODE_ENV: "production" },
});
fs.closeSync(serverLog);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const headers = { "x-pacedmind-ui": key };
async function until(fn, label, ms = 25000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(200);
  }
  throw new Error(`Timed out: ${label}`);
}
let rpcId = 0;
let mcpSession;
let rpcToken = ownerToken;
async function rpc(method, params, expectError = false) {
  const response = await fetch(`${origin}/api/mcp`, { method: "POST", headers: {
    Authorization: `Bearer ${rpcToken}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream",
    ...(mcpSession ? { "Mcp-Session-Id": mcpSession } : {}),
  }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) });
  if (response.headers.get("mcp-session-id")) mcpSession = response.headers.get("mcp-session-id");
  const raw = await response.text();
  const messages = raw.startsWith("{") ? [JSON.parse(raw)] : raw.split("\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5)));
  const reply = messages.find((m) => m.id === rpcId);
  assert.ok(response.ok && reply && !reply.error, `MCP ${method}: ${raw}`);
  assert.equal(!!reply.result?.isError, expectError, `MCP ${method}: ${JSON.stringify(reply.result)}`);
  return reply.result;
}
const call = (name, args) => rpc("tools/call", { name, arguments: args });
const body = (win) => win.webContents.executeJavaScript("document.body.innerText");
const click = (win, label) => win.webContents.executeJavaScript(`(() => { const b = [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === ${JSON.stringify(label)} || b.textContent.trim() === ${JSON.stringify(label)}); if (!b || b.disabled) return false; b.click(); return true; })()`);
async function screenshot(win, name) {
  await win.webContents.executeJavaScript("document.fonts.ready.then(() => true)");
  await sleep(350);
  fs.writeFileSync(path.join(root, "dist", name), (await win.webContents.capturePage()).toPNG());
}
app.whenReady().then(async () => {
let db;
let notePoll;
try {
  await until(async () => fetch(`${origin}/api/state`, { headers }).then((r) => r.ok, () => false), "server");
  await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "note-check", version: "1" } });
  await call("create_task", { title: "Prepare the release checklist", agent: "codex", subtasks: ["Review the changes", "Check the installer"] });
  await call("create_task", { title: "Write the daily project update", agent: "human", repeat: "day", planned_date: "2026-10-04" });
  db = new DatabaseSync(path.join(dirs.data, "organizer.db"));
  const tasks = db.prepare("SELECT id, key, title, created_at FROM tasks ORDER BY id").all();
  assert.equal(tasks.length, 2);
  let theme = "dark";
  const preferred = new Map();
  const planner = new BrowserWindow({ show: false, width: 1280, height: 850, webPreferences: { sandbox: true, contextIsolation: true, preload: path.join(root, "desktop/preload.cjs"), additionalArguments: ["--pacedmind-theme=dark"] } });
  const notes = createTaskWindows({ BrowserWindow, screen: (await import("electron")).screen, origin,
    preload: path.join(root, "desktop/preload.cjs"), theme: () => ({ name: theme, background: theme === "dark" ? "#010101" : "#f5f5f6" }),
    icon: path.join(root, "desktop/icon.ico"), showMain: (url) => { void planner.loadURL(url); },
    preferredDisplay: (scope) => preferred.get(scope) ?? null, rememberDisplay: (scope, display) => preferred.set(scope, display),
  });
  ipcMain.handle("pacedmind:float-task", (e, id, scope, createdAt) => e.sender === planner.webContents && e.senderFrame === planner.webContents.mainFrame && notes.open(id, scope, createdAt));
  ipcMain.handle("pacedmind:close-task-note", (e) => notes.close(e));
  ipcMain.handle("pacedmind:show-floating-task", (e, href) => notes.showInPlanner(e, href));
  ipcMain.on("pacedmind:set-theme", () => {});
  // The production main process performs this once for all notes; renderers never poll /api/state.
  let polling = false;
  let autoPoll = true;
  const pollNotes = async () => {
    if (polling || !autoPoll) return;
    polling = true;
    try {
      const r = await fetch(`${origin}/api/desktop/task-notes`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "local", displays: notes.displays("local"), results: [], receive: false, notes: notes.tasks("local") }) });
      const state = await r.json();
      notes.updateVersions("local", state.versions);
    } finally { polling = false; }
  };
  notePoll = setInterval(() => { void pollNotes().catch(console.error); }, 1000);
  const requests = [];
  let actionId;
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    requests.push({ url: details.url, webContentsId: details.webContentsId, method: details.method });
    if (details.url.includes("/floating/task/")) actionId = Object.entries(details.requestHeaders).find(([name]) => name.toLowerCase() === "next-action")?.[1] ?? actionId;
    callback({ requestHeaders: details.requestHeaders });
  });
  await session.defaultSession.cookies.set({ url: origin, name: "pm_ui", value: key, httpOnly: true, sameSite: "strict" });
  await planner.loadURL(`${origin}/inbox`);
  await until(() => planner.webContents.executeJavaScript("document.querySelectorAll('button[aria-label=\"Float task\"]').length === 2"), "two float buttons");
  assert.equal(await click(planner, "Float task"), true);
  await until(() => BrowserWindow.getAllWindows().length === 2, "first note");
  const first = BrowserWindow.getAllWindows().find((w) => w !== planner);
  await until(async () => (await body(first)).includes(tasks[0].title), "first note content");
  assert.equal(first.isAlwaysOnTop(), true);
  assert.equal(first.getParentWindow(), null);
  await click(planner, "Float task");
  await sleep(300);
  assert.equal(BrowserWindow.getAllWindows().length, 2);
  await planner.webContents.executeJavaScript("document.querySelectorAll('button[aria-label=\"Float task\"]')[1].click()");
  await until(() => BrowserWindow.getAllWindows().length === 3, "second note");
  const second = BrowserWindow.getAllWindows().find((w) => w !== planner && w !== first);
  await until(async () => (await body(second)).includes(tasks[1].title), "second note content");
  planner.hide();
  assert.equal(first.isVisible(), true);
  assert.equal(second.isVisible(), true);
  assert.equal(second.isAlwaysOnTop(), true);
  console.log("PASS: real renderer buttons, independent topmost windows, duplicate prevention, main window hidden");
  await sleep(4300);
  await call("start_task", { task: tasks[0].key, agent: "codex" });
  await call("report_progress", { task: tasks[0].key, message: "Checking the last installer details before the release.", plan: [{ step: "Review the release checklist", done: true }, { step: "Verify the installer", done: false }] });
  await until(async () => (await body(first)).includes("Checking the last installer") && (await body(first)).includes("1 / 2"), "agent live progress");
  await screenshot(first, "task-note-dark.png");
  theme = "light";
  await planner.webContents.executeJavaScript("localStorage.setItem('pacedmind-theme', 'light')");
  await until(() => first.webContents.executeJavaScript("document.documentElement.dataset.theme === 'light'"), "theme storage sync");
  await screenshot(first, "task-note-light.png");
  await call("report_progress", { task: tasks[0].key, kind: "issue", message: "The installer needs one final adjustment." });
  await until(async () => (await body(first)).includes("one final adjustment"), "agent issue");
  await call("report_progress", { task: tasks[0].key, kind: "question", message: "Ready for your review?" });
  await until(async () => (await body(first)).includes("Has a question"), "agent attention");
  await call("finish_task", { task: tasks[0].key, summary: "The release checklist is ready for your review." });
  await until(async () => (await body(first)).includes("Finished · review") && (await body(first)).includes("In review"), "agent finish status");
  assert.equal(await click(first, "Mark as done"), true);
  await until(async () => (await body(first)).includes("Reopen task"), "completion from note");
  assert.equal(db.prepare("SELECT status FROM tasks WHERE id = ?").get(tasks[0].id).status, "done");
  assert.equal(db.prepare("SELECT status FROM sessions WHERE task_id = ?").get(tasks[0].id).status, "done");
  assert.ok(actionId);
  for (const [scope, stamp] of [["11111111-1111-4111-8111-111111111111", tasks[0].created_at], [null, tasks[0].created_at], ["local", "2000-01-01T00:00:00"]]) {
    const rejectedWrite = await fetch(`${origin}/floating/task/${tasks[0].id}?scope=local&createdAt=${encodeURIComponent(tasks[0].created_at)}`, {
      method: "POST", headers: { ...headers, "Next-Action": actionId, "Content-Type": "text/plain;charset=UTF-8", Origin: origin },
      body: JSON.stringify([tasks[0].id, scope, stamp, false]),
    }).then((r) => r.text());
    assert.ok(rejectedWrite.includes('"ok":false'), rejectedWrite);
    assert.equal(db.prepare("SELECT status FROM tasks WHERE id = ?").get(tasks[0].id).status, "done");
  }
  console.log("PASS: stale note actions cannot write after a scope change or task replacement");
  console.log("PASS: MCP progress, plan, question, finished report, theme sync, completing task and session");
  assert.equal(await click(first, "Open in PacedMind"), true);
  await until(async () => (await body(planner)).includes("Task details") || await planner.webContents.executeJavaScript("!!document.querySelector('aside[aria-label=\"Task details\"]')"), "completed task details");
  assert.equal(await click(second, "Mark as done"), true);
  await until(() => db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE title = ?").get(tasks[1].title).n === 2, "repeating task");
  await until(async () => (await body(second)).includes("Reopen task"), "repeat completion rendered");
  assert.equal(await click(second, "Close note"), true);
  await until(() => second.isDestroyed(), "close second");
  assert.equal(first.isDestroyed(), false);
  assert.equal(db.prepare("SELECT status FROM tasks WHERE id = ?").get(tasks[1].id).status, "done");
  console.log("PASS: open completed inbox details, repeated task created once, closing one note leaves the other");
  const wrongScope = `${origin}/floating/task/${tasks[0].id}?scope=11111111-1111-4111-8111-111111111111&createdAt=${encodeURIComponent(tasks[0].created_at)}`;
  const rejected = await fetch(wrongScope, { headers }).then((r) => r.text());
  assert.ok(!rejected.includes(tasks[0].title));
  await call("delete_task", { task: tasks[0].key });
  await until(async () => (await body(first)).includes("This task is no longer available"), "deleted task");
  notes.keepScope(null);
  autoPoll = false;
  await until(() => !polling, "last automatic note poll");
  await until(() => first.isDestroyed(), "scope closes note");
  console.log("PASS: mismatched account cannot read the note, deleted tasks clear the note, scope change closes notes");
  await call("create_task", { title: "Agent note delivery", agent: "codex" });
  const agentTask = db.prepare("SELECT * FROM tasks WHERE title = 'Agent note delivery'").get();
  const exchange = async (patch = {}, extraHeaders = headers) => {
    const response = await fetch(`${origin}/api/desktop/task-notes`, { method: "POST", headers: { ...extraHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "local", displays: notes.displays("local"), results: [], ...patch }) });
    return { status: response.status, ...(response.ok ? await response.json() : {}) };
  };
  const snap = notes.displays("local");
  const chosen = snap.displays[0].id;
  // Simulated monitor inventory, delivered through the real main-process route and MCP tools.
  const three = { ...snap, displays: [snap.displays[0], ...[1, 2].map((i) => ({ ...snap.displays[0], id: String(9000000 + i), label: `Test display ${i + 1}`, x: i * 1920, primary: false }))] };
  assert.equal((await exchange({ displays: three })).status, 200);
  const choices = await call("list_task_note_displays", {});
  assert.match(JSON.stringify(choices), /Test display 3/);
  await rpc("tools/call", { name: "show_task_note", arguments: { task: agentTask.key } }, true);
  assert.equal(db.prepare("SELECT count(*) n FROM task_note_requests").get().n, 0);
  await rpc("tools/call", { name: "show_task_note", arguments: { task: agentTask.key, display: chosen } }, true);
  await call("show_task_note", { task: agentTask.key, display: chosen, remember: true });
  assert.equal((await exchange({}, { Cookie: `pm_ui=${key}` })).status, 403);
  assert.equal((await exchange({}, { ...headers, Origin: origin })).status, 403);
  assert.equal((await exchange({ scope: "11111111-1111-4111-8111-111111111111" })).requests.length, 0);
  assert.equal(db.prepare("SELECT status FROM task_note_requests").get().status, "pending");
  const delivery = await exchange();
  assert.equal(delivery.requests.length, 1);
  const item = delivery.requests[0];
  assert.equal(db.prepare("SELECT status FROM task_note_requests WHERE id = ?").get(item.id).status, "dispatched");
  assert.equal((await exchange()).requests.length, 0); // Never repeat an in-flight delivery.
  const shown = notes.show(item.taskId, "local", item.taskCreatedAt, item.displayId, item.remember);
  assert.equal(shown.status, "opened");
  const agentWindow = BrowserWindow.getAllWindows().find((w) => w !== planner);
  await until(async () => (await body(agentWindow)).includes(agentTask.title), "note opened by agent request");
  assert.equal(agentWindow.isAlwaysOnTop(), true);
  await exchange({ receive: false, results: [{ id: item.id, ...shown }] });
  assert.equal(db.prepare("SELECT status FROM task_note_requests WHERE id = ?").get(item.id).status, "opened");
  assert.equal(preferred.get("local"), chosen);
  assert.match(JSON.stringify(await call("list_task_note_displays", {})), /opened/);
  agentWindow.close();
  assert.equal((await exchange()).requests.length, 0);
  assert.equal(BrowserWindow.getAllWindows().length, 1);
  // The saved choice avoids another monitor question; replaced tasks and expiry fail closed.
  await call("show_task_note", { task: agentTask.key });
  db.prepare("UPDATE tasks SET created_at = '2000-01-01T00:00:00' WHERE id = ?").run(agentTask.id);
  assert.equal((await exchange()).requests.length, 0);
  assert.equal(db.prepare("SELECT status FROM task_note_requests ORDER BY requested_at DESC LIMIT 1").get().status, "failed");
  await call("show_task_note", { task: agentTask.key });
  db.prepare("UPDATE task_note_requests SET expires_at = '2000-01-01T00:00:00Z' WHERE status = 'pending'").run();
  assert.equal((await exchange()).requests.length, 0);
  assert.equal(db.prepare("SELECT status FROM task_note_requests ORDER BY requested_at DESC LIMIT 1").get().status, "expired");
  console.log("PASS: MCP screen choice, explicit remember answer, Electron delivery, receipts, saved choice, protected bridge, at-most-once delivery, stale tasks and expiry");
  assert.equal(agentTask.id, 4);
  db.prepare("INSERT INTO sessions (id, task_id, agent, status, started_at) VALUES (?, ?, 'codex', 'running', ?)").run(limitedSession, agentTask.id, new Date().toISOString());
  rpcToken = limitedToken; mcpSession = undefined;
  await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "limited-note-check", version: "1" } });
  await rpc("tools/call", { name: "show_task_note", arguments: { task: tasks[1].key } }, true);
  await call("show_task_note", { task: agentTask.key });
  rpcToken = ownerToken; mcpSession = undefined;
  console.log("PASS: a launched session can show only its own task note");
  await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "note-performance", version: "1" } });
  await call("create_tasks", { tasks: Array.from({ length: 46 }, (_, i) => ({ title: `Performance note ${i + 1}`, agent: "human" })) });
  const performanceTasks = db.prepare("SELECT id, key, title, created_at FROM tasks WHERE title LIKE 'Performance note %' ORDER BY id").all();
  const { screen } = await import("electron");
  const display = screen.getPrimaryDisplay();
  // Hidden real renderers exercise the same code without covering the user's desktop during the load test.
  const noteWindows = [];
  function HiddenNote(options) {
    const window = new BrowserWindow(options);
    window.showInactive = () => {};
    noteWindows.push(window);
    return window;
  }
  const many = createTaskWindows({ BrowserWindow: HiddenNote, screen: {
    getPrimaryDisplay: () => display, getAllDisplays: () => [{ ...display, workArea: { x: 0, y: 0, width: 2560, height: 1392 } }],
    getDisplayMatching: () => display,
  }, origin, preload: path.join(root, "desktop/preload.cjs"), theme: () => ({ name: theme, background: "#f5f5f6" }), showMain() {} });
  for (const t of performanceTasks) assert.equal(many.show(t.id, "local", t.created_at, String(display.id)).status, "opened");
  assert.equal(noteWindows.length, 46);
  await until(async () => (await Promise.all(noteWindows.map((w) => body(w).catch(() => "")))).every((text) => text.includes("Mark as done")), "46 loaded renderers", 90000);
  const readVersions = async () => (await exchange({ receive: false, notes: many.tasks("local") })).versions;
  const initialVersions = await readVersions();
  many.updateVersions("local", initialVersions);
  await sleep(1500);
  requests.length = 0;
  await sleep(4500);
  const noteIds = new Set(noteWindows.map((w) => w.webContents.id));
  assert.equal(requests.filter((r) => noteIds.has(r.webContentsId) && r.url.includes("/api/state")).length, 0, "notes must not poll the planner");
  const target = noteWindows.find((w) => new URL(w.webContents.getURL()).pathname.endsWith(`/${performanceTasks[0].id}`));
  const started = Date.now();
  assert.equal(await click(target, "Mark as done"), true);
  await until(async () => (await body(target)).includes("Reopen task"), "completion with 46 notes");
  const elapsed = Date.now() - started;
  assert.ok(requests.some((r) => r.webContentsId === target.webContents.id && r.method === "POST"), "capture the actual renderer action");
  const changedVersions = await readVersions();
  assert.equal(changedVersions.filter((v, i) => v.version !== initialVersions[i].version).length, 1);
  many.updateVersions("local", changedVersions);
  await sleep(1500);
  assert.equal(requests.filter((r) => noteIds.has(r.webContentsId) && r.webContentsId !== target.webContents.id && r.url.includes("/floating/task/")).length, 0,
    "completing one task must not refresh the other 45");
  console.log(`PASS: 46 real notes, zero renderer state polls, only the changed task refreshed, completion ${elapsed} ms (local fixture)`);
  many.keepScope(null);
  clearInterval(notePoll);
  console.log(`Artifacts: ${path.join(root, "dist")}`);
  console.log(`Fixture: ${temp}`);
  planner.destroy();
  db.close();
  child.stdin.end();
  child.kill();
  app.exit(0);
} catch (error) {
  clearInterval(notePoll);
  console.error(error);
  console.error(`Fixture: ${temp}`);
  for (const window of BrowserWindow.getAllWindows()) {
    try { console.error(await body(window)); } catch { /* Closed. */ }
  }
  child.stdin.end();
  child.kill();
  app.exit(1);
}
});
