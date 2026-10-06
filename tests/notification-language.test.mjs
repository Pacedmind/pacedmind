import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import vm from "node:vm";

test("push titles follow the saved browser language across worker restarts and preserve user text", async () => {
  const listeners = {}, cache = new Map(), notifications = [];
  const context = {
    URL, Response,
    caches: { open: async () => ({ match: async key => cache.get(key)?.clone(), put: async (key, value) => cache.set(key, value) }) },
    self: { location: { origin: "https://app.pacedmind.com" }, addEventListener: (kind, fn) => { listeners[kind] = fn; },
      registration: { showNotification: async (title, options) => { notifications.push({ title, options }); } } },
  };
  const source = fs.readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
  const restart = () => vm.runInNewContext(source, context);
  const fire = async (kind, event) => { let pending; listeners[kind]({ ...event, waitUntil: p => { pending = p; } }); await pending; };
  const push = () => fire("push", { data: { json: () => ({ title: "WRK-12 is waiting for you", body: "Today — własny tytuł użytkownika", path: "/sessions?s=test" }) } });
  restart();
  await push();
  assert.equal(notifications.at(-1).title, "WRK-12 is waiting for you");
  await fire("message", { source: { url: "https://app.pacedmind.com/today" }, data: { kind: "pacedmind-language", language: "pl" } });
  restart();
  await push();
  assert.equal(notifications.at(-1).title, "WRK-12 czeka na Ciebie");
  assert.equal(notifications.at(-1).options.body, "Today — własny tytuł użytkownika");
  await fire("message", { source: { url: "https://example.com" }, data: { kind: "pacedmind-language", language: "en" } });
  await push();
  assert.equal(notifications.at(-1).title, "WRK-12 czeka na Ciebie");
  await fire("message", { source: { url: "https://app.pacedmind.com/settings" }, data: { kind: "pacedmind-language", language: "en" } });
  await push();
  assert.equal(notifications.at(-1).title, "WRK-12 is waiting for you");
});
