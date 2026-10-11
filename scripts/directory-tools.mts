// Writes deploy/directory/tools.md: PacedMind Cloud's MCP tools as its server lists them (ORGANIZER_MODE=web), with
// the annotation values and a justification for each, which OpenAI's plugin portal asks for tool by tool. The values
// come from the server itself (src/server/mcp/metadata.ts); only the sentences live here, so a new tool needs one.
//
//   npm run directory:tools            write the file
//   npm run directory:tools -- --check fail when the file isn't current (CI)
import fs from "node:fs";
import path from "node:path";

process.env.ORGANIZER_MODE = "web";
const { createMcpHandler } = await import("mcp-handler");
const { registerTools } = await import("../src/server/mcp");
const { runAs } = await import("../src/server/mcp/principal");

type Annotations = { title: string; readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean };
type Tool = { name: string; title: string; annotations: Annotations };

const handler = createMcpHandler(registerTools);
const request = new Request("https://app.pacedmind.com/api/mcp", {
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/list" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {
    _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} },
  } }),
});
const tools = ((await (await runAs({ kind: "owner" }, () => handler(request))).json()).result.tools as Tool[]);

/** What each tool reads (read-only tools) or does (the others), in words that finish "It only reads …" or "It …". */
const EFFECT: Record<string, string> = {
  get_overview: "today's date, the user's areas and projects, what is overdue, due or planned today, today's events, preferences and sessions waiting for review",
  list_areas: "the user's areas",
  list_projects: "the user's projects",
  get_project: "one project with its tasks",
  list_tasks: "the tasks that match the filters",
  get_task: "one task with its details and the latest report on it",
  get_preferences: "the planning preferences the user saved",
  list_events: "calendar events between two dates",
  get_agenda: "the day-by-day plan: events, tasks, free time and focus blocks",
  get_settings: "the work hours and the account's MCP address",
  list_computers: "the user's computers and what their agents have",
  list_task_note_displays: "the displays of a computer for floating task notes, and recent note results",
  list_sessions: "agent sessions and what they handed back",
  get_next_task: "the next task in a project that is ready to work on",
  create_area: "adds a new area",
  create_project: "adds a new project to an area",
  create_task: "adds one new task",
  create_tasks: "adds several new tasks",
  create_event: "adds a calendar event",
  connect_tasks: "adds a dependency between two tasks of the same project",
  report_progress: "adds a progress note to the session the agent works in",
  set_folder: "records a request for one of the user's computers to use a folder; nothing changes until the user allows it on that computer",
  show_task_note: "asks one of the user's computers to open a floating window for an existing task, without changing the task",
  update_area: "renames an area or changes its color or icon",
  update_project: "changes a project's fields, and can move it with its tasks to another area",
  update_task: "changes a task's fields, which can replace its description, clear its dates or remove sub-tasks",
  bulk_update_tasks: "applies one change to several tasks at once",
  reorder_tasks: "replaces the order of a project's tasks",
  update_preferences: "adds, rewrites or removes the user's saved preferences",
  update_event: "renames or moves a calendar event, the whole series for a weekly one",
  reschedule_day: "moves everything planned for one day, and optionally its deadlines, to another day",
  update_settings: "replaces the work hours, break and work days",
  start_task: "marks a task in progress and records that the agent's session started work on it",
  finish_task: "hands a task back with the agent's report and moves it to review",
  close_session: "marks a running agent session closed and returns its task to Todo",
  disconnect_tasks: "removes a dependency between two tasks",
  delete_area: "deletes an area and its projects, moving their tasks to the Inbox",
  delete_project: "deletes a project, keeping its tasks in the area",
  delete_task: "deletes a task with its sub-tasks, sessions and dependencies",
  delete_event: "deletes a calendar event, or every occurrence of a weekly one",
  start_session: "asks one of the user's computers to start Claude Code or Codex on a task",
  request_changes: "asks to reopen an agent session on the user's computer with the changes the user wants",
};
/** For open-world tools: what they reach outside the account. */
const OUTSIDE: Record<string, string> = {
  set_folder: "a folder setting on one of the user's own computers",
  show_task_note: "a window on one of the user's own computers",
  start_session: "an agent session on one of the user's own computers",
  request_changes: "an agent session on one of the user's own computers",
};
// Deletes whose descriptions tell the assistant to ask the user first, and other changes that can't be undone.
const ASKS_FIRST = new Set(["delete_area", "delete_project", "delete_task", "delete_event"]);
const FINAL = new Set(["close_session", "disconnect_tasks"]);
const LAUNCHES = new Set(["start_session", "request_changes"]);

