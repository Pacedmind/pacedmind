import assert from "node:assert/strict";
import { test } from "node:test";
import { googleAvatarImage, profileAvatarVersion } from "../src/server/profile-avatar";

const googlePhoto = "https://lh3.googleusercontent.com/a/member=s96-c";

test("only trusted Google photo URLs reach the avatar proxy", async (t) => {
  const request = t.mock.method(globalThis, "fetch", async (url: URL, options?: RequestInit) => {
    assert.equal(url.href, googlePhoto);
    assert.equal(options?.redirect, "error");
    return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/jpeg" } });
  });
  for (const url of [
    "http://lh3.googleusercontent.com/a/member",
    "https://lh3.googleusercontent.com.example.com/a/member",
    "https://lh3.googleusercontent.com@127.0.0.1/a/member",
    "https://user:password@lh3.googleusercontent.com/a/member",
    "https://lh3.googleusercontent.com:81/a/member",
  ]) {
    assert.equal(await googleAvatarImage(url), null);
    assert.equal(profileAvatarVersion({ source: "google", picture: null, googleUrl: url }), null);
  }
  assert.equal(request.mock.callCount(), 0);
  assert.deepEqual(await googleAvatarImage(googlePhoto), { data: new Uint8Array([1, 2, 3]), type: "image/jpeg" });
  assert.equal(request.mock.callCount(), 1);
});

test("the proxy rejects non-raster and oversized avatar responses", async (t) => {
  const request = t.mock.method(globalThis, "fetch", async () => new Response("<svg/>", {
    headers: { "content-type": "image/svg+xml" },
  }));
  assert.equal(await googleAvatarImage(googlePhoto), null);
  request.mock.mockImplementation(async () => new Response(new Uint8Array(256 * 1024 + 1), {
    headers: { "content-type": "image/png" },
  }));
  assert.equal(await googleAvatarImage(googlePhoto), null);
  assert.equal(profileAvatarVersion({ source: "initials", picture: null, googleUrl: googlePhoto }), null);
});
