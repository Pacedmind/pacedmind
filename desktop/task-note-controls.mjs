// Only the planner's own main frame may inspect or toggle its note windows.
export function registerTaskNoteControls({ ipcMain, taskWindows, planner, origin, readScope }) {
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
    return toggle ? taskWindows.toggle() : taskWindows.state();
  };
  ipcMain.handle("pacedmind:task-notes-state", handle(false));
  ipcMain.handle("pacedmind:toggle-task-notes", handle(true));
}
