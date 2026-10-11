---
name: pacedmind-planning
description: Plan the user's day or week in PacedMind - review the agenda, fit tasks into free focus time, set priorities, and move tasks and calendar events between days. Use this skill whenever the user asks what to work on, wants to plan today or this week, wants to reschedule or push something ("move X to Friday", "clear my afternoon", "I'm sick today"), says they are overloaded or behind, or asks for a schedule, even if they don't mention PacedMind.
---

# Planning with PacedMind

Planning works best as a short conversation. Look at the real schedule, propose a plan, and change PacedMind only for what the user agrees to or clearly asked for. The tools come from the PacedMind MCP server, `pacedmind` (in Claude Code: `mcp__pacedmind__<tool>`, or `mcp__plugin_pacedmind_pacedmind__<tool>` from the PacedMind plugin).

Start from the user's preferences (in `get_overview`, all of them in `get_preferences`): when they do deep work, when they take meetings, how much slack they want, their days off. Plan by them, and say when a plan has to break one. When the user states a new rule ("nothing before 9", "Fridays are for admin"), offer to save it with `update_preferences`.

## Plan a day

1. Call `get_agenda` for the day; it defaults to today. It shows:
   - fixed events;
   - tasks due and planned;
   - the auto-planner's focus blocks;
   - free focus time, overdue tasks, and what didn't fit.
2. Compare what's committed with the free time. When planned work is more than the free time, something has to move, and it's better to say so now than at 5 pm.
3. Propose the day in a few lines:
   - first the one to three things that matter most: deadlines today, urgent tasks, and overdue tasks that still matter;
   - then the rest;
   - finally, point out conflicts and anything that won't fit.
4. Apply what the user agrees to:
   - Doing it today: `update_task` with `planned` set to today, plus a priority if needed.
   - Not today: set `planned` to a realistic day, or clear it with null. For many tasks, use `bulk_update_tasks` with `planned` or `shift_days`.
   - A deadline that really moves: change `due` only when the user says the deadline itself changed. A planned day is the user's intention; a due date is a promise.
5. After several changes, call `get_agenda` again and show the resulting day.

## Plan a week

1. Call `get_agenda` from today to the end of the week (at most 14 days per call), and `list_tasks` with `due_to` a week out to see upcoming deadlines.
2. Spread the work:
   - give each task a specific planned day before its deadline;
   - put heavier work on days with more free time;
   - leave slack, because a week planned to 100% breaks on the first surprise.
3. Keep project target dates in view with `list_projects`, and point out projects that can't make it.

## Move things

- **One task**: `update_task` with `planned` or `due`.
- **Several tasks by the same amount**: `bulk_update_tasks` with `shift_days`.
- **A whole day** ("I'm out tomorrow"): `reschedule_day` from one day to another.
  - Add `move_deadlines: true` only if the deadlines really move.
  - Weekly events stay; tell the user which ones they may want to skip.
- **A calendar event**: `update_event`.
  - `move_to_date` keeps the time on a new day.
  - `start` sets a new time.
  - `shift_minutes` nudges it on the same day.
  - Moving a weekly event moves every occurrence, so say so before doing it.

## When the user is overloaded

Moving everything to tomorrow makes tomorrow worse. Instead:

- Look for work that can be:
  - **dropped**: status canceled;
  - **handed to an agent**: set `agent` and give it a proper description;
  - **made smaller**: trim sub-tasks or the estimate;
  - **postponed for real**: a later planned day, or `planned: null` to unschedule it.
- Protect the deadlines that matter. Changing a deadline is the user's call.
- Say how much work is over the free time (for example "about 3 hours more than your free focus time this week"), so the trade-off is visible.

## How focus blocks are made

The auto-planner fills free time inside work hours around events and the break (see `get_settings`; change them with `update_settings`).

- It schedules open tasks that have no agent and have a due date, a planned day or urgent/high priority.
- It goes most urgent first and uses each task's estimate.
- When an agent session finishes, it adds a short review block for the user.

You can't place a block directly. To change the blocks, change the task: its planned day, due date, priority or estimate.

## Example

User: "I'm sick today, push everything."

1. `get_agenda` for today.
2. Suggest what should move. Also point out today's deadlines, which may need a message to someone rather than a new date.
3. Once the user confirms, call `reschedule_day` from today to tomorrow, or to the next work day with room. Use `bulk_update_tasks` if only some tasks move.
4. Report what moved and anything that is still due today.
