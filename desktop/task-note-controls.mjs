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
    // Reading the window count and hiding cards are local. Only showing data needs a fresh scope.
    if (!toggle) return taskWindows.state();
    if (taskWindows.state().visible) return taskWindows.hideAll();
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
  // Layouts never accept a renderer-supplied account; each change rechecks the signed-in planner.
  const workspace = (write) => async (event, input) => {
    if (!allowed(event)) return null;
    const scope = await readScope();
    if (!scope || !allowed(event)) return null;
    taskWindows.keepScope(scope);
    if (!write) return { ok: true, workspace: taskWindows.workspace(scope) };
    if (!input || typeof input !== "object" || JSON.stringify(input).length > 32000) return { ok: false, error: "Invalid layout." };
    return input.ref ? taskWindows.moveNote(scope, input.displayId, input.ref, input.bounds) : taskWindows.configure(scope, input);
  };
  ipcMain.handle("pacedmind:task-note-layout", workspace(false));
  ipcMain.handle("pacedmind:set-task-note-layout", workspace(true));
  ipcMain.on("pacedmind:task-note-metadata", (event, data) => taskWindows.report(event, data));
}
