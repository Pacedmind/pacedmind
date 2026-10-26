import "server-only";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { repoRoot } from "./folders";
import { mainCheckout } from "./git-remote";

/*
 * Codex asks whether you trust a folder the first time it starts there too, and keeps the answer in its config.toml
 * as [projects."<folder>"] trust_level = "trusted", for the repository's root (the checkout a worktree was made from),
 * else for the folder. With this computer's "Trust session folders" on (device.ts), the launcher gives that answer
 * before a Codex session starts (trustForCodex). A folder Codex already has an answer for keeps it, "untrusted" too.
 */

const codexHome = () => process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const fold = (p: string) => (process.platform === "linux" ? p : p.toLowerCase());

const unquote = (inner: string): string | null => {
  try {
    return JSON.parse(`"${inner}"`) as string;
  } catch {
    return null;
  }
};

/**
 * Adds the folder's answer to Codex's config.toml, at its end, when Codex has a config here (it has run) and no
 * answer for the folder yet. Written next to the file and moved over, and again from a fresh read if it changed
 * meanwhile. Returns whether it answered.
 */
export function trustForCodex(folder: string): boolean {
  let file: string;
  try {
    file = fs.realpathSync(path.join(codexHome(), "config.toml"));
  } catch {
    return false;
  }
  const root = repoRoot(folder);
  let key = root ? mainCheckout(root) : path.resolve(folder);
  try {
    key = fs.realpathSync.native(key);
  } catch {
    // Kept as resolved.
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    let text: string;
    let before: number;
    try {
      before = fs.statSync(file).mtimeMs;
      text = fs.readFileSync(file, "utf8");
    } catch {
      return false;
    }
    const answered = [...text.matchAll(/^\s*\[\s*projects\.(?:'([^']+)'|"((?:[^"\\]|\\.)+)")\s*\]/gm)]
      .some((m) => {
        const name = m[1] ?? unquote(m[2]);
        return name !== null && fold(path.resolve(/*turbopackIgnore: true*/ name)) === fold(key);
      });
    // Projects written as one inline table can't take another table after them.
    if (answered || /^\s*projects\s*=/m.test(text)) return false;
    const table = `[projects.${JSON.stringify(key)}]\ntrust_level = "trusted"\n`;
    const next = text ? `${text}${text.endsWith("\n") ? "" : "\n"}\n${table}` : table;
    const temp = `${file}.pacedmind-${process.pid}-${Date.now()}`;
    fs.writeFileSync(temp, next, { mode: fs.statSync(file).mode & 0o777 });
    if (fs.statSync(file).mtimeMs !== before) {
      fs.rmSync(temp, { force: true });
      continue;
    }
    fs.renameSync(temp, file);
    return true;
  }
  return false;
}
