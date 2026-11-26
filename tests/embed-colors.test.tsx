import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { CalendarDetails } from "../src/lib/calendar-sync";
import { calendarSource } from "../src/lib/calendar-source";
import { CalendarSourceBadge } from "../src/components/calendar-source";
import { Dot } from "../src/components/ui";

/*
 * A synced calendar's color as the pages draw it (the badge, and the month view's dot), and what a host's own value
 * does to it. Rendered without the react-server condition, which client components need.
 */

const css = fs.readFileSync(path.resolve(import.meta.dirname, "../src/app/globals.css"), "utf8");
const block = (selector: string) => new RegExp(`\\n${selector.replace(/[[\]"]/g, "\\$&")} \\{\\n([\\s\\S]*?)\\n\\}`).exec(css)?.[1] ?? "";
const declarations = (body: string) => new Map([...body.matchAll(/^\s*(--[a-z0-9-]+):\s*([^;]+);/gm)].map((m) => [m[1], m[2].trim()]));

/** The custom properties a page ends up with: @theme and :root, the light theme's when shown, then the host's `:root`. */
function resolved(theme: "dark" | "light", host = "") {
  const values = new Map([...declarations(block("@theme")), ...declarations(block(":root"))]);
  if (theme === "light") for (const [name, value] of declarations(block('html[data-theme="light"]'))) values.set(name, value);
  for (const [name, value] of declarations(host)) values.set(name, value);
  return values;
}
const backgroundOf = (html: string) => /background:var\((--color-calendar-\d)\)/.exec(html)?.[1];

const synced = (accountName: string): CalendarDetails => ({ source: { calendarId: `cal-${accountName}`, accountName, calendarName: "Work" } } as CalendarDetails);

/** The six colors synced calendars had before they became variables, in the same order. */
const DEFAULTS = ["#5585d9", "#aa74ca", "#d07845", "#3b9a87", "#c36984", "#7f8c42"];

test("synced calendars keep their colors, from variables a host can set", () => {
  // Each of the six, named in :root only, so they're the same in both themes and a host's :root replaces them.
  for (const [i, value] of DEFAULTS.entries()) {
    const name = `--color-calendar-${i + 1}`;
    assert.equal(resolved("dark").get(name), value, name);
    assert.equal(resolved("light").get(name), value, name);
    assert.equal(css.split(`${name}:`).length - 1, 1, `${name} is declared once`);
  }

  // A synced event as the badge and the month view's dot draw it: the variable, never the value.
  const accounts = ["ann@example.com", "ben@example.com", "team@example.org", "Family", "Holidays", "Sports", "Club"];
  const seen = new Set<string>();
  for (const account of accounts) {
    const details = synced(account);
    const color = calendarSource(details).color;
    const badge = backgroundOf(renderToStaticMarkup(<CalendarSourceBadge calendar={details} />));
    const dot = backgroundOf(renderToStaticMarkup(<Dot color={color} size={6} />));
    assert.ok(badge, account);
    assert.equal(dot, badge, account);
    assert.equal(color, `var(${badge})`);
    seen.add(badge!);
    // Without an override, the color it always had for this account (the same hash, the same order).
    let hash = 0;
    for (const char of account) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
    assert.equal(resolved("dark").get(badge!), DEFAULTS[hash % DEFAULTS.length], account);
    // With a host's override on :root, the host's color.
    assert.equal(resolved("dark", `:root {\n  ${badge}: #123456;\n}`).get(badge!), "#123456", account);
  }
  assert.ok(seen.size > 1, "the accounts land on more than one color");

  // PacedMind's own events keep their muted mark.
  assert.equal(calendarSource(undefined).color, "var(--color-mut2)");
});

test("error messages keep Tailwind's red-400 in both themes", () => {
  const red400 = "oklch(70.4% 0.191 22.216)";
  assert.equal(resolved("dark").get("--color-error"), red400);
  assert.equal(resolved("light").get("--color-error"), red400);
  const settings = fs.readFileSync(path.resolve(import.meta.dirname, "../src/components/google-calendar-settings.tsx"), "utf8");
  assert.equal(settings.split('role="alert" className="text-error"').length - 1, 2);
});
