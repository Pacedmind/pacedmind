// Builds the PacedMind desktop app and updates the existing installation in place.
//
//   npm run desktop                 build, package, install and start it: on Windows in
//                                   %LOCALAPPDATA%\Programs\Organizer with Start Menu and desktop shortcuts
//                                   (not started when run from Claude or Codex: open it from the Start Menu
//                                   then), on macOS as ~/Applications/PacedMind.app
//   npm run desktop -- --no-install build and package only (output in dist/package)
//   npm run desktop -- --no-launch  install without starting it
//   npm run desktop -- --release    what scripts/release.mjs builds: on macOS a universal app, signed with
//                                   your Developer ID and notarized (see deploy/README.md)
//   npm run desktop -- --allow-unlanded
//                                   install from a checkout that doesn't contain master (a test): without it,
//                                   installing refuses, so it can't roll back work already on master (landed.mjs)
//
// The app keeps its data in %APPDATA%\Organizer, or ~/Library/Application Support/Organizer on macOS,
// so reinstalling never touches it.
import { execFileSync, execSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { packager } from "@electron/packager";
import { assertLanded } from "./landed.mjs";

const root = path.resolve(import.meta.dirname, "..");
const dist = path.join(root, "dist");
const stage = path.join(dist, "app");
const flags = new Set(process.argv.slice(2));
const installs = !flags.has("--no-install") && ["win32", "darwin"].includes(process.platform);
// The installed app is this computer's, whichever checkout builds it.
if (installs && !flags.has("--allow-unlanded")) assertLanded(root, { skip: "npm run desktop -- --allow-unlanded" });
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const pkg = readJson(path.join(root, "package.json"));
const electronVersion = readJson(path.join(root, "node_modules", "electron", "package.json")).version;
const mac = process.platform === "darwin";
const installDir = path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Organizer");
const installedExe = path.join(installDir, "Organizer.exe");
// macOS is new, so its bundle carries the product's name; the data folder is still called Organizer.
const macApps = path.join(os.homedir(), "Applications");
const installedApp = path.join(macApps, "PacedMind.app");

const step = (text) => console.log(`\n> ${text}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Number of Organizer processes running from the install folder (the app and its server). */
function runningFromInstall() {
  const dir = installDir.replace(/'/g, "''");
  const out = execFileSync("powershell.exe", [
    "-NoProfile", "-Command",
    `@(Get-Process -Name Organizer -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '${dir}\\*' }).Count`,
  ], { encoding: "utf8" });
  return Number(out.trim()) || 0;
}

/** Number of PacedMind processes running from ~/Applications on macOS (the app, its helpers and server). */
function runningOnMac() {
  try {
    return execFileSync("pgrep", ["-f", `${installedApp}/Contents/`], { encoding: "utf8" }).split("\n").filter(Boolean).length;
  } catch {
    return 0; // pgrep exits with 1 when nothing matches.
  }
}

// Validate every recursive-delete target before touching a previous build or installation.
function assertChildPath(target, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(target));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Unsafe output path: ${target}`);
  }
}

/**
 * The MSIX app (Claude, Codex) whose private copy of `dir` this terminal sees, or undefined. Those apps
 * redirect %APPDATA% for what they start, and paths look the same from inside, so compare file IDs.
 */
function sandboxApp(dir) {
  const packages = path.join(process.env.LOCALAPPDATA, "Packages");
  const { dev, ino } = fs.statSync(dir, { bigint: true });
  return fs.readdirSync(packages).find((name) => {
    try {
      const copy = fs.statSync(path.join(packages, name, "LocalCache", "Roaming", path.basename(dir)), { bigint: true, throwIfNoEntry: false });
      return copy?.ino === ino && copy.dev === dev;
    } catch {
      return false; // A package folder we can't read isn't where this profile lives.
    }
  })?.split("_")[0];
}
assertChildPath(stage, root);
assertChildPath(path.join(dist, "package"), root);
if (process.platform === "win32") {
  if (!process.env.LOCALAPPDATA || !path.isAbsolute(process.env.LOCALAPPDATA)) {
    throw new Error("LOCALAPPDATA must identify the current user's app directory.");
  }
  assertChildPath(installDir, path.join(process.env.LOCALAPPDATA, "Programs"));
}

step("Generating PacedMind icons");
execFileSync(process.execPath, [path.join(root, "scripts", "make-icons.mjs")], { cwd: root, stdio: "inherit" });

step("Building the Next.js app");
fs.rmSync(stage, { recursive: true, force: true }); // An old copy would end up in the build's file tracing.
execSync("npm run build", { cwd: root, stdio: "inherit" });

step("Collecting the app files");
const server = path.join(stage, "server");
const standalone = path.join(root, ".next", "standalone");
// Only what server.js runs from. File tracing also copies in project files that the server's dynamic
// paths seem to reach, and the server never reads them: data/ (your local database and session
// scripts), dist/, docs/ and src/ files, the checkout's .git and .claude. Some are private, and in the
// main checkout .git and .claude/worktrees are huge.
// sharp is there for Next's image optimizer, which the app never uses. Its native binaries would tie
// the server to one platform and processor, and a universal Mac app runs the same files on both.
const keep = [".next", "node_modules", "package.json", "server.js"];
const skip = ["node_modules/sharp", "node_modules/@img"].map((dir) => path.join(standalone, dir));
for (const entry of keep) {
  fs.cpSync(path.join(standalone, entry), path.join(server, entry), {
    recursive: true,
    filter: (src) => !skip.some((dir) => src === dir || src.startsWith(dir + path.sep)),
  });
}
const traced = fs.readdirSync(standalone).filter((entry) => !keep.includes(entry));
if (traced.length) console.log(`  Left out what file tracing added: ${traced.join(", ")}`);
fs.cpSync(path.join(root, ".next", "static"), path.join(server, ".next", "static"), { recursive: true });
if (fs.existsSync(path.join(root, "public"))) fs.cpSync(path.join(root, "public"), path.join(server, "public"), { recursive: true });
for (const file of ["main.mjs", "task-windows.mjs", "task-note-layout.mjs", "preload.cjs", "icon.ico", "icon.png", "trayTemplate.png", "trayTemplate@2x.png"]) {
  fs.copyFileSync(path.join(root, "desktop", file), path.join(stage, file));
}
fs.writeFileSync(path.join(stage, "package.json"), JSON.stringify({
  name: "organizer",
  productName: "PacedMind",
  version: pkg.version,
  description: "Tasks, time blocks and agent sessions",
  main: "main.mjs",
}, null, 2));

