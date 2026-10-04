/**
 * The MCP tools a session started by PacedMind may use, and without asking: reading, the session protocol
 * (start_task, attach_image, report_progress, ask_user, finish_task) and adding or updating tasks. They are also all it may use: the
 * server refuses anything else from a session's token (common.ts), so an agent led astray by what it reads
 * can't delete, move the calendar, change projects or start other sessions. You do those in
 * PacedMind or from your own Claude Code or Codex (the owner token).
 */
export const AGENT_ALLOWED_TOOLS = [
  "get_overview",
  "list_areas",
  "list_projects",
  "get_project",
  "list_tasks",
  "get_task",
  "list_events",
  "get_agenda",
  "list_sessions",
  "list_computers",
  "list_task_note_displays",
  "show_task_note",
  "get_settings",
  "get_preferences",
  "get_next_task",
  "start_task",
  "attach_image",
  "report_progress",
  "ask_user",
  "finish_task",
  "create_task",
  "update_task",
] as const;

export const SESSION_TOOLS: ReadonlySet<string> = new Set(AGENT_ALLOWED_TOOLS);
