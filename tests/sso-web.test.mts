import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mock, test } from "node:test";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import * as nextServer from "next/server";

/*
 * Signing in through your organisation in the hosted app, end to end: the three routes, the session they leave in the
 * browser's cookies, and what that session may then do. Supabase is a stand-in answering this process's fetch (no
 * request leaves it), next/headers is a cookie jar, and every key is made for this run and thrown away.
 * Run with --experimental-test-module-mocks and without the react-server condition (npm run test:auth).
 */

const ORIGIN = "https://planner.example.test";
const PROJECT = "https://project.example.test";
const ISSUER = "https://issuer.example.test";
const SECRET = `test-secret-${randomUUID()}`;
const keys = await generateKeyPair("ES256", { extractable: true });
Object.assign(process.env, {
  ORGANIZER_MODE: "web", ORGANIZER_PUBLIC_ORIGIN: ORIGIN, SUPABASE_URL: PROJECT, SUPABASE_PUBLISHABLE_KEY: "test-publishable",
  SUPABASE_SECRET_KEY: SECRET, SSO_ISSUER: ISSUER, SSO_CLIENT_ID: "planner", SSO_AUTHORIZE_URL: `${ISSUER}/authorize`,
  SSO_JWKS: JSON.stringify({ keys: [{ ...(await exportJWK(keys.publicKey)), kid: "key-1" }] }), SSO_LABEL: "Example Org",
});

/* ---------- the browser's cookies ---------- */

type Cookie = { value: string; options?: Record<string, unknown> };
const jar = new Map<string, Cookie>();
const store = {
  get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)!.value } : undefined),
  getAll: () => [...jar].map(([name, c]) => ({ name, value: c.value })),
  has: (name: string) => jar.has(name),
  set: (name: string, value: string, options?: Record<string, unknown>) => {
    if (options?.maxAge === 0 || value === "") jar.delete(name);
    else jar.set(name, { value, options });
  },
  delete: (name: string) => { jar.delete(name); },
};
// Run without the react-server condition, so the sign-in pages' client parts load too; "server-only" guards bundles.
mock.module("server-only", { namedExports: {} });
mock.module("next/headers", { namedExports: { cookies: async () => store, headers: async () => new Headers() } });
// What Next does inside a request, as far as the sign-in needs it: a redirect ends the action with its digest.
const redirects: string[] = [];
mock.module("next/navigation", { namedExports: {
  redirect: (url: string) => { redirects.push(url); throw Object.assign(new Error("NEXT_REDIRECT"), { digest: `NEXT_REDIRECT;replace;${url};307;` }); },
  notFound: () => { throw Object.assign(new Error("NEXT_HTTP_ERROR_FALLBACK;404"), { digest: "NEXT_HTTP_ERROR_FALLBACK;404" }); },
} });
// A page's `connection()` only says "render per request" to Next; there's no request scope here to say it to.
mock.module("next/server", { namedExports: { ...nextServer, connection: async () => {} } });
mock.module("next/cache", { namedExports: { refresh: () => {}, revalidatePath: () => {}, revalidateTag: () => {} } });

/* ---------- Supabase, standing in ---------- */

type User = { id: string; email: string; email_confirmed_at: string | null; factors: { id: string; factor_type: string; status: string; created_at: string }[]; user_metadata?: Record<string, unknown> };
const fake = {
  users: new Map<string, User>(),
  links: new Map<string, string>(),
  tokens: new Set<string>(),
  links_pending: new Map<string, string>(),
  sessions: new Map<string, { userId: string; token: string }>(),
  marks: new Map<string, number>(),
  calls: [] as { path: string; apikey: string | null; auth: string | null; body: unknown }[],
  markFails: false,
  deleted: [] as string[],
  approvals: [] as { request: string; marked: boolean }[],
};

