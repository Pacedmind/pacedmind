"use client";
import { useTranslation } from "@/components/language";

import { useEffect, useRef, useState } from "react";

import { deleteEventAction, updateEventAction } from "@/app/actions";
import { dateOnly, hhmm, minutesOf, parseLocal, timeOf } from "@/lib/dates";
import type { Area, EventOccurrence } from "@/lib/types";
import { ConfirmDialog } from "./dialog";
import { DateField } from "./date-field";
import { AreaMark, Icon } from "./icons";
import { Button, Menu, cx, toast, useAction } from "./ui";

/** The lengths quick add offers; an activity's own length is added when it's another one. */
const LENGTHS = [15, 30, 45, 60, 90, 120, 180];

/** Opens the editor for an activity, on the day it was clicked. */
export function openActivity(occurrence: EventOccurrence) {
  window.dispatchEvent(new CustomEvent("organizer:activity", { detail: occurrence }));
}

const minutesBetween = (start: string, end: string) => Math.round((parseLocal(end).getTime() - parseLocal(start).getTime()) / 60_000);

/** Where an activity starting at `start` ends after `length` minutes: on the same day, or null past midnight. */
function endOf(start: string, length: number): string | null {
  const m = minutesOf(timeOf(start) ?? "00:00") + length;
  return m > 24 * 60 ? null : `${dateOnly(start)}T${hhmm(Math.min(m, 24 * 60 - 1))}`;
}

/**
 * Renames, moves or deletes a calendar activity; every view that shows activities opens it with openActivity. A
 * weekly activity changes every week, and the summary line says so (see updateEventAction).
 */
