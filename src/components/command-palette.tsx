"use client";
import { useTranslation } from "@/components/language";
import { type Translator } from "@/lib/i18n";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Status } from "@/lib/types";
import { Icon, StatusIcon, type IconName } from "./icons";
import { cx } from "./ui";

export interface PaletteTask {
  key: string;
  title: string;
  status: Status;
  href: string;
}

type Entry = { id: string; label: string; hint?: string; icon: React.ReactNode; run: () => void };

const PAGES = (tx: Translator): [string, string, IconName][] => ([
  [tx("Today"), "/today", "sun"], [tx("Inbox"), "/inbox", "inbox"], [tx("Upcoming"), "/upcoming", "clock"],
  [tx("Calendar"), "/calendar", "calendar"], [tx("Week"), "/calendar/week", "calendar"], [tx("Timeline"), "/timeline", "timeline"],
  [tx("Roadmap"), "/roadmap", "roadmap"], [tx("Sessions"), "/sessions", "terminal"], [tx("Computers"), "/settings/computers", "laptop"],
  [tx("Settings"), "/settings", "settings"],
]);

export function CommandPalette({ tasks, projects }: { tasks: PaletteTask[]; projects: { id: string; name: string }[] }) {
  const tx = useTranslation();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
        setQ("");
        setActive(0);
      }
    };
    const onOpen = () => { setOpen(true); setQ(""); setActive(0); };
    window.addEventListener("keydown", onKey);
    window.addEventListener("organizer:palette", onOpen);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("organizer:palette", onOpen); };
  }, []);

  useEffect(() => {
    if (open) setTimeout(() => input.current?.focus(), 0);
  }, [open]);

  const entries = useMemo<Entry[]>(() => {
    const go = (href: string) => () => { router.push(href); setOpen(false); };
    const s = q.trim().toLowerCase();
    const match = (...xs: string[]) => !s || xs.some((x) => x.toLowerCase().includes(s));
    const out: Entry[] = [];
    if (match(tx("new task"), "create")) {
      out.push({ id: "new", label: tx("New task"), hint: "C", icon: <Icon name="pen" size={14} />, run: () => { setOpen(false); window.dispatchEvent(new CustomEvent("organizer:new")); } });
    }
    for (const [key, href, icon] of PAGES(tx)) { const label = tx(key); if (match(label, tx("go to {0}", [label]))) out.push({ id: href, label: tx("Go to {0}", [label]), icon: <Icon name={icon} size={14} />, run: go(href) }); }
    for (const p of projects) if (s && match(p.name)) out.push({ id: `p-${p.id}`, label: p.name, hint: tx("Project"), icon: <Icon name="layers" size={14} />, run: go(`/project/${p.id}`) });
    if (s) {
      for (const t of tasks.filter((t) => match(t.key, t.title)).slice(0, 12)) {
        out.push({ id: t.key, label: t.title, hint: t.key, icon: <StatusIcon status={t.status} />, run: go(t.href) });
      }
    }
    return out;
  }, [q, tasks, projects, router, tx]);

  if (!open) return null;
  const current = Math.min(active, Math.max(entries.length - 1, 0));

  return (
    // On a phone it sits at the top, clear of the on-screen keyboard, with a margin at the sides.
    <div className="fixed inset-0 z-50 flex justify-center bg-overlay pt-28 max-md:px-3 max-md:pt-3" onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
      <div role="dialog" aria-label={tx("Command menu")} className="flex h-fit max-h-[460px] w-[600px] max-w-full flex-col overflow-hidden rounded-xl border border-line2 bg-raised shadow-[var(--shadow-popover)] max-md:max-h-[min(460px,calc(100dvh-24px))]">
        <div className="flex h-12 items-center gap-2.5 border-b border-line px-4">
          <Icon name="search" size={15} className="shrink-0 text-mut2" />
          <input ref={input} value={q} aria-label={tx("Search tasks, projects and pages")} placeholder={tx("Search tasks, projects and pages…")}
            onChange={(e) => { setQ(e.target.value); setActive(0); }}
            onKeyDown={(e) => {
              if (e.key === "Escape") setOpen(false);
              if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, entries.length - 1)); }
              if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
              if (e.key === "Enter") entries[current]?.run();
            }}
            // 16 px on a phone: Safari zooms into a smaller field when it gets focus.
            className="min-w-0 flex-1 bg-transparent text-[14px] text-strong outline-none placeholder:text-dim max-md:text-[16px]" />
          {/* Without Esc, a phone closes it here (or with a tap on the page around it). */}
          <button type="button" aria-label={tx("Close")} onClick={() => setOpen(false)}
            className="-mr-2 flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-mut hover:bg-hover md:hidden">
            <Icon name="x" size={15} />
          </button>
        </div>
        <div className="overflow-y-auto p-1.5">
          {entries.map((en, i) => (
            <button key={en.id} type="button" onMouseEnter={() => setActive(i)} onClick={en.run}
              className={cx("flex h-9 w-full items-center gap-3 rounded-md px-2.5 text-left text-[13px]", i === current ? "bg-sel text-strong" : "text-fg2")}>
              <span className="flex w-4 justify-center text-mut">{en.icon}</span>
              <span className="min-w-0 flex-1 truncate">{en.label}</span>
              {en.hint && <span className="font-mono text-[11px] text-mut2">{en.hint}</span>}
            </button>
          ))}
          {!entries.length && <div className="px-3 py-6 text-center text-[12.5px] text-mut2">{tx("No matches. Try a task key like DEV-21.")}</div>}
        </div>
        {/* Keys: a phone has none of them. */}
        <div className="flex h-9 items-center gap-3 border-t border-line px-4 text-[11.5px] text-mut2 max-md:hidden">
          <span>{tx("↑↓ to move")}</span><span>{tx("↵ to open")}</span><span>{tx("Esc to close")}</span>
        </div>
      </div>
    </div>
  );
}