function accessToken(userId: string, sessionId: string): string {
  const now = Math.floor(Date.now() / 1000);
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  // HS256 without a kid: auth-js then asks Auth (/user) instead of checking a signature, as with a legacy project.
  return `${enc({ alg: "HS256", typ: "JWT" })}.${enc({ sub: userId, session_id: sessionId, aal: "aal1", role: "authenticated", exp: now + 3600, iat: now, amr: [{ method: "otp", timestamp: now }] })}.sig`;
}
const sessionOf = (auth: string | null) => [...fake.sessions].find(([, s]) => `Bearer ${s.token}` === auth);
const userJson = (u: User) => ({ id: u.id, aud: "authenticated", role: "authenticated", email: u.email, email_confirmed_at: u.email_confirmed_at, factors: u.factors, app_metadata: {}, user_metadata: u.user_metadata ?? {}, created_at: "2026-01-01T00:00:00Z" });
const json = (body: unknown, status = 200) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const isSecret = (apikey: string | null) => apikey === SECRET;

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  assert.equal(url.origin, PROJECT, `Only the stand-in project may be called, not ${url.origin}`);
  const headers = new Headers(init?.headers);
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  const apikey = headers.get("apikey");
  const auth = headers.get("authorization");
  fake.calls.push({ path: url.pathname, apikey, auth, body });
  const path = url.pathname;
  if (path === "/auth/v1/verify") {
    const userId = fake.links_pending.get(body.token_hash);
    if (!userId || body.type !== "magiclink") return json({ code: "otp_expired", msg: "expired" }, 403);
    fake.links_pending.delete(body.token_hash);
    const sessionId = randomUUID();
    const token = accessToken(userId, sessionId);
    fake.sessions.set(sessionId, { userId, token });
    return json({ access_token: token, refresh_token: randomUUID(), token_type: "bearer", expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: userJson(fake.users.get(userId)!) });
  }
  if (path === "/auth/v1/logout") {
    const s = sessionOf(auth);
    if (s) fake.sessions.delete(s[0]);
    return new Response(null, { status: 204 });
  }
  if (path === "/auth/v1/user") {
    const s = sessionOf(auth);
    return s ? json(userJson(fake.users.get(s[1].userId)!)) : json({ code: "session_not_found", msg: "gone" }, 403);
  }
  if (path.startsWith("/auth/v1/admin/") || ["/rest/v1/rpc/issuer_claim_token", "/rest/v1/rpc/issuer_link_account", "/rest/v1/rpc/issuer_mark_session"].includes(path)) {
    // These need the project's secret key, as in Supabase.
    if (!isSecret(apikey)) return json({ code: "not_admin", message: "secret key required" }, 401);
  }
  if (path === "/auth/v1/admin/users" && init?.method === "POST") {
    const id = randomUUID();
    fake.users.set(id, { id, email: body.email, email_confirmed_at: body.email_confirm ? new Date().toISOString() : null, factors: [], user_metadata: body.user_metadata });
    return json(userJson(fake.users.get(id)!));
  }
  if (path.startsWith("/auth/v1/admin/users/")) {
    const u = fake.users.get(path.split("/").pop()!);
    return u ? json(userJson(u)) : json({ code: "user_not_found" }, 404);
  }
  if (path === "/auth/v1/admin/generate_link") {
    const u = [...fake.users.values()].find((x) => x.email === body.email)!;
    const hashed = randomUUID().replace(/-/g, "") + "abcdef0123456789abcdef01";
    fake.links_pending.set(hashed, u.id);
    return json({ ...userJson(u), action_link: "https://unused.example.test", email_otp: "000000", hashed_token: hashed, redirect_to: ORIGIN, verification_type: "magiclink" });
  }
  if (path === "/rest/v1/rpc/issuer_claim_token") {
    if (fake.tokens.has(body.token_id)) return json(false);
    fake.tokens.add(body.token_id);
    return json(true);
  }
  if (path === "/rest/v1/rpc/issuer_link_account") {
    const linked = fake.links.get(body.subject);
    if (linked) return json({ user_id: linked });
    const u = [...fake.users.values()].find((x) => x.email === body.email);
    if (!u) return json({ user_id: null });
    if (!u.email_confirmed_at) return json({ refused: "account_unconfirmed" });
    fake.links.set(body.subject, u.id);
    return json({ user_id: u.id });
  }
  if (path === "/rest/v1/rpc/issuer_mark_session") {
    if (fake.markFails) return json({ code: "42501", message: "That session is not a new session of this account." }, 403);
    assert.equal(fake.sessions.get(body.session)?.userId, body.account);
    fake.marks.set(body.session, Date.parse(body.verified_at));
    return new Response(null, { status: 204 });
  }
  const own = sessionOf(auth);
  if (path === "/rest/v1/rpc/issuer_session") {
    const at = own ? fake.marks.get(own[0]) : undefined;
    return json(at === undefined ? null : new Date(at).toISOString());
  }
  if (path === "/rest/v1/rpc/can_control_computers") return json(!!own && fake.marks.has(own[0]));
  // The database takes the approval from a planner session; the marked session is one (supabase/tests/issuer_sign_in.sql).
  if (path === "/rest/v1/rpc/approve_agent_login") {
    if (!own) return json({ code: "42501", message: "Complete sign-in first." }, 403);
    fake.approvals.push({ request: body.request_id, marked: fake.marks.has(own[0]) });
    return json({ login: randomUUID(), redirect_uri: "http://127.0.0.1:33418/callback" });
  }
  if (/^\/auth\/v1\/oauth\/authorizations\/[^/]+\/consent$/.test(path)) {
    return own ? json({ redirect_url: "http://127.0.0.1:33418/callback?code=abc&state=xyz" }) : json({ code: "no_session" }, 401);
  }
  if (path === "/rest/v1/rpc/delete_account") {
    if (!own) return json({ code: "42501", message: "Confirm your identity again" }, 403);
    fake.deleted.push(own[1].userId);
    return new Response(null, { status: 204 });
  }
  // The planner's own data, for /api/state: an empty account.
  if (own && (init?.method ?? "GET") === "GET" && path.startsWith("/rest/v1/") && !path.startsWith("/rest/v1/rpc/")) return json([]);
  if (own && path.startsWith("/rest/v1/rpc/")) return json(null);
  throw new Error(`The stand-in has no ${init?.method ?? "GET"} ${path}`);
}) as typeof fetch;

