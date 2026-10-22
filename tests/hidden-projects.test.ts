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
old.exec(`CREATE TABLE areas (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, key TEXT NOT NULL UNIQUE, color TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0
);
INSERT INTO areas(id, name, key, color) VALUES ('legacy', 'Legacy area', 'LEG', '#123456');
CREATE TABLE projects (
  id TEXT PRIMARY KEY, area_id TEXT NOT NULL, name TEXT NOT NULL,
  start_date TEXT, target_date TEXT, folder TEXT, agent TEXT, after_project_id TEXT,
  flow_on INTEGER NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0
);`);
old.close();

test("hide and restore keep all data, while everyday lists, MCP and sessions respect visibility", async () => {
  const repo = await import("../src/server/repo");
  const { db } = await import("../src/server/store/local-db");
  const { findTask, findProject, findArea } = await import("../src/server/mcp/common");
  const { runAs } = await import("../src/server/mcp/principal");
  const area = await repo.createArea({ name: "Visibility test", color: "#123456" });
  assert.equal((await repo.listAreas()).find((a) => a.id === "legacy")?.hidden, false);
  assert.equal(area.hidden, false);
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

  // Hiding the section from the sidebar also hides loose to-dos and calendar activities.
  // A project explicitly hidden beforehand must stay hidden when its area is restored.
  await repo.updateProject(project.id, { hidden: true });
  const outside = await repo.createArea({ name: "Outside", color: "#123456" });
  const outsideTask = await repo.createTask({ title: "Unaffected", areaId: outside.id });
  const looseSession = await repo.createSession({ taskId: loose.id, agent: "codex", folder: null, status: "running" });
  const event = await repo.createEvent({ title: "Area activity", areaId: area.id, start: "2026-12-01T10:00", end: "2026-12-01T11:00", recurrence: "weekly" });
  const outsideEvent = await repo.createEvent({ title: "Other activity", areaId: outside.id, start: "2026-12-01T12:00", end: "2026-12-01T13:00" });
  const allTasks = await repo.listAllTasks();
  const allProjects = await repo.listAllProjects();
  const activityBefore = await repo.getEvent(event);
  const areaVersion = await repo.stateVersion();
  await repo.updateArea(area.id, { hidden: true });
  assert.notEqual(await repo.stateVersion(), areaVersion);
  assert.ok(!(await repo.listAreas()).some((a) => a.id === area.id));
  assert.equal((await repo.listAllAreas()).find((a) => a.id === area.id)?.hidden, true);
  assert.ok(!(await repo.listProjects()).some((p) => p.areaId === area.id));
  assert.equal(await repo.isProjectVisible(other), false);
  assert.deepEqual(await repo.listTasks({ areaId: area.id }), []);
  const visible = new Set((await repo.listTasks()).map((t) => t.id));
  for (const task of [hiddenTask, shownTask, loose]) {
    assert.equal(visible.has(task.id), false);
    assert.equal(await repo.isTaskVisible(task), false);
    assert.equal((await floatingTaskVersions("local", [{ id: task.id, createdAt: task.createdAt }]))[0].hidden, true);
  }
  assert.ok(visible.has(outsideTask.id) && visible.has(inbox.id));
  assert.deepEqual(await repo.listSessions(), []);
  assert.deepEqual((await repo.listEvents()).map((e) => e.id), [outsideEvent]);
  assert.deepEqual((await repo.occurrences("2026-12-01", "2026-12-08")).map((e) => e.eventId), [outsideEvent]);
  await runAs({ kind: "owner" }, async () => {
    await assert.rejects(findArea(area.id), /No area/);
    await assert.rejects(findProject(other.id), /No project/);
    await assert.rejects(findTask(loose.key), /No task/);
  });
  await runAs({ kind: "session", sessionId: looseSession.id, taskId: loose.id }, async () => {
    assert.equal((await findTask(loose.key)).id, loose.id);
  });
  assert.deepEqual(await repo.listAllTasks(), allTasks);
  assert.deepEqual(await repo.listAllProjects(), allProjects);
  assert.deepEqual(await repo.getEvent(event), activityBefore);
  await repo.updateArea(area.id, { hidden: false });
  assert.equal(await repo.isProjectVisible(other), true);
  assert.equal(await repo.isTaskVisible(loose), true);
  assert.equal(await repo.isTaskVisible(shownTask), true);
  assert.equal(await repo.isTaskVisible(hiddenTask), false);
  assert.equal((await repo.getProject(project.id))?.hidden, true);
  assert.deepEqual(await repo.listAllTasks(), allTasks);
  assert.ok((await repo.listEvents()).some((e) => e.id === event));
  assert.equal((await repo.occurrences("2026-12-08", "2026-12-08"))[0].eventId, event);
  assert.equal((await floatingTaskVersions("local", [{ id: loose.id, createdAt: loose.createdAt }]))[0].hidden, false);
  db().close();
});
