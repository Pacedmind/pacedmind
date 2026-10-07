// The PacedMind plugin (plugins/pacedmind) for the Claude and OpenAI plugin directories: copies the agent skills
// (skills/) and the license into it, checks it against both directories' rules, and builds the ZIP that OpenAI's
// plugin portal takes (Codex format). The folder itself is what Claude's directory reads from GitHub.
//
//   npm run plugins                          sync, check and build dist/plugins/pacedmind-openai-<version>.zip
//   npm run plugins -- --check               only check that the folder is in sync and valid (CI)
//   npm run plugins -- --demo-url <https>    also put the review's demo recording into the ZIP's manifest
//
// The rules come from developers.openai.com/plugins/deploy/submission-errors and
// claude.com/docs/plugins/pre-submission-checklist; deploy/directory/ has the rest of the submission.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const root = path.resolve(import.meta.dirname, "..");
const plugin = path.join(root, "plugins", "pacedmind");
const checkOnly = process.argv.includes("--check");
const demoAt = process.argv.indexOf("--demo-url");
const demoUrl = demoAt > 0 ? process.argv[demoAt + 1] : null;

const problems = [];
const problem = (text) => problems.push(text);
const rel = (file) => path.relative(root, file).split(path.sep).join("/");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const text = (file) => fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");

/** Every file under a folder, as paths relative to it with forward slashes, sorted. */
function files(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`${rel(full)}: symbolic links can't go into a plugin`);
    return entry.isDirectory() ? files(full, base) : [path.relative(base, full).split(path.sep).join("/")];
  }).sort();
}

/* ---------- the copies: skills/ and LICENSE ---------- */

// A text file counts as the same whatever its line endings, so a checkout on Windows doesn't look out of date.
const same = (a, b) => fs.existsSync(a) && fs.existsSync(b) && (fs.readFileSync(a).equals(fs.readFileSync(b)) || text(a) === text(b));

const copies = [
  ...files(path.join(root, "skills")).map((f) => [path.join(root, "skills", f), path.join(plugin, "skills", f)]),
  [path.join(root, "LICENSE"), path.join(plugin, "LICENSE")],
];
const stale = files(path.join(plugin, "skills")).filter((f) => !fs.existsSync(path.join(root, "skills", f)));
if (checkOnly) {
  for (const [from, to] of copies) if (!same(from, to)) problem(`${rel(to)} differs from ${rel(from)}: run npm run plugins`);
  for (const f of stale) problem(`plugins/pacedmind/skills/${f} isn't in skills/: run npm run plugins`);
} else {
  for (const [from, to] of copies) {
    if (same(from, to)) continue;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    console.log(`copied ${rel(from)} -> ${rel(to)}`);
  }
  for (const f of stale) {
    fs.rmSync(path.join(plugin, "skills", f));
    console.log(`removed plugins/pacedmind/skills/${f}`);
  }
}

/* ---------- checks ---------- */

const claude = readJson(path.join(plugin, ".claude-plugin", "plugin.json"));
const codex = readJson(path.join(plugin, ".codex-plugin", "plugin.json"));
const marketplace = readJson(path.join(root, ".claude-plugin", "marketplace.json"));
const mcp = readJson(path.join(plugin, ".mcp.json"));
const ui = codex.interface ?? {};
const review = codex.extensions?.["com.openai"]?.review ?? {};
const publication = codex.extensions?.["com.openai"]?.publication ?? {};

// Single-line text without control characters or Unicode line and paragraph separators.
const oneLine = (s) => typeof s === "string" && s.trim() !== "" && !/[\u0000-\u001f\u007f\u2028\u2029]/.test(s);
const supported = (s) => typeof s === "string" && s.trim() !== "" && !/[\u0000-\u0009\u000b-\u001f\u007f\u2028\u2029]/.test(s);
const https = (s) => { try { const u = new URL(s); return u.protocol === "https:" && !u.username && !u.password; } catch { return false; } };
function line(name, value, max) {
  if (!oneLine(value)) problem(`${name} must be one non-empty line`);
  else if (value.length > max) problem(`${name} is ${value.length} characters; at most ${max}`);
}
function block(name, value, max) {
  if (!supported(value)) problem(`${name} must be non-empty supported text`);
  else if (value.length > max) problem(`${name} is ${value.length} characters; at most ${max}`);
}

