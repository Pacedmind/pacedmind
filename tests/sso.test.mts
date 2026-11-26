import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey } from "jose";
import { readFileSync } from "node:fs";
import { canUsePlanner } from "../src/lib/auth-access";
import { ssoConfirmHref, ssoStartHref } from "../src/lib/sso";
import { nextStep } from "../src/server/auth-flow";
import { readSsoConfig, type SsoConfig } from "../src/server/sso-config";
import { verifyIdentityToken } from "../src/server/sso-token";
import {
  FINISH_COOKIE, FRESH_MAX_AGE, START_COOKIE, acceptCallback, finishSignIn, startSignIn, type AccountSteps, type OpenedHandoff, type SessionSteps,
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

const ORIGIN = "https://planner.example.test";
const env = (patch: Record<string, string | undefined> = {}) => ({
  NODE_ENV: "production", ORGANIZER_PUBLIC_ORIGIN: ORIGIN, SSO_ISSUER: ISSUER, SSO_CLIENT_ID: CLIENT, SSO_AUTHORIZE_URL: `${ISSUER}/authorize`,
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
    // No address to send the issuer back to, or one it shouldn't post a token to.
    { ORGANIZER_PUBLIC_ORIGIN: undefined }, { ORGANIZER_PUBLIC_ORIGIN: "http://planner.example.test" },
    { ORGANIZER_PUBLIC_ORIGIN: `${ORIGIN}/app` },
  ];
  for (const patch of refused) assert.throws(() => readSsoConfig(env(patch)), Error, JSON.stringify(patch));
  assert.throws(() => readSsoConfig(env({ ORGANIZER_PUBLIC_ORIGIN: undefined })), /ORGANIZER_PUBLIC_ORIGIN/);
  assert.equal(readSsoConfig(env({ ORGANIZER_PUBLIC_ORIGIN: `${ORIGIN}/` }))!.publicOrigin, ORIGIN);
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
    issuer: ISSUER, subject: body.sub, email: "person@org.example", name: "A Person", tokenId: body.jti, issuedAt: now,
    authTime: now - 600, expiresAt: now + 120,
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
    ["auth_time in the future", { auth_time: now + 61 }, "token"],
    ["no name", { name: undefined }, "token"],
    ["name too long", { name: "n".repeat(201) }, "token"],
    ["other nonce", { nonce: "m".repeat(43) }, "nonce"],
    ["unverified email", { email_verified: false }, "email"],
    ["email_verified as text", { email_verified: "true" }, "email"],
    ["upper-case email", { email: "Person@org.example" }, "email"],
    // Each part within its own limit, the whole address over the 254 characters an address may have.
    ["email too long", { email: `${"p".repeat(64)}@${"d".repeat(185)}.example` }, "email"],
    ["no two-factor code", { amr: ["pwd"] }, "two_factor"],
    ["amr not a list", { amr: "otp" }, "two_factor"],
    ["acr aal1", { acr: "aal1" }, "two_factor"],
  ];
  for (const [why, patch, code] of cases) {
    assert.deepEqual(await verify(await sign(claims(patch))), { ok: false, code }, why);
  }
  // At the limits themselves, each is still fine.
  assert.ok((await verify(await sign(claims({ auth_time: now + 60, name: "n".repeat(200), email: `${"p".repeat(64)}@${"d".repeat(181)}.example` })))).ok);
  const limited = { ...config, allowedDomains: ["org.example"] };
  assert.ok((await verifyIdentityToken(await sign(claims()), limited, NONCE, now)).ok);
  assert.deepEqual(await verifyIdentityToken(await sign(claims({ email: "person@sub.org.example" })), limited, NONCE, now), { ok: false, code: "domain" });
});

/* ---------- the steps ---------- */

function started(next: string | null = "/settings/account", at = Date.now(), fresh = false) {
  const { location, cookie } = startSignIn(config, next, at, fresh);
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
  // A plain sign-in asks the issuer for no particular freshness, and says so in its cookie.
  assert.equal(url.searchParams.has("max_age"), false);
  assert.equal(JSON.parse(Buffer.from(cookie.value, "base64url").toString()).fresh, false);
});