const problems: string[] = [];
function justify(t: Tool) {
  const a = t.annotations;
  const effect = EFFECT[t.name];
  if (!effect) problems.push(`${t.name}: add its effect to EFFECT in scripts/directory-tools.mts`);
  const readOnly = a.readOnlyHint
    ? `Read-only: it only reads ${effect} and changes nothing.`
    : `Not read-only: it ${effect}.`;
  const destructive = !a.destructiveHint
    ? (a.readOnlyHint ? "Not destructive: it changes nothing." : "Not destructive: it only adds; nothing that exists is overwritten or removed.")
    : ASKS_FIRST.has(t.name)
      ? "Destructive: the deletion can't be undone. The tool's description tells the assistant to ask the user first, and the host asks for confirmation."
      : FINAL.has(t.name)
        ? "Destructive: this can't be undone. It acts only on the item the user names, and the host asks for confirmation."
      : LAUNCHES.has(t.name)
        ? "Destructive: an agent session can change files on that computer. Only when the user asks; the computer's own settings then refuse it, ask the user there, or start it, and connections without two-factor sign-in are refused."
        : "Destructive: it overwrites existing values, which PacedMind can't undo by itself. It acts only on the items the user names, and the host asks for confirmation.";
  const openWorld = a.openWorldHint
    ? `Open-world: it reaches beyond the PacedMind account, to ${OUTSIDE[t.name] ?? "something outside the account"}.`
    : "Not open-world: it stays within the signed-in user's own PacedMind account.";
  if (a.openWorldHint && !OUTSIDE[t.name]) problems.push(`${t.name}: say what it reaches in OUTSIDE in scripts/directory-tools.mts`);
  return { readOnly, destructive, openWorld };
}

const yes = (b: boolean) => (b ? "true" : "false");
const rows = tools.map((t) => `| \`${t.name}\` | ${t.annotations.title} | ${yes(t.annotations.readOnlyHint)} | ${yes(t.annotations.destructiveHint)} | ${yes(t.annotations.openWorldHint)} |`);
const blocks = tools.map((t) => {
  const j = justify(t);
  return [
    `### \`${t.name}\` (${t.annotations.title})`,
    "",
    `- readOnlyHint **${yes(t.annotations.readOnlyHint)}**: ${j.readOnly}`,
    `- destructiveHint **${yes(t.annotations.destructiveHint)}**: ${j.destructive}`,
    `- openWorldHint **${yes(t.annotations.openWorldHint)}**: ${j.openWorld}`,
  ].join("\n");
});
const doc = `# PacedMind Cloud's MCP tools

Generated by \`npm run directory:tools\` from the server's own tool list (\`ORGANIZER_MODE=web\`, as \`https://app.pacedmind.com/api/mcp\` lists them to a signed-in agent). Don't edit by hand: the values come from \`src/server/mcp/metadata.ts\`, the sentences from \`scripts/directory-tools.mts\`.

${tools.length} tools. Every tool has a \`title\` and explicit \`readOnlyHint\`, \`destructiveHint\` and \`openWorldHint\` values, and declares OAuth (\`securitySchemes: [{ type: "oauth2", scopes: [] }]\`). \`attach_image\` and \`ask_user\` exist only on the desktop app's own server and aren't listed here.

| Tool | Title | readOnlyHint | destructiveHint | openWorldHint |
| --- | --- | --- | --- | --- |
${rows.join("\n")}

## Justifications

Paste these into OpenAI's plugin portal (MCPs → the tool → its annotations). They explain the values the server advertises; they don't change them.

${blocks.join("\n\n")}
`;

if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
const out = path.resolve(import.meta.dirname, "..", "deploy", "directory", "tools.md");
const current = fs.existsSync(out) ? fs.readFileSync(out, "utf8").replace(/\r\n/g, "\n") : null;
if (process.argv.includes("--check")) {
  if (current !== doc) {
    console.error("deploy/directory/tools.md is out of date: run npm run directory:tools");
    process.exit(1);
  }
  console.log(`deploy/directory/tools.md is current (${tools.length} tools).`);
} else if (current === doc) {
  console.log(`kept deploy/directory/tools.md (${tools.length} tools)`);
} else {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, doc);
  console.log(`wrote deploy/directory/tools.md (${tools.length} tools)`);
}
