import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey } from "jose";
import { canUsePlanner } from "../src/lib/auth-access";
import { nextStep } from "../src/server/auth-flow";
import { readSsoConfig, type SsoConfig } from "../src/server/sso-config";
import { verifyIdentityToken } from "../src/server/sso-token";
import {
  FINISH_COOKIE, START_COOKIE, acceptCallback, finishSignIn, startSignIn, type AccountSteps, type Handoff, type SessionSteps,
} from "../src/server/sso";
import { CODE_REUSE_MS, codeFreshUntil } from "../src/server/step-up";
import type { AuthState } from "../src/server/supabase";

/*
 * Signing in through your organisation, without a server: the configuration, every check on the identity token, and
 * the three steps with stand-ins for Supabase. Every key here is made for this run and thrown away.
 */

const ISSUER = "https://issuer.example.test";
const CLIENT = "planner";
const keys = await generateKeyPair("ES256", { extractable: true });
const other = await generateKeyPair("ES256", { extractable: true });
const publicJwk = { ...(await exportJWK(keys.publicKey)), kid: "key-1", alg: "ES256", use: "sig" };
const otherJwk = { ...(await exportJWK(other.publicKey)), kid: "key-2" };

const env = (patch: Record<string, string | undefined> = {}) => ({
  NODE_ENV: "production", SSO_ISSUER: ISSUER, SSO_CLIENT_ID: CLIENT, SSO_AUTHORIZE_URL: `${ISSUER}/authorize`,
  SSO_JWKS: JSON.stringify({ keys: [publicJwk, otherJwk] }), SSO_LABEL: "Example Org", SUPABASE_SECRET_KEY: "test-only-not-a-key",
  ...patch,
});
const config: SsoConfig = readSsoConfig(env())!;

const now = 1_800_000_000;
const NONCE = "n".repeat(43);

type Claims = Record<string, unknown>;
function claims(patch: Claims = {}): Claims {
  return {
    iss: ISSUER, aud: CLIENT, sub: randomUUID(), email: "person@org.example", email_verified: true, name: "A Person",
    amr: ["pwd", "otp"], acr: "aal2", nonce: NONCE, iat: now, exp: now + 120, auth_time: now - 600, jti: randomUUID(), ...patch,
  };
}
async function sign(body: Claims, { key = keys.privateKey, kid = "key-1", alg = "ES256", typ = "JWT" }: { key?: CryptoKey | Uint8Array; kid?: string | null; alg?: string; typ?: string } = {}) {
  const payload = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
  return new SignJWT(payload).setProtectedHeader({ alg, typ, ...(kid === null ? {} : { kid }) }).sign(key);
}
const verify = (token: string, nonce = NONCE, at = now) => verifyIdentityToken(token, config, nonce, at);
/** Claims issued just now, for the steps, which read the real clock. */
function liveClaims(patch: Claims = {}): Claims {
  const at = Math.floor(Date.now() / 1000);
  return claims({ iat: at, exp: at + 120, auth_time: at - 600, ...patch });
}

