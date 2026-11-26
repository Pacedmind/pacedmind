// Embed mode in the pages the app draws: `npm run test:embed:app`.
//
// It starts a development server of its own in a new folder with an empty home (as screenshots.mjs does), so nothing
// of this computer shows and no request leaves it: the app without an account, on the sample data. Today and the
// sign-in page with and without the `pacedmind-embed=1` cookie, and the stylesheet the pages get.
import { spawn, execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const PORT = 4362;
const base = `http://127.0.0.1:${PORT}`;

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pacedmind-embed-"));
const dirs = Object.fromEntries(["data", "home", "appdata", "claude", "codex"].map((d) => [d, path.join(temp, d)]));
for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
// Past the sign-in screen and the first-start import offer.
fs.writeFileSync(path.join(dirs.data, "device.json"), JSON.stringify({ name: "Studio", withoutAccount: true, importOffered: true }));

/** A development server with this environment besides the folders above; `stop()` ends it and waits until it's gone. */
function start(env) {
  const server = spawn(process.execPath, [path.join(root, "node_modules/next/dist/bin/next"), "dev", "-p", String(PORT), "-H", "127.0.0.1"], {
    cwd: root,
    env: {
      ...process.env,
      ORGANIZER_DB: path.join(dirs.data, "organizer.db"),
      USERPROFILE: dirs.home, HOME: dirs.home, APPDATA: dirs.appdata, CLAUDE_CONFIG_DIR: dirs.claude, CODEX_HOME: dirs.codex,
      SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test", NEXT_TELEMETRY_DISABLED: "1",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const run = { server, log: "" };
  server.stdout.on("data", (b) => { run.log += b; });
  server.stderr.on("data", (b) => { run.log += b; });
  const gone = new Promise((resolve) => server.once("exit", resolve));
  run.stop = async () => {
    if (server.exitCode !== null || server.signalCode !== null) return;
    try {
      if (process.platform === "win32") execFileSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
      else server.kill();
    } catch { /* gone already */ }
    await gone;
  };
  return run;
}

/** Waits until the server answers `probe()` with something, which it returns. */
async function ready(run, probe) {
  for (let i = 0; i < 240; i++) {
    if (run.server.exitCode !== null) throw new Error(`The development server stopped:\n${run.log}`);
    const answer = await probe().catch(() => null);
    if (answer) return answer;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`The development server didn't answer:\n${run.log}`);
}

/** A page as a browser gets it, without following where it sends the browser. */
const get = (url, headers = {}) => new Promise((resolve, reject) => {
  http.get(`${base}${url}`, { headers }, (res) => {
    const chunks = [];
    res.on("data", (chunk) => chunks.push(chunk));
    res.on("end", () => resolve({ status: res.statusCode, headers: new Headers(Object.entries(res.headers).map(([name, value]) => [name, String(value)])),
      text: async () => Buffer.concat(chunks).toString("utf8") }));
    res.on("error", reject);
  }).on("error", reject);
});

const attributes = (html, pattern) => [...html.matchAll(pattern)].map((m) => m[0]);
const navKinds = (html) => attributes(html, /data-pm-kind="[a-z]+"/g).sort();
const htmlTag = (html) => html.match(/<html[^>]*>/)[0];
const sidebar = (html) => html.match(/<div data-pm="sidebar"[^>]*>/)?.[0];
const mainTag = (html) => html.match(/<main[^>]*>/)[0];

async function sampleData() {
  const run = start({ SUPABASE_URL: "http://127.0.0.1:9" });
  try {
    const keyFile = path.join(dirs.data, "ui-key");
    const key = await ready(run, async () => {
      if (!fs.existsSync(keyFile)) return null;
      const saved = fs.readFileSync(keyFile, "utf8").trim();
      return (await get("/today", { cookie: `pm_ui=${saved}` })).status === 200 ? saved : null;
    });
    /** The page's HTML with these cookies besides the window key. */
    const page = async (url, cookies = "") => {
      const r = await get(url, { cookie: `pm_ui=${key}${cookies ? `; ${cookies}` : ""}` });
      assert.equal(r.status, 200, url);
      return { html: await r.text(), headers: r.headers };
    };
    const plain = await page("/today");
    const off = await page("/today", "pacedmind-embed=0");
    const embedded = await page("/today", "pacedmind-embed=1");

    // Without the cookie (or with another value), nothing changes: the title bar, the sidebar shown, the framed page.
    for (const { html } of [plain, off]) {
      assert.doesNotMatch(htmlTag(html), /data-embed/);
      assert.match(html, /<header class="app-titlebar"/);
      assert.ok(sidebar(html) && !/\shidden/.test(sidebar(html)), "the sidebar shows");
      assert.match(mainTag(html), /class="m-2 ml-0 /);
    }
    assert.deepEqual(navKinds(off.html), navKinds(plain.html));

    // With it: the document says so, no title bar (the only drag region), the sidebar in the page but hidden, no frame.
    const { html } = embedded;
    assert.match(htmlTag(html), /data-embed=""/);
    assert.match(htmlTag(html), /data-theme="dark"/);
    assert.doesNotMatch(html, /app-titlebar/);
    assert.match(sidebar(html), /\shidden=""/);
    assert.equal(mainTag(html), '<main class="flex min-w-0 flex-1 overflow-hidden bg-panel">');

    // The same names in both modes: every kind of link, the counts shown, each link's label.
    assert.deepEqual(navKinds(html), navKinds(plain.html));
    for (const kind of ["view", "area", "todos", "project", "settings"]) assert.ok(navKinds(html).includes(`data-pm-kind="${kind}"`), kind);
    assert.deepEqual(attributes(html, /data-pm-count="\d+"/g), attributes(plain.html, /data-pm-count="\d+"/g));
    assert.ok(attributes(html, /data-pm-count="\d+"/g).length > 0, "the sample data shows counts");
    // Every link of the sidebar is named, so a host that lists the named ones misses none.
    const whole = html.slice(html.indexOf('<div data-pm="sidebar"'), html.indexOf("<main"));
    const links = attributes(whole, /<a [^>]*>/g);
    assert.ok(links.length > 10 && links.every((a) => /data-pm="nav-link"/.test(a) && /href="\/[^"]*"/.test(a) && /data-pm-label="[^"]+"/.test(a)), "each link has its name, address and label");

    // The sign-in page: dark in embed mode too, as usual without it, and the form either way.
    const login = await page("/login");
    const loginEmbedded = await page("/login", "pacedmind-embed=1");
    assert.doesNotMatch(htmlTag(login.html), /data-embed/);
    assert.match(htmlTag(loginEmbedded.html), /data-embed=""/);
    assert.match(htmlTag(loginEmbedded.html), /data-theme="dark"/);
    for (const { html: form } of [login, loginEmbedded]) assert.ok(form.includes('type="password"'), "the sign-in form");

    // Embed mode is for a top-level browser view: the page still refuses frames.
    for (const { headers } of [plain, embedded, login, loginEmbedded]) {
      assert.equal(headers.get("x-frame-options"), "DENY");
      assert.match(headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
    }

    // The stylesheet the page gets: the pages' shadows are globals.css's variables, declared where a host's own value
    // replaces them. (Tailwind's own shadow sizes write their color into their class instead; tests/embed.test.ts
    // checks that no page uses one.)
    const sheets = attributes(html, /<link [^>]*rel="stylesheet"[^>]*>/g).map((link) => link.match(/href="([^"]+)"/)[1].replaceAll("&amp;", "&"));
    assert.ok(sheets.length > 0, "the page links its stylesheet");
    const css = (await Promise.all(sheets.map(async (href) => (await get(href)).text()))).join("\n");
    for (const variable of ["--shadow-sm", "--shadow-lg", "--shadow-popover"]) {
      const rule = css.match(new RegExp(`\\.shadow-\\\\\\[var\\\\\\(${variable}\\\\\\)\\\\\\]\\s*\\{([^}]*)\\}`))?.[1] ?? "";
      assert.match(rule, new RegExp(`--tw-shadow:\\s*var\\(${variable}\\)`), `shadow-[var(${variable})] takes the variable`);
      assert.match(css, new RegExp(`:root\\s*\\{[^}]*${variable}:\\s*\\d`), `${variable} is declared on :root`);
    }
    // The synced calendars' colors are declared on :root too, where a host's own value replaces them.
    for (let n = 1; n <= 6; n++) assert.match(css, new RegExp(`:root\\s*\\{[^}]*--color-calendar-${n}:\\s*#[0-9a-f]{6}`), `--color-calendar-${n}`);
    // A task note's header drags its own window, which in embed mode is the host's.
    assert.match(css, /html\[data-embed\] \.task-note-titlebar\s*\{[^}]*-webkit-app-region:\s*no-drag/);
    console.log("Embed mode: ok (Today and the sign-in page with and without pacedmind-embed=1, the stylesheet's variables)");
  } finally {
    await run.stop();
  }
}

try {
  await sampleData();
} finally {
  // A server may hold its files a moment after it stops.
  for (let i = 0; i < 10; i++) {
    try {
      fs.rmSync(temp, { recursive: true, force: true });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}
