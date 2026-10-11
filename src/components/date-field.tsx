"use client";
import { useTranslation } from "@/components/language";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { DatePicker } from "./date-picker";

/**
 * A small popover to pick a date and (optionally) a time. Value is "YYYY-MM-DD" or "YYYY-MM-DDTHH:mm". The panel is
 * rendered into document.body, like the menus, so a dialog or a panel that scrolls can't cut it off.
 */
export function DateField({
  value, onChange, trigger, withTime = true, align = "left",
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  trigger: ReactNode;
  withTime?: boolean;
  align?: "left" | "right";
}) {
  const tx = useTranslation();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const inside = (t: EventTarget | null) => !!ref.current?.contains(t as Node) || !!panel.current?.contains(t as Node);
    // Pointer, not mouse: Safari on a phone sends no mouse events for a tap on something that isn't clickable.
    const onDown = (e: PointerEvent) => { if (!inside(e.target)) setOpen(false); };
    // It floats over the page, so it can't follow its field when something else scrolls or the window resizes.
    const onScroll = (e: Event) => { if (!panel.current?.contains(e.target as Node)) setOpen(false); };
    const onResize = () => setOpen(false);
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);
  // Below the field, or above it when the window has no room below (a dialog's footer, a phone); inside the window
  // sideways.
  useLayoutEffect(() => {
    if (!open) return;
    const field = ref.current?.getBoundingClientRect();
    const box = panel.current?.getBoundingClientRect();
    if (!field || !box) return;
    const left = Math.max(8, Math.min(align === "right" ? field.right - box.width : field.left, window.innerWidth - box.width - 8));
    const below = window.innerHeight - 8 - (field.bottom + 4);
    const down = box.height <= below || below >= field.top - 12;
    setPos({ left, top: down ? field.bottom + 4 : Math.max(8, field.top - 4 - box.height) });
  }, [open, align]);
  const toggle = () => { setPos(null); setOpen((o) => !o); };
  // Focus goes back to the trigger, or it would be lost with the panel (and the keys of the dialog around it).
  const close = () => {
    const inside = panel.current?.contains(document.activeElement);
    setOpen(false);
    if (inside) ref.current?.querySelector<HTMLElement>("button, [tabindex]")?.focus();
  };
  return (
    <div ref={ref} className="relative">
      <div onClick={toggle}>{trigger}</div>
      {/* data-popup: a press outside only closes it, so a calendar's day doesn't also take that press as a click.
          data-picker-popup: a popover it opens from stays open while you pick. */}
      {open && createPortal(
        <div ref={panel} data-popup data-picker-popup style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}
          onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } }}
          className="fixed z-[80] w-[272px] max-w-[calc(100vw-16px)] rounded-lg border border-line2 bg-raised p-2 shadow-[var(--shadow-popover)]">
          <DatePicker value={value} withTime={withTime} onChange={(v, done) => { onChange(v); if (done) close(); }} onDone={close}>
            {value && (
              <button type="button" onClick={() => { onChange(null); close(); }}
                className="ml-auto h-7 rounded-md px-2 text-[12.5px] text-mut2 hover:bg-sel">{tx("Clear")}</button>
            )}
          </DatePicker>
        </div>,
        document.body,
      )}
    </div>
  );
}
