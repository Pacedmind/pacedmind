"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslation } from "./language";
import { Button, useAction } from "./ui";
import { ConfirmDialog } from "./dialog";
import { chooseGoogleCalendarAction, connectGoogleCalendarAction, defaultGoogleCalendarAction, disconnectGoogleCalendarAction, googleCalendarStatusAction, resolveGoogleCalendarAction, syncGoogleCalendarAction } from "@/app/google-calendar-actions";
import type { GoogleCalendarStatus, GoogleCalendarConnectionStatus } from "@/lib/google-calendar";

export function GoogleCalendarSettings({ initial, web }: { initial: GoogleCalendarStatus; web: boolean }) {
  const tx = useTranslation(); const router = useRouter(); const { run, pending } = useAction();
  const [status, setStatus] = useState(initial);
  useEffect(() => {
    const id = setInterval(() => { void googleCalendarStatusAction().then(setStatus).catch(() => {}); }, 5000);
    return () => clearInterval(id);
  }, []);
  const refresh = async () => { setStatus(await googleCalendarStatusAction()); router.refresh(); };
  const active = (status.connections ?? []).filter((c) => c.calendarName);
  return <div className="max-w-2xl space-y-4 text-[13px]">
    <p className="text-mut2">{tx("Connect calendars from several Google accounts. Imported events stay linked to their original calendar. New PacedMind events go to your default calendar.")}</p>
    <p className="text-mut2">{web ? tx("This connection syncs while PacedMind is open in this browser. Keep a tab open, or connect from the desktop app for background sync.") : tx("This connection syncs while PacedMind is running on this computer, including when its window is closed to the tray.")}</p>
    {!status.configured && <p className="rounded-lg border border-line p-3">{tx("Google Calendar is not configured on this server yet. Follow the setup guide to enable the connection.")}</p>}
    {status.elsewhere && <p>{tx("This connection runs on another computer or the web app. Open its Calendar settings to sync or resolve conflicts. You can disconnect it here.")}</p>}
    {status.error && <p role="alert" className="text-red-400">{tx.generated(status.error)}</p>}
    {!status.elsewhere && <>
      {status.configured && <Button disabled={pending} onClick={() => run(async () => {
        const result = await connectGoogleCalendarAction();
        if (result.ok) window.location.assign(result.url);
        return result;
      })}>{tx(status.connected ? "Add Google account" : "Connect Google Calendar")}</Button>}
      {active.length > 0 && <div className="space-y-2">
        <label className="block">{tx("Default calendar for new events")}
          <select aria-label={tx("Default calendar for new events")} value={status.defaultId ?? ""} disabled={pending} className="mt-2 block w-full rounded border border-line bg-bg p-2" onChange={(e) => { const id = e.target.value; void run(async () => { const r = await defaultGoogleCalendarAction(id); await refresh(); return r; }); }}>
            {active.map((c) => <option key={c.id} value={c.id}>{c.calendarName} — {c.accountName}</option>)}
          </select>
        </label>
        <p className="text-mut2">{tx("Changes sync about once a minute. Tasks and automatic focus blocks are not sent to Google.")}</p>
        <Button disabled={pending} onClick={() => run(async () => { const r = await syncGoogleCalendarAction(); await refresh(); return r; })}>{tx("Sync now")}</Button>
      </div>}
      {(status.connections ?? []).map((connection) => <ConnectionCard key={connection.id} connection={connection} firstCalendar={!status.defaultId} refresh={refresh} />)}
    </>}
    {status.elsewhere && <DisconnectButton refresh={refresh} />}
  </div>;
}

function DisconnectButton({ id, refresh }: { id?: string; refresh: () => Promise<void> }) {
  const tx = useTranslation(); const { run, pending } = useAction(); const [confirm, setConfirm] = useState(false);
  return <>
    <Button disabled={pending} onClick={() => setConfirm(true)}>{tx("Disconnect Google Calendar")}</Button>
    {confirm && <ConfirmDialog title={tx("Disconnect Google Calendar?")} confirmLabel={tx("Disconnect")} onCancel={() => setConfirm(false)} onConfirm={() => run(async () => {
      const r = await disconnectGoogleCalendarAction(id); setConfirm(false); await refresh(); return r;
    })}>{tx("Events already copied stay in both calendars. Changes will stop syncing. You can also revoke PacedMind access in your Google account.")}</ConfirmDialog>}
  </>;
}

