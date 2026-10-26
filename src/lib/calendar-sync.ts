import { Temporal } from "@js-temporal/polyfill";
import { rrulestr } from "rrule";
import type { CalEvent, EventOccurrence } from "./types";

/** Provider-neutral details. Local date/time strings are wall times in timeZone. */
export interface CalendarDetails {
  description?: string;
  location?: string;
  timeZone?: string;
  allDay?: boolean;
  recurrence?: string[];
  excludedStarts?: string[];
  source?: { connectionId: string; calendarId: string; eventId: string };
}

export function calendarDetails(value: unknown): CalendarDetails | undefined {
  if (typeof value === "string") { try { value = JSON.parse(value); } catch { return undefined; } }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as CalendarDetails;
  const result: CalendarDetails = {};
  if (typeof v.description === "string") result.description = v.description.slice(0, 16000);
  if (typeof v.location === "string") result.location = v.location.slice(0, 2000);
  if (typeof v.timeZone === "string") { try { Temporal.Now.zonedDateTimeISO(v.timeZone); result.timeZone = v.timeZone; } catch { /* invalid zone */ } }
  result.allDay = v.allDay === true;
  if (Array.isArray(v.recurrence)) result.recurrence = v.recurrence.filter((s) => typeof s === "string" && /^(RRULE|EXRULE|RDATE|EXDATE)[;:]/.test(s) && s.length <= 2000).slice(0, 100);
  if (Array.isArray(v.excludedStarts)) result.excludedStarts = v.excludedStarts.filter((s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}/.test(s)).slice(0, 10000);
  if (v.source && [v.source.connectionId, v.source.calendarId, v.source.eventId].every((s) => typeof s === "string" && s.length <= 1024)) result.source = v.source;
  return result;
}

export const wallTime = (instant: string, zone: string) => Temporal.Instant.from(instant).toZonedDateTimeISO(zone).toPlainDateTime().toString({ smallestUnit: "minute" });
export const zonedTime = (wall: string, zone: string) => Temporal.PlainDateTime.from(wall).toZonedDateTime(zone).toString({ timeZoneName: "never" });

/** Expands RFC5545 in wall time first, then converts each occurrence (including DST) for the viewer. */
export function detailedOccurrences(e: CalEvent, from: string, to: string, viewerZone = Intl.DateTimeFormat().resolvedOptions().timeZone): EventOccurrence[] {
  const detail = e.calendar ?? {};
  const zone = detail.timeZone ?? viewerZone;
  const start = Temporal.PlainDateTime.from(e.start);
  const end = Temporal.PlainDateTime.from(e.end);
  const duration = start.until(end);
  const rules = detail.recurrence?.length ? detail.recurrence : e.recurrence === "weekly" ? ["RRULE:FREQ=WEEKLY"] : [];
  const stamp = (d: Temporal.PlainDateTime) => d.toString({ smallestUnit: "minute" });
  const floating = (d: Temporal.PlainDateTime) => new Date(`${d.toString()}Z`);
  // The window has padding for overnight events and conversions across the date line.
  const lower = Temporal.PlainDate.from(from.slice(0, 10)).subtract({ days: Math.max(2, Math.ceil(start.until(end, { largestUnit: "days" }).days) + 1) }).toPlainDateTime();
  const upper = Temporal.PlainDate.from(to.slice(0, 10)).add({ days: 2 }).toPlainDateTime();
  let starts: Temporal.PlainDateTime[] = [start];
  if (rules.length) {
    const compact = stamp(start).replace(/[-:]/g, "") + "00";
    // RRule works with floating UTC dates; timezone conversion happens below, never in the host timezone.
    const normalized = rules.map((rule) => rule.replace(/;TZID=[^:]+:/, ":").replace(/\d{8}T\d{6}Z/g, (utc) => {
      const iso = `${utc.slice(0, 4)}-${utc.slice(4, 6)}-${utc.slice(6, 8)}T${utc.slice(9, 11)}:${utc.slice(11, 13)}:${utc.slice(13, 15)}Z`;
      return Temporal.Instant.from(iso).toZonedDateTimeISO(zone).toPlainDateTime().toString({ smallestUnit: "second" }).replace(/[-:]/g, "");
    }));
    const parsed = rrulestr([`DTSTART:${compact}Z`, ...normalized].join("\n"), { forceset: true });
    starts = parsed.between(floating(lower), floating(upper), true, (_date, index) => index < 10000)
      .map((d) => Temporal.PlainDateTime.from(d.toISOString().slice(0, 19)));
  }
  return starts.flatMap((s) => {
    if (detail.excludedStarts?.some((x) => x === stamp(s) || x === s.toPlainDate().toString())) return [];
    const en = s.add(duration);
    const localStart = detail.allDay ? stamp(s) : wallTime(zonedTime(stamp(s), zone), viewerZone);
    const localEnd = detail.allDay ? stamp(en) : wallTime(zonedTime(stamp(en), zone), viewerZone);
    if (localStart.slice(0, 10) > to.slice(0, 10) || localEnd.slice(0, 10) < from.slice(0, 10)) return [];
    const occurrences: EventOccurrence[] = [];
    for (let day = Temporal.PlainDate.from(localStart.slice(0, 10)); day.toString() <= localEnd.slice(0, 10); day = day.add({ days: 1 })) {
      const date = day.toString();
      if (date < from.slice(0, 10) || date > to.slice(0, 10) || `${date}T00:00` >= localEnd) continue;
      occurrences.push({ eventId: e.id, title: e.title, areaId: e.areaId, start: date === localStart.slice(0, 10) ? localStart : `${date}T00:00`,
        end: date === localEnd.slice(0, 10) ? localEnd : `${date}T23:59`, weekly: e.recurrence === "weekly", done: e.doneOn.includes(date), calendar: detail,
        series: rules.length > 0, originalStart: stamp(s), originalEnd: stamp(en) });
    }
    return occurrences;
  });
}
