import assert from "node:assert/strict";
import { test } from "node:test";
import { canUsePlanner } from "../src/lib/auth-access";
import { nextStep, safeNext, withNext } from "../src/server/auth-flow";
import type { AuthState } from "../src/server/supabase";

function state(patch: Partial<AuthState> = {}): AuthState {
  return { user: { id: "account" } as AuthState["user"], aal: "aal1", sessionId: "session", factors: [],
    mfaEnabled: false, hasRecoveryCodes: false, clientId: null, amr: [], issuer: null, ...patch };
}

test("an unenrolled account reaches its planner without a setup redirect", () => {
  assert.equal(canUsePlanner(state()), true);
  assert.equal(nextStep(state()), null);
});

test("all enrolled factor types require verification, even without a TOTP shown in this UI", () => {
  const enrolled = state({ mfaEnabled: true });
  assert.equal(canUsePlanner(enrolled), false);
  assert.equal(nextStep(enrolled), "/login/verify");
  assert.equal(canUsePlanner(state({ mfaEnabled: true, aal: "aal2" })), true);
  assert.equal(nextStep(state({ mfaEnabled: true, aal: "aal2" })), null);
});

test("OAuth tokens cannot act as human browser sessions, even after verifying a factor", () => {
  for (const aal of ["aal1", "aal2"] as const) {
    assert.equal(canUsePlanner(state({ clientId: "agent", aal })), false);
    assert.equal(nextStep(state({ clientId: "agent", aal })), "/login");
  }
  assert.equal(canUsePlanner(null), false);
  assert.equal(nextStep(null), "/login");
});

test("verification preserves OAuth consent and account recovery destinations", () => {
  for (const next of ["/oauth/consent?authorization_id=valid_123", "/login/new-password", "/settings/account", "/settings/security"]) {
    assert.equal(safeNext(next), next);
    assert.equal(withNext("/login/verify", next), `/login/verify?next=${encodeURIComponent(next)}`);
  }
  for (const bad of ["https://elsewhere.example", "//elsewhere.example", "/settings/account?next=//elsewhere", "/oauth/consent?authorization_id=x&next=//elsewhere"]) {
    assert.equal(safeNext(bad), "/today");
  }
});
