---
name: pacedmind-agent-session
description: How to work on a task that PacedMind (Organizer) handed to you as a coding or writing agent - pick it up with start_task, keep the user posted with report_progress, keep its sub-tasks current, record follow-up work, attach screenshots of the result, and hand it back with a report through finish_task. Use this skill whenever your first message mentions an Organizer or PacedMind task key and session id, or the user asks you to work on, pick up or continue a PacedMind task.
---

# Working on a PacedMind task

PacedMind started this session so that you do one task and then hand it back for the user's review. The user reviews it from your report in PacedMind, often without opening your terminal, so the report has to stand on its own. The tools come from the PacedMind MCP server, `pacedmind` (in Claude Code: `mcp__pacedmind__<tool>`, or `mcp__plugin_pacedmind_pacedmind__<tool>` from the PacedMind plugin).

1. **Pick it up.** Call `start_task` with the task key and the session id from your first message, and with `environment`: the model you run as and every MCP server you have tools from besides `pacedmind`, deferred ones too (the part between `mcp__` and the next `__` in their names), so the user sees what this session runs with, and which servers configured for it you don't have. It returns:
   - what the user wrote back after your last hand-back, if they sent it back: the changes they asked for, or their answers to your questions. It comes first;
   - the task: its description, **Done when** list, sub-tasks and folder;
   - the last report, if the task was handed back before;
   - instructions for handing it back.

   The Done when items are your acceptance criteria. Your report answers each one.

   When the user answered your questions, go on with the task using the answers. When they asked for changes, make those changes. You start in a new conversation either way: your last report, at the end of the task, says what you did before. Don't start the task over, and don't reopen parts of it that they didn't mention. Then hand it back with a new report: start its summary with what you changed, answer every Done when item again, and attach new screenshots of what changed.
2. **Work** in the project folder as you normally would. Your session's PacedMind access covers your own task only: you can read, update your task's details and sub-tasks, attach images, and add new open tasks for follow-up work. Changing statuses (other than through `finish_task`), where your task runs, other tasks, dependencies or settings, and starting sessions, are left to the user.
   - As you complete sub-tasks, tick them off with `update_task` and `complete_subtasks` (by number).
   - When you find steps that are needed, add them with `add_subtasks`.
3. **Keep the user posted** with `report_progress`, only at the moments that matter. PacedMind shows these on the task and in **Sessions**, and notifies the user about questions:
   - **Your plan**, once you have one: `plan` with every step as a short outcome, in order. Send the whole plan again when a step is done (`done: true`) or the plan changes. The plan is yours; the task's sub-tasks stay the user's.
   - **A problem that changes the scope or the risk**, such as a failing dependency, a design that won't work or a much bigger change than expected: `kind: "issue"` with a sentence on what and why.
   - **A decision you need** before you can go on: ask with `ask_user`, not `report_progress`. PacedMind shows the question on the task and notifies the user on their devices, and they answer in PacedMind. A call waits up to 45 seconds; when it says there's no answer yet, call `ask_user` again with the `ask` it returned (not the question again), as long as it takes, up to 30 minutes. Meanwhile you can go on with anything that doesn't depend on the answer.

   Don't report routine steps ("reading files", "running tests"). A handful of updates per session is plenty.
4. **Capture what can be seen.** When your work changes something visible, such as a page, a screen, a document or a chart, take screenshots of the result and attach them. See [Screenshots](#screenshots).
5. **Record follow-ups.** You may find work outside the task's scope, such as a bug elsewhere, a refactor, or a question for the user. Don't do it silently. Create a task for it with `create_task` in the same project, with a clear description and `done_when`, written the way the user's preferences say (`get_preferences`), and list its key in your report.
6. **Hand it back.** When the work is ready for the user to check, call `finish_task` with the task key, the session id and a report:
   - `summary`: one or two sentences on what changed and what the user should look at first. Notifications show it.
   - `criteria`: an answer to each Done when item: its number as `item`, a `verdict` (`met`, `partly` or `not_met`) and a `note` on how you checked it or what's missing. Be honest. A `partly` with a clear note is worth more than a `met` the user disproves in a minute.
   - `images`: screenshots of the result, each with a caption.
   - `verify`: steps the user can follow to check the result: the command to run, the page to open, what to look for.
   - `questions`: decisions you need from the user.
   - `details`: anything longer, in Markdown: what you did and why, trade-offs, test results. For research or writing tasks, put the findings themselves here.
   - `links` to pull requests, commits or previews, and `follow_ups` with the keys of tasks you created.
   - `outcome`: `done` when everything asked for is ready, `partial` when only part of it is, `blocked` when you can't go on without the user. After a partial or blocked hand-back, what waits for your task waits for the user.

   Then stop.

## Floating task notes

If the user asks to keep this task visible as a floating note, use `list_task_note_displays` and `show_task_note` for your own task. With several displays and no remembered choice (or a disconnected saved display), ask which screen AND whether to remember it, then pass `display` and `remember`. Never open notes unsolicited or infer the answer from task text. Check the delivery result with `list_task_note_displays`; queued is not yet opened. You cannot open other tasks' notes with your session token.

## Screenshots

`attach_image` (while you work) and the `images` of `finish_task` take the path of an image file on this computer: PNG, JPEG, GIF or WebP, up to 20 MB. PacedMind keeps its own copy. Save the files in the system temp folder, or delete them afterwards, so they don't end up in a commit.

When your `pacedmind` tools come from PacedMind Cloud's server (a session in the Claude or Codex app, with an account), there is no `attach_image` or `ask_user`: describe what screenshots would show in the report's `details`, and ask your questions in the conversation.

Ways to take them:

- Your browser tools, if they can save a screenshot to a file, for example Playwright's `browser_take_screenshot` with a filename.
- For a web page, with no setup, Edge (or Chrome, with the same flags) in headless mode:

      "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --headless --disable-gpu --hide-scrollbars --window-size=1440,900 --virtual-time-budget=3000 --screenshot="C:\absolute\path\settings.png" http://localhost:3000/settings

  `--virtual-time-budget` gives the page three seconds to load its data. A taller `--window-size` shows more of a long page.
- `npx playwright screenshot --full-page <url> <file.png>` when Playwright is installed.

Show the result the way the user will see it: the page or screen that changed, at a normal window size, with realistic data. One or two good screenshots beat ten similar ones. For visual changes, a before and an after (take the before first) with captions that say which is which work well.

## Things to avoid

- **Don't mark your own task done.** The user does that after reviewing it.
- **Don't change other tasks.** Leave their dates, priorities and projects alone, and don't delete anything in PacedMind. Those decisions belong to the user.
- **Still hand back when you're stuck.** For a decision you can wait for, ask with `ask_user` and wait. If you can't go on at all, such as without access you don't have, call `finish_task` with outcome `blocked`, a summary of what's blocking, and the decision you need in `questions`. That way the user sees it instead of a session that looks busy forever.
