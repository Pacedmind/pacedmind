---
name: pacedmind-review
description: Review and tidy the user's PacedMind planner - triage the Inbox, deal with overdue and stale tasks, check agent sessions waiting for review, and run a weekly review of projects and upcoming deadlines. Use this skill whenever the user asks to triage, clean up, catch up, review the week, see what is overdue, stuck or forgotten, or says their list is a mess, even if they don't mention PacedMind.
---

# Reviews in PacedMind

A review is about decisions, not just lists. Suggest them by the user's preferences (`get_overview` shows them), and when the user settles something that will come up again, offer to save it as a preference. Show items in small batches, each with a suggested decision. Apply what the user confirms, then report what changed. The tools come from the PacedMind MCP server, `pacedmind` (in Claude Code: `mcp__pacedmind__<tool>`, or `mcp__plugin_pacedmind_pacedmind__<tool>` from the PacedMind plugin).

## Triage the Inbox

1. Call `list_tasks` with `area: "inbox"`.
2. Suggest one decision for each task:
   - **Do it**: give it an area or project, a planned day, a priority and an estimate (`update_task`).
   - **Later**: an area or project, and either a planned day further out or no date at all.
   - **Hand to an agent**: move it into a project, set `agent` (the user's Agents and sessions preferences may say which), and write a description an agent can work from.
   - **Drop it**: set status to canceled.
   - For unclear tasks, rewrite the title and description with the user rather than guessing.
3. Apply decisions that are the same for several tasks in one `bulk_update_tasks` call.

## Overdue and stale tasks

- Call `list_tasks` with `overdue: true`. For each task, ask whether it still matters, then:
  - do it today;
  - give it a new, realistic date (changing a due date is a real decision, so say so); or
  - cancel it.
- Some tasks point to something blocking them:
  - tasks in_progress for a long time;
  - tasks whose planned day is in the past with no progress.

  Ask what's in the way, and capture it as a sub-task, a note in the description, or a new task.

## Agent sessions

- `list_sessions` with `status: "waiting"` shows agents that finished and wait for the user's review, with a count of Done when items met, images and questions.
  - `get_task` shows the agent's report: the summary, its answer to each Done when item, image captions, how to check it and its questions.
  - Summarize each one briefly. Lead with what needs the user: hand-backs that were partial or blocked, Done when items that aren't met, and questions. Point to the screenshots in PacedMind rather than describing them.
  - Mark a task done only once the user confirms (`update_task` with status done).
  - When the user wants changes instead, `request_changes` with the task and their feedback in their words sends it back: the agent's session reopens in a new terminal and continues from its report. It opens a terminal on the user's computer, so only use it when the user asks.
- `list_sessions` with `status: "running"` shows sessions still at work. If one has been running a long time without progress, the user may want to look at its terminal or close it with `close_session`.

## Weekly review

Work through these steps briefly, then end with a short summary:

1. **Done**: `list_tasks` with `status: ["done"]`, to acknowledge what got finished.
2. **Inbox**: triage it until it's empty.
3. **Overdue**: decide on each task.
4. **Projects**: go through `list_projects`. For each active project:
   - check its progress against the target date;
   - check it has a clear next task (`get_project`);
   - flag the ones at risk.
5. **Next week**: `get_agenda` for the coming days (at most 14 per call). Make sure every deadline has a planned day and the load fits the free time. The pacedmind-planning skill covers this in detail.
6. **Waiting sessions**: anything left to review.
