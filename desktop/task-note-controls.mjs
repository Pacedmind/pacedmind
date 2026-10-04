// Only the planner's own main frame may inspect or toggle its note windows.
export function registerTaskNoteControls({ ipcMain, taskWindows, planner, origin, readScope, openNotes }) {
  let opening = false;
  function allowed(event) {
    const window = planner();
    if (!window || window.isDestroyed() || event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame) return false;
    try { return new URL(event.senderFrame.url).origin === origin; } catch { return false; }
  }
  const handle = (toggle) => async (event) => {
    if (!allowed(event)) return null;
    const scope = await readScope();
    if (scope === undefined || !allowed(event)) return null;
    taskWindows.keepScope(scope);
    if (toggle && scope && taskWindows.state().count === 0 && openNotes) {
      if (opening) return null;
      opening = true;
      try {
        const result = await openNotes(event, scope);
        return { ...taskWindows.state(), ...(result === false ? { ok: false, error: "Couldn't open notes. Try again when PacedMind is ready." } : result) };
      } finally { opening = false; }
    }
    return toggle ? taskWindows.toggle() : taskWindows.state();
  };
  ipcMain.handle("pacedmind:task-notes-state", handle(false));
  ipcMain.handle("pacedmind:toggle-task-notes", handle(true));
}
