import "server-only";
import { format } from "date-fns";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { mcpUrl } from "../launcher";
import { agentCommandFor, deviceConfig } from "../device";
import * as repo from "../repo";
import { MODE } from "../supabase";
import { cloudMcpUrl } from "../supabase-config";
import { planTimeBlocks, type PlanResult } from "@/lib/planner";
import { addDaysStr, dateOnly, dayDiff, hhmm, minutesOf, parseLocal, timeOf, toDateStr } from "@/lib/dates";
import { PRIORITY_LABEL, type CalEvent } from "@/lib/types";
import { terminalFor } from "@/lib/terminals";
import {
  areaRef, dateInput, dateTimeInput, eventLine, fail, findAreaOrInbox, findEvent, fmtMinutes, fmtWhen, isOpen, names,
  taskLine, todayLine, tool, when, type Names,
} from "./common";

const DAY_NAMES = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const dayLabel = (d: string) => `${format(parseLocal(d), "EEE")} ${d}`;
/** 1 = Monday … 7 = Sunday, as in the work-day settings. */
const weekdayOf = (d: string) => ((parseLocal(d).getDay() + 6) % 7) + 1;

function eventText(e: CalEvent, n: Names): string {
  return `Event ${e.id} · ${e.title} · ${fmtWhen(e.start.slice(0, 10))} ${timeOf(e.start)}–${timeOf(e.end)}` +
    `${e.areaId ? ` · ${n.area(e.areaId)}` : ""}${e.recurrence === "weekly" ? ` · weekly on ${format(parseLocal(e.start), "EEEE")}s` : ""}`;
}

/** An event's end: a time on the start's day ("18:30"), a date-time on the same day, or start + duration. */
function endFor(start: string, end: string | undefined, minutes: number | undefined): string {
  let value: string;
  if (end !== undefined) {
    const t = /^(\d{1,2}):(\d{2})$/.exec(end.trim());
    value = t ? `${start.slice(0, 10)}T${t[1].padStart(2, "0")}:${t[2]}` : when(end, "required");
  } else {
    const m = minutesOf(start.slice(11, 16)) + (minutes ?? 60);
    if (m > 24 * 60) fail("The event would run past midnight. Events stay within one day.");
    value = `${start.slice(0, 10)}T${hhmm(Math.min(m, 24 * 60 - 1))}`;
  }
  if (value.slice(0, 10) !== start.slice(0, 10)) fail("An event starts and ends on the same day.");
  if (value <= start) fail("The end has to be after the start.");
  return value;
}

const durationOf = (e: CalEvent) => minutesOf(e.end.slice(11, 16)) - minutesOf(e.start.slice(11, 16));

function readTime(label: string, value: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) fail(`${label} needs a time like 09:00.`);
  return `${m[1].padStart(2, "0")}:${m[2]}`;
}

