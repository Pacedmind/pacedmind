"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { publishPlan } from "./plan-state";
import { POLL_EVENT, publishLaunchState } from "./request-status";

/**
 * Re-renders the page when data changed somewhere else, e.g. an agent reported progress over MCP. Each answer also
 * carries the account's requests to its computers, for the chips that show what became of them (request-status.tsx).
 */
export function LiveRefresh({ every = 4000, refreshOnMount = false }: { every?: number; refreshOnMount?: boolean }) {
  const router = useRouter();
  useEffect(() => {
    let last: string | null = null;
    let busy = false;
    let again = false;
    const check = async () => {
      if (document.visibilityState !== "visible") return;
      // A request sent while a poll is on its way wants the next answer, not that one.
      if (busy) {
        again = true;
        return;
      }
      busy = true;
      try {
        const r = await fetch("/api/state", { cache: "no-store" });
        const state = (await r.json()) as { version: string; requests?: unknown; codeFreshUntil?: unknown; asks?: unknown; plan?: unknown };
        publishLaunchState(state);
        publishPlan(state.plan);
        // A newly opened note may have loaded just before an agent's write and its first poll just after it.
        if ((last === null && refreshOnMount) || (last !== null && state.version !== last)) router.refresh();
        last = state.version;
      } catch {
        // The server is restarting; try again on the next tick.
      } finally {
        busy = false;
        if (again) {
          again = false;
          void check();
        }
      }
    };
    check();
    const id = window.setInterval(check, every);
    const onVisible = () => { if (document.visibilityState === "visible") check(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener(POLL_EVENT, check);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener(POLL_EVENT, check);
    };
  }, [router, every, refreshOnMount]);
  return null;
}
