"use client";
import { useTranslation } from "@/components/language";

import { clsx } from "clsx";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { failedMessage } from "./plan-state";

export const cx = clsx;

/* ---------- buttons and small parts ---------- */

type BtnProps = React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "ghost" | "outline" | "primary"; size?: "sm" | "md" };

export function Button({ variant = "outline", size = "md", className, ...rest }: BtnProps) {
  return (
    <button
      {...rest}
      className={cx(
        "inline-flex items-center gap-1.5 rounded-md whitespace-nowrap transition-colors disabled:opacity-50 disabled:cursor-default",
        size === "sm" ? "h-6 px-2 text-[12px]" : "h-7 px-2.5 text-[12.5px]",
        variant === "outline" && "border border-ctl text-fg2 hover:bg-hover",
        variant === "ghost" && "text-mut hover:bg-hover hover:text-fg2",
        variant === "primary" && "bg-accent-strong text-white font-medium hover:brightness-110",
        className,
      )}
    />
  );
}

export function IconButton({ label, className, children, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button {...rest} aria-label={label} title={label}
      className={cx("inline-flex h-7 w-7 items-center justify-center rounded-md text-mut hover:bg-hover hover:text-fg2", className)}>
      {children}
    </button>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-[18px] items-center rounded border border-ctl px-1.5 font-mono text-[10.5px] text-mut">{children}</kbd>
  );
}

export function Dot({ color, size = 8 }: { color: string; size?: number }) {
  return <span className="inline-block shrink-0 rounded-full" style={{ width: size, height: size, background: color }} />;
}

export function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)}
      className={cx("flex h-[18px] w-[30px] shrink-0 items-center rounded-full p-0.5 transition-colors", on ? "justify-end bg-accent-strong" : "justify-start bg-ctl")}>
      <span className="h-3.5 w-3.5 rounded-full bg-white" />
    </button>
  );
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void }) {
  return (
    <div className="flex h-7 items-center gap-0.5 rounded-[7px] border border-line bg-input p-0.5">
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}
          className={cx("flex h-[22px] items-center gap-1.5 rounded-[5px] px-2.5 text-[12px]",
            o.value === value ? "bg-sel text-strong" : "text-mut hover:text-fg2")}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ---------- menu (small popover list) ---------- */

export interface MenuItem<V> {
  value: V;
  label: ReactNode;
  icon?: ReactNode;
  hint?: ReactNode;
  /** A line that only says something (why the list is empty, say): it can't be chosen. */
  disabled?: boolean;
}

export function Menu<V>({
  trigger, items, onSelect, align = "left", width = 220, className,
}: {
  trigger: ReactNode;
  items: MenuItem<V>[];
  onSelect: (v: V) => void;
  align?: "left" | "right";
  width?: number;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null);
  useEffect(() => {
    if (!open) return;
    const inside = (t: EventTarget | null) => !!ref.current?.contains(t as Node) || !!list.current?.contains(t as Node);
    // Pointer, not mouse: Safari on a phone sends no mouse events for a tap on something that isn't clickable.
    const onDown = (e: PointerEvent) => { if (!inside(e.target)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    // The list floats over the page, so it can't follow its button when something scrolls or the window resizes.
    const onScroll = (e: Event) => { if (!list.current?.contains(e.target as Node)) setOpen(false); };
    const onResize = () => setOpen(false);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);
  // Below the button, or above it when the window has no room below (a dialog's footer, say). It is rendered into
  // document.body, so a dialog or scrolling panel that hides its overflow can't cut it off. On a phone narrower
  // than the list, it takes the window's width less a margin.
  useLayoutEffect(() => {
    if (!open) return;
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    const h = list.current?.scrollHeight ?? 0;
    const w = Math.min(width, window.innerWidth - 16);
    const roomBelow = window.innerHeight - 8 - (box.bottom + 4);
    const roomAbove = box.top - 4 - 8;
    const down = h <= roomBelow || roomBelow >= roomAbove;
    const maxHeight = Math.max(80, Math.min(320, down ? roomBelow : roomAbove));
    const left = Math.max(8, Math.min(align === "right" ? box.right - w : box.left, window.innerWidth - w - 8));
    setPos({ left, width: w, maxHeight, top: down ? box.bottom + 4 : box.top - 4 - Math.min(h, maxHeight) });
  }, [open, align, width]);
  return (
    <div ref={ref} className={cx("relative", className)}>
      <div onClick={() => setOpen((o) => !o)}>{trigger}</div>
      {open && createPortal(
        <div ref={list} role="menu" style={{ width: pos?.width ?? width, left: pos?.left ?? -9999, top: pos?.top ?? -9999, maxHeight: pos?.maxHeight ?? 320 }}
          className="fixed z-[80] overflow-auto rounded-lg border border-line2 bg-raised p-1 shadow-[var(--shadow-popover)]">
          {items.map((it, i) => (
            <button key={i} type="button" role="menuitem" disabled={it.disabled} onClick={() => { onSelect(it.value); setOpen(false); }}
              className="flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-left text-[12.5px] text-fg2 hover:bg-sel disabled:text-mut2 disabled:hover:bg-transparent">
              {it.icon}
              <span className="min-w-0 flex-1 truncate">{it.label}</span>
              {it.hint && <span className="text-[11.5px] text-mut2">{it.hint}</span>}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}

/* ---------- toasts ---------- */

type Toast = { id: number; text: string; kind: "info" | "error" };

export function toast(text: string, kind: Toast["kind"] = "info") {
  window.dispatchEvent(new CustomEvent("organizer:toast", { detail: { text, kind } }));
}

export function Toaster() {
  const tx = useTranslation();
  const [items, setItems] = useState<Toast[]>([]);
  useEffect(() => {
    let n = 0;
    const on = (e: Event) => {
      const d = (e as CustomEvent).detail as Omit<Toast, "id">;
      const id = ++n;
      setItems((xs) => [...xs, { ...d, id }]);
      setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), d.kind === "error" ? 6000 : 3500);
    };
    window.addEventListener("organizer:toast", on);
    return () => window.removeEventListener("organizer:toast", on);
  }, []);
  return (
    // On a phone a long message wraps inside the screen's margins.
    <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex flex-col gap-2 max-md:left-4 max-md:items-end">
      {items.map((t) => (
        <div key={t.id} role="status"
          className={cx("pointer-events-auto flex max-w-sm items-center gap-2.5 rounded-lg border bg-raised px-3.5 py-2.5 text-[12.5px] shadow-[var(--shadow-popover)]",
            t.kind === "error" ? "border-danger-line text-danger" : "border-line2 text-fg2")}>
          <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: t.kind === "error" ? "var(--color-danger)" : "var(--color-accent)" }} />
          {tx.generated(t.text)}
        </div>
      ))}
    </div>
  );
}

/** Runs a server action in a transition and shows its message or error as a toast. */
export function useAction() {
  const tx = useTranslation();
  const [pending, start] = useTransition();
  const run = useCallback(<R extends { ok?: boolean; error?: string; message?: string } | void>(fn: () => Promise<R>, success?: string) => {
    start(async () => {
      try {
        const r = await fn();
        if (r && r.ok === false) toast(r.error ?? tx("Something went wrong"), "error");
        else if (r && r.message) toast(r.message);
        else if (success) toast(success);
      } catch (e) {
        toast(failedMessage(e instanceof Error ? e.message : tx("Something went wrong")), "error");
      }
    });
  }, [tx]);
  return { pending, run };
}
