import path from "node:path";

/** Use Electron's bundled Node without registering another foreground app in the macOS Dock. */
export function nodeExecutable(executable = process.execPath, platform = process.platform) {
  if (platform !== "darwin") return executable;
  const helper = `${path.basename(executable)} Helper`;
  return path.join(path.dirname(executable), "..", "Frameworks", `${helper}.app`, "Contents", "MacOS", helper);
}
