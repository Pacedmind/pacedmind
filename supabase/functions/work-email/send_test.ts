import assert from "node:assert/strict";
import { sendWorkEmailCode } from "./send.ts";

const account = "00000000-0000-0000-0000-000000000001";
const callerToken = "Bearer header.payload.signature";
const address = "work@company.invalid";
const environment = {
  SUPABASE_URL: "https://db.example.invalid",
  SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: "test-publishable" }),
  SUPABASE_SECRET_KEYS: JSON.stringify({ default: "test-secret" }),
  WORK_EMAIL_RESEND_API_KEY: "test-mail",
  WORK_EMAIL_FROM: "PacedMind <verify@example.invalid>",
};

async function withFetch(fetcher: (request: Request) => Promise<Response>, test: () => Promise<void>) {
  const previous = new Map(Object.keys(environment).map((key) => [key, Deno.env.get(key)]));
  const originalFetch = globalThis.fetch;
  try {
    for (const [key, value] of Object.entries(environment)) Deno.env.set(key, value);
    globalThis.fetch = (input, init) => fetcher(new Request(input, init));
    await test();
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of previous) value === undefined ? Deno.env.delete(key) : Deno.env.set(key, value);
  }
}

function sendRequest() {
  return new Request("https://edge.example.invalid/work-email", {
    method: "POST",
    headers: { Authorization: callerToken, "Content-Type": "application/json" },
    body: JSON.stringify({ email: " Work@Company.Invalid ", language: "pl", account: "spoofed-account" }),
  });
}

Deno.test("sends the code only to the normalized address and reserves its digest for the signed-in account", async () => {
  let digest = "";
  const calls: string[] = [];
  await withFetch(async (request) => {
    const url = new URL(request.url);
    calls.push(url.pathname);
    switch (url.pathname) {
      case "/rest/v1/rpc/get_work_email":
        assert.equal(request.headers.get("authorization"), callerToken);
        assert.equal(request.headers.get("apikey"), "test-publishable");
        return Response.json({ user_id: account });
      case "/rest/v1/rpc/issue_work_email_code": {
        assert.equal(request.headers.get("apikey"), "test-secret");
        const body = await request.json();
        assert.equal(body.account, account);
        assert.equal(body.target_email, " Work@Company.Invalid ");
        assert.match(body.code_digest, /^[0-9a-f]{64}$/);
        digest = body.code_digest;
        return Response.json(address);
      }
      case "/emails": {
        assert.equal(url.origin, "https://api.resend.com");
        assert.equal(request.headers.get("authorization"), "Bearer test-mail");
        const body = await request.json();
        assert.deepEqual(body.to, [address]);
        assert.equal(body.from, environment.WORK_EMAIL_FROM);
        assert.equal(body.subject, "Potwierdź służbowy adres w PacedMind");
        const code = body.text.match(/\b([A-HJ-NP-Z2-9]{5})-([A-HJ-NP-Z2-9]{5})\b/);
        assert.ok(code);
        const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code[1] + code[2]));
        const expected = Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
        assert.equal(digest, expected);
        return Response.json({ id: "test-delivery" });
      }
      default: throw new Error("Unexpected request");
    }
  }, async () => {
    const result = await sendWorkEmailCode(sendRequest());
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), { sent: true });
  });
  assert.deepEqual(calls, ["/rest/v1/rpc/get_work_email", "/rest/v1/rpc/issue_work_email_code", "/emails"]);
});

Deno.test("does not issue or send codes when the database refuses the caller", async () => {
  const calls: string[] = [];
  await withFetch((request) => {
    calls.push(new URL(request.url).pathname);
    return Promise.resolve(Response.json({ code: "42501", message: "Sign in to manage your work email." }, { status: 403 }));
  }, async () => {
    const response = await sendWorkEmailCode(sendRequest());
    assert.equal(response.status, 401);
  });
  assert.deepEqual(calls, ["/rest/v1/rpc/get_work_email"]);
});

Deno.test("stops before delivery when the account is rate limited", async () => {
  const calls: string[] = [];
  await withFetch((request) => {
    const path = new URL(request.url).pathname;
    calls.push(path);
    return Promise.resolve(path.endsWith("/get_work_email") ? Response.json({ user_id: account })
      : Response.json({ code: "PT429", message: "Try again later." }, { status: 429 }));
  }, async () => {
    const response = await sendWorkEmailCode(sendRequest());
    assert.equal(response.status, 429);
  });
  assert.deepEqual(calls, ["/rest/v1/rpc/get_work_email", "/rest/v1/rpc/issue_work_email_code"]);
});
