---
name: pacedmind-intake
description: Turn what the user asks for into a well-placed PacedMind task without a question for every field - read their saved preferences, the pacedmind.md of the folder you're in and what they already said, then ask only what's still open (where it goes, when, the deadline, who does it, which computer and folder) in one short message with suggested answers, and save what they want every agent to know as a preference. Use this skill whenever the user asks to add, capture, schedule or hand off a task, a reminder or a piece of work ("add a task", "remind me", "put it on my list", "have Codex do this on my Mac", "plan this for next week"), or tells you how they like to work, even if they don't mention PacedMind.
---

# Asking the right questions

Every task needs a place, a time and someone to do it. Most of that the user has already told you, or told PacedMind. Work it out first, then ask only for the rest, once. The tools come from the PacedMind MCP server, `pacedmind` (in Claude Code: `mcp__pacedmind__<tool>`, or `mcp__plugin_pacedmind_pacedmind__<tool>` from the PacedMind plugin).

## 1. Gather what's known

- **`get_overview`**: today's date and time, the areas and projects with their ids, what's already planned, and the user's **preferences** (all of them with `get_preferences` when the overview only gives a count). Preferences are how the user likes to work, in their own words, under topics such as Time and schedule, Dates and deadlines, Writing tasks, Projects and places, Agents and sessions, or topics of their own. Follow them.
- **The folder you're in**: a `pacedmind.md` in it, or in a folder above it, names the PacedMind project or area it belongs to (`project:` and `area:`, with their ids). Work about this folder goes there unless the user says otherwise.
- **Your own memory** (such as Claude Code's memory or a CLAUDE.md) may know the user's habits too. PacedMind's preferences win when they differ: they're what the user told every agent, and they're current.
- **The day**: `get_agenda` shows the free time, so a planned time lands in a gap rather than on a meeting.
- **Agent work on another computer**: `list_computers` shows which computer has the agent, MCP servers and connectors the task needs, and what it does with a session you ask it for.

## 2. Work out what's still open

Fill in each field from the request, the preferences, the folder and the conversation. Ask only about what none of them settle.

| Field | Usually settled by | Ask only when |
|---|---|---|
| Where: project, area or Inbox | the folder's pacedmind.md, a project the user names, a Projects and places preference | several places fit and it matters |
| Planned day and time | the request ("tomorrow"), a Time and schedule preference, the free time in the agenda | the user wants it on the calendar and nothing says when |
| Due date | only a real deadline the user gives; a Dates and deadlines preference may say how far before it to plan | the user hints at one ("before the demo"). Never invent one |
| Who does it (`agent`) | the request, an Agents and sessions preference, the project's default agent | it could be the user's or an agent's |
| Estimate, priority, labels | the kind of work, Writing tasks preferences | they change the plan |
| Done when | the request, for agent work | the outcome isn't clear |
| Computer and folder, for agent work | the task's or project's computer, `list_computers`, the project's folder there | the agent needs a folder there that isn't set |

## 3. Ask once

Send one message with a suggested answer for every open question, so that "yes" or a short correction settles it:

    I'll add "Fix the invoice export" to Organizer app (this folder):
    - planned for tomorrow 9:00, 90 minutes (your mornings are for deep work), no due date;
    - done by Codex (your preference for refactors), in a terminal on this computer.
    OK, or should I change something?

- Say what you assumed from the preferences instead of asking about it again.
- Two or three open questions at most. More means the work isn't clear yet: put it in the Inbox with a note, and say what's missing.
- When the user only wants it noted ("add it to the inbox", "remind me"), note it without questions.

## 4. Create it

- `create_task` (or `create_tasks` for several) with everything settled. Check the dates in the result, and tell the user the key, where it went and when it's planned.
- When the user wants an agent on it now: `start_session`. On this computer the user allows it in PacedMind; on another one (`computer`), that computer does what its own settings say, and the answer tells you which.
- When agent work needs a folder that a computer doesn't have for the project and the user tells you where it is there: `set_folder` asks that computer to use it, and the user allows it there.

## 5. Learn

When the user tells you how they like to work, or answers something you'd otherwise have to ask again next time ("never before 9", "Acme work goes to Clients", "Codex does the backend"), offer to keep it for every agent:

    Should every agent know this? I'd save it under Time and schedule: "No meetings before 9:00".

- On yes: `update_preferences` with `add`, or `change` (by id) when it updates one they have. One short sentence in the user's words, under a topic of theirs that fits, else a suggested one; a new topic only when the user names it or none fits.
- Never save what the user didn't say or confirm, and nothing about a single task: that goes in the task.
- How the user plans and works belongs in PacedMind, where every agent on every computer reads it. How you work together in this tool (your own conventions) stays in your memory.
