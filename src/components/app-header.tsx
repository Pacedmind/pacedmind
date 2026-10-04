"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useSyncExternalStore, useTransition } from "react";
import type { TaskNotesState } from "@/lib/theme";
import { signOutAction } from "@/app/auth/actions";
import { BrandWordmark } from "./brand-wordmark";
import { Icon } from "./icons";
import { useAction } from "./ui";
import { Popover, PopoverItem, PopoverLabel, PopoverSeparator, type Anchor } from "./popover";

type NavigationState = EventTarget & { canGoBack: boolean; canGoForward: boolean };
const navigation = () => (window as Window & { navigation?: NavigationState }).navigation;

function subscribe(onChange: () => void) {
  const nav = navigation();
  let active = true;
  // Next updates browser history during its insertion effect. Notify after that commit.
  const update = () => queueMicrotask(() => { if (active) onChange(); });
  nav?.addEventListener("currententrychange", update);
  window.addEventListener("popstate", update);
  return () => {
    active = false;
    nav?.removeEventListener("currententrychange", update);
    window.removeEventListener("popstate", update);
  };
}

// Primitive snapshots stay stable between history changes. Electron supports both directions.
function navigationSnapshot() {
  const nav = navigation();
  return nav ? Number(nav.canGoBack) | (Number(nav.canGoForward) << 1) : Number(window.history.length > 1);
}
const initialNavigation = () => 0;

/** Opens or closes the sidebar, which on a phone is a panel over the page (sidebar.tsx). */
export function toggleMenu() {
  window.dispatchEvent(new CustomEvent("organizer:menu"));
}

/**
 * Shared app header; Electron supplies the native window buttons over its right edge. On a phone it has the
 * menu button instead of back and forward, which the browser has.
 */
export function AppHeader({ email }: { email: string | null }) {
  const history = useSyncExternalStore(subscribe, navigationSnapshot, initialNavigation);
  return (
    <header className="app-titlebar" aria-label="PacedMind">
      <div className="app-titlebar__content">
        <button type="button" className="app-titlebar__button app-titlebar__menu" aria-label="Menu" onClick={toggleMenu}>
          <Icon name="menu" size={18} />
        </button>
        <div className="app-titlebar__navigation" role="group" aria-label="Page navigation">
          <button type="button" className="app-titlebar__button" aria-label="Go back" title="Go back (Alt+Left)"
            disabled={!(history & 1)} onClick={() => window.history.back()}>
            <Icon name="arrowRight" size={16} className="rotate-180" />
          </button>
          <button type="button" className="app-titlebar__button" aria-label="Go forward" title="Go forward (Alt+Right)"
            disabled={!(history & 2)} onClick={() => window.history.forward()}>
            <Icon name="arrowRight" size={16} />
          </button>
        </div>
        <Link href="/today" aria-label="PacedMind — Today" className="app-titlebar__home">
          <BrandWordmark className="w-[112px]" />
        </Link>
        <TaskNotesToggle />
        {email ? <AccountMenu email={email} /> : (
          // No account (the desktop app with this computer's own data): the way to PacedMind Cloud.
          <div className="app-titlebar__account">
            <Link href="/login" title="Your tasks are on this computer only. Sign in to PacedMind Cloud to use them on your other computers too."
              className="flex h-7 items-center rounded-md border border-ctl px-2.5 text-[12.5px] text-fg2 hover:bg-hover">
              Sign in
            </Link>
          </div>
        )}
      </div>
    </header>
  );
}

const MENU_WIDTH = 240;

function TaskNotesToggle() {
  const [state, setState] = useState<TaskNotesState | null>(null);
  const { run, pending } = useAction();
  useEffect(() => {
    const desktop = window.pacedMindDesktop;
    if (!desktop?.taskNotesState || !desktop.toggleTaskNotes) return;
    let active = true;
    let updated = false;
    const unsubscribe = desktop.onTaskNotesChanged?.((next) => {
      updated = true;
      if (active) setState(next);
    });
    void desktop.taskNotesState().then((next) => { if (active && !updated) setState(next); }).catch(() => {});
    return () => { active = false; unsubscribe?.(); };
  }, []);
  if (!state) return null;
  const label = state.visible ? "Hide task notes" : "Show task notes";
  return (
    <button type="button" className="app-titlebar__button app-titlebar__notes" aria-label={label}
      aria-pressed={state.visible} disabled={pending}
      title={state.count ? `${label} (${state.count})` : "Show all open tasks as notes"}
      onClick={() => run(async () => {
        const next = await window.pacedMindDesktop?.toggleTaskNotes?.();
        if (next) { setState(next); return next; }
        else return { ok: false, error: "Couldn't show or hide notes. Try again when PacedMind is ready." };
      })}>
      <Icon name="layers" size={15} />
      <span>{state.visible ? "Hide notes" : "Show notes"}</span>
      {state.count > 0 && <span className="text-[11px] tabular-nums">{state.count}</span>}
    </button>
  );
}

/** The signed-in account, with Settings and Sign out. A portal popover, because the header clips its overflow. */
function AccountMenu({ email }: { email: string }) {
  const router = useRouter();
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="app-titlebar__account">
      <button type="button" className="app-titlebar__button" aria-label={`Account: ${email}`} title={email} aria-haspopup="menu"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          // Below the button, right-aligned with it.
          setAnchor(anchor ? null : { x: r.right - MENU_WIDTH - 6, y: r.bottom + 4 });
        }}>
        <span className="flex h-6 w-6 items-center justify-center rounded-full border border-line2 text-[11px] font-medium uppercase text-fg2">{email[0]}</span>
      </button>
      {anchor && (
        <Popover anchor={anchor} width={MENU_WIDTH} onClose={() => setAnchor(null)}>
          <PopoverLabel>Signed in as</PopoverLabel>
          <div className="truncate px-2 pb-1.5 text-[12.5px] text-fg2">{email}</div>
          <PopoverSeparator />
          <PopoverItem icon={<Icon name="settings" size={13} />} onClick={() => { setAnchor(null); router.push("/settings"); }}>Settings</PopoverItem>
          <PopoverItem icon={<Icon name="arrowRight" size={13} />} onClick={() => start(() => signOutAction())}>
            {pending ? "Signing out…" : "Sign out"}
          </PopoverItem>
        </Popover>
      )}
    </div>
  );
}
