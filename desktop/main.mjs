// PacedMind desktop app. Runs the built Next.js server (server/server.js) with Electron's own Node,
// shows it in a window and keeps running in the tray (the menu bar on macOS), so agents can still
// report back after the window is closed. Built and installed by scripts/build-desktop.mjs.
import { app, BrowserWindow, Menu, Notification, Tray, dialog, ipcMain, nativeImage, nativeTheme, safeStorage, screen, session, shell } from "electron";
import { spawn } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createTaskWindows } from "./task-windows.mjs";
import { registerTaskNoteControls } from "./task-note-controls.mjs";

const PORT = 4319;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const WINDOWS = process.platform === "win32";
const MAC = process.platform === "darwin";
const APP_ID = "Organizer.Desktop"; // Keep the existing Windows identity and notification grouping.
const ICON = path.join(import.meta.dirname, "icon.ico");
const ICON_PNG = path.join(import.meta.dirname, "icon.png");
// Black on clear with "Template" in its name, so macOS tints it for a light or dark menu bar.
const TRAY_TEMPLATE = path.join(import.meta.dirname, "trayTemplate.png");
const SERVER_DIR = path.join(import.meta.dirname, "server");
const THEME_COLORS = {
  dark: { background: "#010101", symbol: "#a1a1a8", line: "#121214" },
  light: { background: "#f5f5f6", symbol: "#61616e", line: "#e3e3e8" },
};

// Preserve the installed app's database, window state and browser session across the rebrand.
const profile = path.join(app.getPath("appData"), "Organizer");
fs.mkdirSync(profile, { recursive: true });
app.setPath("userData", profile);
app.setPath("sessionData", profile);

// Claude and Codex are MSIX apps: what they start sees new files under %APPDATA% redirected into their own
// folder in %LOCALAPPDATA%\Packages, so PacedMind would open, or half-write, a separate copy of the data.
// Paths look the same from inside, even through realpath, so write a file and look for it there by file
// ID. Returns that app's name ("Claude", "OpenAI.Codex"), or null when started normally.
function sandboxApp() {
  const packages = path.join(process.env.LOCALAPPDATA ?? "", "Packages");
  if (process.platform !== "win32" || !process.env.LOCALAPPDATA || !fs.existsSync(packages)) return null;
  const probe = path.join(profile, `sandbox-probe-${process.pid}`);
  fs.writeFileSync(probe, "");
  try {
    const { dev, ino } = fs.statSync(probe, { bigint: true });
    for (const name of fs.readdirSync(packages)) {
      try {
        const copy = fs.statSync(path.join(packages, name, "LocalCache", "Roaming", "Organizer", path.basename(probe)), { bigint: true, throwIfNoEntry: false });
        if (copy && copy.ino === ino && copy.dev === dev) return name.split("_")[0];
      } catch {
        // A package folder we can't read isn't where the probe went.
      }
    }
    return null;
  } finally {
    fs.rmSync(probe, { force: true });
  }
}
const sandbox = sandboxApp();

// A content-specific path lets Windows refresh icons without clearing its global cache. It lives next to
// the exe, not in the profile, because Explorer can't see those redirected folders. Updates replace it.
// Windows only: on macOS a file written into the app bundle would break its signature.
let shortcutIcon = null;
if (WINDOWS) {
  const iconBytes = fs.readFileSync(ICON);
  shortcutIcon = path.join(path.dirname(process.execPath), `pacedmind-${createHash("sha256").update(iconBytes).digest("hex").slice(0, 12)}.ico`);
  if (!fs.existsSync(shortcutIcon)) fs.writeFileSync(shortcutIcon, iconBytes);
}

let win = null;
let tray = null;
let server = null;
let quitting = false;
let serverReady = false;
let hidden = process.argv.includes("--hidden");
const notifications = new Set();

const dataDir = () => path.join(app.getPath("userData"), "data");

/*
 * Keys between this process and the server it starts (see src/server/ui-key.ts and secure-file.ts):
 * - The window key, new every run: only this app's window (a cookie) and this process (a header) may use
 *   the server's pages and actions, not other programs on the computer or the agents it starts.
 * - The data key, kept in the OS keychain (safeStorage: DPAPI on Windows), encrypts the server's secrets on
 *   disk: the account's session, MCP tokens, agent commands and project folders.
 * Both reach the server as environment variables, which it keeps out of agent terminals.
 */
