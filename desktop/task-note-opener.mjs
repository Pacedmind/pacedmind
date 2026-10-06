import { randomUUID } from "node:crypto";

/** The planner renders the chooser; only its initiating main frame may answer it. */
export function createTaskNoteOpener({ ipcMain, taskWindows, planner, origin, readScope, ready = () => true }) {
  let opening = false, pending = null;
  const allowed = (event) => {
    const window = planner();
    if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return false;
    try { return new URL(event.senderFrame.url).origin === origin; } catch { return false; }
  };
  ipcMain.handle("pacedmind:choose-task-note-display", (event, requestId, answer) => {
    if (!pending || !allowed(event) || event.sender !== pending.sender || event.senderFrame !== pending.frame || requestId !== pending.id) return false;
    if (answer !== null && (!answer || typeof answer.remember !== "boolean" || !pending.displays.some(d => d.id === answer.displayId))) return false;
    pending.finish(answer === null ? null : { displayId: answer.displayId, remember: answer.remember });
    return true;
  });
  function choose(event, snapshot, count) {
    return new Promise(resolve => {
      const window = planner(), sender = event.sender, id = randomUUID();
      const finish = answer => {
        if (pending?.id !== id) return;
        pending = null; clearTimeout(timer);
        window.removeListener("close", cancel);
        sender.removeListener("destroyed", cancel);
        sender.removeListener("did-start-navigation", navigating);
        if (!sender.isDestroyed()) sender.send("pacedmind:task-note-display-request", null);
        resolve(answer);
      };
      const cancel = () => finish(null);
      const navigating = (_event, _url, _inPlace, isMainFrame) => { if (isMainFrame) cancel(); };
      const timer = setTimeout(cancel, 300_000); timer.unref?.();
      pending = { id, sender, frame: event.senderFrame, displays: snapshot.displays, finish };
      window.once("close", cancel); sender.once("destroyed", cancel); sender.on("did-start-navigation", navigating);
      sender.send("pacedmind:task-note-display-request", { ...snapshot, requestId: id, count });
    });
  }
  return async function open(event, tasks, scope) {
    if (!ready() || !allowed(event) || opening) return false;
    opening = true;
    try {
      if ((await readScope()) !== scope || !allowed(event)) return false;
      const snapshot = taskWindows.displays(scope);
      let display = snapshot.displays.find(d => d.id === snapshot.defaultDisplay)?.id, remember = false;
      if (!display && snapshot.displays.length === 1 && !snapshot.defaultDisplay) display = snapshot.displays[0].id;
      if (!display) {
        const answer = await choose(event, snapshot, tasks.length);
        if (!answer) return { ok: true };
        display = answer.displayId; remember = answer.remember;
      }
      // The account, initiating frame and connected display may have changed while the chooser was open.
      if ((await readScope()) !== scope || !ready() || !allowed(event)) return false;
      let opened = 0;
      for (const { id, createdAt } of tasks) {
        const result = taskWindows.show(id, scope, createdAt, display, remember);
        if (result.status !== "opened") return { ok: false, error: `${opened ? `Opened ${opened} of ${tasks.length} notes. ` : ""}${result.note}` };
        opened++;
      }
      return { ok: true };
    } finally { opening = false; }
  };
}
