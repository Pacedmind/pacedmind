// Run after npm run build. Uses a temporary profile/database and its own port; never the installed app.
import { spawn } from "node:child_process";
import path from "node:path";
import electron from "electron";

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const root = path.resolve(import.meta.dirname, "..");
const child = spawn(electron, [path.join(root, "tests/task-notes.integration.mjs")], { cwd: root, env, stdio: "inherit", windowsHide: true });
child.on("error", (error) => { console.error(error); process.exitCode = 1; });
child.on("exit", (code) => { process.exitCode = code ?? 1; });
