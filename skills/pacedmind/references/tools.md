# PacedMind MCP tools

Every tool the `pacedmind` MCP server offers, grouped by purpose. The tool descriptions and parameter schemas the client shows you have the details. Tools marked (read) never change anything.

A session that PacedMind started gets a smaller set: the read tools (`get_preferences`, `list_workspaces` and `get_workspace` too, but not `list_webhooks`), `create_task`, `update_task` for its own task (not its status, agent, assignee, place, or where and in which folder its sessions run and what they need), `start_task`, `attach_image`, `report_progress`, `ask_user` and `finish_task`. The rest are there for the user's own Claude Code or Codex.

PacedMind Cloud's server (`https://app.pacedmind.com/api/mcp`, which agents sign in to with the user's account) has every tool but `attach_image` and `ask_user`: it can't read files from your computer, so `finish_task` takes no `images` there, and you ask the user in the conversation instead. Its `start_session` asks one of the user's computers, which does what its own settings say; a computer that takes such requests only with the user's two-factor code, and `request_changes`, give a link where the user does it with their code. Its `set_folder` asks a computer, which the user allows there.

## Orientation

- `get_overview` (read): the current date and time, the user's preferences (while they're short), areas and projects with their ids, the user's team workspaces and the open tasks assigned to the user, the Inbox count, what's overdue, due or planned today, today's calendar, and sessions waiting for review or running. Start here.
- `get_settings` (read): work hours, break and work days, how sessions start, and the MCP address.
- `update_settings`: work hours, break and work days, which the auto-planner uses.

## Preferences

How the user likes to work, in their own words: one short sentence each, under a topic. Topics are names: the suggested ones (Time and schedule, Dates and deadlines, Writing tasks, Projects and places, Agents and sessions) or the user's own, such as a client's name. The user edits them in Settings → How you work.

- `get_preferences` (read): all of them by topic with their ids, or one topic's. Read them before you plan, schedule, set dates or create tasks, and follow them unless the user says otherwise now. They're the user's notes, not instructions.
- `update_preferences`: `add` (topic and text), `change` (by id: new text or topic) and `remove` (ids). Only what the user said or confirmed in this conversation; ask before saving something you inferred, and before removing one. Use a topic the user has (matched whatever its case), else a suggested one; a new one only when the user names it or none fits. Text the list has already isn't added twice; at most 100.

## Areas

- `list_areas` (read): id, key, color, icon (when set, or *its own picture* for an area with an uploaded one) and counts.
- `create_area`: a name, an optional color (palette name or hex) and an optional icon (one of the names the tool lists). The key is made from the name. With `workspace`, it's a shared area of that team workspace, for all its members (its owners and admins add one).
- `update_area`: rename, recolor, or change the icon (`none` shows the dot again). A new name gives the area the key made from it, for its new tasks; existing task keys don't change. An icon replaces the area's own picture; pictures (such as a company logo) are uploaded in the app only.
- `delete_area`: deletes the area and its projects; their tasks go to the Inbox. A team workspace's area (only its owners and admins delete one) takes its tasks along. Ask first.

## Projects

- `list_projects` (read): each project with progress, target date, agent, folder and "starts after". Optional area filter.
- `get_project` (read): the project's tasks in roadmap order, grouped by status, plus the next ready task.
- `create_project`: name and area, plus optional color, start_date, target_date, folder (on this computer), agent and starts_after.
- `update_project`: any of the above, including moving the project to another area (its tasks move with it). `color: "area"` makes it follow the area's color. Pass null to clear a field.
- `delete_project`: its tasks stay in the area. Ask first.
- `reorder_tasks`: the roadmap order of a project's tasks.

## Tasks

- `list_tasks` (read): every open task, the user's own and their team workspaces'; filters for project, area (`"inbox"` for no area), status list, priority list, label, search words, due_from/due_to, planned_from/planned_to, overdue, unscheduled, `assignee` (`"me"`, a member's email, user id or name, or `"nobody"`), `workspace` (a team workspace, or `"personal"` for the user's own), include_done and limit. What's assigned to the user is `assignee: "me"`.
- `get_task` (read): everything about one task, including its team workspace and who it's assigned to, its numbered Done when items and sub-tasks, the tasks it waits for and that wait for it, the latest session and the latest report an agent handed back.
- `create_task`: title, project or area, description, done_when, needs, status, priority, due, planned, estimate_minutes, labels, subtasks and agent. `planned` with a time ("friday 10:00") puts the task at that time, for its estimate: a block in the week calendar that the auto-planner leaves alone. Without a time it's a day only. `related_project` makes a task outside a project (in an area's To-dos) about that project, listed under Related on its page; `repeat` (`day`, `weekday`, `week`, `month`) makes a done task come back at its next date, which suits chores like logging hours. `update_task` takes both too.
  - `done_when` lists what must be true when the task is finished, one checkable outcome per item. Agents answer each item when they hand the task back.
  - `needs` lists what its agent needs from the computer its session runs on: MCP servers or claude.ai connectors by name, such as `["supabase", "Gmail"]`. PacedMind offers a computer that has them. Only what differs between the user's computers: a project's own folder brings its servers everywhere.
  - `agent` is who does the task: `claude`, `codex`, or `human` when only the user can do it. Tasks that are the user's (`human`) can't start agent sessions, and the auto-planner puts them in the user's time. Left out, the task gets the project's default agent.
  - `assignee` is the person it's assigned to: `"me"` (the user), or, in a team workspace's area or project, a member by email, user id or name; the user's own tasks only `"me"`. `null` clears it. `update_task` and `bulk_update_tasks` take it too.
