"use client";
import { useTranslation } from "@/components/language";
import { type Translator } from "@/lib/i18n";

import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { addDays, addMonths, isSameMonth, startOfMonth } from "date-fns";
import { addDaysStr, dateOnly, hhmm, minutesOf, mondayOf, parseLocal, parseTime, timeOf, toDateStr, todayStr } from "@/lib/dates";
import { parseWhen } from "@/lib/parse";
import { Icon } from "./icons";
import { cx } from "./ui";

/**
 * Picks a day, typed ("fri 10:00", "in 2 weeks"), suggested or from a month, and with `withTime` a time.
 * `onChange` gets "YYYY-MM-DD" or "YYYY-MM-DDTHH:mm"; `done` says the picker can close. Without a time, a day closes
 * it. With one, a day leaves it open and moves to the time field, like Spectrum's and MUI's desktop date-time
 * pickers: a time picked there (or Enter on it, for none) closes it, and so does **Done** (`onDone`). A typed date
 * with Enter always closes it.
 */
export function DatePicker({ value, withTime, onChange, onDone, children }: {
  value: string | null;
  withTime: boolean;
  onChange: (value: string, done: boolean) => void;
  onDone?: () => void;
  /** At the bottom, after the time (Clear). */
  children?: ReactNode;
}) {
  const tx = useTranslation();
  const date = value ? dateOnly(value) : "";
  // The time just set, until `value` has it (a task's save takes a moment), so a day picked next keeps it.
  const [ownTime, setOwnTime] = useState<string | null>(null);
  const time = withTime ? ownTime ?? timeOf(value) ?? "" : "";
  const at = (day: string, t: string) => (withTime && t ? `${day}T${t}` : day);
  const [text, setText] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const timeInput = useRef<HTMLInputElement>(null);
  const pickDay = (day: string) => {
    onChange(at(day, time), !withTime);
    timeInput.current?.focus();
  };
  // Typing is quicker from a keyboard; on a phone the keyboard would cover the calendar.
  useEffect(() => { if (window.matchMedia("(pointer: fine)").matches) input.current?.focus(); }, []);
  const typed = text.trim() ? parseWhen(text) : null;
  // A time typed on its own ("2pm") keeps the day already chosen, and a day on its own keeps the time.
  const typedValue = typed && at(typed.dayGiven || !date ? typed.day : date, typed.time ?? time);
  const now = new Date();
  const suggestions: [string, number][] = [
    [tx("Today"), 0], [tx("Tomorrow"), 1], [tx("Weekend"), (6 - now.getDay() + 7) % 7], [tx("Next week"), 8 - (now.getDay() || 7)],
  ];
  const row = "flex h-7 items-center justify-between gap-2 rounded-md px-2 text-[12.5px]";
  return (
    <div className="flex flex-col">
      <input ref={input} value={text} onChange={(e) => setText(e.target.value)} aria-label={tx("Type a date")}
        placeholder={withTime ? tx("Type a date: fri 10:00") : tx("Type a date: next fri")}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); if (typedValue) onChange(typedValue, true); }
          if (e.key === "Escape" && text) { e.stopPropagation(); setText(""); }
        }}
        className="mb-1 h-8 rounded-md border border-line2 bg-input px-2 text-[12.5px] placeholder:text-dim" />
      {text.trim() ? (
        // As tall as the suggestions, so the calendar stays put while you type.
        <div className="h-[58px]">
          {typedValue ? (
            <button type="button" onClick={() => onChange(typedValue, true)} className={cx(row, "w-full bg-sel text-strong")}>
              {tx.date(parseLocal(typedValue), timeOf(typedValue) ? "EEEE d MMMM, HH:mm" : "EEEE d MMMM")}
              <span className="text-[11px] text-dim">Enter</span>
            </button>
          ) : <p className={cx(row, "text-dim")}>{tx("No date in that")}</p>}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-0.5">
          {suggestions.map(([label, n]) => {
            const d = addDays(now, n);
            const day = toDateStr(d);
            return (
              <button key={label} type="button" title={tx.date(d, "EEEE d MMMM")} onClick={() => pickDay(day)}
                className={cx(row, "hover:bg-sel", day === date ? "text-strong" : "text-fg2")}>
                {label}<span className="text-[11px] text-dim">{tx.date(d, n < 2 ? "EEE" : "EEE d")}</span>
              </button>
            );
          })}
        </div>
      )}
      <div className="my-1.5 border-t border-line2" />
      <MiniCalendar value={date} onPick={pickDay} />
      {(withTime || children) && (
        <div className="mt-1.5 flex items-center gap-1 border-t border-line2 pt-2">
          {/* A time without a day is for today, and the picker stays open for the day, which keeps the time. */}
          {withTime && (
            <TimeField value={time} inputRef={timeInput} onChange={(t, final) => {
              if (!date && !t) return;
              setOwnTime(t);
              onChange(at(date || todayStr(), t), final && !!date);
            }} />
          )}
          {children}
          {withTime && onDone && (
            <button type="button" onClick={onDone} className={cx("h-7 rounded-md border border-line2 bg-hover px-3 text-[12.5px] text-fg hover:bg-sel", !children && "ml-auto")}>
              {tx("Done")}</button>
          )}
        </div>
      )}
    </div>
  );
}

