import { noteCapacity, noteLayout } from "./task-note-layout.mjs";

// Independent task notes: no parent window, so hiding the planner leaves them on screen.
export function createTaskWindows({ BrowserWindow, screen, origin, preload, theme, icon, showMain,
  preferredDisplay = () => null, rememberDisplay = () => {}, platform = process.platform }) {
  const notes = new Map();
  const validScope = (scope) => typeof scope === "string" && /^(local|[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})$/i.test(scope);

  function senderNote(event) {
    for (const note of notes.values()) {
      const wc = note.window.webContents;
      if (event.sender === wc && event.senderFrame === wc.mainFrame && event.senderFrame?.url === note.url) return note;
    }
    return null;
  }

  const displayOf = (note) => String(screen.getDisplayMatching(note.window.getBounds()).id);
  const onDisplay = (id, scope) => [...notes.values()].filter((n) => n.scope === scope && displayOf(n) === id);

  const api = {
    displays(scope) {
      const primary = screen.getPrimaryDisplay().id;
      const saved = preferredDisplay(scope);
      return {
        displays: screen.getAllDisplays().map((d) => ({
          id: String(d.id), label: (d.label || `Display ${d.id}`).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 100),
          ...d.workArea, primary: d.id === primary, capacity: noteCapacity(d.workArea), openCount: onDisplay(String(d.id), scope).length,
        })),
        defaultDisplay: typeof saved === "string" && /^-?\d{1,20}$/.test(saved) ? saved : null, updatedAt: new Date().toISOString(),
      };
    },
    // Direct clicks may use the cursor's screen. Agent requests always name a screen chosen from displays().
    open(id, scope, createdAt) {
      const displayId = preferredDisplay(scope) ?? String(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id);
      const ok = api.show(id, scope, createdAt, displayId).status === "opened";
      if (ok) notes.get(`${scope}:${id}`)?.window.focus();
      return ok;
    },
    show(id, scope, createdAt, displayId, remember = false) {
      if (!Number.isSafeInteger(id) || id < 1 || !validScope(scope) || typeof createdAt !== "string" ||
          !/^\d{4}-\d{2}-\d{2}T[\d:.+Z-]{5,25}$/.test(createdAt) || typeof remember !== "boolean") return { status: "failed", note: "Invalid task note." };
      const display = screen.getAllDisplays().find((d) => String(d.id) === displayId);
      if (!display) return { status: "failed", note: "That display is no longer connected. Ask the user to choose a display again." };
      const key = `${scope}:${id}`;
      const existing = notes.get(key);
      const group = onDisplay(displayId, scope).filter((n) => n !== existing);
      const layout = noteLayout(display.workArea, group.length + 1);
      if (!layout) return { status: "failed", note: "This display has no room for another readable note. Ask the user to close a note or choose another display." };
      const place = (note) => {
        [...group, note].forEach((n, i) => n.window.setBounds(layout[i]));
        if (remember) rememberDisplay(scope, displayId);
      };
      if (existing && existing.createdAt === createdAt) {
        if (existing.window.isMinimized()) existing.window.restore();
        place(existing);
        existing.window.showInactive();
        return { status: "opened", note: "Task note shown and arranged on the selected display." };
      }
      existing?.window.close();
      const colors = theme();
      const window = new BrowserWindow({
        ...layout.at(-1), minWidth: 280, minHeight: 200,
        title: "PacedMind · Task note", frame: false, alwaysOnTop: true,
        resizable: true, maximizable: false, fullscreenable: false,
        skipTaskbar: true, autoHideMenuBar: true, show: false,
        backgroundColor: colors.background,
        ...(platform === "win32" ? { icon } : {}),
        webPreferences: {
          contextIsolation: true, sandbox: true, nodeIntegration: false,
          backgroundThrottling: false, preload,
          additionalArguments: [`--pacedmind-theme=${colors.name}`],
        },
      });
      const url = `${origin}/floating/task/${id}?${new URLSearchParams({ scope, createdAt })}`;
      const note = { window, url, scope, createdAt };
      notes.set(key, note);
      place(note);
      window.setMenuBarVisibility(false);
      if (platform === "darwin") window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      window.once("ready-to-show", () => { if (!window.isDestroyed()) window.showInactive(); });
      window.on("closed", () => { if (notes.get(key) === note) notes.delete(key); });
      // A note never becomes a browser or a second full planner. Its buttons use narrow IPC calls.
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      const stayHere = (event, target) => { if (target !== url) event.preventDefault(); };
      window.webContents.on("will-navigate", stayHere);
      window.webContents.on("will-redirect", stayHere);
      void window.loadURL(url).catch(() => { if (!window.isDestroyed()) window.close(); });
      return { status: "opened", note: "Task note opened and arranged on the selected display." };
    },
    close(event) {
      const note = senderNote(event);
      if (!note) return false;
      note.window.close();
      return true;
    },
    showInPlanner(event, href) {
      if (!senderNote(event) || typeof href !== "string") return false;
      // Only the planner destinations produced by the task page; never a URL supplied by task text.
      if (!/^\/(?:today|inbox|project\/[\w-]+|area\/[\w-]+\/todos)(?:\?task=[A-Z0-9]+-\d+)?$/.test(href)) return false;
      showMain(`${origin}${href}`);
      return true;
    },
    keepScope(scope) {
      for (const note of notes.values()) if (note.scope !== scope) note.window.close();
    },
    setBackgroundColor(color) {
      for (const note of notes.values()) note.window.setBackgroundColor(color);
    },
    reload() {
      for (const note of notes.values()) note.window.webContents.reload();
    },
  };
  return api;
}