test("the feature is off with nothing set, and refuses to run half set up or with unsafe values", () => {
  assert.equal(readSsoConfig({}), null);
  assert.equal(readSsoConfig({ NODE_ENV: "production", SUPABASE_SECRET_KEY: "x" }), null);
  assert.deepEqual(config.allowedDomains, []);
  assert.equal(config.keys.length, 2);
  assert.deepEqual(readSsoConfig(env({ SSO_ALLOWED_EMAIL_DOMAINS: " Org.Example ,team.example" }))!.allowedDomains, ["org.example", "team.example"]);
  const refused: Record<string, string | undefined>[] = [
    { SSO_JWKS: undefined }, { SSO_LABEL: undefined }, { SUPABASE_SECRET_KEY: undefined },
    { SSO_ISSUER: "http://issuer.example.test" }, { SSO_ISSUER: `${ISSUER}/` }, { SSO_AUTHORIZE_URL: "https://user:pw@issuer.example.test/a" },
    { SSO_JWKS: "not json" }, { SSO_JWKS: JSON.stringify({ keys: [] }) },
    { SSO_JWKS: JSON.stringify({ keys: [{ ...publicJwk, d: "private" }] }) },
    { SSO_JWKS: JSON.stringify({ keys: [{ ...publicJwk, crv: "P-384" }] }) },
    { SSO_JWKS: JSON.stringify({ keys: [{ ...publicJwk, alg: "RS256" }] }) },
    { SSO_JWKS: JSON.stringify({ keys: [{ ...publicJwk, kid: undefined }] }) },
    { SSO_JWKS: JSON.stringify({ keys: [publicJwk, publicJwk] }) },
    { SSO_ALLOWED_EMAIL_DOMAINS: "not a domain" }, { SSO_LABEL: "<b>Org</b>" }, { SSO_CLIENT_ID: "a b" },
  ];
  for (const patch of refused) assert.throws(() => readSsoConfig(env(patch)), Error, JSON.stringify(patch));
  // Errors name the setting, never the secret key or a key's numbers.
  try {
    readSsoConfig(env({ SSO_JWKS: JSON.stringify({ keys: [{ ...publicJwk, d: "private-part" }] }) }));
  } catch (e) {
    assert.doesNotMatch(String(e), /private-part|test-only-not-a-key/);
  }
  // A local issuer over plain http works only outside production.
  assert.ok(readSsoConfig(env({ NODE_ENV: "development", SSO_ISSUER: "http://127.0.0.1:9000", SSO_AUTHORIZE_URL: "http://127.0.0.1:9000/a" })));
});

test("a genuine token verifies to the person it names", async () => {
  const body = claims();
  const r = await verify(await sign(body));
  assert.ok(r.ok);
  assert.deepEqual(r.identity, {
    issuer: ISSUER, subject: body.sub, email: "person@org.example", name: "A Person", tokenId: body.jti, issuedAt: now, expiresAt: now + 120,
  });
  // Within a minute of clock difference either way.
  assert.ok((await verify(await sign(claims({ iat: now + 50, exp: now + 170, auth_time: now + 50 })))).ok);
  assert.ok((await verify(await sign(claims({ iat: now - 170, exp: now - 50 })))).ok);
});

test("the signature must be ES256 by the key the token names", async () => {
  const hmac = new TextEncoder().encode("a shared secret anyone with the config could know!");
  for (const [why, token] of [
    ["another key under our kid", await sign(claims(), { key: other.privateKey, kid: "key-1" })],
    ["no kid", await sign(claims(), { kid: null })],
    ["an unknown kid", await sign(claims(), { kid: "key-9" })],
    ["HS256", await sign(claims(), { key: hmac, alg: "HS256" })],
    ["not a JWT", await sign(claims(), { typ: "at+jwt" })],
    ["unsigned", `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT", kid: "key-1" })).toString("base64url")}.${Buffer.from(JSON.stringify(claims())).toString("base64url")}.`],
    ["garbage", "a.b.c"],
    ["too long", "x".repeat(9000)],
  ] as const) {
    const r = await verify(token);
    assert.deepEqual(r, { ok: false, code: "token" }, why);
  }
  // The other configured key works for tokens it signed.
  assert.ok((await verify(await sign(claims(), { key: other.privateKey, kid: "key-2" }))).ok);
});

