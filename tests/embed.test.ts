import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import { EMBED_COOKIE, isEmbedCookie, navLink } from "../src/lib/embed";
import { THEME_INIT_SCRIPT } from "../src/lib/theme";

/** The hosted app's proxy, with a Supabase address on this computer that nothing answers: no request leaves it. */
async function hosted() {
  process.env.ORGANIZER_MODE = "web";
  process.env.SUPABASE_URL = "http://127.0.0.1:9";
  process.env.SUPABASE_PUBLISHABLE_KEY = "sb_publishable_test";
  const [{ proxy }, { NextRequest }] = await Promise.all([import("../src/proxy"), import("next/server")]);
  return { proxy, request: (url: string, init?: { headers: Record<string, string> }) => new NextRequest(url, init) };
}

const root = path.resolve(import.meta.dirname, "..");

test("only pacedmind-embed=1 switches embed mode on", () => {
  assert.equal(EMBED_COOKIE, "pacedmind-embed");
  assert.equal(isEmbedCookie("1"), true);
  for (const value of [undefined, "", "0", "true", "1 ", "yes"]) assert.equal(isEmbedCookie(value), false);
});

test("sidebar links carry the names a host reads them by", () => {
  assert.deepEqual(navLink("view", "Inbox", { count: 3 }), { "data-pm": "nav-link", "data-pm-kind": "view", "data-pm-label": "Inbox", "data-pm-count": "3" });
  // No count shown, no count named.
  assert.deepEqual(navLink("todos", "To-dos", { count: 0 }), { "data-pm": "nav-link", "data-pm-kind": "todos", "data-pm-label": "To-dos" });
  assert.deepEqual(navLink("area", "Work", { shared: true }), { "data-pm": "nav-link", "data-pm-kind": "area", "data-pm-label": "Work", "data-pm-shared": "" });
  assert.deepEqual(navLink("area", "Home", { shared: false }), { "data-pm": "nav-link", "data-pm-kind": "area", "data-pm-label": "Home" });
  // The sidebar names its wrapper and every kind of link, in and out of embed mode, and hides the wrapper only in it.
  const sidebar = fs.readFileSync(path.join(root, "src/components/sidebar.tsx"), "utf8");
  assert.match(sidebar, /<div data-pm="sidebar" hidden=\{embedded\}/);
  // Each kind of link with what it shows: the count next to it, the mark of an area shared with a team workspace
  // (which the sample data has none of, so no page test sees it).
  for (const link of [
    'navLink("view", n.label, { count: n.count && counts[n.count] })',
    'navLink("area", a.name, { shared: Boolean(a.workspaceId) })',
    'navLink("todos", tx("To-dos"), { count: usage.areas[a.id]?.loose })',
    'navLink("project", p.name)',
    'navLink("settings", tx("Settings"))',
  ]) assert.ok(sidebar.includes(link), link);
  // Areas and projects hand their names to the row, which puts them on its link.
  assert.equal(sidebar.split("pm={navLink(").length - 1, 2);
  assert.match(sidebar, /<Link href=\{href\}[^>]*\{\.\.\.pm\}/);
});

/** What the theme script leaves on the document, with this saved theme, system theme and document attributes. */
function themeAfterScript(saved: string | null, systemDark: boolean, attributes: Record<string, string>) {
  const document = {
    documentElement: { dataset: { theme: "dark" } as Record<string, string>, hasAttribute: (name: string) => name in attributes },
  };
  const window = { pacedMindDesktop: undefined };
  const localStorage = { getItem: () => saved };
  const matchMedia = () => ({ matches: systemDark });
  vm.runInNewContext(THEME_INIT_SCRIPT, { document, window, localStorage, matchMedia });
  return document.documentElement.dataset.theme;
}

test("embed mode stays dark whatever the person chose; without it their choice counts", () => {
  assert.equal(themeAfterScript("light", false, { "data-embed": "" }), "dark");
  assert.equal(themeAfterScript("system", false, { "data-embed": "" }), "dark");
  assert.equal(themeAfterScript("light", false, {}), "light");
  assert.equal(themeAfterScript("system", false, {}), "light");
  assert.equal(themeAfterScript(null, false, {}), "dark");
});