const SLOTS = Array.from({ length: 48 }, (_, i) => hhmm(i * 30));

/**
 * A time to type ("9", "1300", "14:30", "2pm") or pick from the half hours; "" for none. `final` is a choice made
 * (a pick, Enter), not a field left or a time removed.
 */
function TimeField({ value, onChange, inputRef }: {
  value: string;
  onChange: (time: string, final: boolean) => void;
  inputRef?: RefObject<HTMLInputElement | null>;
}) {
  const tx = useTranslation();
  // What's typed, until it's taken (Enter, a pick, leaving the field).
  const [draft, setDraft] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const listId = useId();
  const typed = draft === null ? null : parseTime(draft);
  // The half hour to show and highlight: nearest what's typed, else the time set, else 9:00.
  const near = hhmm((Math.round(minutesOf(typed ?? (value || "09:00")) / 30) * 30) % 1440);
  useLayoutEffect(() => {
    const box = list.current;
    const el = box?.querySelector<HTMLElement>(`[data-t="${near}"]`);
    if (box && el) box.scrollTop = el.offsetTop - box.clientHeight / 2 + el.offsetHeight / 2;
  }, [open, near]);
  const take = (t: string) => { onChange(t, true); setDraft(null); setOpen(false); };
  const leave = () => {
    if (draft !== null) {
      if (typed) onChange(typed, false);
      else if (!draft.trim()) onChange("", false);
    }
    setDraft(null);
    setOpen(false);
  };
  const key = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const i = SLOTS.indexOf(near) + (e.key === "ArrowDown" ? 1 : -1);
      setDraft(SLOTS[(i + SLOTS.length) % SLOTS.length]);
      setOpen(true);
    } else if (e.key === "Enter") {
      e.preventDefault();
      // Nothing typed: the time stays as it is (none, too), and that's the choice.
      if (typed) take(typed);
      else if (draft === null || !draft.trim()) take(draft === null ? value : "");
    } else if (e.key === "Escape" && (open || draft !== null)) {
      e.stopPropagation();
      setDraft(null);
      setOpen(false);
    }
  };
  return (
    <div className="relative flex items-center">
      <span className="pointer-events-none absolute left-2 text-mut"><Icon name="clock" size={13} /></span>
      {/* The list opens on a click, typing or the arrow keys, not on focus: a day picked moves focus here. */}
      <input ref={inputRef} value={draft ?? value} placeholder={tx("Add time")} aria-label={tx("Time")} inputMode="text" autoComplete="off"
        role="combobox" aria-expanded={open} aria-controls={listId}
        onClick={() => setOpen(true)} onBlur={leave} onKeyDown={key}
        onChange={(e) => { setDraft(e.target.value); setOpen(true); }}
        className={cx("h-7 w-[108px] rounded-md border bg-input pl-7 pr-2 text-[12px] tabular-nums placeholder:text-dim",
          draft !== null && draft.trim() && !typed ? "border-danger-line" : "border-line2")} />
      {value && draft === null && (
        <button type="button" aria-label={tx("Remove time")} onClick={() => onChange("", false)}
          className="ml-0.5 grid h-6 w-6 place-items-center rounded-md text-mut hover:bg-sel hover:text-fg2"><Icon name="x" size={12} /></button>
      )}
      {open && (
        // Above the field, over the calendar, so it stays inside the picker.
        <div ref={list} id={listId} role="listbox" aria-label={tx("Times")}
          className="absolute bottom-full left-0 z-10 mb-1 max-h-44 w-[108px] overflow-y-auto rounded-md border border-line2 bg-raised p-1 shadow-[var(--shadow-popover)]">
          {SLOTS.map((s) => (
            <button key={s} type="button" role="option" aria-selected={s === near} data-t={s} tabIndex={-1}
              onMouseDown={(e) => e.preventDefault()} onClick={() => take(s)}
              className={cx("block h-7 w-full rounded px-2 text-left text-[12px] tabular-nums", s === near ? "bg-sel text-strong" : "text-fg2 hover:bg-hover")}>
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const WEEKDAYS = (tx: Translator) => ([tx("Mo"), tx("Tu"), tx("We"), tx("Th"), tx("Fr"), tx("Sa"), tx("Su")]);
const STEP: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };

/** A month to pick a day from, weeks from Monday. `value` and the picked day are "YYYY-MM-DD" ("" for none). */
function MiniCalendar({ value, onPick }: { value: string; onPick: (day: string) => void }) {
  const tx = useTranslation();
  const today = todayStr();
  const [month, setMonth] = useState(() => startOfMonth(parseLocal(value || today)));
  // The day the arrow keys move from; Tab lands on it.
  const [focus, setFocus] = useState(value || today);
  const grid = useRef<HTMLDivElement>(null);
  // Always six weeks, so the panel keeps its size from month to month.
  const days = Array.from({ length: 42 }, (_, i) => addDays(mondayOf(month), i));
  const shown = days.map((d) => toDateStr(d));
  const tabDay = isSameMonth(parseLocal(focus), month) ? focus : toDateStr(month);
  const turn = (n: number) => setMonth((m) => addMonths(m, n));
  const move = (e: KeyboardEvent, day: string) => {
    const step = STEP[e.key];
    if (!step) return;
    e.preventDefault();
    const next = addDaysStr(day, step);
    setFocus(next);
    if (!isSameMonth(parseLocal(next), month)) setMonth(startOfMonth(parseLocal(next)));
    requestAnimationFrame(() => grid.current?.querySelector<HTMLButtonElement>(`[data-day="${next}"]`)?.focus());
  };
  const nav = "grid h-6 w-6 place-items-center rounded-md text-mut hover:bg-sel hover:text-fg2";
  return (
    <div>
      <div className="mb-1 flex items-center justify-between pl-1.5">
        <span className="text-[12.5px] font-medium text-fg2">{tx.date(month, "MMMM yyyy")}</span>
        <div className="flex">
          <button type="button" aria-label={tx("Previous month")} onClick={() => turn(-1)} className={nav}><Icon name="chevronLeft" size={13} /></button>
          <button type="button" aria-label={tx("Next month")} onClick={() => turn(1)} className={nav}><Icon name="chevronRight" size={13} /></button>
        </div>
      </div>
      <div className="grid grid-cols-7 text-center text-[10.5px] leading-6 text-dim" aria-hidden="true">
        {WEEKDAYS(tx).map((w) => <span key={w}>{w}</span>)}
      </div>
      <div ref={grid} className="grid grid-cols-7 gap-y-0.5">
        {days.map((d, i) => {
          const day = shown[i];
          const picked = day === value;
          return (
            <button key={day} type="button" data-day={day} tabIndex={day === tabDay ? 0 : -1}
              aria-label={tx.date(d, "EEEE d MMMM yyyy")} aria-pressed={picked} aria-current={day === today ? "date" : undefined}
              onClick={() => onPick(day)} onKeyDown={(e) => move(e, day)} onFocus={() => setFocus(day)}
              className={cx("h-7 rounded-md text-[12px] tabular-nums",
                picked ? "bg-accent font-semibold text-bg"
                  : cx("hover:bg-sel", day === today ? "font-semibold text-accent-fg ring-1 ring-inset ring-accent/50"
                    : !isSameMonth(d, month) ? "text-faint" : day < today ? "text-mut2" : "text-fg2"))}>
              {d.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}
