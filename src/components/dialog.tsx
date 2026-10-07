"use client";

import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button } from "./ui";

/**
 * A centered confirmation dialog. Enter confirms, Escape cancels. With `typed`, it confirms only once that word is
 * typed in it, for what deletes a lot at once.
 */
export function ConfirmDialog({ title, children, confirmLabel, danger, typed, onConfirm, onCancel }: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  typed?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState("");
  const ready = !typed || text.trim().toLowerCase() === typed.toLowerCase();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
      if (e.key === "Enter") {
        e.preventDefault();
        if (ready) onConfirm();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, onConfirm, ready]);
  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-start justify-center bg-overlay pt-40 max-md:px-3 max-md:pt-24" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div role="alertdialog" aria-label={title} className="flex w-[440px] max-w-full flex-col gap-3 rounded-xl border border-line2 bg-raised p-5 shadow-[var(--shadow-popover)]">
        <h2 className="text-[15px] font-semibold text-strong">{title}</h2>
        <div className="text-[13px] leading-relaxed text-mut">{children}</div>
        {typed && (
          <label className="flex flex-col gap-1.5 text-[12.5px] text-mut">
            <span>Type <span className="font-semibold text-fg2">{typed}</span> to confirm</span>
            <input autoFocus value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} autoComplete="off"
              className="h-8 rounded-md border border-line2 bg-input px-2.5 text-[13px] text-fg2 outline-none focus:border-line-strong" />
          </label>
        )}
        <div className="mt-2 flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button onClick={onConfirm} autoFocus={!typed} disabled={!ready}
            className={danger ? "border-danger-line bg-danger-bg text-danger-fg hover:bg-danger-hover" : "border-transparent bg-accent-strong text-white hover:brightness-110"}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
