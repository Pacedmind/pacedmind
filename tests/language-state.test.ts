import assert from "node:assert/strict";
import { test } from "node:test";
import { createLanguageState } from "../src/lib/language-state";

test("language changes publish synchronously without waiting for server rendering", () => {
  const state = createLanguageState();
  const rendered: string[] = [];
  state.subscribe(() => rendered.push(state.get("en")));
  assert.equal(state.get("pl"), "pl");
  assert.equal(state.set("pl"), true);
  assert.deepEqual(rendered, ["pl"]);
  assert.equal(state.get("en"), "pl", "An older server response cannot undo the choice");
  state.set("en");
  assert.equal(state.get("pl"), "en");
  assert.deepEqual(rendered, ["pl", "en"]);
});

test("desktop and browser echoes trigger only one update and invalid messages are ignored", () => {
  const state = createLanguageState();
  let updates = 0;
  const unsubscribe = state.subscribe(() => updates++);
  assert.equal(state.set("pl"), true);
  for (const echo of ["pl", "pl", null, undefined, "PL", "de", { language: "en" }]) assert.equal(state.set(echo), false);
  assert.equal(updates, 1);
  unsubscribe();
  state.set("en");
  assert.equal(updates, 1);
});