const UI_KEY = randomBytes(32).toString("base64url");
const UI_COOKIE = "pm_ui";
const UI_HEADER = "x-pacedmind-ui";

function dataKey() {
  if (!safeStorage.isEncryptionAvailable()) return null;
  const file = path.join(dataDir(), "data-key.bin");
  try {
    return safeStorage.decryptString(fs.readFileSync(file));
  } catch {
    if (fs.existsSync(file)) {
      // A key we can't read (another Windows user's, or a changed keychain) would lock the old files for good.
      fs.renameSync(file, `${file}.unreadable-${Date.now()}`);
    }
  }
  const key = randomBytes(32).toString("base64");
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(file, safeStorage.encryptString(key));
  return key;
}
const logFile = () => path.join(app.getPath("logs"), "server.log");
const stateFile = () => path.join(app.getPath("userData"), "window-state.json");
// On Windows the login item starts the exe with --hidden; macOS has its own login items for the app.
const loginArgs = WINDOWS ? { name: "Organizer", path: process.execPath, args: ["--hidden"] } : {};

/* ---------- small helpers ---------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(pathname) {
  return new Promise((resolve) => {
    const req = http.get(`${ORIGIN}${pathname}`, { timeout: 1500, headers: { [UI_HEADER]: UI_KEY } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          resolve(res.statusCode === 200 ? JSON.parse(body) : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
  });
}

function postJson(pathname, body) {
  return new Promise((resolve) => {
    const req = http.request(`${ORIGIN}${pathname}`, {
      method: "POST", timeout: 10_000, headers: { [UI_HEADER]: UI_KEY, "Content-Type": "application/json" },
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { text += c; });
      res.on("end", () => {
        try { resolve(res.statusCode === 200 ? JSON.parse(text) : null); } catch { resolve(null); }
      });
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
    req.end(JSON.stringify(body));
  });
}

/** Whether the server on the port is the one this app started: only it can sign a random value with this run's key. */
async function isOurServer() {
  const nonce = randomBytes(16).toString("hex");
  const answer = await getJson(`/api/health?proof=${nonce}`);
  return !!answer && answer.proof === createHmac("sha256", UI_KEY).update(nonce).digest("hex");
}

const sameOrigin = (url) => {
  try {
    return new URL(url).origin === ORIGIN;
  } catch {
    return false;
  }
};

function readState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), "utf8"));
  } catch {
    return {};
  }
}

function writeState(patch) {
  try {
    fs.writeFileSync(stateFile(), JSON.stringify({ ...readState(), ...patch }, null, 2));
  } catch {
    // Not worth failing over.
  }
}

function openOutside(url) {
  if (/^(https?|mailto):/i.test(url)) shell.openExternal(url);
}

let activeTheme = readState().theme === "light" ? "light" : "dark";

const taskWindows = createTaskWindows({
  BrowserWindow, screen, origin: ORIGIN, preload: path.join(import.meta.dirname, "preload.cjs"), icon: ICON,
  theme: () => ({ name: activeTheme, ...THEME_COLORS[activeTheme] }), showMain: showWindow,
  preferredDisplay: (scope) => readState().taskNoteDisplays?.[scope] ?? null,
  rememberDisplay: (scope, display) => writeState({ taskNoteDisplays: { ...readState().taskNoteDisplays, [scope]: display } }),
  onChange: (state) => { if (win && !win.isDestroyed()) win.webContents.send("pacedmind:task-notes-changed", state); },
});
registerTaskNoteControls({ ipcMain, taskWindows, planner: () => win, origin: ORIGIN,
  readScope: async () => (await getJson("/api/state"))?.floatingScope,
});

