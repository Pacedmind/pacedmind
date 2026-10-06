"use client";
import { useTranslation } from "@/components/language";

import Link from "next/link";
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { toDateTimeStr } from "@/lib/dates";
import { Icon, type IconName } from "../icons";
import type { QuickAddDefaults } from "../quick-add";
import { openAdd } from "../task-list";
import { cx } from "../ui";

/**
 * A view's title row. On a phone it drops the icon and tightens up; `phoneSubtitleOnly` also drops the title there,
 * for views whose subtitle says more (the calendar's month or day; the menu shows which view is open).
 */
export function ViewHeader({ icon, title, subtitle, phoneSubtitleOnly, children }: {
  icon: IconName; title: string; subtitle?: ReactNode; phoneSubtitleOnly?: boolean; children?: ReactNode;
}) {
  return (
    <div className="flex h-[52px] shrink-0 items-center gap-2.5 border-b border-line pl-5 pr-4 max-sm:gap-2 max-sm:pl-4 max-sm:pr-3">
      <Icon name={icon} className="shrink-0 text-mut max-sm:hidden" />
      <h1 className={cx("shrink-0 text-[14px] font-semibold text-strong", phoneSubtitleOnly && subtitle && "max-sm:sr-only")}>{title}</h1>
      {subtitle && <span className={cx("min-w-0 truncate", phoneSubtitleOnly ? "max-sm:font-semibold max-sm:text-strong sm:text-mut2" : "text-mut2")}>{subtitle}</span>}
      {children}
    </div>
  );
}

export function PeriodNav({ unit, prev, next, today }: { unit: "month" | "week"; prev: string; next: string; today: string }) {
  const tx = useTranslation();
  const arrow = "flex h-[26px] w-[26px] items-center justify-center rounded-md text-mut hover:bg-hover";
  return (
    <div className="ml-1.5 flex shrink-0 items-center gap-0.5 max-sm:ml-0">
      <Link href={prev} aria-label={tx("Previous {0}", [unit])} title={tx("Previous {0}", [unit])} className={arrow}>
        <Icon name="chevronLeft" size={14} strokeWidth={2} />
      </Link>
      <Link href={next} aria-label={tx("Next {0}", [unit])} title={tx("Next {0}", [unit])} className={arrow}>
        <Icon name="chevronRight" size={14} strokeWidth={2} />
      </Link>
      <Link href={today} className="flex h-[26px] items-center rounded-md border border-line2 px-[9px] text-[12.5px] text-fg3 hover:bg-hover">{tx("Today")}</Link>
    </div>
  );
}

/** Looks like Segmented, but each option is a link to the other calendar view. */
export function ViewSwitch({ value, month, week }: { value: "month" | "week"; month: string; week: string }) {
  const tx = useTranslation();
  const options = [{ value: "month", label: tx("Month"), href: month }, { value: "week", label: tx("Week"), href: week }] as const;
  return (
    <nav aria-label={tx("Calendar view")} className="flex h-7 shrink-0 items-center gap-0.5 rounded-[7px] border border-line bg-input p-0.5">
      {options.map((o) => (
        <Link key={o.value} href={o.href} aria-current={o.value === value ? "page" : undefined}
          className={cx("flex h-[22px] items-center rounded-[5px] px-2.5 text-[12px] max-sm:px-2", o.value === value ? "bg-sel text-strong" : "text-mut hover:text-fg2")}>
          {o.label}
        </Link>
      ))}
    </nav>
  );
}

/** The selected task key, cleared with Escape like in TaskList. */
export function useSelection(initialKey: string | null) {
  const [sel, setSel] = useState<string | null>(initialKey);
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape" && !(e.target as HTMLElement).closest("input, textarea, [contenteditable=true], [role=dialog]")) setSel(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return [sel, setSel] as const;
}

/** "YYYY-MM-DDTHH:mm", starting from the server's value so hydration matches, then ticking every minute. */
export function useNow(initial: string) {
  const [now, setNow] = useState(initial);
  useEffect(() => {
    const id = setInterval(() => setNow(toDateTimeStr(new Date())), 60_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/** Props that make a non-button element (e.g. a draggable card) act like a button. */
export function pressable(onPress: () => void) {
  return {
    role: "button" as const,
    tabIndex: 0,
    onClick: onPress,
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onPress();
      }
    },
  };
}

/** A click on one of these is its own, not the day's under it: tasks, links, buttons, panels and marked items. */
const OWN_CLICK = "a, button, input, [role=button], [role=dialog], [data-item]";

/**
 * Makes a day's empty space add a task: a click there opens quick add with what `at` gives for the click (the day
 * to plan it for; in some views a project, an area or when an activity would start), or does nothing for null.
 * A click on something of the day's own is left to it, and a press that closes a menu or a panel only closes it.
 */
export function useAddOnClick() {
  const closing = useRef(false);
  return (at: (e: MouseEvent<HTMLElement>) => QuickAddDefaults | null) => ({
    onPointerDown: () => { closing.current = !!document.querySelector("[role=menu], [role=dialog], [data-popup]"); },
    onClick: (e: MouseEvent<HTMLElement>) => {
      const own = (e.target as Element).closest(OWN_CLICK);
      // A press that selected text isn't a click on the day either.
      if (closing.current || (own && e.currentTarget.contains(own)) || window.getSelection()?.isCollapsed === false) return;
      const defaults = at(e);
      if (defaults) openAdd(defaults);
    },
  });
}

/**
 * A day's "+", for a new task on it: shown while the day (a `group/day`) is hovered, or while `shown`, and to the
 * keyboard. A phone has no hover, so there a tap on the day does the same.
 */
export function AddButton({ label, shown, onAdd, className }: { label: string; shown?: boolean; onAdd: () => void; className?: string }) {
  const tx = useTranslation();
  return (
    <button type="button" aria-label={tx("New task on {0}", [label])} title={tx("New task on {0}", [label])} onClick={onAdd}
      className={cx("flex h-5 w-5 shrink-0 items-center justify-center rounded text-mut2 hover:bg-hover hover:text-fg2 focus-visible:opacity-100",
        shown ? "opacity-100" : "opacity-0 group-hover/day:opacity-100", className)}>
      <Icon name="plus" size={12} strokeWidth={2.2} />
    </button>
  );
}

export const isOpenTask = (t: { status: string }) => t.status !== "done" && t.status !== "canceled";

export const areaColor = (areas: { id: string; color: string }[], id: string | null) => areas.find((a) => a.id === id)?.color ?? "var(--color-mut2)";
