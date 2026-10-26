import "server-only";
import { execFile, spawn } from "node:child_process";

/**
 * The environment for agent processes, without what only this server uses. Otherwise an agent's
 * `npm install` would see NODE_ENV=production, its dev server would try PacedMind's PORT, Electron-based
 * tools would run as plain Node (ELECTRON_RUN_AS_NODE, set by the desktop app), and agents would see
 * PacedMind's own keys (ORGANIZER_DATA_KEY, ORGANIZER_UI_SECRET) and Supabase settings.
 */
export function agentEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(PORT|HOSTNAME|NODE_ENV|ELECTRON_RUN_AS_NODE|NEXT_.*|__NEXT_.*|TURBOPACK.*|ORGANIZER_.*|SUPABASE_.*|GOOGLE_CALENDAR_.*)$/i.test(key)) delete env[key];
  }
  for (const key of HOST_SESSION_VARS) delete env[key];
  return env;
}

/**
 * What a running Claude Code session sets for the programs it starts. PacedMind can run inside one (`npm run dev`
 * from Claude Code, say); an agent it starts then isn't that session's child: with these, Claude Code saves no
 * transcript (so Request changes has no conversation to resume) and the agent would get the host session's own
 * messaging token. The user's own settings, such as CLAUDE_CODE_USE_BEDROCK, stay. The terminal scripts clear
 * them again (launcher.ts), since a terminal app started by an earlier launch keeps its environment.
 */
export const HOST_SESSION_VARS = [
  // Reused terminal apps can retain the server environment from an earlier launch.
  "GOOGLE_CALENDAR_CLIENT_ID", "GOOGLE_CALENDAR_CLIENT_SECRET", "GOOGLE_CALENDAR_ENCRYPTION_KEY", "GOOGLE_CALENDAR_DESKTOP_CREDENTIALS",
  "CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_HOST_SESSION_ID",
  "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_CODE_SSE_PORT", "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_SESSION_ATTENDED", "CLAUDE_PID",
];

/** A command from Settings that is safe to hand to cmd.exe or sh as it is: a program and plain arguments. */
export const plainCommand = (command: string) => /^[\w .:\\/@()+=,-]+$/.test(command.trim());

/**
 * One double-quoted argument for a line of a .cmd script. Line breaks become spaces, `"` becomes `'`
 * and `%` is doubled; inside the quotes cmd.exe takes & | < > ^ literally.
 */
export function cmdQuote(text: string): string {
  return `"${text.replace(/[\u0000-\u001f]+/g, " ").replace(/"/g, "'").replace(/%/g, "%%").trim()}"`;
}

/** One single-quoted argument for a line of a shell script. */
export function shQuote(text: string): string {
  return `'${text.replace(/\u0000/g, "").replace(/'/g, "'\\''")}'`;
}

/**
 * The shell that runs a command line: cmd.exe, which gets the line exactly as written (quotes included), or the
 * user's login shell on macOS and Linux, so tools installed with npm or Homebrew are on the PATH.
 */
export function shellFor(line: string): { file: string; args: string[]; verbatim: boolean } {
  if (process.platform === "win32") return { file: "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], verbatim: true };
  return { file: process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/sh"), args: ["-lc", line], verbatim: false };
}

/** Runs a command line through the platform's shell and returns its output, or null when it failed or took too long. */
export function runCommand(line: string, timeout = 10_000): Promise<string | null> {
  return execLine(line, { timeout }).then((r) => (r.code === 0 ? r.stdout : null));
}

/** Runs a command line in a folder, feeding it `input`, and returns its exit code and output. */
export function execLine(line: string, opts: { cwd?: string; input?: string; timeout?: number } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const sh = shellFor(line);
    let stdout = "";
    let stderr = "";
    let child;
    try {
      // turbopackIgnore: a program chosen at run time would make the build trace (and ship) the whole project.
      child = spawn(/* turbopackIgnore: true */ sh.file, sh.args, { cwd: opts.cwd, env: agentEnv(), windowsHide: true, windowsVerbatimArguments: sh.verbatim });
    } catch (e) {
      resolve({ code: -1, stdout, stderr: e instanceof Error ? e.message : String(e) });
      return;
    }
    const timer = setTimeout(() => child.kill(), opts.timeout ?? 10_000);
    child.stdout.setEncoding("utf8").on("data", (d: string) => { if (stdout.length < 1 << 20) stdout += d; });
    child.stderr.setEncoding("utf8").on("data", (d: string) => { if (stderr.length < 1 << 16) stderr += d; });
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: stderr || e.message }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }); });
    child.stdin.on("error", () => {});
    child.stdin.end(opts.input ?? "");
  });
}

/** Runs a program with arguments (no shell) and returns its output, or null when it failed or took too long. */
export function runFile(file: string, args: string[], timeout = 10_000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, windowsHide: true, env: agentEnv(), encoding: "utf8", maxBuffer: 1 << 20 }, (err, stdout) =>
      resolve(err ? null : String(stdout)));
  });
}

/** Opens a link with the app registered for it: a claude:// or codex:// link opens that desktop app. */
export function openUrl(url: string): string | null {
  try {
    // rundll32 hands the link to the shell as it is, without cmd.exe reading & or % in it.
    const [file, args] = process.platform === "win32"
      ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
      : [process.platform === "darwin" ? "open" : "xdg-open", [url]];
    const child = spawn(/* turbopackIgnore: true */ file, args, { detached: true, stdio: "ignore", env: agentEnv() });
    child.on("error", () => {});
    child.unref();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