let choosingNoteDisplay = false;
ipcMain.handle("pacedmind:float-task", async (event, id, scope, createdAt) => {
  if (!serverReady || !win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) return false;
  if (!sameOrigin(event.senderFrame.url)) return false;
  const state = await getJson("/api/state");
  if (choosingNoteDisplay || state?.floatingScope !== scope) return false;
  const snapshot = taskWindows.displays(scope);
  let display = snapshot.displays.find((d) => d.id === snapshot.defaultDisplay)?.id;
  let remember = false;
  if (!display && snapshot.displays.length === 1 && !snapshot.defaultDisplay) display = snapshot.displays[0].id;
  if (!display) {
    choosingNoteDisplay = true;
    try {
      const answer = await dialog.showMessageBox(win, {
        type: "question", title: "Task notes", message: "Which display should show this task note?",
        detail: (snapshot.defaultDisplay ? "The remembered display is disconnected.\n\n" : "") + snapshot.displays.map((d, i) => `${i + 1}. ${d.label} · ${d.width} × ${d.height}${d.primary ? " (primary)" : ""} · position ${d.x}, ${d.y}`).join("\n"),
        buttons: [...snapshot.displays.map((_, i) => `Display ${i + 1}`), "Cancel"],
        cancelId: snapshot.displays.length, defaultId: Math.max(0, snapshot.displays.findIndex((d) => d.primary)),
        checkboxLabel: "Always use this display for task notes on this computer", checkboxChecked: false,
      });
      if (answer.response === snapshot.displays.length) return { ok: true }; // Cancel is not an error.
      display = snapshot.displays[answer.response]?.id;
      remember = answer.checkboxChecked;
    } finally { choosingNoteDisplay = false; }
  }
  if ((await getJson("/api/state"))?.floatingScope !== scope) return false;
  const result = taskWindows.show(id, scope, createdAt, display, remember);
  return { ok: result.status === "opened", error: result.note };
});
ipcMain.handle("pacedmind:close-task-note", (event) => taskWindows.close(event));
ipcMain.handle("pacedmind:show-floating-task", (event, href) => taskWindows.showInPlanner(event, href));

ipcMain.on("pacedmind:set-theme", (event, theme) => {
  if ((theme !== "dark" && theme !== "light") || !win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) return;
  try { if (new URL(event.senderFrame.url).origin !== ORIGIN) return; } catch { return; }
  activeTheme = theme;
  const colors = THEME_COLORS[theme];
  nativeTheme.themeSource = theme;
  win.setBackgroundColor(colors.background);
  taskWindows.setBackgroundColor(colors.background);
  if (process.platform === "win32") win.setTitleBarOverlay({ color: colors.background, symbolColor: colors.symbol, height: 40 });
  if (readState().theme !== theme) writeState({ theme });
});

// Folders are picked in the system's dialog, over the window, never typed: only for the app's own page.
ipcMain.handle("pacedmind:pick-folder", async (event, near) => {
  if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) return null;
  try { if (new URL(event.senderFrame.url).origin !== ORIGIN) return null; } catch { return null; }
  let defaultPath;
  try { if (typeof near === "string" && path.isAbsolute(near) && fs.statSync(near).isDirectory()) defaultPath = near; } catch { /* gone */ }
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: "Choose a folder", buttonLabel: "Use this folder", defaultPath,
    properties: ["openDirectory", "createDirectory", "dontAddToRecent"],
  });
  return canceled ? null : filePaths[0] ?? null;
});

const wordmark = fs.readFileSync(path.join(SERVER_DIR, "public", "brand", "pacedmind-wordmark.png")).toString("base64");
const loadingArrows = ["back", "forward"].map((direction) => `<button disabled aria-label="Go ${direction}" style="-webkit-app-region:no-drag;display:grid;place-items:center;width:32px;height:32px;padding:0;border:0;background:none;color:inherit;opacity:0.3"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="transform:rotate(${direction === "back" ? 180 : 0}deg)"><path d="M5 12h14M13 6l6 6-6 6"/></svg></button>`).join("");
const page = (text) =>
  `data:text/html;charset=utf-8,${encodeURIComponent(
    `<!doctype html><title>PacedMind</title><body style="margin:0;height:100vh;display:flex;flex-direction:column;background:${THEME_COLORS[activeTheme].background};color:${THEME_COLORS[activeTheme].symbol};font:13px 'Segoe UI',system-ui,sans-serif"><header style="-webkit-app-region:drag;flex-shrink:0;box-sizing:border-box;height:calc(max(40px,env(titlebar-area-height,40px)) + 1px);border-bottom:1px solid ${THEME_COLORS[activeTheme].line};user-select:none"><div style="height:100%;display:flex;align-items:center;box-sizing:border-box;margin-left:env(titlebar-area-x,0px);width:env(titlebar-area-width,100%);padding:0 8px"><div style="display:flex;gap:2px">${loadingArrows}</div><div style="position:relative;margin-left:8px;width:112px;aspect-ratio:1819/298;overflow:hidden;mix-blend-mode:${activeTheme === "light" ? "multiply" : "screen"}"><img alt="PacedMind" src="data:image/png;base64,${wordmark}" style="position:absolute;width:116.8774%;max-width:none;left:-9.5107%;top:-85.5705%;filter:grayscale(1) ${activeTheme === "light" ? "" : "invert(1)"}"></div></div></header><main style="flex:1;display:grid;place-items:center">${text}</main></body>`,
  )}`;

