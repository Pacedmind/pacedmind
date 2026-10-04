// Sandboxed Electron preloads use CommonJS, with no general Node access.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("pacedMindDesktop", {
  initialTheme: process.argv.includes("--pacedmind-theme=light") ? "light" : "dark",
  setTheme(theme) {
    if (theme === "dark" || theme === "light") ipcRenderer.send("pacedmind:set-theme", theme);
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