const withoutNonce = (csp: string | null) => csp?.replace(/'nonce-[^']+'/, "'nonce'");

test("embed mode keeps every security header: no frames, the nonce policy", async () => {
  const { proxy, request } = await hosted();
  for (const page of ["/login", "/today", "/project/p1"]) {
    const plain = await proxy(request(`https://app.example${page}`));
    const embedded = await proxy(request(`https://app.example${page}`, { headers: { cookie: `${EMBED_COOKIE}=1` } }));
    assert.equal(embedded.status, plain.status, page);
    for (const header of ["X-Frame-Options", "X-Content-Type-Options", "Referrer-Policy", "Permissions-Policy", "Cross-Origin-Opener-Policy",
      "Cross-Origin-Resource-Policy", "Strict-Transport-Security"]) {
      assert.equal(embedded.headers.get(header), plain.headers.get(header), `${page} ${header}`);
    }
    const csp = embedded.headers.get("Content-Security-Policy");
    assert.equal(withoutNonce(csp), withoutNonce(plain.headers.get("Content-Security-Policy")));
    assert.match(csp ?? "", /frame-ancestors 'none'/);
    assert.match(csp ?? "", /script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
    assert.equal(embedded.headers.get("X-Frame-Options"), "DENY");
  }
});

/*
 * Colors on the app's pages and the sign-in pages come from the variables in globals.css, so a host's override (embed
 * mode) reaches everything. Data colors (areas', projects', a picture's) are the person's own and come as values.
 */
const COLOR = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(|\b(?:bg|text|border|ring|fill|stroke|from|via|to|shadow|outline|divide|decoration|caret|accent|placeholder)-(?:white|black|(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3})\b/;
/** A color by its CSS name, as an SVG attribute (`fill="white"`) or a style's value (`color: "black"`, `1px solid red`). */
const NAMED = "white|black|red|green|blue|yellow|orange|purple|pink|gr[ae]y|silver|gold|navy|teal|maroon|olive|lime|aqua|cyan|magenta|fuchsia|brown|beige|ivory|indigo|violet";
const NAMED_COLOR = new RegExp(`\\b(?:fill|stroke|color|stopColor|floodColor|lightingColor)=\\{?["'\`](?:${NAMED})["'\`]`
  + `|\\b(?:color|background|backgroundColor|fill|stroke|boxShadow|textShadow|filter|caretColor|accentColor|outline|outlineColor|textDecorationColor|columnRuleColor|border(?:Top|Right|Bottom|Left|Block|Inline)?(?:Color)?)\\s*:\\s*["'\`][^"'\`]*\\b(?:${NAMED})\\b`);
/** The words of a line of code as a class list has them: between quotes and spaces, without its comments. */
const classNames = (line: string) => (/^\s*(?:\/?\*|\/\/)/.test(line) ? "" : line.replace(/\/\*.*?\*\//g, "").replace(/\s\/\/\s.*$/, ""))
  .split(/["'`\s]+/).filter(Boolean);
/**
 * A class's shadow: the variable it takes (`shadow-[var(--shadow-popover)]` gives `--shadow-popover`), `own` for one
 * of Tailwind's sizes or a value of its own, which write a color into the stylesheet, or null for no shadow at all.
 */
function shadowOf(cls: string): string | null {
  const shadow = /^(?:[\w-]+:)*(?:inset-|drop-|text-)?shadow(?:-(.*))?$/.exec(cls);
  if (!shadow || shadow[1] === "none") return null;
  return /^\[var\((--shadow-[a-z0-9-]+)\)\]$/.exec(shadow[1] ?? "")?.[1] ?? "own";
}
/** Not part of a page's look: brand marks drawn in their owners' colors, and pages and images with no stylesheet. */
const COLOR_EXCEPTIONS = new Map([
  ["src/app/globals.css", "the variables themselves"],
  ["src/app/manifest.ts", "the installed web app's colors, for the system"],
  ["src/app/auth/native/route.ts", "a page of its own for the phone app's browser, without the app's stylesheet"],
  ["src/app/api/attachments/[id]/route.ts", "a placeholder image"],
  ["src/components/tool-icon-paths.ts", "brand marks"],
  ["src/components/area-icon-paths.ts", "icon shapes"],
  ["src/lib/colors.ts", "the colors areas and projects can be given: the person's own, stored with them"],
]);
const GOOGLE_MARK = /function GoogleMark\(\) \{[\s\S]*?\n\}\n/;

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? files(file) : /\.(tsx?|css)$/.test(entry.name) ? [file] : [];
  });
}

test("the pages take their colors from globals.css", () => {
  const found: string[] = [];
  const shadows = new Set<string>();
  for (const file of ["src/app", "src/components", "src/lib"].flatMap((dir) => files(path.join(root, dir)))) {
    const name = path.relative(root, file).split(path.sep).join("/");
    if (COLOR_EXCEPTIONS.has(name)) continue;
    // Google's "G" keeps Google's colors, as its sign-in branding asks.
    const source = fs.readFileSync(file, "utf8").replace(GOOGLE_MARK, "");
    source.split("\n").forEach((line, i) => {
      if (COLOR.test(line) || NAMED_COLOR.test(line)) found.push(`${name}:${i + 1}: ${line.trim().slice(0, 120)}`);
      for (const cls of classNames(line)) {
        const shadow = shadowOf(cls);
        if (shadow?.startsWith("--")) shadows.add(shadow);
        else if (shadow) found.push(`${name}:${i + 1}: ${cls}`);
      }
    });
  }
  assert.deepEqual(found, []);
  // Each shadow in use is a variable of :root, where a host's own value replaces it. (Declared in @theme instead, a
  // shadow becomes a class with its color written out.)
  const css = fs.readFileSync(path.join(root, "src/app/globals.css"), "utf8");
  const rootBlock = /\n:root \{\n([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
  const theme = /@theme \{\n([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
  assert.deepEqual([...shadows].sort(), ["--shadow-lg", "--shadow-popover", "--shadow-sm"]);
  for (const shadow of shadows) assert.match(rootBlock, new RegExp(`^\\s*${shadow}: `, "m"), shadow);
  assert.doesNotMatch(theme, /--(?:inset-|drop-|text-)?shadow-/);
  assert.deepEqual((css.match(/--shadow-[a-z0-9-]+(?=:)/g) ?? []).filter((v) => !shadows.has(v)), [], "a shadow no page uses");
});

test("the color check sees colors by name and shadows that aren't variables", () => {
  for (const line of ['<path fill="white" />', "<circle stroke={'black'} />", 'style={{ color: "red" }}', 'style={{ border: "1px solid gray" }}',
    "style={{ boxShadow: `0 1px 2px black` }}"]) assert.ok(NAMED_COLOR.test(line), line);
  for (const line of ['<path fill="currentColor" />', 'stroke="none"', 'style={{ color: "var(--color-fg)" }}', 'style={{ background: a.color }}',
    'const color = "blue";', 'tx("Paint it black")']) assert.ok(!NAMED_COLOR.test(line), line);
  assert.deepEqual(classNames('<div className="p-4 md:shadow-[var(--shadow-popover)]"> {/* Its shadow covers the row. */}'),
    ["<div", "className=", "p-4", "md:shadow-[var(--shadow-popover)]", ">", "{}"]);
  assert.deepEqual(classNames("  // A shadow under the card."), []);
  assert.deepEqual(classNames("   * The shadow of the panel."), []);
  // Put together here, never written out: Tailwind reads this file too, and a class it finds goes into the stylesheet.
  const named = (prefix: string, size: string) => `${prefix}shadow${size && `-${size}`}`;
  for (const prefix of ["", "md:hover:", "inset-", "drop-", "text-"]) {
    for (const size of ["", "2xs", "xs", "sm", "md", "lg", "xl", "2xl", "[0_1px_2px_var(--color-line)]"]) assert.equal(shadowOf(named(prefix, size)), "own", named(prefix, size));
  }
  assert.equal(shadowOf("md:shadow-[var(--shadow-popover)]"), "--shadow-popover");
  for (const none of [named("", "none"), named("box-", ""), named("transition-", ""), "p-4"]) assert.equal(shadowOf(none), null, none);
});
