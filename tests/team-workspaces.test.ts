import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// This computer's own store (no account): team workspaces are PacedMind Cloud's, assignment is to yourself only.
const dir = mkdtempSync(path.join(tmpdir(), "pacedmind-team-test-"));
process.env.ORGANIZER_DB = path.join(dir, "organizer.db");
process.env.ORGANIZER_SEED = "empty";
process.env.ORGANIZER_MODE = "desktop";

type Principal = { kind: "owner" } | { kind: "session"; sessionId: string; taskId: number };

async function mcp() {
  const { createMcpHandler } = await import("mcp-handler");
  const { registerTools } = await import("../src/server/mcp");
  const { runAs } = await import("../src/server/mcp/principal");
  const handler = createMcpHandler(registerTools);
  let id = 0;
  const post = (who: Principal, method: string, params: Record<string, unknown>) => runAs(who, () => handler(new Request("http://127.0.0.1:4320/api/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": method,
      ...(typeof params.name === "string" ? { "Mcp-Name": params.name } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params: {
      ...params, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} },
    } }),
  })));
  const call = async (name: string, args: Record<string, unknown> = {}, who: Principal = { kind: "owner" }) => {
    const body = await (await post(who, "tools/call", { name, arguments: args })).json();
    assert.equal(body.error, undefined, JSON.stringify(body.error));
    return { text: (body.result.content as { text: string }[]).map((c) => c.text).join("\n"), error: body.result.isError === true };
  };
  const list = async (who: Principal) => ((await (await post(who, "tools/list", {})).json()).result.tools as { name: string }[]).map((t) => t.name);
  return { call, list };
}

test("workspace tools say they need PacedMind Cloud on this computer's own store", async () => {
  const { call } = await mcp();
  const listed = await call("list_workspaces");
  assert.equal(listed.error, false);
  assert.match(listed.text, /isn't in any team workspace/);
  for (const [name, args] of [
    ["create_workspace", { name: "Persate" }],
    ["get_workspace", { workspace: "persate" }],
    ["invite_member", { workspace: "persate", email: "someone@persate.com" }],
    ["share_area", { area: "WRK", workspace: "persate" }],
    ["set_webhook", { workspace: "persate", url: "https://hooks.persate.com/x", events: ["task.assigned"] }],
  ] as const) {
    const r = await call(name, args);
    assert.equal(r.error, true, name);
    assert.match(r.text, /PacedMind Cloud|isn't in any team workspace/, name);
  }
  assert.match((await call("list_webhooks")).text, /no webhooks/);
});

test("a task of your own is assigned to you or nobody, and list_tasks filters by assignee", async () => {
  const repo = await import("../src/server/repo");
  const { ME } = await import("../src/lib/types");
  const { call } = await mcp();
  const area = await repo.createArea({ name: "Assignments", color: "#6A8DC3" });
  const mine = await call("create_task", { title: "Mine to do", area: area.key, assignee: "me" });
  assert.equal(mine.error, false, mine.text);
  assert.match(mine.text, /assigned to the user/);
  const loose = await call("create_task", { title: "Nobody's yet", area: area.key });
  assert.equal(loose.error, false);
  const key = (text: string) => /([A-Z][A-Z0-9]+-\d+)/.exec(text)![1];
  const [mineKey, looseKey] = [key(mine.text), key(loose.text)];
  assert.equal((await repo.getTask(mineKey))!.assigneeId, ME);

  const refused = await call("update_task", { task: looseKey, assignee: "colleague@persate.com" });
  assert.equal(refused.error, true);
  assert.match(refused.text, /Only a team workspace's tasks can be assigned to someone else/);
  assert.equal((await repo.getTask(looseKey))!.assigneeId, null);

  const assignedToMe = await call("list_tasks", { assignee: "me" });
  assert.match(assignedToMe.text, new RegExp(mineKey));
  assert.doesNotMatch(assignedToMe.text, new RegExp(`${looseKey}\\b`));
  const nobody = await call("list_tasks", { assignee: "nobody", area: area.key });
  assert.match(nobody.text, new RegExp(looseKey));
  assert.doesNotMatch(nobody.text, new RegExp(`${mineKey}\\b`));
  assert.match((await call("list_tasks", { workspace: "personal", area: area.key })).text, /2 tasks/);
  assert.equal((await call("list_tasks", { workspace: "persate" })).error, true);
  assert.match((await call("get_task", { task: mineKey })).text, /Assigned to: the user/);
  assert.match((await call("get_task", { task: looseKey })).text, /Assigned to: nobody/);

  const bulk = await call("bulk_update_tasks", { tasks: [mineKey, looseKey], assignee: null });
  assert.equal(bulk.error, false, bulk.text);
  assert.equal((await repo.getTask(mineKey))!.assigneeId, null);
  assert.deepEqual((await repo.listTasks({ assigneeId: ME })).map((t) => t.key), []);
  await assert.rejects(repo.updateTask((await repo.getTask(looseKey))!.id, { assigneeId: "00000000-0000-4000-8000-000000000000" }), /PacedMind Cloud/);
  const overview = await call("get_overview");
  assert.doesNotMatch(overview.text, /Team workspaces:/);
});

test("launched sessions read workspaces but never manage them or reassign their task", async () => {
  const repo = await import("../src/server/repo");
  const { list, call } = await mcp();
  const task = await repo.createTask({ title: "Session's own" });
  const session = await repo.createSession({ taskId: task.id, agent: "claude", folder: null, status: "running" });
  const who = { kind: "session" as const, sessionId: session.id, taskId: task.id };
  const names = await list(who);
  for (const name of ["list_workspaces", "get_workspace"]) assert.ok(names.includes(name), name);
  for (const name of ["create_workspace", "invite_member", "update_member", "remove_member", "set_workspace_domain", "remove_workspace_domain",
    "share_area", "set_webhook", "delete_webhook", "list_webhooks"]) {
    assert.equal(names.includes(name), false, name);
  }
  const r = await call("update_task", { task: task.key, assignee: "me" }, who);
  assert.equal(r.error, true);
  assert.match(r.text, /can't change its task's status, agent, assignee/);
});

test("invitation links, initials and sign-in's way back to an invitation", async () => {
  const { inviteLink, CLOUD_ONLY_WORKSPACES } = await import("../src/server/store/shared");
  const { safeNext } = await import("../src/server/auth-flow");
  const { initialsOf, manages } = await import("../src/lib/types");
  const token = "a".repeat(64);
  assert.equal(inviteLink("https://app.pacedmind.com/", token), `https://app.pacedmind.com/join/${token}`);
  assert.equal(safeNext(`/join/${token}`), `/join/${token}`);
  for (const bad of [`/join/${token}x`, "/join/../settings", `//evil.example/join/${token}`, `/join/${"A".repeat(64)}`]) assert.equal(safeNext(bad), "/today");
  assert.equal(initialsOf("Mikołaj Bednarczyk"), "MB");
  assert.equal(initialsOf("", "olivia@acme.test"), "OL");
  assert.equal(initialsOf("Łucja"), "ŁU");
  assert.equal(initialsOf(null, null), "?");
  assert.ok(manages("owner") && manages("admin") && !manages("member") && !manages(null));
  assert.match(CLOUD_ONLY_WORKSPACES, /PacedMind Cloud/);
});