function ConnectionCard({ connection: c, firstCalendar, refresh }: { connection: GoogleCalendarConnectionStatus; firstCalendar: boolean; refresh: () => Promise<void> }) {
  const tx = useTranslation(); const { run, pending } = useAction();
  const [adding, setAdding] = useState(!c.calendarName); const [selected, setSelected] = useState(c.calendars?.[0]?.id ?? ""); const [existing, setExisting] = useState(false);
  const selectedId = c.calendars?.some((item) => item.id === selected) ? selected : c.calendars?.[0]?.id ?? "";
  return <section className="space-y-3 rounded-lg border border-line p-4">
    <div><strong>{c.calendarName ?? c.accountName ?? tx("Google Calendar")}</strong>{c.calendarName && <p className="text-mut2">{c.accountName}</p>}</div>
    {c.error && <p role="alert" className="text-red-400">{tx.generated(c.error)}</p>}
    {c.calendarName && <p className="text-mut2">{c.lastSync ? tx("Last synced: {0}", [new Date(c.lastSync).toLocaleString(tx.language)]) : tx("Waiting for the first sync")}</p>}
    {c.calendarName && !!c.calendars?.length && <Button disabled={pending} onClick={() => setAdding(!adding)}>{tx("Add another calendar")}</Button>}
    {adding && <div className="space-y-3">
      <label className="block">{tx("Calendar to synchronize")}
        <select aria-label={tx("Calendar to synchronize")} value={selectedId} onChange={(e) => setSelected(e.target.value)} className="mt-2 block w-full rounded border border-line bg-bg p-2">
          {(c.calendars ?? []).map((calendar) => <option key={calendar.id} value={calendar.id}>{calendar.name}</option>)}
        </select>
      </label>
      {!c.calendars?.length && <p>{tx("No additional calendars with editing permission were found.")}</p>}
      {firstCalendar && <label className="flex items-start gap-2"><input type="checkbox" checked={existing} onChange={(e) => setExisting(e.target.checked)} />{tx("Also send existing PacedMind events to Google")}</label>}
      <p className="text-mut2">{tx("Events from this calendar will be imported and edits will synchronize in both directions.")}</p>
      <Button disabled={pending || !selectedId} onClick={() => run(async () => { const r = await chooseGoogleCalendarAction(selectedId, firstCalendar && existing, Intl.DateTimeFormat().resolvedOptions().timeZone, c.id); if (r.ok) setAdding(false); await refresh(); return r; })}>{tx("Start synchronization")}</Button>
    </div>}
    {(c.conflicts ?? []).map((conflict) => <div key={conflict.id} className="space-y-2 rounded-lg border border-line p-3">
      <strong>{conflict.title}</strong><p>{tx("This event changed in both calendars. Choose which version to keep, including whether it was deleted.")}</p>
      <div className="grid gap-3 sm:grid-cols-2">{([conflict.local, conflict.google] as const).map((version, i) => <div key={i} className="min-w-0 rounded border border-line p-3">
        <strong>{i === 0 ? "PacedMind" : tx("Google Calendar")}</strong>
        {version ? <div className="mt-1 max-h-48 space-y-1 overflow-y-auto break-words"><p>{version.title}</p><p>{version.start.replace("T", " ")} – {version.end.replace("T", " ")}</p><p>{version.timeZone}</p><p>{version.location}</p><p className="whitespace-pre-wrap">{version.description}</p></div> : <p>{tx("Deleted")}</p>}
      </div>)}</div>
      <div className="flex gap-2">{(["local", "google"] as const).map((choice) => <Button key={choice} disabled={pending} onClick={() => run(async () => { const r = await resolveGoogleCalendarAction(conflict.id, choice, c.id); await refresh(); return r; })}>{choice === "local" ? tx("Keep PacedMind version") : tx("Keep Google version")}</Button>)}</div>
    </div>)}
    <DisconnectButton id={c.id} refresh={refresh} />
  </section>;
}