/* ---------- the server ---------- */

async function startServer() {
  // Something already answers on the port. Ours (a restart) can prove it; a server left behind by a crash has
  // another key and exits once it notices its parent is gone; anything else must never get this window.
  for (let i = 0; i < 100 && (await getJson("/api/health")); i++) {
    if (await isOurServer()) return;
    await sleep(100);
  }
  if (await getJson("/api/health")) throw new Error(`Another program answers on port ${PORT}.`);

  fs.mkdirSync(dataDir(), { recursive: true });
  fs.mkdirSync(path.dirname(logFile()), { recursive: true });
  try {
    if (fs.statSync(logFile()).size > 5_000_000) fs.rmSync(logFile());
  } catch {
    // No log yet.
  }
  const log = fs.openSync(logFile(), "a");
  fs.writeSync(log, `\n--- ${new Date().toISOString()} starting PacedMind ${app.getVersion()}\n`);
  const dataKeyValue = dataKey();
  if (!dataKeyValue) fs.writeSync(log, "The OS keychain isn't available: secrets on disk are not encrypted.\n");

  const child = spawn(process.execPath, [path.join(SERVER_DIR, "server.js")], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      NODE_ENV: "production",
      PORT: String(PORT),
      HOSTNAME: "127.0.0.1",
      ORGANIZER_DB: path.join(dataDir(), "organizer.db"),
      ORGANIZER_SEED: "empty",
      ORGANIZER_EXIT_WITH_PARENT: "1",
      ORGANIZER_UI_SECRET: UI_KEY,
      ...(dataKeyValue ? { ORGANIZER_DATA_KEY: dataKeyValue } : {}),
      NEXT_TELEMETRY_DISABLED: "1",
    },
    // stdin stays open as a lifeline: the server exits when it closes (see src/instrumentation.ts).
    stdio: ["pipe", log, log],
    windowsHide: true,
  });
  fs.closeSync(log);
  server = child;
  let exited = false;
  child.on("exit", (code) => {
    exited = true;
    if (server === child) server = null;
    if (!quitting && serverReady) serverDied(code);
  });

  for (let i = 0; i < 300 && !exited; i++) {
    if (await isOurServer()) return;
    await sleep(100);
  }
  throw new Error(exited ? "The server stopped while starting." : "The server did not answer within 30 seconds.");
}

function stopServer() {
  if (server) server.kill();
  server = null;
}

async function serverDied(code) {
  serverReady = false;
  const { response } = await dialog.showMessageBox({
    type: "error",
    title: "PacedMind",
    message: "PacedMind's server stopped.",
    detail: `Exit code ${code}. Details are in ${logFile()}`,
    buttons: ["Restart", "Open log", "Quit"],
    defaultId: 0,
  });
  if (response === 1) shell.openPath(logFile());
  if (response === 2) return quit();
  boot();
}

/* ---------- window ---------- */

function visibleBounds(b) {
  if (!b || typeof b.x !== "number") return undefined;
  const area = screen.getDisplayMatching(b).workArea;
  const overlaps = b.x < area.x + area.width - 80 && b.x + b.width > area.x + 80 && b.y < area.y + area.height - 60 && b.y >= area.y - 10;
  return overlaps ? b : undefined;
}

