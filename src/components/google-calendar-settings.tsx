"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslation } from "./language";
import { Button, useAction } from "./ui";
import { ConfirmDialog } from "./dialog";
import { chooseGoogleCalendarAction, connectGoogleCalendarAction, disconnectGoogleCalendarAction, googleCalendarStatusAction, resolveGoogleCalendarAction, syncGoogleCalendarAction } from "@/app/google-calendar-actions";
import type { GoogleCalendarStatus } from "@/lib/google-calendar";

export function GoogleCalendarSettings({ initial, web }: { initial: GoogleCalendarStatus; web: boolean }) {
  const tx = useTranslation(); const router = useRouter(); const { run, pending } = useAction();
  const [status, setStatus] = useState(initial);
  const [selected, setSelected] = useState(initial.calendars?.[0]?.id ?? "");
  const [existing, setExisting] = useState(false);
  const [disconnect, setDisconnect] = useState(false);
  useEffect(() => {
    const id = setInterval(() => { void googleCalendarStatusAction().then((next) => {
      setStatus(next); setSelected((value) => value || next.calendars?.[0]?.id || "");
    }).catch(() => {}); }, 5000);
    return () => clearInterval(id);
  }, []);
  const refresh = async () => { setStatus(await googleCalendarStatusAction()); router.refresh(); };
  return <div className="max-w-2xl space-y-4 text-[13px]">
    <p className="text-mut2">{tx("Add, edit and delete events in either calendar. Changes sync about once a minute. Tasks and automatic focus blocks are not sent to Google.")}</p>
    <p className="text-mut2">{web ? tx("This connection syncs while PacedMind is open in this browser. Keep a tab open, or connect from the desktop app for background sync.") : tx("This connection syncs while PacedMind is running on this computer, including when its window is closed to the tray.")}</p>
    {!status.configured && <p className="rounded-lg border border-line p-3">{tx("Google Calendar is not configured on this server yet. Follow the setup guide to enable the connection.")}</p>}
    {status.elsewhere && <p>{tx("This connection runs on another computer or the web app. Open its Calendar settings to sync or resolve conflicts. You can disconnect it here.")}</p>}
    {status.error && <p role="alert" className="text-red-400">{tx.generated(status.error)}</p>}
    {!status.connected && !status.elsewhere && status.configured && <Button disabled={pending} onClick={() => run(async () => {
      const result = await connectGoogleCalendarAction();
      if (!result.ok) return result;
      // Desktop intercepts external navigation; web navigates directly so popup blockers cannot break consent.
      window.location.assign(result.url); return result;
    })}>{tx("Connect Google Calendar")}</Button>}
    {status.connected && !status.elsewhere && !status.calendarName && <div className="space-y-3 rounded-lg border border-line p-4">
      <label className="block">{tx("Calendar to synchronize")}
        <select aria-label={tx("Calendar to synchronize")} value={selected} onChange={(e) => setSelected(e.target.value)} className="mt-2 block w-full rounded border border-line bg-bg p-2">
          {(status.calendars ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </label>
      {!status.calendars?.length && <p>{tx("No calendars with editing permission were found. Disconnect, grant access and try again.")}</p>}
      <label className="flex items-start gap-2"><input type="checkbox" checked={existing} onChange={(e) => setExisting(e.target.checked)} />{tx("Also send existing PacedMind events to Google")}</label>
      <p className="text-mut2">{tx("All events in the selected Google calendar will be imported. New PacedMind events will be sent to it. Later edits and deletions apply on both sides.")}</p>
      <Button disabled={pending || !selected} onClick={() => run(async () => { const r = await chooseGoogleCalendarAction(selected, existing, Intl.DateTimeFormat().resolvedOptions().timeZone); await refresh(); return r; })}>{tx("Start synchronization")}</Button>
    </div>}
    {status.calendarName && !status.elsewhere && <div className="flex flex-wrap items-center gap-3 rounded-lg border border-line p-4">
      <div className="flex-1"><strong>{status.calendarName}</strong><p className="mt-1 text-mut2">{status.lastSync ? tx("Last synced: {0}", [new Date(status.lastSync).toLocaleString(tx.language)]) : tx("Waiting for the first sync")}</p></div>
      <Button disabled={pending} onClick={() => run(async () => { const r = await syncGoogleCalendarAction(); await refresh(); return r; })}>{tx("Sync now")}</Button>
    </div>}
    {(status.conflicts ?? []).map((c) => <div key={c.id} className="space-y-2 rounded-lg border border-line p-4">
      <strong>{c.title}</strong><p>{tx("This event changed in both calendars. Choose which version to keep, including whether it was deleted.")}</p>
      <div className="grid gap-3 sm:grid-cols-2">{([c.local, c.google] as const).map((version, i) => <div key={i} className="min-w-0 rounded border border-line p-3">
        <strong>{i === 0 ? "PacedMind" : tx("Google Calendar")}</strong>
        {version ? <div className="mt-1 max-h-48 space-y-1 overflow-y-auto break-words"><p>{version.title}</p><p>{version.start.replace("T", " ")} – {version.end.replace("T", " ")}</p><p>{version.timeZone}</p><p>{version.location}</p><p className="whitespace-pre-wrap">{version.description}</p></div> : <p>{tx("Deleted")}</p>}
      </div>)}</div>
      <div className="flex gap-2">{(["local", "google"] as const).map((choice) => <Button key={choice} disabled={pending} onClick={() => run(async () => { const r = await resolveGoogleCalendarAction(c.id, choice); await refresh(); return r; })}>{choice === "local" ? tx("Keep PacedMind version") : tx("Keep Google version")}</Button>)}</div>
    </div>)}
    {(status.connected || status.elsewhere) && <Button disabled={pending} onClick={() => setDisconnect(true)}>{tx("Disconnect Google Calendar")}</Button>}
    {disconnect && <ConfirmDialog title={tx("Disconnect Google Calendar?")} confirmLabel={tx("Disconnect")} onCancel={() => setDisconnect(false)} onConfirm={() => run(async () => {
      const r = await disconnectGoogleCalendarAction(); setDisconnect(false); await refresh(); return r;
    })}>{tx("Events already copied stay in both calendars. Changes will stop syncing. You can also revoke PacedMind access in your Google account.")}</ConfirmDialog>}
  </div>;
}