test("every promised claim is checked", async () => {
  const cases: [string, Claims, string][] = [
    ["issuer", { iss: "https://elsewhere.example.test" }, "token"],
    ["audience", { aud: "another-app" }, "token"],
    ["several audiences", { aud: [CLIENT, "another-app"] }, "token"],
    ["expired", { iat: now - 300, exp: now - 180 }, "expired"],
    ["issued in the future", { iat: now + 120, exp: now + 240 }, "token"],
    ["lives too long", { exp: now + 600 }, "token"],
    ["subject not a UUID", { sub: "someone" }, "token"],
    ["no jti", { jti: undefined }, "token"],
    ["no auth_time", { auth_time: undefined }, "token"],
    ["no name", { name: undefined }, "token"],
    ["other nonce", { nonce: "m".repeat(43) }, "nonce"],
    ["unverified email", { email_verified: false }, "email"],
    ["email_verified as text", { email_verified: "true" }, "email"],
    ["upper-case email", { email: "Person@org.example" }, "email"],
    ["no two-factor code", { amr: ["pwd"] }, "two_factor"],
    ["amr not a list", { amr: "otp" }, "two_factor"],
    ["acr aal1", { acr: "aal1" }, "two_factor"],
  ];
  for (const [why, patch, code] of cases) {
    assert.deepEqual(await verify(await sign(claims(patch))), { ok: false, code }, why);
  }
  const limited = { ...config, allowedDomains: ["org.example"] };
  assert.ok((await verifyIdentityToken(await sign(claims()), limited, NONCE, now)).ok);
  assert.deepEqual(await verifyIdentityToken(await sign(claims({ email: "person@sub.org.example" })), limited, NONCE, now), { ok: false, code: "domain" });
});

/* ---------- the steps ---------- */

const ORIGIN = "https://planner.example.test";

function started(next: string | null = "/settings/account", at = Date.now()) {
  const { location, cookie } = startSignIn(config, ORIGIN, next, at);
  const url = new URL(location);
  return { url, cookie, state: url.searchParams.get("state")!, nonce: url.searchParams.get("nonce")! };
}

