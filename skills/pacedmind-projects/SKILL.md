---
name: pacedmind-projects
description: Set up and structure projects in PacedMind - create the project, break the work into well-described tasks with sub-tasks and estimates, order the roadmap, set target dates and dependencies between tasks and between projects, and mark which tasks agents do. Use this skill whenever the user starts something new ("I want to build...", "new project", "help me plan X"), asks for a breakdown, roadmap or milestones, or wants agents to work through a project, even if they don't mention PacedMind.
---

# Projects in PacedMind

The tools come from the PacedMind MCP server, `pacedmind` (in Claude Code: `mcp__pacedmind__<tool>`, or `mcp__plugin_pacedmind_pacedmind__<tool>` from the PacedMind plugin).

## Set up a project

1. Call `get_overview` to see the areas, the existing projects and the user's preferences (Projects and places, Agents and sessions, Writing tasks). If a matching project already exists, extend it rather than creating a duplicate. A `pacedmind.md` in the folder you work in names the project or area it belongs to.
2. Call `create_project` in the right area, and propose a target date if the user hasn't given one. For code projects:
   - set `folder` to the repository's absolute path, so agent sessions on this computer start in the right place. On another of the user's computers, or through PacedMind Cloud's server (where `folder` fails), `set_folder` with `computer` asks that one to use its copy (the user allows it there);
   - set `agent` to claude or codex, as the user's preferences say when they do.
3. If the project has to wait for another one, set `starts_after`.

## Break the work down

Aim for tasks of roughly 30 minutes to one day of work. Bigger ones hide uncertainty, so split them. Much smaller ones work better as sub-tasks.

- Order the tasks the way they'll be done, and let each one leave the project in a working state.
- Give each task:
  - a verb-first title;
  - a description with the context: why, constraints, links, in Markdown (short paragraphs or a list, `code` for paths and commands);
  - `done_when`: the outcomes that must be true when it's finished, each one checkable. Agents answer every item when they hand the task back, and the user reviews against them. For work with a visible result, include a screenshot item, such as "A screenshot of /reports with the new button";
  - sub-tasks for its steps;
  - an estimate.
- Create them all in one `create_tasks` call. Only set `planned` or `due` where the user has dates in mind; otherwise leave scheduling to planning.
- Tasks without a planned day, a due date or urgent/high priority stay off the auto-planner's focus blocks. If the user wants to start soon, give the first one or two tasks a planned day so they show up on the calendar.
- Set the roadmap order with `reorder_tasks`.
- Show the user the breakdown (keys and titles) and adjust it before building more on top.

A task an agent can act on:

    title: "Add CSV export to the reports page"
    description: "Finance wants monthly exports for their spreadsheet. Use the same query as the table."
    done_when:
      - "A Download CSV button on /reports downloads the rows for the current filters"
      - "The CSV has the table's columns, with dates as YYYY-MM-DD"
      - "An empty report gives a file with only the header"
      - "A screenshot of /reports with the button"

## Who does what, and in which order

1. Mark who does what: set `agent` to claude or codex for work an agent can do on its own (code, writing, research), and to `human` for tasks only the user can do (calls, purchases, decisions, reviews). Human tasks stay in the project and on its roadmap, but never get an agent session. Use `update_task` or `create_tasks`.
2. Where a task can't begin before another is finished, make it wait with `connect_tasks` from → to (same project, never a loop). Dependencies show as arrows on the Timeline, and `get_next_task` and `get_project` follow them. Leave independent tasks unconnected: the roadmap order is enough.
3. Nothing starts by itself. The user starts a session with the Start button in PacedMind; if they ask you to, `start_session` sends the request and they allow it in PacedMind.

## Keep projects healthy

- `get_project` shows the tasks by status and the next ready task. `list_projects` shows progress and target dates.
- If a target date is at risk, tell the user early and offer options: cut scope, move the date (`update_project` with `target_date`), or plan more time.
- When a project is finished, mark the remaining tasks done or canceled rather than deleting the project, unless the user wants it gone.