export function registerCalendarTools(server: McpServer) {
  tool(server, "list_events", {
    title: "List calendar events",
    description:
      "Fixed calendar activities (meetings, gym, appointments) between two dates, including weekly ones. Each shows its event id for update_event and delete_event.",
    input: z.object({
      from: dateInput.optional().describe("Defaults to today"),
      to: dateInput.optional().describe("Defaults to 6 days after from"),
      area: areaRef.optional(),
    }),
    kind: "read",
  }, async (args) => {
    const from = args.from ? when(args.from, "drop") : toDateStr(new Date());
    const to = args.to ? when(args.to, "drop") : addDaysStr(from, 6);
    if (to < from) fail("to is before from.");
    if (dayDiff(from, to) > 92) fail("Ask for at most three months at a time.");
    const area = args.area ? await findAreaOrInbox(args.area) : undefined;
    const [n, list, all] = await Promise.all([names(), repo.listEvents(), repo.occurrences(from, to)]);
    const weekly = new Set(list.filter((e) => e.recurrence === "weekly").map((e) => e.id));
    const occ = all.filter((e) => area === undefined || e.areaId === (area?.id ?? null));
    if (!occ.length) return `No events from ${fmtWhen(from)} to ${fmtWhen(to)}.`;
    const days = [...new Set(occ.map((e) => dateOnly(e.start)))];
    return days.map((d) => `${dayLabel(d)}:\n${occ.filter((e) => dateOnly(e.start) === d).map((e) => `- ${eventLine(e, n, weekly.has(e.eventId))}`).join("\n")}`).join("\n\n");
  });

  tool(server, "create_event", {
    title: "Create calendar event",
    description:
      "Add a fixed activity to the calendar (a meeting, workout, appointment). The auto-planner keeps focus time around it. Weekly events repeat on the same weekday.",
    input: z.object({
      title: z.string(),
      start: dateTimeInput.describe('Start with a time, e.g. "2026-09-26T14:00" or "friday 14:00"'),
      end: z.string().optional().describe('End time ("15:30") or date-time on the same day'),
      duration_minutes: z.number().int().min(5).max(24 * 60).optional().describe("Used when end is left out; default 60"),
      area: areaRef.optional(),
      weekly: z.boolean().optional(),
    }),
    kind: "create",
  }, async (args) => {
    if (!args.title.trim()) fail("An event needs a title.");
    const start = when(args.start, "required");
    const end = endFor(start, args.end, args.duration_minutes);
    const areaId = args.area ? (await findAreaOrInbox(args.area))?.id ?? null : null;
    const id = await repo.createEvent({ title: args.title, areaId, start, end, recurrence: args.weekly ? "weekly" : null });
    return `Created ${eventText((await repo.getEvent(id))!, await names())}.`;
  });

  tool(server, "update_event", {
    title: "Update or move calendar event",
    description:
      "Rename an event, change its area, or move it: to a new start (keeps its length), to another day at the same time (move_to_date), or by a number of days or minutes. For a weekly event this moves the whole series.",
    input: z.object({
      event: z.number().int().describe("Event id from list_events"),
      title: z.string().optional(),
      area: areaRef.nullable().optional().describe('An area, or null / "none" for no area'),
      start: dateTimeInput.optional().describe("New start with a time; the length stays unless you give end or duration_minutes"),
      move_to_date: dateInput.optional().describe("Same times, another day"),
      shift_days: z.number().int().min(-366).max(366).optional(),
      shift_minutes: z.number().int().min(-24 * 60).max(24 * 60).optional().describe("Move earlier (negative) or later on the same day"),
      end: z.string().optional().describe('New end time ("15:30") or date-time on the same day'),
      duration_minutes: z.number().int().min(5).max(24 * 60).optional(),
      weekly: z.boolean().optional().describe("Turn repeating on or off"),
    }),
    kind: "write",
  }, async (args) => {
    const e = await findEvent(args.event);
    const moves = [args.start, args.move_to_date, args.shift_days, args.shift_minutes].filter((x) => x !== undefined).length;
    if (moves > 1) fail("Use only one of start, move_to_date, shift_days and shift_minutes.");
    let start = e.start;
    if (args.start !== undefined) start = when(args.start, "required");
    if (args.move_to_date !== undefined) start = `${when(args.move_to_date, "drop")}T${timeOf(e.start)}`;
    if (args.shift_days !== undefined) start = `${addDaysStr(e.start, args.shift_days)}T${timeOf(e.start)}`;
    if (args.shift_minutes !== undefined) {
      const m = minutesOf(e.start.slice(11, 16)) + args.shift_minutes;
      if (m < 0 || m + durationOf(e) > 24 * 60) fail("That would move the event into another day. Use shift_days or move_to_date for that.");
      start = `${e.start.slice(0, 10)}T${hhmm(m)}`;
    }
    const end = args.end !== undefined || args.duration_minutes !== undefined
      ? endFor(start, args.end, args.duration_minutes)
      : endFor(start, undefined, durationOf(e));
    if (args.title !== undefined && !args.title.trim()) fail("The title can't be empty.");
    await repo.updateEvent(e.id, {
      title: args.title,
      areaId: args.area === undefined ? undefined : (await findAreaOrInbox(args.area))?.id ?? null,
      start,
      end,
      recurrence: args.weekly === undefined ? undefined : args.weekly ? "weekly" : null,
    });
    return `Updated ${eventText((await repo.getEvent(e.id))!, await names())}.`;
  });

  tool(server, "delete_event", {
    title: "Delete calendar event",
    description: "Remove an event from the calendar. For a weekly event this removes every occurrence. It can't be undone.",
    input: z.object({ event: z.number().int() }),
    kind: "delete",
  }, async ({ event }) => {
    const e = await findEvent(event);
    const n = await names();
    await repo.deleteEvent(e.id);
    return `Deleted ${eventText(e, n)}.`;
  });

  tool(server, "get_agenda", {
    title: "Get agenda",
    description:
      "Day-by-day plan: fixed events, tasks due or planned, and the auto-planner's focus blocks that fill free work time with open tasks, plus free time and what didn't fit, for planning a day or week.",
    input: z.object({
      from: dateInput.optional().describe("Defaults to today"),
      to: dateInput.optional().describe("Defaults to from; at most 14 days"),
    }),
    kind: "read",
  }, async (args) => {
    const now = new Date();
    const today = toDateStr(now);
    const from = args.from ? when(args.from, "drop") : today;
    const to = args.to ? when(args.to, "drop") : from;
    if (to < from) fail("to is before from.");
    if (dayDiff(from, to) > 13) fail("Ask for at most 14 days at a time.");
    const [n, tasks, settings, list, sessions] = await Promise.all([
      names(), repo.listTasks(), repo.getSettings(), repo.listEvents(), repo.listSessions(),
    ]);
    const open = tasks.filter(isOpen);
    const weekly = new Set(list.filter((e) => e.recurrence === "weekly").map((e) => e.id));
    // Every occurrence from the earlier of from and today, so each day below picks its own from one list.
    const start = from < today ? from : today;
    const occ = await repo.occurrences(start, to >= today ? to : today);
    const between = (a: string, b: string) => occ.filter((e) => dateOnly(e.start) >= a && dateOnly(e.start) <= b);
    const events = between(from, to);
    let plan: PlanResult | null = null;
    if (to >= today) {
      plan = planTimeBlocks({ tasks, sessions, settings, now, events: between(today, to), days: dayDiff(today, to) + 1 });
    }
    const out = [todayLine(now)];
    for (let d = from; d <= to; d = addDaysStr(d, 1)) {
      const lines: string[] = [];
      const workday = settings.workDays.includes(weekdayOf(d));
      const dayEvents = events.filter((e) => dateOnly(e.start) === d);
      if (dayEvents.length) lines.push("Calendar:", ...dayEvents.map((e) => `- ${eventLine(e, n, weekly.has(e.eventId))}`));
      const blocks = plan?.blocks.filter((b) => dateOnly(b.start) === d) ?? [];
      if (blocks.length) {
        lines.push("Focus blocks (auto-planned):", ...blocks.map((b) =>
          `- ${timeOf(b.start)}–${timeOf(b.end)} ${b.kind === "check" ? `Review ${b.key} (an agent finished it)` : `${b.key} ${b.title}`}`));
      }
      const due = open.filter((t) => t.dueDate && dateOnly(t.dueDate) === d);
      if (due.length) lines.push("Due:", ...due.map((t) => `- ${taskLine(t, n)}`));
      const planned = open.filter((t) => t.plannedDate === d && !due.includes(t));
      if (planned.length) lines.push("Planned:", ...planned.map((t) => `- ${taskLine(t, n)}`));
      if (d >= today && workday) {
        const capacity = planTimeBlocks({
          tasks: [], sessions: [], settings, now: d === today ? now : parseLocal(d), events: between(d, d), days: 1,
        }).capacityMinutes;
        const used = blocks.reduce((m, b) => m + minutesOf(b.end.slice(11, 16)) - minutesOf(b.start.slice(11, 16)), 0);
        lines.push(`Free focus time${d === today ? " left" : ""}: ${fmtMinutes(capacity)} · planned: ${fmtMinutes(used)}`);
      }
      out.push(`${dayLabel(d)}${d === today ? " (today)" : ""}${workday ? "" : " · day off"}\n${lines.length ? lines.join("\n") : "Nothing scheduled."}`);
    }
    if (from <= today && today <= to) {
      const overdue = open.filter((t) => t.dueDate && dateOnly(t.dueDate) < today);
      if (overdue.length) out.push(`Overdue:\n${overdue.map((t) => `- ${taskLine(t, n)}`).join("\n")}`);
    }
    if (plan?.unplaced.length) {
      out.push(`Didn't fit into free focus time:\n${plan.unplaced.map((u) => `- ${u.key} ${u.title} · ${fmtMinutes(u.minutes)} left`).join("\n")}`);
    }
    out.push(
      `Focus blocks are suggestions: open tasks without an agent that have a due date, a planned day or urgent/high priority fill free time within work hours ${settings.workStart}–${settings.workEnd} (break ${settings.lunchStart}–${settings.lunchEnd}), most urgent first. Change them by changing the tasks' planned days, due dates, priorities (${PRIORITY_LABEL[1]} first) or estimates.`,
    );
    return out.join("\n\n");
  });

  tool(server, "reschedule_day", {
    title: "Move a day's plans",
    description:
      "Move everything planned for one day to another: tasks planned for that day, one-off calendar events (same times), and optionally deadlines. Weekly events stay where they are.",
    input: z.object({
      from: dateInput,
      to: dateInput,
      include: z.enum(["tasks", "events", "both"]).optional().describe("Default both"),
      move_deadlines: z.boolean().optional().describe("Also move open tasks that are due that day (default false)"),
    }),
    kind: "write",
  }, async (args) => {
    const from = when(args.from, "drop");
    const to = when(args.to, "drop");
    if (from === to) fail("from and to are the same day.");
    const include = args.include ?? "both";
    const n = await names();
    const lines: string[] = [];
    if (include !== "events") {
      const open = (await repo.listTasks()).filter(isOpen);
      for (const t of open.filter((x) => x.plannedDate === from)) {
        await repo.updateTask(t.id, { plannedDate: to });
        lines.push(`Planned ${to}: ${taskLine({ ...t, plannedDate: to }, n)}`);
      }
      if (args.move_deadlines) {
        for (const t of open.filter((x) => x.dueDate && dateOnly(x.dueDate) === from)) {
          const time = timeOf(t.dueDate);
          const dueDate = time ? `${to}T${time}` : to;
          await repo.updateTask(t.id, { dueDate });
          lines.push(`Due ${to}: ${taskLine({ ...t, dueDate, plannedDate: t.plannedDate === from ? to : t.plannedDate }, n)}`);
        }
      }
    }
    const list = await repo.listEvents();
    if (include !== "tasks") {
      for (const e of list.filter((x) => x.recurrence !== "weekly" && dateOnly(x.start) === from)) {
        const moved = { ...e, start: `${to}T${timeOf(e.start)}`, end: `${to}T${timeOf(e.end)}` };
        await repo.updateEvent(e.id, { start: moved.start, end: moved.end });
        lines.push(`Moved ${eventText(moved, n)}`);
      }
    }
    const weeklyIds = new Set(list.filter((e) => e.recurrence === "weekly").map((e) => e.id));
    const weeklyThatDay = include === "tasks" ? [] : (await repo.occurrences(from, from)).filter((o) => weeklyIds.has(o.eventId));
    if (weeklyThatDay.length) lines.push(`Left in place (weekly): ${weeklyThatDay.map((o) => `${o.title} ${timeOf(o.start)}`).join(", ")}`);
    return lines.length ? `From ${fmtWhen(from)} to ${fmtWhen(to)}:\n${lines.join("\n")}` : `Nothing to move on ${fmtWhen(from)}.`;
  });

  tool(server, "get_settings", {
    title: "Get settings",
    description: "Work hours and days the auto-planner uses, how agent sessions start on this computer, and the MCP address.",
    input: z.object({}),
    kind: "read",
  }, async () => {
    const s = await repo.getSettings();
    const hours = [
      `Work hours: ${s.workStart}–${s.workEnd} · Break: ${s.lunchStart}–${s.lunchEnd}`,
      `Work days: ${s.workDays.map((d) => DAY_NAMES[d - 1]).join(", ")}`,
    ];
    // PacedMind Cloud's MCP server: how sessions start is each computer's own setting, in its desktop app.
    if (MODE === "web") {
      return [...hours, "Sessions start on the user's computers, as each computer's PacedMind desktop app says.", `MCP address: ${cloudMcpUrl()}`].join("\n");
    }
    const d = deviceConfig();
    const asked = { off: "refused", ask: "wait for the user to allow them on this computer", auto: "start right away" }[d.remoteStart];
    const code = d.remoteStart === "off" ? "" : d.remoteCode !== false ? ", asked with a two-factor code" : ", asked without a two-factor code";
    return [
      ...hours,
      `Sessions on this computer open in: ${terminalFor(d.terminal, process.platform).label} · Claude Code command: ${agentCommandFor("claude")} · Codex command: ${agentCommandFor("codex")}`,
      `Sessions asked for over MCP wait for the user to allow them in PacedMind. Requests from the web app or another computer: ${asked}${code}.`,
      `MCP address: ${mcpUrl()}`,
    ].join("\n");
  });

  tool(server, "update_settings", {
    title: "Update work hours",
    description: "Change the work hours, break and work days the auto-planner fills with focus blocks.",
    input: z.object({
      work_start: z.string().optional().describe("HH:mm"),
      work_end: z.string().optional().describe("HH:mm"),
      break_start: z.string().optional().describe("HH:mm"),
      break_end: z.string().optional().describe("HH:mm"),
      work_days: z.array(z.string()).optional().describe('Days like ["mon", "tue", "wed", "thu", "fri"]'),
    }),
    kind: "write",
  }, async (args) => {
    const s = await repo.getSettings();
    const workStart = args.work_start ? readTime("work_start", args.work_start) : s.workStart;
    const workEnd = args.work_end ? readTime("work_end", args.work_end) : s.workEnd;
    const lunchStart = args.break_start ? readTime("break_start", args.break_start) : s.lunchStart;
    const lunchEnd = args.break_end ? readTime("break_end", args.break_end) : s.lunchEnd;
    if (workStart >= workEnd) fail("Work has to start before it ends.");
    if (lunchStart >= lunchEnd) fail("The break has to start before it ends.");
    let workDays = s.workDays;
    if (args.work_days) {
      workDays = [...new Set(args.work_days.map((d) => {
        const i = DAY_NAMES.indexOf(d.trim().toLowerCase().slice(0, 3));
        return i >= 0 ? i + 1 : fail(`Unknown day "${d}". Use mon, tue, wed, thu, fri, sat or sun.`);
      }))].sort();
    }
    await repo.setSettings({ workStart, workEnd, lunchStart, lunchEnd, workDays });
    return `Work hours ${workStart}–${workEnd}, break ${lunchStart}–${lunchEnd}, work days ${workDays.map((d) => DAY_NAMES[d - 1]).join(", ")}.`;
  });
}