test("the fresh check asks the issuer for max_age=300 and nothing else besides", () => {
  const { url, cookie } = started("/settings/account", Date.now(), true);
  assert.equal(FRESH_MAX_AGE, 300);
  assert.deepEqual([...url.searchParams.keys()].sort(), ["client_id", "max_age", "nonce", "redirect_uri", "response_mode", "state"]);
  assert.equal(url.searchParams.get("max_age"), "300");
  assert.equal(JSON.parse(Buffer.from(cookie.value, "base64url").toString()).fresh, true);
});

test("every Confirm with link is the fresh round-trip; signing in and linking are plain ones", () => {
  assert.equal(ssoConfirmHref(), "/auth/sso/start?fresh=1");
  assert.equal(ssoConfirmHref("/settings/account"), "/auth/sso/start?next=%2Fsettings%2Faccount&fresh=1");
  assert.equal(ssoStartHref("/settings/security"), "/auth/sso/start?next=%2Fsettings%2Fsecurity");
  // The pages that offer the fresh check: each "Confirm with {0}" link leads to ssoConfirmHref, and nothing there
  // starts the round-trip any other way.
  let links = 0;
  for (const file of ["src/components/remote-start.tsx", "src/components/ask-card.tsx", "src/components/views/settings.tsx"]) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /href=\{SSO_START_PATH\}/, file);
    const lines = source.split("\n");
    lines.forEach((line, i) => {
      if (!line.includes('tx("Confirm with {0}"')) return;
      links += 1;
      assert.match(lines.slice(Math.max(0, i - 2), i + 1).join("\n"), /href=\{ssoConfirmHref\(/, `${file}:${i + 1}`);
    });
  }
  assert.equal(links, 3);
});

function accounts(patch: Partial<AccountSteps> = {}) {
  const calls: string[] = [];
  const seen = new Set<string>();
  const kept: { id: string; subject: string; tokenId: string; authTime: number; fresh: boolean; userId: string; next: string }[] = [];
  let created = false;
  const steps: AccountSteps = {
    claimToken: async (id) => { calls.push(`claim ${id}`); if (seen.has(id)) return false; seen.add(id); return true; },
    linkAccount: async () => { calls.push("link"); return { userId: "11111111-1111-4111-8111-111111111111" }; },
    createAccount: async (identity) => { calls.push(`create ${identity.email}`); created = true; },
    beginHandoff: async (id, identity, userId, next, fresh) => {
      calls.push(`keep ${userId}`);
      kept.push({ id, subject: identity.subject, tokenId: identity.tokenId, authTime: identity.authTime, fresh, userId, next });
    },
    ...patch,
  };
  return { steps, calls, kept, created: () => created };
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

test("a token signs in once: the database keeps the verified sign-in, the browser only a random id for it", async () => {
  const s = started("/settings/account");
  const body = liveClaims({ nonce: s.nonce });
  const token = await sign(body);
  const { steps, calls, kept } = accounts();
  const r = await acceptCallback({ id_token: token, state: s.state }, s.cookie.value, config, steps);
  assert.ok(r.ok);
  assert.equal(r.cookie.name, FINISH_COOKIE);
  assert.deepEqual(r.cookie.options, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 60 });
  // 256 random bits and nothing else: no account, person, time or sign-in token the browser could change.
  assert.match(r.cookie.value, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(kept, [{
    // The issuer's check is when the person last passed it (auth_time, ten minutes ago here), never when the token was
    // made; and a plain sign-in is not the fresh check.
    id: r.cookie.value, subject: body.sub, tokenId: body.jti, authTime: body.auth_time, fresh: false,
    userId: "11111111-1111-4111-8111-111111111111", next: "/settings/account",
  }]);
  assert.deepEqual(calls, [`claim ${body.jti}`, "link", "keep 11111111-1111-4111-8111-111111111111"]);
  // The same token again, even through a new start in the same browser: refused, and no account is touched.
  const again = started();
  const replay = await sign({ ...body, nonce: again.nonce });
  calls.length = 0;
  const { jti } = body;
  assert.deepEqual(await acceptCallback({ id_token: replay, state: again.state }, again.cookie.value, config, steps), { ok: false, code: "replayed" });
  assert.deepEqual(calls, [`claim ${jti}`]);
});

test("the fresh check takes only a token whose code was entered within max_age; a plain sign-in takes any", async () => {
  const at = Math.floor(Date.now() / 1000);
  // Exactly at the limit: the fresh check, kept as such with the code's time.
  const ok = started("/settings/account", Date.now(), true);
  const body = liveClaims({ nonce: ok.nonce, auth_time: at - FRESH_MAX_AGE });
  const fresh = accounts();
  const r = await acceptCallback({ id_token: await sign(body), state: ok.state }, ok.cookie.value, config, fresh.steps, at * 1000);
  assert.ok(r.ok);
  assert.deepEqual(fresh.kept.map((k) => [k.authTime, k.fresh]), [[at - FRESH_MAX_AGE, true]]);
  // A second older: the issuer didn't ask for a code (or the token isn't the answer to this request). Refused before the
  // token is used up or any account touched.
  const late = started("/settings/account", Date.now(), true);
  const stale = accounts();
  assert.deepEqual(await acceptCallback({ id_token: await sign(liveClaims({ nonce: late.nonce, auth_time: at - FRESH_MAX_AGE - 1 })), state: late.state },
    late.cookie.value, config, stale.steps, at * 1000), { ok: false, code: "stale" });
  assert.deepEqual(stale.calls, []);
  // The plain sign-in takes an issuer session that started hours ago, and keeps that time; it is no fresh check.
  const plain = started();
  const signIn = accounts();
  assert.ok((await acceptCallback({ id_token: await sign(liveClaims({ nonce: plain.nonce, auth_time: at - 4 * 3600 })), state: plain.state },
    plain.cookie.value, config, signIn.steps, at * 1000)).ok);
  assert.deepEqual(signIn.kept.map((k) => [k.authTime, k.fresh]), [[at - 4 * 3600, false]]);
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
    assert.ok(!blocked.calls.some((c) => c.startsWith("keep") || c.startsWith("create")));
  }
});

