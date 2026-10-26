"use client";
import type { CalendarDetails } from "@/lib/calendar-sync";
import { calendarSource } from "@/lib/calendar-source";
import type { EventOccurrence } from "@/lib/types";
import { useTranslation } from "./language";

export function CalendarSourceBadge({ calendar, compact = false }: { calendar?: CalendarDetails; compact?: boolean }) {
  const tx = useTranslation();
  const source = calendarSource(calendar);
  const title = `${tx("Calendar source")}: ${source.google ? `${tx("Google Calendar")} · ` : ""}${source.label}`;
  return <span title={title} aria-label={title} className={`inline-flex min-w-0 items-center gap-1 text-[10px] font-normal text-mut2 ${compact ? "max-w-[90px] shrink-0" : "max-w-full"}`}>
    {!compact && <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: source.color }} />}
    <span className="truncate">{compact ? source.short : source.label}</span>
  </span>;
}

export function CalendarSourceLegend({ events }: { events: EventOccurrence[] }) {
  const tx = useTranslation();
  const calendars = new Map(events.map((event) => [calendarSource(event.calendar).key, event.calendar]));
  if (!calendars.size) return null;
  return <div aria-label={tx("Calendar sources")} className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b border-line px-5 py-2">
    <span className="text-[11px] text-mut">{tx("Calendar sources")}</span>
    {[...calendars].map(([key, calendar]) => <CalendarSourceBadge key={key} calendar={calendar} />)}
  </div>;
}
