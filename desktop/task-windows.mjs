import { noteCapacity, noteLayout } from "./task-note-layout.mjs";
import { animationDelays, importance, layoutSettings, normalRegion, pixelRegion, refOf, validRegion, workspaceLayout } from "./task-note-workspace.mjs";
import { createNoteMotion } from "./task-note-motion.mjs";

// Independent task notes, with shared visibility controls in the planner.
export function createTaskWindows({ BrowserWindow, screen, origin, preload, theme, icon, showMain,
  preferredDisplay = () => null, rememberDisplay = () => {}, onChange = () => {}, platform = process.platform,
  readLayout = () => null, writeLayout = () => {}, reduceMotion = () => false, animate = true }) {
  const notes = new Map();
  const motion = createNoteMotion({ enabled: () => animate && !reduceMotion() });
  const configs = new Map();
  const layoutTimers = new Map();
  const config = (scope, display) => {
    const key = `${scope}:${display}`;
    if (!configs.has(key)) configs.set(key, layoutSettings(readLayout(scope, display)));
    return configs.get(key);
  };
  const save = (scope, display, settings, resetPositions = false) => { configs.set(`${scope}:${display}`, settings); writeLayout(scope, display, { ...settings, positions: resetPositions ? {} : readLayout(scope, display)?.positions ?? {} }); };
  const delayFor = (group) => {
    const result = new Map();
    for (const note of group) {
      const same = group.filter(n => n.scope === note.scope && displayOf(n) === displayOf(note));
      if (!result.has(note)) for (const [n, delay] of animationDelays(same, config(note.scope, displayOf(note)).animation)) result.set(n, delay);
    }
    return result;
  };
  const validScope = (scope) => typeof scope === "string" && /^(local|[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})$/i.test(scope);

  function senderNote(event) {
    for (const note of notes.values()) {
      const wc = note.window.webContents;
      if (event.sender === wc && event.senderFrame === wc.mainFrame && event.senderFrame?.url === note.url) return note;
    }
    return null;
  }

  const displayOf = (note) => note.displayId ?? String(screen.getDisplayMatching(note.window.getBounds()).id);
  const onDisplay = (id, scope) => [...notes.values()].filter((n) => n.scope === scope && displayOf(n) === id);

  function showOnTop(window) {
    if (window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    // Reassert this for existing windows too. showInactive alone can leave a note behind
    // other windows; moveTop raises it without taking keyboard focus from the user's app.
    window.setAlwaysOnTop(true);
    window.showInactive();
    window.moveTop();
  }
  function publish(note) {
    if (note.window.isDestroyed()) return;
    const settings = config(note.scope, displayOf(note));
    note.window.webContents.send("pacedmind:task-note-style", { size: settings.size, emphasis: settings.emphasis ? importance(note.meta) : "normal" });
  }
  function reveal(note, delay) {
    if (!note.ready || note.hidden) return;
    delay ??= delayFor(onDisplay(displayOf(note), note.scope)).get(note) ?? 0;
    if (!note.window.isVisible?.()) note.window.setOpacity?.(animate && config(note.scope, displayOf(note)).animation !== "none" && !reduceMotion() && !note.reducedMotion ? 0 : 1);
    showOnTop(note.window);
    motion.run(note, { bounds: note.targetBounds, opacity: 1, delay, immediate: config(note.scope, displayOf(note)).animation === "none" });
  }
  function arrange(scope, displayId, settings = config(scope, displayId), animated = true, restore = false) {
    const display = screen.getAllDisplays().find(d => String(d.id) === displayId);
    if (!display) return null;
    const group = onDisplay(displayId, scope), plan = workspaceLayout(display.workArea, group, settings);
    if (!plan) return null;
    const delays = animationDelays(group, settings.animation);
    for (const placement of plan.placements) {
      const { note } = placement;
      let { bounds } = placement;
      const saved = restore ? readLayout(scope, displayId)?.positions?.[refOf(note)] : null;
      if (validRegion(saved)) {
        const previous = pixelRegion(display.workArea, saved);
        if (previous.width >= 280 && previous.height >= 200) bounds = previous;
      }
      note.targetBounds = bounds;
      motion.run(note, { bounds, opacity: note.hidden ? 0 : 1, delay: delays.get(note), immediate: !animated || note.hidden || settings.animation === "none" });
      publish(note);
    }
    return plan;
  }

  const api = {
    state() {
      return { count: notes.size, visible: [...notes.values()].some((note) => !note.hidden) };
    },
    bindPlanner(window) {
      // Close-to-tray must hide notes too, including ones still loading.
      window.on("close", () => api.hideAll(true));
    },
    hideAll(immediate = false) {
      const delays = delayFor([...notes.values()]);
      for (const note of notes.values()) {
        note.hidden = true;
        motion.run(note, { opacity: 0, delay: delays.get(note), immediate: immediate || config(note.scope, displayOf(note)).animation === "none", done: () => { if (note.hidden) note.window.hide(); } });
      }
      onChange(api.state());
      return api.state();
    },
    toggle() {
      if (api.state().visible) return api.hideAll();
      const delays = delayFor([...notes.values()]);
      for (const note of notes.values()) {
        note.hidden = false;
        reveal(note, delays.get(note));
      }
      onChange(api.state());
      return api.state();
    },
    tasks(scope) {
      return [...notes.values()].filter((n) => n.scope === scope).map(({ id, createdAt }) => ({ id, createdAt }));
    },
    workspace(scope) {
      const snapshot = api.displays(scope);
      return { scope, defaultDisplay: snapshot.defaultDisplay, displays: snapshot.displays.map(d => {
        const settings = config(scope, d.id), group = onDisplay(d.id, scope);
        const plan = workspaceLayout(d, group, settings);
        return { ...d, settings, groups: plan?.groups ?? [], compact: !!plan?.compact,
          notes: group.map(n => ({ ref: refOf(n), title: n.meta?.title ?? `Task ${n.id}`, ...normalRegion(d, n.targetBounds ?? n.window.getBounds()) })) };
      }) };
    },
    configure(scope, input) {
      const display = screen.getAllDisplays().find(d => String(d.id) === input?.displayId);
      if (!display || !validScope(scope)) return { ok: false, error: "That display is no longer connected." };
      const id = String(display.id), previous = config(scope, id);
      const settings = layoutSettings({ ...previous, ...input.settings });
      const group = input.move ? [...notes.values()].filter(n => n.scope === scope) : onDisplay(id, scope);
      if (!workspaceLayout(display.workArea, group, settings)) return { ok: false, error: "The spaces overlap or are too small for these cards. Enlarge them or reset the spaces." };
      const resetPositions = ["size", "group", "order", "regions"].some(k => input.settings && k in input.settings);
      const rearrange = input.move === true || resetPositions;
      save(scope, id, settings, resetPositions);
      if (input.move === true) { group.forEach(n => { n.displayId = id; }); rememberDisplay(scope, id); }
      if (rearrange) arrange(scope, id, settings, true, !resetPositions);
      else group.forEach(publish);
      onChange(api.state());
      return { ok: true, workspace: api.workspace(scope) };
    },
    moveNote(scope, displayId, ref, region) {
      const note = [...notes.values()].find(n => n.scope === scope && refOf(n) === ref && displayOf(n) === displayId);
      const display = screen.getAllDisplays().find(d => String(d.id) === displayId);
      if (!note || !display || !validRegion(region)) return { ok: false, error: "This note is no longer on that display." };
      const bounds = pixelRegion(display.workArea, region);
      if (bounds.width < 280 || bounds.height < 200) return { ok: false, error: "Cards need at least 280 × 200 pixels." };
      note.targetBounds = bounds;
      motion.run(note, { bounds, opacity: note.hidden ? 0 : 1, immediate: note.hidden || config(scope, displayId).animation === "none" });
      api.rememberPosition(note);
      return { ok: true, workspace: api.workspace(scope) };
    },
    rememberPosition(note) {
      const display = screen.getAllDisplays().find(d => String(d.id) === displayOf(note));
      if (!display) return;
      const settings = config(note.scope, displayOf(note));
      const saved = readLayout(note.scope, displayOf(note)) ?? {};
      const positions = { ...saved.positions, [refOf(note)]: normalRegion(display.workArea, note.targetBounds ?? note.window.getBounds()) };
      writeLayout(note.scope, displayOf(note), { ...settings, positions: Object.fromEntries(Object.entries(positions).slice(-200)) });
    },
    report(event, meta) {
      const note = senderNote(event);
      if (!note || !meta || typeof meta !== "object") return false;
      const text = key => typeof meta[key] === "string" ? meta[key].replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, key === "title" ? 300 : 100) : null;
      const first = !note.meta;
      note.meta = Object.fromEntries(["title", "projectId", "projectName", "areaId", "areaName", "priority", "status", "dueDate", "plannedDate"].map(k => [k, text(k)]));
      if (Number.isInteger(meta.priority)) note.meta.priority = ["none", "urgent", "high", "medium", "low"][meta.priority] ?? "none";
      note.reducedMotion = meta.reducedMotion === true;
      publish(note);
      // Initial hydration can fill groups, but live deadline changes must not move the user's cards.
      if (first && config(note.scope, displayOf(note)).group !== "none") {
        const key = `${note.scope}:${displayOf(note)}`;
        clearTimeout(layoutTimers.get(key));
        layoutTimers.set(key, setTimeout(() => { layoutTimers.delete(key); arrange(note.scope, displayOf(note), undefined, true, true); }, 120));
      }
      return true;
    },
    setTheme(name, color) {
      const delays = delayFor([...notes.values()]);
      for (const note of notes.values()) {
        clearTimeout(note.themeTimer);
        const reduced = reduceMotion() || note.reducedMotion || config(note.scope, displayOf(note)).animation === "none";
        note.themeTimer = setTimeout(() => {
          if (note.window.isDestroyed()) return;
          note.window.setBackgroundColor(color);
          note.window.webContents.send("pacedmind:task-note-theme", { theme: name, duration: reduced ? 0 : 240 });
        }, reduced ? 0 : delays.get(note) ?? 0);
      }
    },
    updateVersions(scope, versions) {
      for (const { id, createdAt, version } of versions ?? []) {
        const note = notes.get(`${scope}:${id}`);
        if (note && note.createdAt === createdAt && !note.window.isDestroyed() &&
            typeof version === "string" && /^[a-f0-9]{64}$/.test(version)) {
          note.window.webContents.send("pacedmind:task-note-version", version);
        }
      }
    },
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
      const layout = noteLayout(display.workArea, group.length + 1, config(scope, displayId).size);
      if (!layout) return { status: "failed", note: "This display has no room for another readable note. Ask the user to close a note or choose another display." };
      const place = (note) => {
        note.displayId = displayId;
        const arranged = arrange(scope, displayId, undefined, false, true);
        if (!arranged) [...group, note].forEach((n, i) => { n.targetBounds = layout[i]; n.window.setBounds(layout[i]); });
        if (remember) rememberDisplay(scope, displayId);
      };
      if (existing && existing.createdAt === createdAt) {
        place(existing);
        existing.hidden = false;
        reveal(existing);
        onChange(api.state());
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
      const note = { window, url, scope, createdAt, id, hidden: false, ready: false };
      notes.set(key, note);
      place(note);
      window.setMenuBarVisibility(false);
      if (platform === "darwin") window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      window.once("ready-to-show", () => {
        note.ready = true;
        publish(note);
        reveal(note);
      });
      let positionTimer;
      const manual = () => { note.manualMove = true; motion.cancel(note); };
      window.on("will-move", manual); window.on("will-resize", manual);
      const moved = () => {
        if (!note.manualMove || motion.has(note) || !note.ready) return;
        clearTimeout(positionTimer);
        positionTimer = setTimeout(() => {
          if (window.isDestroyed() || motion.has(note)) return;
          note.displayId = String(screen.getDisplayMatching(window.getBounds()).id);
          note.targetBounds = window.getBounds(); note.manualMove = false; api.rememberPosition(note); publish(note);
        }, 180);
      };
      window.on("moved", moved); window.on("resized", moved);
      window.on("closed", () => {
        motion.cancel(note); clearTimeout(positionTimer); clearTimeout(note.themeTimer); clearTimeout(note.layoutTimer);
        if (notes.get(key) === note) notes.delete(key);
        onChange(api.state());
      });
      onChange(api.state());
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
      note.hidden = true;
      motion.run(note, { opacity: 0, immediate: config(note.scope, displayOf(note)).animation === "none", done: () => note.window.close() });
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
