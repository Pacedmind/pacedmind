"use client";
import { useEffect } from "react";

/** The web has no persisted user session worker: poll with this browser's authorized session. */
export function GoogleCalendarPoll() {
  useEffect(() => {
    let busy = false;
    const sync = async () => {
      if (busy) return; busy = true;
      try { await fetch("/api/google-calendar/sync", { method: "POST" }); } catch { /* retry next minute */ }
      finally { busy = false; }
    };
    void sync(); const id = setInterval(sync, 60000);
    return () => clearInterval(id);
  }, []);
  return null;
}