/**
 * A Mac app for others to download: one app for Apple silicon and Intel, signed with the Developer ID
 * Application certificate in your keychain (PACEDMIND_SIGN_IDENTITY picks one if there are several)
 * under the hardened runtime, then notarized with the notarytool profile in your keychain
 * (PACEDMIND_NOTARY_PROFILE, "PacedMind" by default). The secrets never leave the keychain.
 */
function macRelease() {
  return {
    arch: "universal",
    osxSign: {
      identity: process.env.PACEDMIND_SIGN_IDENTITY || undefined,
      continueOnError: false,
      // The app gets only what it needs (desktop/entitlements.mac.plist); Electron's helper apps keep
      // @electron/osx-sign's defaults, which it picks by the same names.
      optionsForFile: (file) => (/\((Plugin|GPU|Renderer)\)\.app/.test(file) ? {} : { entitlements: path.join(root, "desktop", "entitlements.mac.plist") }),
    },
    osxNotarize: { keychainProfile: process.env.PACEDMIND_NOTARY_PROFILE || "PacedMind" },
  };
}

step(`Packaging with Electron ${electronVersion}`);
const [packaged] = await packager({
  dir: stage,
  out: path.join(dist, "package"),
  overwrite: true,
  platform: process.platform,
  arch: process.arch,
  electronVersion,
  appVersion: pkg.version,
  asar: false, // The server runs from plain files with Electron's own Node.
  prune: false, // server/node_modules is already exactly what the server needs.
  quiet: true,
  ...(mac ? {
    name: "PacedMind",
    executableName: "PacedMind",
    icon: path.join(root, "desktop", "icon.icns"),
    appBundleId: "com.pacedmind.desktop",
    appCategoryType: "public.app-category.productivity",
    ...(flags.has("--release") && macRelease()),
  } : {
    // Windows keeps the Organizer names, so updates replace the existing installation.
    name: "Organizer",
    executableName: "Organizer",
    icon: path.join(root, "desktop", "icon.ico"),
    win32metadata: { CompanyName: "PacedMind", FileDescription: "PacedMind", ProductName: "PacedMind", InternalName: "Organizer" },
  }),
});
console.log(`  ${packaged}`);

if (!installs) {
  console.log("\nDone. Run the app from the folder above.");
  process.exit(0);
}

if (mac) {
  step(`Installing to ${installedApp}`);
  if (runningOnMac()) {
    console.log("  Closing the running app…");
    // A second instance hands --quit to the running one and exits.
    spawn(path.join(installedApp, "Contents", "MacOS", "PacedMind"), ["--quit"], { stdio: "ignore" });
    for (let i = 0; i < 50 && runningOnMac(); i++) await sleep(200);
    if (runningOnMac()) throw new Error("PacedMind is still running. Quit it from its menu bar icon and run this again.");
  }
  fs.mkdirSync(macApps, { recursive: true });
  assertChildPath(installedApp, macApps);
  fs.rmSync(installedApp, { recursive: true, force: true });
  // ditto keeps the bundle's symbolic links, extended attributes and signature.
  execFileSync("ditto", [path.join(packaged, "PacedMind.app"), installedApp]);
  console.log("  Installed PacedMind in Applications, in your home folder.");
  if (!flags.has("--no-launch")) {
    execFileSync("open", [installedApp]);
    console.log("  Started PacedMind.");
  }
  console.log(`\nDone. Your data lives in ${path.join(os.homedir(), "Library", "Application Support", "Organizer")}.`);
  process.exit(0);
}

step(`Installing to ${installDir}`);
if (fs.existsSync(installedExe) && runningFromInstall()) {
  console.log("  Closing the running app…");
  spawn(installedExe, ["--quit"], { stdio: "ignore", windowsHide: true });
  for (let i = 0; i < 50 && runningFromInstall(); i++) await sleep(200);
  if (runningFromInstall()) throw new Error("Organizer is still running. Quit it from the tray icon and run this again.");
}
fs.rmSync(installDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
fs.cpSync(packaged, installDir, { recursive: true });
execFileSync(installedExe, ["--install"], { windowsHide: true }); // Start Menu and desktop shortcuts.
console.log("  Added PacedMind to the Start Menu and the desktop.");

// An app started from inside Claude or Codex would open their copy of the data (--install created the
// profile folder, so it can be checked now).
const sandbox = sandboxApp(path.join(process.env.APPDATA ?? "", "Organizer"));
if (sandbox) {
  console.log(`  Not starting it from inside ${sandbox}, which keeps its own copy of AppData. Open PacedMind from the Start Menu.`);
} else if (!flags.has("--no-launch")) {
  spawn(installedExe, [], { detached: true, stdio: "ignore" }).unref();
  console.log("  Started PacedMind.");
}
console.log(`\nDone. Your data lives in ${path.join(process.env.APPDATA ?? "", "Organizer")}.`);