/* ---------- the app, loaded with that environment ---------- */

const { NextRequest } = nextServer;
const start = await import("../src/app/auth/sso/start/route");
const callback = await import("../src/app/auth/sso/callback/route");
const finish = await import("../src/app/auth/sso/finish/route");
const { START_COOKIE, FINISH_COOKIE } = await import("../src/server/sso");
const { readAuthState, requireAal2, supabase } = await import("../src/server/supabase");
const { computerAccessProblem } = await import("../src/server/computer-access");
const { ISSUER_MANAGED, freshCheckProblem, verifyCode } = await import("../src/server/step-up");
const { nextStep } = await import("../src/server/auth-flow");
const actions = await import("../src/app/auth/actions");
const consent = await import("../src/app/oauth/consent/actions");

const sessionCookies = () => [...jar.keys()].filter((n) => n.startsWith("sb-"));

async function startFlow(next = "/settings/account") {
  const res = await start.GET(new NextRequest(`${ORIGIN}/auth/sso/start?next=${encodeURIComponent(next)}`));
  assert.equal(res.status, 303);
  const to = new URL(res.headers.get("location")!);
  return { state: to.searchParams.get("state")!, nonce: to.searchParams.get("nonce")!, to, res };
}

async function token(nonce: string, patch: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: ISSUER, aud: "planner", sub: person, email: "person@org.example", email_verified: true, name: "A Person",
    amr: ["pwd", "otp"], acr: "aal2", nonce, iat: now, exp: now + 120, auth_time: now - 60, jti: randomUUID(), ...patch,
  }).setProtectedHeader({ alg: "ES256", typ: "JWT", kid: "key-1" }).sign(keys.privateKey);
}

function post(fields: Record<string, string>) {
  return callback.POST(new NextRequest(`${ORIGIN}/auth/sso/callback`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString(),
  }));
}

async function signIn(next = "/settings/account") {
  const s = await startFlow(next);
  const posted = await post({ id_token: await token(s.nonce), state: s.state });
  assert.equal(posted.status, 303, await posted.clone().text());
  assert.equal(posted.headers.get("location"), "/auth/sso/finish");
  return finish.GET();
}

let person = randomUUID();
const existing: User = { id: randomUUID(), email: "person@org.example", email_confirmed_at: "2026-01-01T00:00:00Z",
  factors: [{ id: randomUUID(), factor_type: "totp", status: "verified", created_at: "2026-01-01T00:00:00Z" }] };
fake.users.set(existing.id, existing);