const HANDOFF = "h".repeat(43);
const ACCOUNT = "11111111-1111-4111-8111-111111111111";

function sessions(opened: OpenedHandoff | null = { userId: ACCOUNT, linked: true, next: "/today" }, patch: Partial<SessionSteps> = {}) {
  const calls: string[] = [];
  const steps: SessionSteps = {
    openHandoff: async (id) => { calls.push(`open ${id}`); return opened; },
    confirmLink: async () => { calls.push("confirm"); return false; },
    replaceSession: async (userId) => { calls.push(`replace ${userId}`); return "33333333-3333-4333-8333-333333333333"; },
    markSession: async (sessionId, id) => { calls.push(`mark ${sessionId} ${id}`); },
    sessionMarked: async (userId) => { calls.push(`marked? ${userId}`); return true; },
    endSession: async () => { calls.push("end"); },
    ...patch,
  };
  return { steps, calls };
}

test("the finish makes the session the kept sign-in names and has it marked from there", async () => {
  const ok = sessions({ userId: ACCOUNT, linked: true, next: "/settings/account" });
  assert.deepEqual(await finishSignIn(HANDOFF, ok.steps), { ok: true, next: "/settings/account" });
  assert.deepEqual(ok.calls, [`open ${HANDOFF}`, `replace ${ACCOUNT}`, `mark 33333333-3333-4333-8333-333333333333 ${HANDOFF}`, `marked? ${ACCOUNT}`]);
  // Where to go is checked again on the way out.
  assert.deepEqual(await finishSignIn(HANDOFF, sessions({ userId: ACCOUNT, linked: true, next: "https://elsewhere.example" }).steps), { ok: true, next: "/today" });
});