test("starting sends exactly the agreed request and keeps state and nonce in a __Host- cookie that survives the post back", () => {
  const { url, cookie, state, nonce } = started("/settings/account");
  assert.equal(`${url.origin}${url.pathname}`, `${ISSUER}/authorize`);
  assert.deepEqual([...url.searchParams.keys()].sort(), ["client_id", "nonce", "redirect_uri", "response_mode", "state"]);
  assert.equal(url.searchParams.get("client_id"), CLIENT);
  assert.equal(url.searchParams.get("redirect_uri"), `${ORIGIN}/auth/sso/callback`);
  assert.equal(url.searchParams.get("response_mode"), "form_post");
  assert.match(state, /^[A-Za-z0-9_-]{43}$/);
  assert.match(nonce, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(state, nonce);
  assert.notEqual(started().state, state);
  assert.equal(cookie.name, START_COOKIE);
  assert.ok(cookie.name.startsWith("__Host-"));
  assert.deepEqual(cookie.options, { httpOnly: true, secure: true, sameSite: "none", path: "/", maxAge: 600 });
  // Where to go afterwards is kept only when sign-in may go there.
  const kept = (next: string | null) => JSON.parse(Buffer.from(started(next).cookie.value, "base64url").toString()).next;
  assert.equal(kept("/settings/account"), "/settings/account");
  assert.equal(kept("https://elsewhere.example"), "/today");
  assert.equal(kept("//elsewhere.example"), "/today");
  assert.equal(kept(null), "/today");
});

function accounts(patch: Partial<AccountSteps> = {}) {
  const calls: string[] = [];
  const seen = new Set<string>();
  let created = false;
  const steps: AccountSteps = {
    claimToken: async (id) => { calls.push(`claim ${id}`); if (seen.has(id)) return false; seen.add(id); return true; },
    linkAccount: async () => { calls.push("link"); return { userId: "11111111-1111-4111-8111-111111111111" }; },
    createAccount: async (identity) => { calls.push(`create ${identity.email}`); created = true; },
    signInToken: async (userId) => { calls.push(`token ${userId}`); return "a".repeat(56); },
    ...patch,
  };
  return { steps, calls, created: () => created };
}

test("the callback refuses anything this browser didn't start, before looking at the token", async () => {
  const s = started();
  const token = await sign(liveClaims({ nonce: s.nonce }));
  for (const [why, form, cookie] of [
    ["no cookie", { id_token: token, state: s.state }, undefined],
    ["other state", { id_token: token, state: started().state }, s.cookie.value],
    ["no state", { id_token: token }, s.cookie.value],
    ["forged cookie", { id_token: token, state: s.state }, Buffer.from(JSON.stringify({ state: s.state, nonce: "x", next: "/today", at: Date.now() })).toString("base64url")],
  ] as const) {
    const { steps, calls } = accounts();
    assert.deepEqual(await acceptCallback(form, cookie, config, steps), { ok: false, code: "state" }, why);
    assert.deepEqual(calls, [], why);
  }
  // Ten minutes is all the browser gets at the issuer.
  const old = started(null, Date.now() - 601_000);
  const { steps } = accounts();
  assert.deepEqual(await acceptCallback({ id_token: token, state: old.state }, old.cookie.value, config, steps), { ok: false, code: "state" });
});

test("the issuer refusing, and a token from another sign-in, end there", async () => {
  const s = started();
  const { steps, calls } = accounts();
  assert.deepEqual(await acceptCallback({ error: "access_denied", state: s.state }, s.cookie.value, config, steps), { ok: false, code: "access_denied" });
  assert.deepEqual(await acceptCallback({ error: "server_error", state: s.state }, s.cookie.value, config, steps), { ok: false, code: "unavailable" });
  // The token was made for someone else's sign-in (its nonce): it never signs this browser in.
  assert.deepEqual(await acceptCallback({ id_token: await sign(liveClaims()), state: s.state }, s.cookie.value, config, steps), { ok: false, code: "nonce" });
  assert.deepEqual(calls, []);
});

test("a token signs in once: the account's one-time sign-in waits in a short-lived __Host- cookie", async () => {
  const s = started("/settings/account");
  const body = liveClaims({ nonce: s.nonce });
  const token = await sign(body);
  const { steps, calls } = accounts();
  const r = await acceptCallback({ id_token: token, state: s.state }, s.cookie.value, config, steps);
  assert.ok(r.ok);
  assert.equal(r.cookie.name, FINISH_COOKIE);
  assert.deepEqual(r.cookie.options, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 60 });
  const handoff = JSON.parse(Buffer.from(r.cookie.value, "base64url").toString());
  assert.equal(handoff.userId, "11111111-1111-4111-8111-111111111111");
  assert.equal(handoff.subject, body.sub);
  assert.equal(handoff.verifiedAt, body.iat);
  assert.equal(handoff.next, "/settings/account");
  assert.deepEqual(calls, [`claim ${body.jti}`, "link", "token 11111111-1111-4111-8111-111111111111"]);
  // The same token again, even through a new start in the same browser: refused, and no account is touched.
  const again = started();
  const replay = await sign({ ...body, nonce: again.nonce });
  calls.length = 0;
  const { jti } = body;
  assert.deepEqual(await acceptCallback({ id_token: replay, state: again.state }, again.cookie.value, config, steps), { ok: false, code: "replayed" });
  assert.deepEqual(calls, [`claim ${jti}`]);
});

test("accounts: a new person gets a confirmed account, and a refused link stops the sign-in", async () => {
  const fresh = () => {
    const s = started();
    return sign(liveClaims({ nonce: s.nonce })).then((t) => ({ s, t }));
  };
  let asked = 0;
  const created = accounts({ linkAccount: async () => (asked++ === 0 ? { userId: null } : { userId: "22222222-2222-4222-8222-222222222222" }) });
  const one = await fresh();
  const r = await acceptCallback({ id_token: one.t, state: one.s.state }, one.s.cookie.value, config, created.steps);
  assert.ok(r.ok);
  assert.equal(created.created(), true);
  assert.ok(created.calls.includes("create person@org.example"));
  for (const refused of ["account_linked", "account_unconfirmed", "account_ambiguous"] as const) {
    const blocked = accounts({ linkAccount: async () => ({ refused }) });
    const two = await fresh();
    assert.deepEqual(await acceptCallback({ id_token: two.t, state: two.s.state }, two.s.cookie.value, config, blocked.steps), { ok: false, code: refused });
    assert.ok(!blocked.calls.some((c) => c.startsWith("token") || c.startsWith("create")));
  }
});