test("the browser goes to the issuer with a fresh state in a __Host- cookie", async () => {
  jar.clear();
  const s = await startFlow("/settings/account");
  assert.equal(s.to.origin + s.to.pathname, `${ISSUER}/authorize`);
  assert.equal(s.to.searchParams.get("redirect_uri"), `${ORIGIN}/auth/sso/callback`);
  assert.equal(s.res.headers.get("cache-control"), "no-store");
  assert.deepEqual(jar.get(START_COOKIE)?.options, { httpOnly: true, secure: true, sameSite: "none", path: "/", maxAge: 600 });
});

test("a full sign-in makes a marked session that counts as two-factor, with no PacedMind code", async () => {
  jar.clear();
  fake.calls.length = 0;
  const done = await signIn("/settings/account");
  assert.equal(done.status, 303);
  assert.equal(done.headers.get("location"), "/settings/account");
  assert.equal(jar.has(START_COOKIE), false);
  assert.equal(jar.has(FINISH_COOKIE), false);
  assert.ok(sessionCookies().length > 0, "the session is in the usual cookies");
  assert.equal(fake.marks.size, 1);
  // The secret key went only to the admin API and the issuer's database functions; no email was sent.
  for (const call of fake.calls) {
    const privileged = call.path.startsWith("/auth/v1/admin/") || call.path.startsWith("/rest/v1/rpc/issuer_") && call.path !== "/rest/v1/rpc/issuer_session";
    assert.equal(isSecret(call.apikey), privileged, call.path);
    assert.doesNotMatch(call.path, /\/(otp|magiclink|recover|invite)$/);
  }

  // The account has PacedMind's own authenticator, yet this session needs no code: the database says it's the issuer's.
  const state = await readAuthState();
  assert.ok(state?.issuer);
  assert.equal(state.aal, "aal2");
  assert.equal(state.mfaEnabled, true);
  assert.equal(nextStep(state), null);
  assert.equal((await requireAal2()).user.id, existing.id);
  assert.equal(await computerAccessProblem(), null);
  assert.equal(await freshCheckProblem(""), null);
  assert.equal(await freshCheckProblem("123456"), null);
  // PacedMind's code is never asked for, nor checked, in such a session.
  fake.calls.length = 0;
  assert.equal(await verifyCode(await supabase(), "123456"), ISSUER_MANAGED);
  assert.ok(!fake.calls.some((c) => c.path.includes("/factors")));
});

test("the check goes stale after four minutes: a new round-trip through the issuer, never a code", async () => {
  const sessionId = [...fake.marks.keys()].pop()!;
  fake.marks.set(sessionId, Date.now() - 5 * 60_000);
  assert.match(String(await freshCheckProblem("123456")), /^Confirm with Example Org again first/);
  assert.match((await actions.deleteAccountAction("", existing.email)).error ?? "", /^Confirm with Example Org again first/);
  assert.equal(fake.deleted.length, 0);
  fake.marks.set(sessionId, Date.now() - 30_000);
});

test("an agent's MCP sign-in is approved from such a session without PacedMind's code or password", async () => {
  fake.calls.length = 0;
  const approved = await consent.approveAgentAction("request_1", null);
  assert.ok(approved.ok, JSON.stringify(approved));
  assert.equal(approved.url, "http://127.0.0.1:33418/callback?code=abc&state=xyz");
  assert.deepEqual(fake.approvals.at(-1), { request: "request_1", marked: true });
  assert.ok(!fake.calls.some((c) => c.path.includes("/factors") || c.path === "/auth/v1/token"));
});

test("pages learn to offer the organisation's round-trip, never a code field, for such a session", async () => {
  const state = await (await import("../src/app/api/state/route")).GET();
  const body = await state.json();
  assert.equal(body.confirmWith, "Example Org");
  assert.equal(typeof body.codeFreshUntil, "number");
  const sessionId = [...fake.marks.keys()].pop()!;
  assert.equal(body.codeFreshUntil, fake.marks.get(sessionId)! + 4 * 60_000);
});

