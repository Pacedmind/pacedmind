"use client";
import { useTranslation } from "@/components/language";

import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button } from "./ui";

/** A centered confirmation dialog. Enter confirms, Escape cancels. */
export function ConfirmDialog({ title, children, confirmLabel, danger, onConfirm, onCancel }: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const tx = useTranslation();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
      if (e.key === "Enter") { e.preventDefault(); onConfirm(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, onConfirm]);
  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-start justify-center bg-overlay pt-40 max-md:px-3 max-md:pt-24" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div role="alertdialog" aria-label={title} className="flex w-[440px] max-w-full flex-col gap-3 rounded-xl border border-line2 bg-raised p-5 shadow-[var(--shadow-popover)]">
        <h2 className="text-[15px] font-semibold text-strong">{title}</h2>
        <div className="text-[13px] leading-relaxed text-mut">{children}</div>
        <div className="mt-2 flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>{tx("Cancel")}</Button>
          <Button onClick={onConfirm} autoFocus
            className={danger ? "border-danger-line bg-danger-bg text-danger-fg hover:bg-danger-hover" : "border-transparent bg-accent-strong text-white hover:brightness-110"}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