function createWindow() {
  const saved = readState();
  const bounds = visibleBounds(saved.bounds);
  win = new BrowserWindow({
    width: bounds?.width ?? 1440,
    height: bounds?.height ?? 900,
    x: bounds?.x,
    y: bounds?.y,
    minWidth: 960,
    minHeight: 600,
    title: "PacedMind",
    ...(WINDOWS ? { icon: ICON } : {}), // macOS takes the icon from the app bundle.
    backgroundColor: THEME_COLORS[activeTheme].background,
    ...(WINDOWS ? {
      titleBarStyle: "hidden",
      titleBarOverlay: { color: THEME_COLORS[activeTheme].background, symbolColor: THEME_COLORS[activeTheme].symbol, height: 40 },
    } : {}),
    // The traffic lights sit in the app's 40 px header, and the overlay tells its CSS where they end
    // (env(titlebar-area-x) in src/app/globals.css).
    ...(MAC ? { titleBarStyle: "hidden", titleBarOverlay: true, trafficLightPosition: { x: 14, y: 13 } } : {}),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true, sandbox: true, spellcheck: true,
      preload: path.join(import.meta.dirname, "preload.cjs"),
      additionalArguments: [`--pacedmind-theme=${activeTheme}`],
    },
  });
  win.setMenuBarVisibility(false);
  taskWindows.bindPlanner(win);
  if (process.platform === "win32") win.setAppDetails({
    appId: APP_ID, appIconPath: shortcutIcon, appIconIndex: 0,
    relaunchCommand: `"${process.execPath}"`, relaunchDisplayName: "PacedMind",
  });
  // maximize() also shows the window, so wait until it should appear (not at all with --hidden).
  win.once("show", () => saved.maximized && win.maximize());
  win.once("ready-to-show", () => {
    if (!hidden) win.show();
    hidden = false; // Later windows (the Dock, a notification, the tray) always show.
  });
  win.on("close", (e) => {
    writeState({ bounds: win.getNormalBounds(), maximized: win.isMaximized() });
    if (quitting) return;
    e.preventDefault();
    win.hide();
    if (!readState().trayHintShown) {
      writeState({ trayHintShown: true });
      if (WINDOWS) {
        tray?.displayBalloon({
          iconType: "info",
          title: "PacedMind is still running",
          content: "It stays in the tray so agents can report back. Right-click the icon to quit.",
        });
      } else if (Notification.isSupported()) {
        new Notification({
          title: "PacedMind is still running",
          body: "It stays in the menu bar so agents can report back. Quit it from the menu bar icon or with ⌘Q.",
        }).show();
      }
    }
  });
  win.on("closed", () => (win = null));
  // Windows is shutting down or signing out: let the window close.
  win.on("session-end", () => {
    quitting = true;
    stopServer();
  });
  // Mouse back and forward buttons, and on macOS a swipe on the trackpad.
  win.on("app-command", (_e, cmd) => {
    const nav = win.webContents.navigationHistory;
    if (cmd === "browser-backward" && nav.canGoBack()) nav.goBack();
    if (cmd === "browser-forward" && nav.canGoForward()) nav.goForward();
  });
  win.on("swipe", (_e, direction) => {
    const nav = win.webContents.navigationHistory;
    if (direction === "right" && nav.canGoBack()) nav.goBack();
    if (direction === "left" && nav.canGoForward()) nav.goForward();
  });

  const wc = win.webContents;
  wc.setWindowOpenHandler(({ url }) => {
    // Ctrl/⌘-click or a middle click on one of the app's own links: a browser has no window key, so it opens here.
    if (sameOrigin(url)) win.loadURL(url);
    else openOutside(url);
    return { action: "deny" };
  });
  wc.on("will-navigate", (e, url) => {
    // Exactly this origin: "127.0.0.1:43190" or "127.0.0.1:4319@elsewhere" also start with it.
    if (!sameOrigin(url) && !url.startsWith("data:")) {
      e.preventDefault();
      openOutside(url);
    }
  });

  win.loadURL(serverReady ? `${ORIGIN}/today` : page("Starting PacedMind…"));
}