test("PacedMind's own authenticators and password can't be changed from such a session", async () => {
  fake.calls.length = 0;
  assert.equal((await actions.startEnrollAction("123456")).error, ISSUER_MANAGED);
  assert.equal((await actions.confirmEnrollAction(existing.factors[0].id, "123456")).error, ISSUER_MANAGED);
  assert.equal((await actions.changePasswordAction("old password!", "a new password 123", "123456")).error, ISSUER_MANAGED);
  assert.equal((await actions.removeFactorAction(existing.factors[0].id, "123456")).error, ISSUER_MANAGED);
  assert.ok(!fake.calls.some((c) => c.path.includes("/factors") || c.path === "/auth/v1/user" && c.body));
});

test("only the database's mark counts: without it the session is an ordinary one", async () => {
  const sessionId = [...fake.marks.keys()].pop()!;
  const at = fake.marks.get(sessionId)!;
  fake.marks.delete(sessionId);
  const state = await readAuthState();
  assert.equal(state?.issuer, null);
  assert.equal(state?.aal, "aal1");
  assert.equal(nextStep(state), "/login/verify");
  await assert.rejects(requireAal2());
  assert.notEqual(await computerAccessProblem(), null);
  fake.marks.set(sessionId, at);
});

test("signing in again replaces the browser's session and ends the old one", async () => {
  const before = [...fake.sessions.keys()];
  assert.equal(before.length, 1);
  fake.calls.length = 0;
  const done = await signIn();
  assert.equal(done.status, 303);
  assert.ok(fake.calls.some((c) => c.path === "/auth/v1/logout"));
  assert.equal(fake.sessions.has(before[0]), false);
  assert.equal(fake.sessions.size, 1);
});

test("a new person gets a confirmed account; a fresh check deletes it with no code", async () => {
  jar.clear();
  person = randomUUID();
  const s = await startFlow();
  const posted = await post({ id_token: await token(s.nonce, { email: "new@org.example", sub: person, name: "New Person" }), state: s.state });
  assert.equal(posted.status, 303);
  assert.equal((await finish.GET()).status, 303);
  const created = [...fake.users.values()].find((u) => u.email === "new@org.example")!;
  assert.ok(created.email_confirmed_at);
  assert.deepEqual(created.user_metadata, { full_name: "New Person" });
  assert.equal((await readAuthState())?.user.id, created.id);
  // No authenticator of PacedMind's own, yet computers are open to it: the issuer's two-factor check counts.
  assert.equal(await computerAccessProblem(), null);
  // And it's not offered PacedMind's own first authenticator or a password change from here either.
  fake.calls.length = 0;
  assert.equal((await actions.startEnrollAction()).error, ISSUER_MANAGED);
  assert.equal((await actions.changePasswordAction("old password!", "a new password 123", "")).error, ISSUER_MANAGED);
  assert.ok(!fake.calls.some((c) => c.path.includes("/factors") || c.path === "/auth/v1/user" && c.body));
  await assert.rejects(actions.deleteAccountAction("", "new@org.example"), (e: Error & { digest?: string }) => /NEXT_REDIRECT/.test(e.digest ?? e.message));
  assert.deepEqual(fake.deleted, [created.id]);
  person = randomUUID();
});

test("refusals show one plain page with a short code and leave no session", async () => {
  jar.clear();
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.join(" ")); };
  try {
    const page = async (res: Response, code: string, status = 403) => {
      assert.equal(res.status, status);
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.match(res.headers.get("content-security-policy") ?? "", /default-src 'none'/);
      const html = await res.text();
      assert.match(html, new RegExp(`Code: ${code}<`));
      assert.doesNotMatch(html, /<script|eyJ/);
      assert.deepEqual(sessionCookies(), []);
      assert.equal(jar.has(FINISH_COOKIE), false);
    };
    // Someone else's post, without this browser's start.
    await page(await post({ id_token: await token("x".repeat(43)), state: "y".repeat(43) }), "state");
    // The issuer refusing the person.
    let s = await startFlow();
    await page(await post({ error: "access_denied", state: s.state }), "access_denied");
    assert.equal(jar.has(START_COOKIE), false, "the start cookie is used up");
    // A token made for another sign-in (its nonce), posted with this browser's state.
    const other = await startFlow();
    const theirs = await token(other.nonce);
    s = await startFlow();
    await page(await post({ id_token: theirs, state: s.state }), "nonce");
    // An address someone signed up with and never confirmed is never taken over.
    fake.users.set(randomUUID(), { id: randomUUID(), email: "squatted@org.example", email_confirmed_at: null, factors: [] });
    s = await startFlow();
    await page(await post({ id_token: await token(s.nonce, { email: "squatted@org.example", sub: randomUUID() }), state: s.state }), "account_unconfirmed");
    // The finish without a verified sign-in.
    await page(await finish.GET(), "state");
    // A session that can't be marked is ended, and the log says why without a token or key.
    fake.markFails = true;
    s = await startFlow();
    assert.equal((await post({ id_token: await token(s.nonce, { sub: randomUUID(), email: "third@org.example" }), state: s.state })).status, 303);
    const sessionsBefore = fake.sessions.size;
    await page(await finish.GET(), "unavailable", 503);
    assert.equal(fake.sessions.size, sessionsBefore, "the session made a moment ago was ended");
    assert.ok(errors.some((e) => /Marking the session failed/.test(e)));
    for (const e of errors) assert.ok(!e.includes(SECRET) && !/eyJ|[0-9a-f]{40}/.test(e), e);
  } finally {
    console.error = original;
    fake.markFails = false;
  }
});

