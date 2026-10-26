"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { NOTE_COLORS } from "../../desktop/task-note-workspace.mjs";
import type { NoteLayoutSettings, NoteWorkspace } from "@/lib/task-note-workspace";
import { useTranslation } from "./language";

const field = "h-8 max-w-[190px] rounded-md border border-ctl bg-panel px-2 text-[12px] text-fg2";
const subscribeDesktop = () => () => {};

export function NoteColorPicker({ value, onChange, disabled = false }: {
  value: NoteLayoutSettings["color"]; onChange: (value: NoteLayoutSettings["color"]) => void; disabled?: boolean;
}) {
  const tx = useTranslation();
  const colors = value in NOTE_COLORS ? [NOTE_COLORS[value as keyof typeof NOTE_COLORS]] : Object.values(NOTE_COLORS);
  return <div className="flex flex-col gap-2 text-[12px] text-fg2">
    <label className="flex items-center justify-between gap-3">{tx("Note colors")}
      <select aria-label={tx("Note colors")} className={field} value={value ?? "none"} disabled={disabled} onChange={e => onChange(e.target.value as NoteLayoutSettings["color"])}>
        <option value="none">{tx("Off (current appearance)")}</option>
        <option value="project">{tx("By project")}</option><option value="area">{tx("By area")}</option>
        <option value="blue">{tx("Blue")}</option><option value="teal">{tx("Teal")}</option>
        <option value="green">{tx("Green")}</option><option value="sand">{tx("Sand")}</option>
        <option value="rose">{tx("Rose")}</option><option value="violet">{tx("Violet")}</option>
      </select>
    </label>
    {value !== "none" && <div className="flex items-center gap-2">
      <div aria-hidden className="flex gap-1">{colors.map(color => <span key={color} className="task-note-color-preview h-6 w-4 rounded border" style={{ "--note-tint": color } as CSSProperties} />)}</div>
      <span className="text-[11px] text-mut">{tx("Soft pastel tints in light and dark themes.")}</span>
    </div>}
  </div>;
}

/** The same per-display preference as the header menu, without moving any notes. */
export function TaskNoteColorSettings() {
  const tx = useTranslation();
  const supported = useSyncExternalStore(subscribeDesktop, () => !!window.pacedMindDesktop?.taskNoteLayout, () => false);
  const [workspace, setWorkspace] = useState<NoteWorkspace | null>(null);
  const [displayId, setDisplayId] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const revision = useRef(0);
  useEffect(() => {
    if (!supported) return;
    let active = true;
    const read = async () => {
      const current = ++revision.current;
      const result = await window.pacedMindDesktop?.taskNoteLayout?.().catch(() => null);
      if (!active || current !== revision.current) return;
      if (result?.workspace) {
        const next = result.workspace;
        setWorkspace(next);
        setDisplayId(id => next.displays.some(d => d.id === id) ? id : next.displays.find(d => d.id === next.defaultDisplay)?.id ?? next.displays.find(d => d.openCount)?.id ?? next.displays[0]?.id ?? "");
      } else setError(tx("Couldn't load the layout. Try again."));
    };
    void read();
    const unsubscribe = window.pacedMindDesktop?.onTaskNotesChanged?.(() => { void read(); });
    return () => { active = false; unsubscribe?.(); };
  }, [supported, tx]);
  if (!supported) return null;
  const display = workspace?.displays.find(d => d.id === displayId);
  async function change(color: NoteLayoutSettings["color"]) {
    setPending(true); setError(""); ++revision.current;
    const result = await window.pacedMindDesktop?.setTaskNoteLayout?.({ displayId, settings: { color } }).catch(() => null);
    ++revision.current;
    if (result?.workspace) setWorkspace(result.workspace);
    if (!result?.ok) setError(result?.error ?? tx("Couldn't update the layout. Try again."));
    setPending(false);
  }
  return <section aria-label={tx("Task notes")} className="mt-6 flex max-w-xl flex-col gap-3 rounded-lg border border-line2 bg-panel p-4">
    <h2 className="text-[13px] font-medium text-strong">{tx("Task notes")}</h2>
    <p className="text-[12px] text-mut">{tx("Colors for Show notes, saved for each screen on this computer.")}</p>
    {display && <>
      <label className="flex items-center justify-between gap-3 text-[12px] text-fg2">{tx("Screen")}
        <select aria-label={tx("Task note color screen")} className={field} value={displayId} disabled={pending} onChange={e => setDisplayId(e.target.value)}>
          {workspace!.displays.map((d, i) => <option key={d.id} value={d.id}>{i + 1}. {d.label}{d.primary ? tx(" (main)") : ""}</option>)}
        </select>
      </label>
      <NoteColorPicker value={display.settings.color} onChange={color => void change(color)} disabled={pending} />
    </>}
    {!display && !error && <p className="text-[12px] text-mut">{tx("Loading…")}</p>}
    {error && <p role="alert" className="text-[12px] text-danger">{tx.generated(error)}</p>}
  </section>;
}
