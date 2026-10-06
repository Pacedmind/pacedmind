"use client";
import { useTranslation } from "@/components/language";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./icons";
import { cx } from "./ui";

export type PickerOption = { value: string; label: string; detail?: string };

/**
 * Searchable single or multiple choice, with a themed popup and keyboard navigation. The trigger looks like a field;
 * `trigger` replaces its look (a chip, say) and `content` what it shows.
 */
export function Picker({ label, values: savedValues, options, onChange, multiple = false, deferred = false, custom, max = Infinity, placeholder, className, trigger: triggerClass, content, title }: {
  label: string; values: string[]; options: PickerOption[]; onChange: (values: string[]) => void;
  multiple?: boolean; deferred?: boolean; custom?: (text: string) => string | null; max?: number; placeholder?: string; className?: string;
  trigger?: string; content?: ReactNode; title?: string;
}) {
  const tx = useTranslation();
  placeholder ??= tx("Choose…");
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(savedValues);
  const values = open && deferred ? draft : savedValues;
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState({ left: 0, top: 0, width: 280, maxHeight: 320 });
  const filtered = options.filter((o) => `${o.label} ${o.detail ?? ""}`.toLowerCase().includes(query.toLowerCase()));
  const extra = custom?.(query.trim());
  const choices = extra && !options.some((o) => o.value === extra || o.label.toLowerCase() === extra.toLowerCase())
    ? [...filtered, { value: extra, label: extra, detail: tx("Add custom value") }] : filtered;
  const index = Math.min(active, Math.max(0, choices.length - 1));
  const selected = values.map((v) => options.find((o) => o.value === v)?.label ?? v);
  const close = useCallback((focus = false) => {
    if (deferred && draft.join("\n") !== savedValues.join("\n")) onChange(draft);
    setOpen(false); if (focus) trigger.current?.focus();
  }, [deferred, draft, savedValues, onChange]);
  const change = deferred ? setDraft : onChange;
  const choose = (value: string) => {
    if (multiple) {
      if (values.includes(value)) change(values.filter((v) => v !== value));
      else if (values.length < max) change([...values, value]);
      search.current?.focus();
    } else { onChange([value]); close(true); }
  };

  useLayoutEffect(() => {
    if (!open || !trigger.current) return;
    const r = trigger.current.getBoundingClientRect();
    const width = Math.min(Math.max(r.width, 300), window.innerWidth - 16);
    const below = window.innerHeight - r.bottom - 12;
    const height = Math.min(340, Math.max(below, r.top - 12));
    setPosition({ left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)),
      top: below >= height ? r.bottom + 4 : Math.max(8, r.top - height - 4), width, maxHeight: height });
    search.current?.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (!popup.current?.contains(e.target as Node) && !trigger.current?.contains(e.target as Node)) close();
    };
    const scroll = (e: Event) => { if (!popup.current?.contains(e.target as Node)) close(); };
    const resize = () => close();
    document.addEventListener("pointerdown", outside);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", resize);
    return () => { document.removeEventListener("pointerdown", outside); window.removeEventListener("scroll", scroll, true); window.removeEventListener("resize", resize); };
  }, [open, close]);
  useEffect(() => { if (open) document.getElementById(`${id}-${index}`)?.scrollIntoView({ block: "nearest" }); }, [id, index, open]);

  return <div className="min-w-0">
    <button ref={trigger} type="button" aria-label={label} title={title} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => { if (open) close(); else { setDraft(savedValues); setQuery(""); setActive(0); setOpen(true); } }}
      className={triggerClass ?? cx("flex min-h-7 w-full items-center gap-2 rounded-md border border-ctl bg-input px-2 py-1 text-left text-[12px] text-fg2 hover:bg-hover focus-visible:outline-accent", className)}>
      {content ?? <>
        <span className="min-w-0 flex-1 truncate">{selected.length ? selected.join(", ") : placeholder}</span>
        {multiple && values.length > 0 && <span className="text-mut2">{values.length}</span>}
        <Icon name="chevronDown" size={12} />
      </>}
    </button>
    {open && createPortal(<div ref={popup} data-picker-popup style={position} className="fixed z-[90] flex flex-col overflow-hidden rounded-lg border border-line2 bg-raised p-1 shadow-[var(--shadow-popover)]"
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") { e.preventDefault(); close(true); }
        if (e.key === "Tab") { e.preventDefault(); close(true); }
        if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setActive(Math.max(0, Math.min(choices.length - 1, index + (e.key === "ArrowDown" ? 1 : -1)))); }
        if (e.key === "Enter" && e.target === search.current) { e.preventDefault(); if (choices[index]) choose(choices[index].value); }
      }}>
      <input ref={search} role="combobox" aria-label={tx("Search {0}", [label.toLowerCase()])} aria-expanded aria-controls={id} aria-autocomplete="list"
        aria-activedescendant={choices.length ? `${id}-${index}` : undefined} value={query}
        onChange={(e) => { setQuery(e.target.value); setActive(0); }} placeholder={custom ? tx("Search or enter a value…") : tx("Search…")}
        className="m-1 rounded border border-line2 bg-input px-2 py-1.5 text-[12px] text-fg outline-none focus:border-line-strong" />
      <div id={id} role="listbox" aria-label={label} aria-multiselectable={multiple || undefined} className="min-h-0 overflow-auto">
        {choices.map((o, i) => {
          const picked = values.includes(o.value);
          const disabled = multiple && !picked && values.length >= max;
          return <button key={o.value} id={`${id}-${i}`} role="option" type="button" tabIndex={-1} aria-selected={picked} aria-disabled={disabled || undefined}
            onMouseDown={(e) => e.preventDefault()} onMouseMove={() => setActive(i)} onClick={() => !disabled && choose(o.value)}
            className={cx("flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-[12px] text-fg2", i === index && "bg-hover", disabled && "opacity-50")}>
            <span className={cx("flex h-4 w-4 shrink-0 items-center justify-center rounded border", picked ? "border-accent bg-accent/15 text-accent-fg" : "border-ctl")}>{picked && <Icon name="check" size={11} />}</span>
            <span className="min-w-0 flex-1 break-words">{o.label}{o.detail && <span className="mt-0.5 block text-[11px] text-mut2">{o.detail}</span>}</span>
          </button>;
        })}
        {!choices.length && <p className="p-3 text-[12px] text-mut2">{tx("No matches")}</p>}
      </div>
      {multiple && <div className="flex items-center justify-between border-t border-line px-2 pt-1 text-[11px] text-mut2">
        <span>{values.length} {" "}{tx("selected")}{max !== Infinity ? tx(" · Up to {0}", [max]) : ""}</span>
        <button type="button" onClick={() => close(true)} className="rounded px-2 py-1 text-fg2 hover:bg-hover">{tx("Done")}</button>
      </div>}
    </div>, document.body)}
  </div>;
}