test("an issuer token replayed through a new start is refused once its nonce matches", async () => {
  jar.clear();
  const s = await startFlow();
  const used = await token(s.nonce);
  assert.equal((await post({ id_token: used, state: s.state })).status, 303);
  jar.clear();
  const again = await startFlow();
  // A second start has another nonce, so only a token signed for it could pass that check; the jti is the last line.
  const sameJti = JSON.parse(Buffer.from(used.split(".")[1], "base64url").toString()).jti;
  const res = await post({ id_token: await token(again.nonce, { jti: sameJti }), state: again.state });
  assert.equal(res.status, 403);
  assert.match(await res.text(), /Code: replayed</);
});

test("an unreadable or broken form is refused", async () => {
  jar.clear();
  const s = await startFlow();
  const res = await callback.POST(new NextRequest(`${ORIGIN}/auth/sso/callback`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ state: s.state }) }));
  assert.equal(res.status, 403);
  assert.match(await res.text(), /Code: token</);
});

test("inside a host application the sign-in pages go straight to the organisation's sign-in, keeping where to go", async () => {
  const login = (await import("../src/app/login/page")).default;
  const verify = (await import("../src/app/login/verify/page")).default;
  const redirected = async (render: Promise<unknown>) => {
    try {
      await render;
    } catch (e) {
      const digest = (e as { digest?: string }).digest ?? "";
      if (digest.startsWith("NEXT_REDIRECT;")) return digest.split(";")[2];
      throw e;
    }
    return null;
  };
  jar.clear();
  jar.set("pacedmind-embed", { value: "1" });
  assert.equal(await redirected(login({ searchParams: Promise.resolve({ next: "/settings/account" }), params: Promise.resolve({}) })), "/auth/sso/start?next=%2Fsettings%2Faccount");
  assert.equal(await redirected(login({ searchParams: Promise.resolve({}), params: Promise.resolve({}) })), "/auth/sso/start");
  // An existing session of the account that still owes PacedMind's code is replaced the same way.
  await signIn();
  fake.marks.clear();
  jar.set("pacedmind-embed", { value: "1" });
  assert.equal(await redirected(login({ searchParams: Promise.resolve({}), params: Promise.resolve({}) })), "/login/verify");
  assert.equal(await redirected(verify({ searchParams: Promise.resolve({}), params: Promise.resolve({}) })), "/auth/sso/start");
  // Outside a host application the sign-in page is shown, with its extra button.
  jar.clear();
  const page = await login({ searchParams: Promise.resolve({ next: "/settings/account" }), params: Promise.resolve({}) });
  const find = (node: unknown): Record<string, unknown> | null => {
    if (!node || typeof node !== "object") return null;
    if (Array.isArray(node)) return node.map(find).find(Boolean) ?? null;
    const props = (node as { props?: Record<string, unknown> }).props;
    if (!props) return null;
    return "organisation" in props ? props : find(props.children);
  };
  assert.deepEqual(find(page)?.organisation, { label: "Example Org", href: "/auth/sso/start?next=%2Fsettings%2Faccount" });
});