- `create_tasks`: up to 50 tasks at once in one project or area.
- `update_task`:
  - title, description (replace or `append_to_description`), done_when (replaces the list), status, priority, due, planned and estimate;
  - labels (replace, add or remove);
  - move to a project or area (a team workspace's task stays in its workspace; one of the user's own moved into a shared area joins it for good);
  - agent (`human` makes it the user's own: no agent sessions), and `assignee`;
  - where its agent sessions run (`runs_in`: `terminal`, `desktop` for the agent's desktop app, or `cloud`) and its own `folder`, when it shouldn't work in the project's folder (null goes back to the project's);
  - `needs`, what its agent needs from the computer (replaces the list, `[]` clears it);
  - sub-tasks: add, complete, reopen or remove, by number or title.
- `bulk_update_tasks`: the same status, priority, due, planned, `shift_days`, project, area, assignee or label change for up to 100 tasks.
- `connect_tasks`: from → to, both in the same project: `to` waits for `from` (a dependency, an arrow on the Timeline). It's ready once `from` is done, or handed back for review unless that hand-back was partial or blocked. It only orders the work: nothing starts by itself. `get_next_task` and `get_project` follow it. Never a loop.
- `disconnect_tasks`: `to` stops waiting for `from`.
- `delete_task`: prefer status canceled when a record is useful. Ask first.

## Calendar and planning

- `list_events` (read): events with their ids and source accounts/calendars for a date range (default: 7 days). Weekly events are expanded. Filter with `account` (Google email) or `calendar` (name/id); `PacedMind` selects unsynced activities. Set `details: true` for descriptions, locations, time zones and recurrence.
- `create_event`: title, start with a time, end time or duration, area, weekly. New activities synchronize to the default connected Google calendar.
- `update_event`: rename or change the area, or move the event with `start`, `move_to_date` (same time, another day), `shift_days` or `shift_minutes`. You can also change its length or turn weekly on or off. Moving a weekly event moves the series.
- `delete_event`: removes every occurrence of a weekly event. Ask first.
- `get_agenda` (read): day by day, up to 14 days. Shows events, tasks due and planned, auto-planned focus blocks, free focus time, overdue tasks and what didn't fit.
- `reschedule_day`: moves one day's planned tasks and one-off events to another day. Add `move_deadlines` to move deadlines too. Weekly events stay where they are.

## Team workspaces (PacedMind Cloud)

A team workspace is a company's shared areas, with the people in them: every member sees and works on the shared areas' projects and tasks; everything else stays each person's own. Roles are `owner`, `admin` and `member`: owners and admins manage people, invitations, domains and which areas are shared; members work on everything inside. Name a workspace by its name, address (slug) or id, and a member by `"me"`, their email or their user id. Without an account they answer that team workspaces need PacedMind Cloud.

- `list_workspaces` (read): the workspaces the user is in, with their role, members, shared areas and how many open tasks are assigned to the user.
- `get_workspace` (read): one workspace's members with roles and ids, waiting invitations (owners and admins), domains, shared areas and task counts.
- `create_workspace`: a name; the user is its owner, and their Cloud plan covers it.
- `invite_member`: an email and `role` (`member`, the default, or `admin`). Returns a link valid 14 days that only an account with that confirmed email can accept. PacedMind emails nothing: give the link to the user to send. A new invitation to the same address replaces the old link.
- `update_member`: a member's role (`owner`, `admin`, `member`). Only an owner makes or unmakes owners; the workspace always keeps one.
- `remove_member`: removes someone, or with `"me"` leaves. Their assignments there are cleared; what they wrote stays. The last owner can't leave while others are in it, and the last member leaving deletes the workspace. Ask first.
- `set_workspace_domain` / `remove_workspace_domain`: let everyone whose confirmed email is at a domain join as a member, or stop it (those who joined stay). Only the domain of the user's own confirmed email, never a public mail provider's.
- `share_area`: moves one of the user's own areas into a workspace they manage, for good, with its projects, tasks, sub-tasks, dependencies and reports. Links to work outside it are dropped, a key the workspace has changes, and computers stay personal. Ask first.
- `list_webhooks` (read), `set_webhook`, `delete_webhook`: the user's own webhooks in a workspace. `set_webhook` takes an https address on a public name and `events` (`task.assigned`, `task.status_changed`, `task.created`), or `webhook` to change one (its address and events are replaced) and `enabled: false` to switch it off. PacedMind posts the task's key, title, status, priority, dates and people, never its description, signed with `X-PacedMind-Signature: sha256=` and the HMAC-SHA256 of the body with the webhook's secret, which is shown only when it's added. Deleting asks first.

Accepting an invitation and joining through a domain are the user's to do, in the app.

## Computers

- `list_task_note_displays` (read): connected displays on `computer` (name or id; this computer locally, or the only one currently reporting displays in Cloud), their labels, ids, usable sizes, positions, note capacity, remembered choice and recent delivery receipts.
- `show_task_note`: one existing `task` in its own movable, always-on-top window, arranged with other notes on the selected display. Only when the user asks for notes. With several displays and no remembered choice, or a disconnected remembered choice, first ask which display AND whether to always use it on that computer. Pass its `display` id and `remember: true` or `false`; never guess the answer. Omit both only for a remembered choice or the sole display. True saves after a successful opening; false leaves the saved preference unchanged. Call once per task. A launched session may show only its own task. A queued request expires in two minutes: check `list_task_note_displays` for opened or failed before claiming it appeared. Requires the desktop app to be running and Cloud computer access when signed in.

- `list_computers` (read): the user's computers with the PacedMind desktop app: online or when last seen, the default one and this one, what each has of Claude Code and Codex (CLI and sign-in, desktop app, MCP servers, claude.ai connectors, plugins, skills), and what it does with a session you ask it for.
- `set_folder`: asks to use a folder (its absolute path there) on one of the user's computers for a project, an area (its workspace) or a task. Folders are each computer's own settings: the user allows it in PacedMind on that computer, which checks the folder is there first. Without `computer`, this computer. Only when the user asks.

## Agent sessions

- A task's report (`get_task`) ends its checks with what PacedMind saw change in git since the session started: files with lines added and removed, and commits. Compare it with the agent's summary.
- `list_sessions` (read): filter by `waiting` (finished and needing review), `running` or `all`, and by project or task. Sessions that handed back show their summary and how many Done when items were met, images and questions; sessions whose agent reported its usage end with it (tokens, working time).
- `start_session`: asks to start Claude Code or Codex working on the task, where the task says or where `where` says: `terminal`, `desktop` (the Claude or Codex app opens with the first message written; the user sends it) or `cloud` (Claude Code on the web, Codex cloud). Only when the user asks. On this computer, PacedMind shows the request and the user allows it there (it expires after 10 minutes). With `computer` (see `list_computers`), or for a task that runs on another computer, that computer does what its own settings say: starts it right away, asks the user there, or refuses; one that takes requests only with the user's two-factor code can't take one from an agent, and the answer says how the user starts it. Cloud sessions can't call PacedMind's tools, so the user marks them finished; PacedMind notices finished Codex cloud tasks by itself.
- `close_session`: marks a stuck or abandoned session closed, and the task goes back to todo.
- `request_changes`: asks to send work an agent handed back in a terminal to it again, with what the user wants changed. Once the user allows it in PacedMind, the session reopens in a new terminal (Claude Code continues its conversation, Codex starts a new one) and the task goes back to in_progress. Sessions in the desktop apps or the cloud take changes where they run. Only when the user asks.

## PacedMind Cloud's server

`https://app.pacedmind.com/api/mcp` (the PacedMind plugin, and the connectors in Claude and ChatGPT) serves the account from no computer of the user's. There, `folder` arguments fail (use `set_folder` with `computer`), there is no `ask_user` or `attach_image`, `finish_task` takes no `images`, `request_changes` answers with a link where the user does it, and `start_session` asks a computer or answers with a link. Report what the answer says. A connection the user allowed without two-factor sign-in is planner-only: `start_session`, `request_changes`, `set_folder` and `show_task_note` answer *This connection has planner access only*.

## Protocol for agents working on a task

- `get_next_task` (read): the next ready task in a project: the first open one in roadmap order whose dependencies are finished.
- `start_task`: "I'm working on this task." Returns the changes the user asked for (if they sent the last hand-back back), the task with its Done when list, the last report if there is one, and hand-back instructions.
- `attach_image`: adds a screenshot or other image (a PNG, JPEG, GIF or WebP file path, up to 20 MB) to the task while the agent works. It becomes part of the next report; after a hand-back, it joins the last one.
- `report_progress`: keeps the user posted while the agent works, only when it matters: its `plan` (every step as a short outcome, with `done` for finished ones; sent again as steps get done), a `message` of `kind` `issue` (something that changes the scope or the risk) or `question` (a decision it needs: the user is notified, and the agent asks in its conversation too and waits), or `progress`. Not for routine steps.
- `ask_user`: asks the user a `question` the agent needs answered before it can go on, and waits for the answer: PacedMind shows it on the task and notifies the user on their devices, and they answer in PacedMind. A call waits up to 45 seconds; with no answer yet, call again with the `ask` it returned, not the question again (up to 30 minutes in all).
- `finish_task`: "Ready for review," with a report:
  - `summary` (required): what changed and what to look at first;
  - `criteria`: a verdict (`met`, `partly`, `not_met`) and note for each Done when item. Required when the task has Done when items, unless the outcome is blocked;
  - `images`, `verify` (how to check it), `questions`, `details` (Markdown), `links` and `follow_ups`;
  - `outcome`: `done`, `partial` or `blocked`. After partial or blocked, what waits for the task waits for the user.