function showWindow(url) {
  if (!win) createWindow();
  if (url && serverReady) win.loadURL(url);
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/* ---------- tray, menu, notifications ---------- */

function trayMenu() {
  const startsAtLogin = app.getLoginItemSettings(loginArgs).openAtLogin;
  return Menu.buildFromTemplate([
    { label: "Open PacedMind", click: () => showWindow() },
    { type: "separator" },
    {
      label: MAC ? "Open at Login" : "Start with Windows",
      type: "checkbox",
      checked: startsAtLogin,
      click: (item) => {
        app.setLoginItemSettings({ ...loginArgs, openAtLogin: item.checked });
        tray.setContextMenu(trayMenu());
      },
    },
    { label: "Open data folder", click: () => shell.openPath(dataDir()) },
    { label: "Open server log", click: () => shell.openPath(logFile()) },
    { type: "separator" },
    { label: "Quit PacedMind", click: quit },
  ]);
}

function createTray() {
  const image = MAC ? nativeImage.createFromPath(TRAY_TEMPLATE) : ICON;
  if (MAC) image.setTemplateImage(true);
  tray = new Tray(image);
  tray.setToolTip("PacedMind");
  tray.setContextMenu(trayMenu());
  // A click on a macOS menu bar icon opens its menu, which has Open PacedMind.
  if (!MAC) tray.on("click", () => showWindow());
}

function appMenu() {
  // Windows hides the menu bar, so there it only provides the keyboard shortcuts. macOS shows it,
  // with the app menu (About, Hide, Quit) and the Window menu (Minimize, Close) of every Mac app.
  const nav = () => win?.webContents.navigationHistory;
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      MAC ? { role: "appMenu" } : {
        label: "PacedMind",
        submenu: [
          { label: "Close window", accelerator: "CmdOrCtrl+W", click: () => BrowserWindow.getFocusedWindow()?.close() },
          { label: "Quit PacedMind", accelerator: "CmdOrCtrl+Q", click: quit },
        ],
      },
      { role: "editMenu" },
      {
        label: "View",
        submenu: [
          { role: "reload" },
          { role: "forceReload" },
          { role: "toggleDevTools" },
          { type: "separator" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { type: "separator" },
          { role: "togglefullscreen" },
          { label: "Back", accelerator: MAC ? "Cmd+[" : "Alt+Left", click: () => nav()?.canGoBack() && nav().goBack() },
          { label: "Forward", accelerator: MAC ? "Cmd+]" : "Alt+Right", click: () => nav()?.canGoForward() && nav().goForward() },
        ],
      },
      ...(MAC ? [{ role: "windowMenu" }] : []),
    ]),
  );
}

/**
 * Watches for sessions that finished, sessions whose agent waits for you in its terminal and sessions waiting to be
 * allowed, tells you with a notification and keeps the tray tooltip current.
 */
function watchSessions() {
  let known = null;
  let heard = null;
  let asked = new Set();
  let checking = false;
  const check = async () => {
    if (!serverReady || checking) return;
    checking = true;
    try {
      const state = await getJson("/api/state");
      if (!state) return;
      taskWindows.keepScope(state.floatingScope);
      const waiting = state.waiting ?? [];
      const attention = state.attention ?? [];
      const approvals = state.approvals ?? [];
      if (known) for (const s of waiting) if (!known.has(s.id)) notify(s);
      // Once per event: a session that waits again later tells you again.
      if (heard) for (const s of attention) if (!heard.has(`${s.id}:${s.eventId}`)) notifyAttention(s);
      for (const a of approvals) if (!asked.has(a.id)) notifyApproval(a);
      known = new Set(waiting.map((s) => s.id));
      heard = new Set(attention.map((s) => `${s.id}:${s.eventId}`));
      asked = new Set(approvals.map((a) => a.id));
      const count = waiting.length + attention.length + approvals.length;
      tray?.setToolTip(count ? `PacedMind · ${count} waiting for you` : "PacedMind");
      await syncTaskNotes(state.floatingScope);
    } catch (error) {
      console.error("[PacedMind] Desktop state refresh failed", error);
    } finally { checking = false; }
  };
  check();
  setInterval(check, 5000);
}

let notesScope = null;
const noteResults = new Map();
async function syncTaskNotes(scope) {
  if (notesScope !== scope) { noteResults.clear(); notesScope = scope; }
  if (!scope) return;
  const exchange = async (receive) => {
    const response = await postJson("/api/desktop/task-notes", {
      scope, displays: taskWindows.displays(scope), results: [...noteResults.values()], receive,
      notes: receive ? taskWindows.tasks(scope) : [],
    });
    if (!response) return null;
    for (const id of response.acknowledged ?? []) noteResults.delete(id);
    if (response.scope !== scope) { taskWindows.keepScope(response.scope); noteResults.clear(); return null; }
    taskWindows.updateVersions(scope, response.versions);
    return response;
  };
  const response = await exchange(true);
  if (!response) return;
  for (const r of (response.requests ?? []).slice(0, 24)) {
    if (typeof r.id !== "string" || noteResults.has(r.id)) continue;
    const result = Date.parse(r.expiresAt) > Date.now()
      ? taskWindows.show(r.taskId, scope, r.taskCreatedAt, r.displayId, r.remember)
      : { status: "failed", note: "The request expired before the note could open." };
    noteResults.set(r.id, { id: r.id, ...result });
  }
  if (noteResults.size) await exchange(false);
}

/**
 * What an approval asks, for its notification: to start a session, to resume one, or to send one back to its agent
 * with changes (`kind`, from /api/state). `agent` reads "Claude Code · Terminal".
 */
