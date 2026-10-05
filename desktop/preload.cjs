// Sandboxed Electron preloads use CommonJS, with no general Node access.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("pacedMindDesktop", {
  initialTheme: process.argv.includes("--pacedmind-theme=light") ? "light" : "dark",
  setTheme(theme, preference) {
    if (theme === "dark" || theme === "light") ipcRenderer.send("pacedmind:set-theme", theme, preference === "system" ? "system" : theme);
  },
  // The system's folder dialog, starting at `near` when it's a folder; the chosen folder, or null when cancelled.
  pickFolder(near) {
    return ipcRenderer.invoke("pacedmind:pick-folder", typeof near === "string" ? near : null);
  },
  floatTask(id, scope, createdAt) {
    return ipcRenderer.invoke("pacedmind:float-task", id, scope, createdAt);
  },
  closeTaskNote() {
    return ipcRenderer.invoke("pacedmind:close-task-note");
  },
  taskNotesState() {
    return ipcRenderer.invoke("pacedmind:task-notes-state");
  },
  toggleTaskNotes() {
    return ipcRenderer.invoke("pacedmind:toggle-task-notes");
  },
  taskNoteLayout() { return ipcRenderer.invoke("pacedmind:task-note-layout"); },
  chooseTaskNoteDisplay(requestId, answer) { return ipcRenderer.invoke("pacedmind:choose-task-note-display", requestId, answer); },
  onTaskNoteDisplayRequest(listener) {
    const receive = (_event, value) => { if (value === null || (value && typeof value.requestId === "string" && Array.isArray(value.displays))) listener(value); };
    ipcRenderer.on("pacedmind:task-note-display-request", receive);
    return () => ipcRenderer.removeListener("pacedmind:task-note-display-request", receive);
  },
  setTaskNoteLayout(input) { return ipcRenderer.invoke("pacedmind:set-task-note-layout", input); },
  reportTaskNote(data) { ipcRenderer.send("pacedmind:task-note-metadata", data); },
  onTaskNoteStyle(listener) {
    const receive = (_event, value) => { if (value && ["xs", "small", "medium", "large"].includes(value.size) && ["strong", "normal", "quiet"].includes(value.emphasis)) listener(value); };
    ipcRenderer.on("pacedmind:task-note-style", receive);
    return () => ipcRenderer.removeListener("pacedmind:task-note-style", receive);
  },
  onTaskNoteTheme(listener) {
    const receive = (_event, value) => { if (value && ["dark", "light"].includes(value.theme) && [0, 240].includes(value.duration)) listener(value); };
    ipcRenderer.on("pacedmind:task-note-theme", receive);
    return () => ipcRenderer.removeListener("pacedmind:task-note-theme", receive);
  },
  onTaskNotesChanged(listener) {
    const receive = (_event, state) => {
      if (state && Number.isSafeInteger(state.count) && state.count >= 0 && typeof state.visible === "boolean") listener(state);
    };
    ipcRenderer.on("pacedmind:task-notes-changed", receive);
    return () => ipcRenderer.removeListener("pacedmind:task-notes-changed", receive);
  },
  showFloatingTask(href) {
    return ipcRenderer.invoke("pacedmind:show-floating-task", href);
  },
  onTaskNoteVersion(listener) {
    const receive = (_event, version) => {
      if (typeof version === "string" && /^[a-f0-9]{64}$/.test(version)) listener(version);
    };
    ipcRenderer.on("pacedmind:task-note-version", receive);
    return () => ipcRenderer.removeListener("pacedmind:task-note-version", receive);
  },
});