// Package identity: one name and version everywhere.
for (const [where, m] of [["Claude manifest", claude], ["Codex manifest", codex]]) {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(m.name ?? "")) problem(`${where}: name must be lowercase letters, digits and hyphens`);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(m.version ?? "")) problem(`${where}: version must be semver`);
  block(`${where}: description`, m.description, 1024);
  line(`${where}: author.name`, m.author?.name, 120);
  if (m.homepage && !https(m.homepage)) problem(`${where}: homepage must be https`);
}
if (claude.name !== codex.name || claude.version !== codex.version) problem("the Claude and Codex manifests must share name and version");
const listed = marketplace.plugins?.find((p) => p.name === claude.name);
if (!listed) problem(".claude-plugin/marketplace.json doesn't list the plugin");
else if (listed.source !== "./plugins/pacedmind") problem("marketplace.json: source must be ./plugins/pacedmind");
else if (listed.version && listed.version !== claude.version) problem("marketplace.json: version differs from the plugin's");

// The remote MCP server: one, over https, for both directories.
const servers = Object.entries(mcp.mcpServers ?? {});
if (servers.length !== 1) problem(".mcp.json must declare exactly one MCP server");
const [serverName, server] = servers[0] ?? [];
if (!server || server.type !== "http" || !https(server.url)) problem(".mcp.json: the server needs type http and an https url");
if (codex.mcpServers !== "./.mcp.json" || codex.skills !== "./skills/") problem("Codex manifest: skills must be ./skills/ and mcpServers ./.mcp.json");

// OpenAI's listing (interface).
line("interface.displayName", ui.displayName, 30);
line("interface.shortDescription", ui.shortDescription, 30);
block("interface.longDescription", ui.longDescription, 4000);
line("interface.developerName", ui.developerName, 80);
const CATEGORIES = ["Productivity", "Creativity", "Developer Tools", "Business & Operations", "Data & Analytics", "Communication",
  "Education & Research", "Security", "Finance", "Healthcare", "Travel", "Entertainment", "Other"];
if (!CATEGORIES.includes(ui.category)) problem(`interface.category must be one of ${CATEGORIES.join(", ")}`);
if (!Array.isArray(ui.capabilities) || ui.capabilities.length > 20) problem("interface.capabilities: a list of at most 20");
for (const c of ui.capabilities ?? []) line(`capability "${c}"`, c, 120);
for (const key of ["websiteURL", "supportURL", "privacyPolicyURL", "termsOfServiceURL"]) {
  if (!https(ui[key]) || ui[key].length > 1024) problem(`interface.${key} must be an https URL`);
}
const prompts = [ui.defaultPrompt ?? []].flat();
if (prompts.length > 3) problem("interface.defaultPrompt: at most 3");
for (const p of prompts) {
  line(`starter prompt "${p}"`, p, 128);
  if (/@\w/.test(p)) problem(`starter prompt "${p}" must not @mention`);
}
const norm = (s) => s.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
if (new Set(prompts.map(norm)).size !== prompts.length) problem("starter prompts must be unique");