test("a finish cookie the browser made up gets no session: only an id the database kept counts", async () => {
  // What the browser itself could set: a sign-in for any account, with a one-time token from that account's own
  // email, a person and a time of its choosing. It isn't an id, so nothing is even looked up.
  const forged = Buffer.from(JSON.stringify({
    hashedToken: "a".repeat(56), userId: ACCOUNT, issuer: ISSUER, subject: randomUUID(), verifiedAt: Math.floor(Date.now() / 1000), next: "/today", at: Date.now(),
  })).toString("base64url");
  for (const [why, value] of [["none", undefined], ["forged sign-in", forged], ["garbage", "%%%"], ["too short", "h".repeat(42)]] as const) {
    const s = sessions();
    assert.deepEqual(await finishSignIn(value, s.steps), { ok: false, code: "state" }, why);
    assert.deepEqual(s.calls, [], why);
  }
  // An id of the right shape the database never kept, or already finished: refused before any session is touched.
  const unknown = sessions(null);
  assert.deepEqual(await finishSignIn(HANDOFF, unknown.steps), { ok: false, code: "state" });
  assert.deepEqual(unknown.calls, [`open ${HANDOFF}`]);
});

test("an account with its own authenticator is linked only from its owner's own two-factor session", async () => {
  const refused = sessions({ userId: ACCOUNT, linked: false, next: "/today" });
  assert.deepEqual(await finishSignIn(HANDOFF, refused.steps), { ok: false, code: "account_protected" });
  // The browser's session, whoever's it is, stays as it was.
  assert.deepEqual(refused.calls, [`open ${HANDOFF}`, "confirm"]);
  const owner = sessions({ userId: ACCOUNT, linked: false, next: "/settings/security" }, { confirmLink: async () => true });
  assert.deepEqual(await finishSignIn(HANDOFF, owner.steps), { ok: true, next: "/settings/security" });
  assert.ok(owner.calls.includes(`replace ${ACCOUNT}`));
});

test("a session the pages wouldn't see as marked is ended, and the person stops on a page instead of going round", async () => {
  const unmarked = sessions(undefined, { markSession: async () => { throw new Error("Marking the session failed."); } });
  await assert.rejects(finishSignIn(HANDOFF, unmarked.steps), /Marking/);
  assert.deepEqual(unmarked.calls, [`open ${HANDOFF}`, `replace ${ACCOUNT}`, "end"]);
  const unseen = sessions(undefined, { sessionMarked: async () => false });
  assert.deepEqual(await finishSignIn(HANDOFF, unseen.steps), { ok: false, code: "unavailable" });
  assert.deepEqual(unseen.calls, [`open ${HANDOFF}`, `replace ${ACCOUNT}`, `mark 33333333-3333-4333-8333-333333333333 ${HANDOFF}`, "end"]);
});

/* ---------- what such a session is allowed ---------- */

function state(patch: Partial<AuthState> = {}): AuthState {
  return { user: { id: "account" } as AuthState["user"], aal: "aal1", sessionId: "session", factors: [],
    mfaEnabled: true, hasRecoveryCodes: false, clientId: null, amr: [], issuer: null, ...patch };
}

test("an issuer session counts as two-factor, and only its fresh round-trip as the fresh check", () => {
  const at = Date.now() - 60_000;
  const viaIssuer = state({ aal: "aal2", issuer: { verifiedAt: at, fresh: true } });
  assert.equal(canUsePlanner(viaIssuer), true);
  assert.equal(nextStep(viaIssuer), null);
  assert.equal(codeFreshUntil(viaIssuer), at + CODE_REUSE_MS);
  // A TOTP timestamp in the token doesn't extend it: the issuer's round-trip is the only check such a session has.
  assert.equal(codeFreshUntil(state({ aal: "aal2", issuer: { verifiedAt: at, fresh: true }, amr: [{ method: "totp", timestamp: Math.floor(Date.now() / 1000) }] })), at + CODE_REUSE_MS);
  assert.equal(codeFreshUntil(state()), null);
  // A plain sign-in through the issuer is two-factor, yet no fresh check, however recent its auth_time: that may be a
  // remembered browser's session start, with no code entered.
  const plain = state({ aal: "aal2", issuer: { verifiedAt: Date.now(), fresh: false } });
  assert.equal(nextStep(plain), null);
  assert.equal(codeFreshUntil(plain), null);
});