function approvalTitle(a) {
  if (a.kind === "folder") return `Use a folder for ${a.title}?`;
  const key = a.key ?? "a session";
  if (a.kind === "resume") return /· Cloud$/.test(a.agent ?? "") ? `Pull ${key} in from the cloud?` : `Resume ${key} with ${a.agent}?`;
  if (a.kind === "changes") return `Send ${key} back to ${String(a.agent ?? "its agent").split(" · ")[0]} with changes?`;
  return `Start ${key} with ${a.agent}?`;
}

/** A session asked for over MCP or from elsewhere: nothing starts until you allow it in the window. */
function notifyApproval(a) {
  if (!Notification.isSupported()) return;
  const n = new Notification({
    title: approvalTitle(a),
    body: [a.kind === "folder" ? a.folder : a.title, `Asked by ${a.from}. Open PacedMind to allow or refuse it.`].filter(Boolean).join("\n"),
    icon: ICON_PNG,
  });
  notifications.add(n);
  n.on("click", () => showWindow());
  n.on("close", () => notifications.delete(n));
  n.show();
}

/**
 * A running session whose agent waits for you: its turn ended in its terminal, it asks for your permission, it asked you
 * something, or it stopped at a usage limit.
 */
function notifyAttention(s) {
  if (!Notification.isSupported()) return;
  const who = s.key ?? "A session";
  const title = s.kind === "permission" ? `${who} asks for your permission`
    : s.kind === "question" || s.kind === "input" ? `${who} has a question for you`
    : s.kind === "limit" ? `${who} stopped at a usage limit`
    : s.kind === "capacity" ? `${who}: model at capacity`
    : s.kind === "locked" ? `${who}: conversation open elsewhere`
    : s.kind === "error" ? `${who}: agent stopped on an error`
    : s.kind === "setup" ? `${who}: check agent startup`
    : s.kind === "send_prompt" ? `${who}: send the first message` : `${who} is waiting for you`;
  const n = new Notification({ title, body: [s.title, s.text].filter(Boolean).join("\n"), icon: ICON_PNG });
  notifications.add(n);
  n.on("click", () => showWindow(`${ORIGIN}/sessions?s=${encodeURIComponent(s.id)}`));
  n.on("close", () => notifications.delete(n));
  n.show();
}

function notify(s) {
  if (!Notification.isSupported()) return;
  const who = s.key ?? "A session";
  const asks = s.questions ? ` · ${s.questions === 1 ? "1 question" : `${s.questions} questions`} for you` : "";
  const n = new Notification({
    title: s.outcome === "blocked" ? `${who} is blocked${asks}` : s.outcome === "partial" ? `${who} is partly done${asks}` : `${who} is finished${asks}`,
    body: [s.title, s.note].filter(Boolean).join("\n"),
    icon: ICON_PNG,
  });
  notifications.add(n); // Keep a reference, or the click handler can be garbage collected.
  n.on("click", () => showWindow(`${ORIGIN}/sessions?s=${encodeURIComponent(s.id)}`));
  n.on("close", () => notifications.delete(n));
  n.show();
}

/* ---------- start and stop ---------- */

async function boot() {
  try {
    await startServer();
    // The window's key, as a cookie only this app's window has; it's gone when the app quits.
    await session.defaultSession.cookies.set({ url: ORIGIN, name: UI_COOKIE, value: UI_KEY, httpOnly: true, sameSite: "strict" });
    serverReady = true;
    taskWindows.reload();
    if (win) {
      const window = win;
      await window.loadURL(`${ORIGIN}/today`);
      // The temporary loading page must never become the Back button's destination.
      if (!window.isDestroyed()) window.webContents.navigationHistory.clear();
    }
  } catch (e) {
    const { response } = await dialog.showMessageBox({
      type: "error",
      title: "PacedMind",
      message: "PacedMind could not start.",
      detail: `${e.message}\n\nIs something else using port ${PORT}? Details are in ${logFile()}`,
      buttons: ["Try again", "Open log", "Quit"],
      defaultId: 0,
    });
    if (response === 0) return boot();
    if (response === 1) shell.openPath(logFile());
    quit();
  }
}

function quit() {
  quitting = true;
  stopServer();
  app.quit();
}