// Brand colors: 2:1 against white (light) and against #212121 (dark).
function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
for (const [key, against] of [["brandColor", "#FFFFFF"], ["brandColorDark", "#212121"]]) {
  const color = ui[key];
  if (color === undefined) continue;
  if (!/^#[0-9A-Fa-f]{6}$/.test(color)) problem(`interface.${key} must be #RRGGBB`);
  else if (contrast(color, against) < 2) problem(`interface.${key} needs 2:1 contrast against ${against}`);
}

// Icons: square PNGs, 48 to 4096 pixels, at most 5 MiB, inside the plugin.
for (const key of ["logo", "logoDark", "composerIcon", "composerIconDark"]) {
  const at = ui[key];
  if (at === undefined) { if (key === "logo" || key === "composerIcon") problem(`interface.${key} is required`); continue; }
  if (!/^\.\/assets\/[\w.-]+\.png$/.test(at)) { problem(`interface.${key} must be ./assets/<name>.png`); continue; }
  const file = path.join(plugin, at);
  if (!fs.existsSync(file)) { problem(`interface.${key}: ${at} is missing (npm run icons)`); continue; }
  const png = fs.readFileSync(file);
  const [w, h] = [png.readUInt32BE(16), png.readUInt32BE(20)];
  if (png.toString("latin1", 1, 4) !== "PNG" || w !== h || w < 48 || w > 4096 || png.length > 5 * 1024 * 1024) {
    problem(`${at} must be a square PNG of 48 to 4096 pixels`);
  }
}
if (ui.screenshots) problem("interface.screenshots: OpenAI allows screenshots only with a custom UI, which PacedMind's tools don't have");

// OpenAI's review: five positive and three negative cases, no credentials, a declared commerce answer.
const positive = review.test_cases?.positive ?? [];
const negative = review.test_cases?.negative ?? [];
if (positive.length !== 5 || negative.length !== 3) problem("review.test_cases: exactly 5 positive and 3 negative cases");
for (const c of positive) {
  block(`positive case "${c.description}"`, c.description, 4000);
  for (const key of ["prompt", "tools_triggered", "expected_behavior"]) if (!supported(c[key])) problem(`positive case "${c.description}": ${key} is required`);
}
for (const c of negative) if (!supported(c.description) || !supported(c.prompt)) problem("negative cases need a description and a prompt");
if (/test_credentials|reviewer_instructions/.test(JSON.stringify(codex))) problem("credentials and reviewer instructions go in the portal, never in the package");
if (review.commerce !== false) problem("review.commerce must be false: PacedMind's tools sell nothing");
for (const [locale, t] of Object.entries(publication.translations ?? {})) {
  if (t.subtitle != null) line(`${locale} subtitle`, t.subtitle, 30);
  if (t.description != null) block(`${locale} description`, t.description, 4000);
}
if (demoUrl && !https(demoUrl)) problem("--demo-url must be an https URL");

// Skills: valid front matter, unique names, plugin-name:skill-name within 64 characters.
const skills = fs.readdirSync(path.join(root, "skills")).filter((n) => fs.existsSync(path.join(root, "skills", n, "SKILL.md")));
for (const name of skills) {
  const front = /^---\n([\s\S]*?)\n---\n/.exec(text(path.join(root, "skills", name, "SKILL.md")))?.[1] ?? "";
  const field = (key) => new RegExp(`^${key}: (.+)$`, "m").exec(front)?.[1]?.trim();
  if (field("name") !== name) problem(`skills/${name}/SKILL.md: name must be ${name}`);
  block(`skills/${name} description`, field("description"), 1024);
  if (`${claude.name}:${name}`.length > 64) problem(`${claude.name}:${name} is longer than 64 characters`);
}

// What Claude's directory scans: regular, small files only, and no system files.
for (const f of files(plugin)) {
  const size = fs.statSync(path.join(plugin, f)).size;
  if (/(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini|__MACOSX)$/i.test(f)) problem(`plugins/pacedmind/${f}: system files can't go into the plugin`);
  if (!/\.(png|md|json)$/.test(f) && f !== "LICENSE") problem(`plugins/pacedmind/${f}: only Markdown, JSON, PNG and LICENSE belong here`);
  if (!f.endsWith(".png") && size > 256 * 1024) problem(`plugins/pacedmind/${f} is over 256 KiB`);
}

if (problems.length) {
  console.error(`The plugin isn't ready:\n- ${problems.join("\n- ")}`);
  process.exit(1);
}
if (checkOnly) {
  console.log(`plugins/pacedmind ${claude.version} is in sync and valid (${skills.length} skills, MCP server ${serverName}).`);
  process.exit(0);
}

/* ---------- OpenAI's ZIP ---------- */

/** A ZIP of [path, bytes] entries, deflated, with a fixed date so the same input gives the same file. */
function zip(entries) {
  const DOS_TIME = 0;
  const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const crc = zlib.crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, deflated);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4); // made by: Unix, so the mode below counts
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(deflated.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // a regular file, rw-r--r--
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + deflated.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

// The Codex manifest, with the demo recording when it's given; .mcp.json in the Codex form (just the URL). The Claude
// manifest stays out: the portal takes exactly one plugin root.
const manifest = structuredClone(codex);
if (demoUrl) manifest.extensions["com.openai"].review.demo_recording_url = demoUrl;
const json = (value) => Buffer.from(JSON.stringify(value, null, 2) + "\n");
const entries = [
  [".codex-plugin/plugin.json", json(manifest)],
  [".mcp.json", json({ mcpServers: { [serverName]: { url: server.url } } })],
  ["README.md", Buffer.from(text(path.join(plugin, "README.md")))],
  ["LICENSE", Buffer.from(text(path.join(plugin, "LICENSE")))],
  ...files(path.join(plugin, "assets")).map((f) => [`assets/${f}`, fs.readFileSync(path.join(plugin, "assets", f))]),
  ...files(path.join(plugin, "skills")).map((f) => [`skills/${f}`, Buffer.from(text(path.join(plugin, "skills", f)))]),
];
const out = path.join(root, "dist", "plugins", `${codex.name}-openai-${codex.version}.zip`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, zip(entries));
console.log(`wrote ${rel(out)} (${entries.length} files, ${fs.statSync(out).size} bytes)${demoUrl ? "" : "; the demo recording's URL goes into the portal, or rebuild with --demo-url"}`);