export function ActivityEditor({ areas }: { areas: Area[] }) {
  const tx = useTranslation();
  const [occ, setOcc] = useState<EventOccurrence | null>(null);
  const [title, setTitle] = useState("");
  const [areaId, setAreaId] = useState<string | null>(null);
  const [start, setStart] = useState("");
  const [length, setLength] = useState(60);
  const [weekly, setWeekly] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const { pending, run } = useAction();

  useEffect(() => {
    const show = (e: Event) => {
      const o = (e as CustomEvent<EventOccurrence>).detail;
      setOcc(o);
      setTitle(o.title);
      setAreaId(o.areaId);
      setStart(o.start);
      setLength(minutesBetween(o.start, o.end));
      setWeekly(o.weekly);
      setConfirming(false);
    };
    window.addEventListener("organizer:activity", show);
    return () => window.removeEventListener("organizer:activity", show);
  }, []);

  useEffect(() => {
    if (occ) setTimeout(() => input.current?.focus(), 0);
  }, [occ]);

  if (!occ) return null;

  const close = () => { setOcc(null); setConfirming(false); };
  const area = areas.find((a) => a.id === areaId) ?? null;
  const end = endOf(start, length);
  const changed = title.trim() !== occ.title || areaId !== occ.areaId || start !== occ.start
    || length !== minutesBetween(occ.start, occ.end) || weekly !== occ.weekly;

  const save = () => {
    const name = title.trim();
    if (!name) { toast(tx("Give it a title first"), "error"); return; }
    if (!end) { toast(tx("That runs past midnight. An activity starts and ends on the same day."), "error"); return; }
    if (!changed) { close(); return; }
    run(async () => {
      const r = await updateEventAction(occ.eventId, occ.start, { title: name, areaId, start, end, weekly });
      if (r.ok) close();
      return r;
    }, tx("Saved {0}", [name]));
  };

  const remove = () => {
    setConfirming(false);
    run(async () => {
      const r = await deleteEventAction(occ.eventId);
      if (r.ok) close();
      return r;
    }, tx("Deleted {0}", [occ.title]));
  };

  const time = end ? `${timeOf(start)}–${timeOf(end)}` : tx("{0}, past midnight", [timeOf(start)]);
  const summary = weekly
    ? tx("Every {0}{1}, {2}", [tx.date(parseLocal(start), "EEEE"), occ.weekly ? "" : tx(" from {0}", [tx.date(parseLocal(start), "d MMM")]), time])
    : `${tx.date(parseLocal(start), "EEE d MMM")}, ${time}`;
  const note = occ.weekly ? (weekly ? tx("Changes apply to every week") : tx("The other weeks will be removed")) : null;
  const lengths = LENGTHS.includes(length) ? LENGTHS : [...LENGTHS, length].sort((a, b) => a - b);
  const chip = "flex h-7 items-center gap-1.5 rounded-md border border-ctl bg-hover px-2 text-[12.5px] text-fg3 hover:bg-sel";

  return (
    <div className="fixed inset-0 z-50 flex justify-center bg-overlay pt-24 max-md:px-3 max-md:pt-3" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div role="dialog" aria-label={tx("Activity")}
        className="flex h-fit w-[560px] max-w-full flex-col rounded-xl border border-line2 bg-raised shadow-[var(--shadow-popover)]"
        onKeyDown={(e) => {
          // The delete confirmation answers its own keys.
          if (confirming) return;
          if (e.key === "Escape") close();
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
        }}>
        <div className="flex h-12 items-center gap-2 pl-4 pr-3">
          <Menu
            trigger={<button type="button" className={chip}>{area ? <AreaMark area={area} size={13} /> : <Icon name="calendar" size={13} />}{area?.name ?? tx("No area")}<Icon name="chevronDown" size={12} /></button>}
            items={[{ value: null as string | null, label: tx("No area"), icon: <Icon name="calendar" size={13} /> },
              ...areas.map((a) => ({ value: a.id as string | null, label: a.name, icon: <AreaMark area={a} size={13} /> }))]}
            onSelect={setAreaId}
          />
          <span className="text-faint">›</span>
          <span className="text-[12.5px] text-mut">{occ.weekly ? tx("Weekly activity") : tx("Activity")}</span>
          <span className="flex-1" />
          <button type="button" aria-label={tx("Close")} onClick={close} className="flex h-7 w-7 items-center justify-center rounded-md text-mut hover:bg-hover">
            <Icon name="x" size={15} />
          </button>
        </div>

        <div className="px-5 pb-3 pt-1.5">
          <input ref={input} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) { e.preventDefault(); save(); } }}
            aria-label={tx("Activity title")} placeholder={tx("Activity title")}
            className="w-full bg-transparent text-[18px] font-medium leading-7 text-strong outline-none placeholder:text-dim" />
        </div>

        <div className="flex flex-wrap gap-1.5 px-5 pb-3.5">
          {/* The start keeps its time when only the day changes. */}
          <DateField value={start} onChange={(v) => { if (v) setStart(timeOf(v) ? v : `${dateOnly(v)}T${timeOf(start)}`); }}
            trigger={<button type="button" className={chip}><Icon name="calendar" size={13} />{tx.date(parseLocal(start), "EEE d MMM, HH:mm")}</button>} />
          <Menu trigger={<button type="button" className={chip}><Icon name="clock" size={13} />{length} min</button>}
            items={lengths.map((m) => ({ value: m, label: `${m} min` }))}
            onSelect={setLength} />
          <button type="button" aria-pressed={weekly} onClick={() => setWeekly((w) => !w)}
            className={cx(chip, weekly && "border-accent/45 bg-accent/10 text-accent-fg")}>
            <Icon name="repeat" size={13} />{weekly ? tx("Every week") : tx("Does not repeat")}
          </button>
        </div>

        <div className="flex h-9 items-center gap-2 border-t border-line px-5 text-[12px] text-mut2">
          <Icon name="check" size={13} className="shrink-0 text-accent" />
          <span className="min-w-0 flex-1 truncate">{summary}{note && <span className="text-mut"> · {note}</span>}</span>
        </div>
        <div className="flex h-14 items-center gap-2 border-t border-line pl-3 pr-3">
          <Button variant="ghost" onClick={() => setConfirming(true)} disabled={pending}><Icon name="trash" size={13} />{tx("Delete")}</Button>
          <span className="flex-1" />
          <Button variant="ghost" onClick={close}>{tx("Cancel")}</Button>
          <Button variant="primary" disabled={pending || !changed || !title.trim()} onClick={save} className="h-8 px-3">
            {tx("Save")}<span className="rounded bg-ink/15 px-1.5 font-mono text-[10.5px] max-md:hidden">Ctrl ↵</span>
          </Button>
        </div>
      </div>
      {confirming && (
        <ConfirmDialog title={tx("Delete {0}?", [occ.title])} confirmLabel={tx("Delete activity")} danger onConfirm={remove} onCancel={() => setConfirming(false)}>
          {occ.weekly ? tx("It repeats every week. Every week's occurrence is removed from the calendar.") : tx("It's removed from the calendar.")}
        </ConfirmDialog>
      )}
    </div>
  );
}