/** Start Menu and desktop shortcuts on Windows. A Mac app in Applications needs none. */
function writeShortcuts() {
  if (!WINDOWS) return;
  const options = {
    target: process.execPath,
    cwd: path.dirname(process.execPath),
    description: "Tasks, time blocks and agent sessions",
    icon: shortcutIcon,
    iconIndex: 0,
    appUserModelId: APP_ID, // Needed for Windows notifications.
  };
  const programs = path.join(app.getPath("appData"), "Microsoft", "Windows", "Start Menu", "Programs");
  for (const folder of [programs, app.getPath("desktop")]) {
    const shortcut = path.join(folder, "PacedMind.lnk");
    if (!shell.writeShortcutLink(shortcut, "create", options)) throw new Error(`Could not create ${shortcut}`);
  }
  // Keep existing pins and their arguments; update only pins targeting this app.
  const pinned = path.join(app.getPath("appData"), "Microsoft", "Internet Explorer", "Quick Launch", "User Pinned", "TaskBar");
  if (fs.existsSync(pinned)) for (const name of fs.readdirSync(pinned)) {
    if (!name.toLowerCase().endsWith(".lnk")) continue;
    const file = path.join(pinned, name);
    try {
      const current = shell.readShortcutLink(file);
      if (path.resolve(current.target).toLowerCase() === path.resolve(process.execPath).toLowerCase()) {
        shell.writeShortcutLink(file, "update", { icon: shortcutIcon, iconIndex: 0, appUserModelId: APP_ID });
      }
    } catch {
      // Leave unreadable or unrelated pins alone.
    }
  }
  // Remove only the old shortcuts that actually belong to this installation.
  for (const folder of [programs, app.getPath("desktop")]) {
    const old = path.join(folder, "Organizer.lnk");
    if (!fs.existsSync(old)) continue;
    try {
      if (path.resolve(shell.readShortcutLink(old).target).toLowerCase() === path.resolve(process.execPath).toLowerCase()) {
        fs.rmSync(old);
      }
    } catch {
      // An unrelated or unreadable shortcut is left alone.
    }
  }
}

function removeShortcuts() {
  if (WINDOWS) {
    const programs = path.join(app.getPath("appData"), "Microsoft", "Windows", "Start Menu", "Programs");
    for (const file of [path.join(programs, "PacedMind.lnk"), path.join(app.getPath("desktop"), "PacedMind.lnk")]) {
      fs.rmSync(file, { force: true });
    }
  }
  app.setLoginItemSettings({ ...loginArgs, openAtLogin: false });
}

if (WINDOWS) app.setAppUserModelId(APP_ID);

if (process.argv.includes("--install")) {
  app.whenReady().then(() => {
    writeShortcuts();
    app.quit();
  }).catch((error) => {
    console.error(error);
    app.exit(1);
  });
} else if (process.argv.includes("--uninstall")) {
  removeShortcuts();
  app.exit(0);
} else if (!app.requestSingleInstanceLock()) {
  // PacedMind is already running: it gets our arguments through "second-instance".
  app.exit(0);
} else if (process.argv.includes("--quit")) {
  // Asked to quit, but nothing was running.
  app.exit(0);
} else if (sandbox) {
  // A PacedMind that was already running got focus above. Release the lock so the Start Menu works
  // while this dialog is still open.
  app.releaseSingleInstanceLock();
  app.whenReady().then(() => {
    dialog.showMessageBoxSync({
      type: "warning",
      title: "PacedMind",
      message: "Open PacedMind from the Start Menu.",
      detail: `It was started from inside ${sandbox}, which keeps its own copy of AppData for the programs it starts. PacedMind would open a separate database there.`,
    });
    app.exit(1);
  });
} else {
  app.on("second-instance", (_e, argv) => (argv.includes("--quit") ? quit() : showWindow()));
  app.on("window-all-closed", () => {
    // Stay in the tray.
  });
  // macOS: clicking the Dock icon, or opening the app again from Finder, brings the window back.
  app.on("activate", (_e, hasVisibleWindows) => {
    if (!hasVisibleWindows || !win?.isVisible()) showWindow();
  });
  app.on("before-quit", () => {
    quitting = true;
    stopServer();
  });
  app.whenReady().then(() => {
    // Opened as a login item: stay in the menu bar, like the Windows login item's --hidden.
    if (MAC && app.getLoginItemSettings().wasOpenedAtLogin) hidden = true;
    nativeTheme.themeSource = activeTheme;
    session.defaultSession.setPermissionRequestHandler((_wc, permission, done) => done(permission === "clipboard-sanitized-write"));
    appMenu();
    createTray();
    createWindow();
    boot().then(watchSessions);
  });
}