function handoffCookie(patch: Partial<Handoff> & { at?: number } = {}) {
  return Buffer.from(JSON.stringify({
    hashedToken: "a".repeat(56), userId: "11111111-1111-4111-8111-111111111111", issuer: ISSUER, subject: randomUUID(),
    verifiedAt: Math.floor(Date.now() / 1000), next: "/today", at: Date.now(), ...patch,
  })).toString("base64url");
}

function sessions(patch: Partial<SessionSteps> = {}) {
  const calls: string[] = [];
  const steps: SessionSteps = {
    replaceSession: async (hashed, userId) => { calls.push(`replace ${userId}`); return "33333333-3333-4333-8333-333333333333"; },
    markSession: async (sessionId) => { calls.push(`mark ${sessionId}`); },
    endSession: async () => { calls.push("end"); },
    ...patch,
  };
  return { steps, calls };
}

test("the finish makes and marks the session, and ends it when it can't be marked", async () => {
  const ok = sessions();
  assert.deepEqual(await finishSignIn(handoffCookie({ next: "/settings/account" }), ok.steps), { ok: true, next: "/settings/account" });
  assert.deepEqual(ok.calls, ["replace 11111111-1111-4111-8111-111111111111", "mark 33333333-3333-4333-8333-333333333333"]);
  for (const [why, value] of [
    ["none", undefined], ["stale", handoffCookie({ at: Date.now() - 61_000 })], ["bad user", handoffCookie({ userId: "x" })],
    ["bad token", handoffCookie({ hashedToken: "<script>" })], ["garbage", "%%%"],
  ] as const) {
    const s = sessions();
    assert.deepEqual(await finishSignIn(value, s.steps), { ok: false, code: "state" }, why);
    assert.deepEqual(s.calls, [], why);
  }
  assert.deepEqual(await finishSignIn(handoffCookie({ next: "https://elsewhere.example" }), sessions().steps), { ok: true, next: "/today" });
  const unmarked = sessions({ markSession: async () => { throw new Error("Marking the session failed."); } });
  await assert.rejects(finishSignIn(handoffCookie(), unmarked.steps), /Marking/);
  assert.deepEqual(unmarked.calls, ["replace 11111111-1111-4111-8111-111111111111", "end"]);
});

/* ---------- what such a session is allowed ---------- */

function state(patch: Partial<AuthState> = {}): AuthState {
  return { user: { id: "account" } as AuthState["user"], aal: "aal1", sessionId: "session", factors: [],
    mfaEnabled: true, hasRecoveryCodes: false, clientId: null, amr: [], issuer: null, ...patch };
}

test("an issuer session counts as two-factor, and its round-trip as the fresh check", () => {
  const at = Date.now() - 60_000;
  const viaIssuer = state({ aal: "aal2", issuer: { verifiedAt: at } });
  assert.equal(canUsePlanner(viaIssuer), true);
  assert.equal(nextStep(viaIssuer), null);
  assert.equal(codeFreshUntil(viaIssuer), at + CODE_REUSE_MS);
  // A TOTP timestamp in the token doesn't extend it: the issuer's round-trip is the only check such a session has.
  assert.equal(codeFreshUntil(state({ aal: "aal2", issuer: { verifiedAt: at }, amr: [{ method: "totp", timestamp: Math.floor(Date.now() / 1000) }] })), at + CODE_REUSE_MS);
  assert.equal(codeFreshUntil(state()), null);
});
