"use client";
import { useTranslation } from "@/components/language";
import { createTranslator, type Translator } from "@/lib/i18n";

import { useState, useSyncExternalStore } from "react";
import type { Task } from "@/lib/types";
import { Icon } from "./icons";
import { Popover, PopoverItem, PopoverLabel, PopoverSeparator, anchorOf, type Anchor } from "./popover";
import type { TaskGroup } from "./task-list";
import { Button } from "./ui";

/** How a task list groups and orders its tasks: the page's own way, or by label, due date and so on. */
export type Grouping = "default" | "label";
export type Ordering = "default" | "label" | "due" | "title" | "created";
export type TaskDisplay = { group: Grouping; order: Ordering };

const KEY = "pacedmind:task-display";
const EVENT = "pacedmind:task-display";
const DEFAULT: TaskDisplay = { group: "default", order: "default" };
const GROUPINGS: Grouping[] = ["default", "label"];
const ORDERINGS: Ordering[] = ["default", "label", "due", "title", "created"];

// One object per stored value, so useSyncExternalStore sees the same snapshot until it changes.
let cache: { raw: string | null; value: TaskDisplay } = { raw: null, value: DEFAULT };

function read(): TaskDisplay {
  let raw: string | null = null;
  try { raw = localStorage.getItem(KEY); } catch { /* Private window: the defaults. */ }
  if (raw === cache.raw) return cache.value;
  let value = DEFAULT;
  try {
    const v = JSON.parse(raw ?? "null") as Partial<TaskDisplay> | null;
    value = {
      group: GROUPINGS.includes(v?.group as Grouping) ? v!.group! : "default",
      order: ORDERINGS.includes(v?.order as Ordering) ? v!.order! : "default",
    };
  } catch { /* A broken value: the defaults. */ }
  cache = { raw, value };
  return value;
}

function subscribe(onChange: () => void) {
  const onStorage = (e: StorageEvent) => { if (e.key === KEY) onChange(); };
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

/** This viewer's choice, the same on every task list. */
export function useTaskDisplay(): [TaskDisplay, (d: TaskDisplay) => void] {
  const display = useSyncExternalStore(subscribe, read, () => DEFAULT);
  const set = (d: TaskDisplay) => {
    try { localStorage.setItem(KEY, JSON.stringify(d)); } catch { /* Not remembered, but nothing to switch without it. */ }
    window.dispatchEvent(new Event(EVENT));
  };
  return [display, set];
}

const byText = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
const firstLabel = (t: Task) => [...t.labels].sort(byText)[0];

/** Missing values (no label, no due date) go last in every order. */
const COMPARE: Record<Exclude<Ordering, "default">, (a: Task, b: Task) => number> = {
  label: (a, b) => {
    const x = firstLabel(a), y = firstLabel(b);
    return x === undefined || y === undefined ? Number(x === undefined) - Number(y === undefined) : byText(x, y);
  },
  due: (a, b) => !a.dueDate || !b.dueDate ? Number(!a.dueDate) - Number(!b.dueDate) : a.dueDate.localeCompare(b.dueDate),
  title: (a, b) => byText(a.title, b.title),
  created: (a, b) => b.createdAt.localeCompare(a.createdAt),
};

/**
 * The page's groups as this viewer wants them. By label, a task shows under each of its labels, and the ones
 * without a label come last. A stable sort, so ties keep the page's own order (priority, then yours).
 */
export function arrange(groups: TaskGroup[], { group, order }: TaskDisplay, tx: Translator = createTranslator("en")): TaskGroup[] {
  let out = groups;
  if (group === "label") {
    const all = groups.flatMap((g) => g.tasks).filter((t, i, list) => list.findIndex((u) => u.id === t.id) === i);
    const labels = [...new Set(all.flatMap((t) => t.labels))].sort(byText);
    out = [
      ...labels.map((l) => ({ id: `label:${l}`, name: l, tasks: all.filter((t) => t.labels.includes(l)) })),
      { id: "label:", name: tx("No label"), tasks: all.filter((t) => !t.labels.length) },
    ].filter((g) => g.tasks.length);
  }
  if (order === "default") return out;
  return out.map((g) => ({ ...g, tasks: [...g.tasks].sort(COMPARE[order]) }));
}

const ORDER_NAMES = (tx: Translator): Record<Ordering, string> => ({
  default: tx("Priority"), label: tx("Label"), due: tx("Due date"), title: tx("Title"), created: tx("Newest first"),
});

export function DisplayMenu({ display, onChange, groupedBy }: {
  display: TaskDisplay;
  onChange: (d: TaskDisplay) => void;
  /** What the page itself groups by, such as "Status". */
  groupedBy: string;
}) {
  const tx = useTranslation();
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const changed = display.group !== "default" || display.order !== "default";
  const tick = (on: boolean) => <Icon name="check" size={13} className={on ? "" : "invisible"} />;
  const pick = (d: Partial<TaskDisplay>) => onChange({ ...display, ...d });
  return (
    <>
      <Button aria-label={tx("Display")} aria-haspopup="menu" aria-expanded={!!anchor}
        // Below the button, right edges lined up (the popover opens 6 px right of its anchor).
        onClick={(e) => { const a = anchorOf(e.currentTarget); setAnchor((o) => o ? null : { x: a.x + (a.w ?? 0) - 206, y: a.y + (a.h ?? 0) + 4 }); }}>
        <Icon name="timeline" size={13} />
        <span className="@max-xl:hidden">{changed ? [display.group === "label" && tx("By label"), display.order !== "default" && ORDER_NAMES(tx)[display.order]].filter(Boolean).join(" · ") : tx("Display")}</span>
      </Button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} width={200}>
          <PopoverLabel>{tx("Group by")}</PopoverLabel>
          <PopoverItem icon={tick(display.group === "default")} onClick={() => pick({ group: "default" })}>{groupedBy}</PopoverItem>
          <PopoverItem icon={tick(display.group === "label")} onClick={() => pick({ group: "label" })}>{tx("Label")}</PopoverItem>
          <PopoverSeparator />
          <PopoverLabel>{tx("Order by")}</PopoverLabel>
          {ORDERINGS.map((o) => (
            <PopoverItem key={o} icon={tick(display.order === o)} onClick={() => pick({ order: o })}>{ORDER_NAMES(tx)[o]}</PopoverItem>
          ))}
          {changed && (
            <>
              <PopoverSeparator />
              <PopoverItem onClick={() => { onChange(DEFAULT); setAnchor(null); }}>{tx("Reset")}</PopoverItem>
            </>
          )}
        </Popover>
      )}
    </>
  );
}
