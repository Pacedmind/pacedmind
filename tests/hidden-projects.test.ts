import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// An isolated old-format database: the first normal read must migrate it without losing rows.
const dir = mkdtempSync(path.join(tmpdir(), "pacedmind-hidden-test-"));
process.env.ORGANIZER_DB = path.join(dir, "organizer.db");
process.env.ORGANIZER_SEED = "empty";
process.env.ORGANIZER_MODE = "desktop";
const old = new DatabaseSync(process.env.ORGANIZER_DB);
old.exec(`CREATE TABLE projects (
  id TEXT PRIMARY KEY, area_id TEXT NOT NULL, name TEXT NOT NULL,
  start_date TEXT, target_date TEXT, folder TEXT, agent TEXT, after_project_id TEXT,
  flow_on INTEGER NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0
);`);
old.close();

test("hide and restore keep all data, while everyday lists, MCP and sessions respect visibility", async () => {
  const repo = await import("../src/server/repo");
  const { db } = await import("../src/server/store/local-db");
  const { findTask, findProject } = await import("../src/server/mcp/common");
  const { runAs } = await import("../src/server/mcp/principal");
  const area = await repo.createArea({ name: "Visibility test", color: "#123456" });
  const project = await repo.createProject({ name: "Later", areaId: area.id });
  const other = await repo.createProject({ name: "Now", areaId: area.id });
  assert.equal(project.hidden, false);
  const hiddenTask = await repo.createTask({ title: "Later task", projectId: project.id, dueDate: "2026-12-01", plannedDate: "2026-11-25", description: "Keep this", priority: 2 });
  const shownTask = await repo.createTask({ title: "Current task", projectId: other.id });
  const loose = await repo.createTask({ title: "Independent area to-do", areaId: area.id, relatedProjectId: project.id });
  const inbox = await repo.createTask({ title: "Inbox" });
  await repo.addSubtask(hiddenTask.id, "Keep this subtask");
  const before = await repo.getTask(hiddenTask.id);
  const session = await repo.createSession({ taskId: hiddenTask.id, agent: "codex", folder: null, status: "running" });
  const visibleSession = await repo.createSession({ taskId: shownTask.id, agent: "codex", folder: null });
  const version = await repo.stateVersion();
  await repo.updateProject(project.id, { hidden: true });
  assert.notEqual(await repo.stateVersion(), version);
  assert.equal((await repo.getProject(project.id))?.hidden, true);
  assert.ok((await repo.listAllProjects()).some((p) => p.id === project.id));
  assert.ok(!(await repo.listProjects()).some((p) => p.id === project.id));
  const ids = (await repo.listTasks()).map((t) => t.id);
  assert.ok(!ids.includes(hiddenTask.id));
  for (const t of [shownTask, loose, inbox]) assert.ok(ids.includes(t.id));
  assert.deepEqual(await repo.listTasks({ projectId: project.id }), []);
  assert.ok(!(await repo.listTasks({ areaId: area.id })).some((t) => t.id === hiddenTask.id));
  assert.deepEqual((await repo.listSessions()).map((s) => s.id), [visibleSession.id]);
  assert.deepEqual(await repo.listSessions({ taskId: hiddenTask.id }), []);
  assert.equal((await repo.listAllSessions({ taskId: hiddenTask.id }))[0].id, session.id);
  assert.equal(await repo.isTaskVisible(hiddenTask), false);
  const { floatingTaskVersions } = await import("../src/server/floating-task-state");
  const note = { id: hiddenTask.id, createdAt: hiddenTask.createdAt };
  assert.equal((await floatingTaskVersions("local", [note]))[0].hidden, true);
  await runAs({ kind: "owner" }, async () => {
    await assert.rejects(findTask(hiddenTask.key), /No task/);
    await assert.rejects(findProject(project.id), /No project/);
    assert.equal((await findTask(shownTask.key)).id, shownTask.id);
  });
  await runAs({ kind: "session", sessionId: session.id, taskId: hiddenTask.id }, async () => {
    assert.equal((await findTask(hiddenTask.key)).id, hiddenTask.id);
  });
  assert.deepEqual(await repo.getTask(hiddenTask.id), before);
  await repo.updateProject(project.id, { hidden: false });
  assert.ok((await repo.listProjects()).some((p) => p.id === project.id));
  assert.deepEqual(await repo.listTasks({ projectId: project.id }), [before]);
  assert.equal((await repo.listSessions({ taskId: hiddenTask.id }))[0].id, session.id);
  assert.deepEqual(await repo.getTask(hiddenTask.id), before);
  assert.equal((await floatingTaskVersions("local", [note]))[0].hidden, false);
  db().close();
});
