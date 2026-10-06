"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { NoteDisplayPrompt } from "@/lib/task-notes";
import { Button, cx } from "./ui";

export function TaskNoteDisplayPicker() {
  const [prompt, setPrompt] = useState<NoteDisplayPrompt | null>(null);
  useEffect(() => window.pacedMindDesktop?.onTaskNoteDisplayRequest?.(setPrompt), []);
  return prompt ? <DisplayDialog key={prompt.requestId} prompt={prompt} /> : null;
}

function DisplayDialog({ prompt }: { prompt: NoteDisplayPrompt }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [selected, setSelected] = useState(prompt.displays.find(d => d.primary)?.id ?? prompt.displays[0]?.id ?? "");
  const [remember, setRemember] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { const el = dialog.current; el?.showModal(); return () => el?.close(); }, []);
  async function answer(cancel = false) {
    if (pending) return;
    setPending(true);
    const ok = await window.pacedMindDesktop?.chooseTaskNoteDisplay?.(prompt.requestId, cancel ? null : { displayId: selected, remember }).catch(() => false);
    if (!ok) { setError("Couldn't select this screen. Close the dialog and try again."); setPending(false); }
  }
  const displays = [...prompt.displays].sort((a, b) => a.x - b.x || a.y - b.y);
  const chosen = displays.find(d => d.id === selected);
  return createPortal(<dialog ref={dialog} aria-labelledby="note-display-title" onCancel={e => { e.preventDefault(); void answer(true); }}
    className="m-auto max-h-[90vh] w-[570px] max-w-[calc(100vw-32px)] overflow-y-auto rounded-xl border border-line2 bg-raised p-6 text-fg shadow-[var(--shadow-popover)] backdrop:bg-overlay">
    <form onSubmit={e => { e.preventDefault(); void answer(); }} className="flex flex-col gap-5">
      <div><h2 id="note-display-title" className="text-[16px] font-medium text-strong">Where should your notes go?</h2>
        <p className="mt-1 text-[13px] text-mut">Choose a screen for {prompt.count === 1 ? "this task" : `${prompt.count} tasks`}. You can change it later in Layout.</p></div>
      {prompt.defaultDisplay && <p className="text-[12px] text-mut">Your saved screen is disconnected. Choose another screen.</p>}
      <div className="grid grid-cols-3 gap-3" role="group" aria-label="Choose a screen">
        {displays.map((d, i) => <button key={d.id} type="button" disabled={pending} aria-label={`Use screen ${d.id}`} aria-pressed={selected === d.id}
          onClick={() => setSelected(d.id)} className={cx("flex min-w-0 flex-col items-center gap-2 rounded-lg border p-3 text-center transition-colors", selected === d.id ? "border-accent bg-sel" : "border-line2 hover:bg-hover")}>
          <span className={cx("flex h-16 w-full items-center justify-center rounded border bg-panel text-[22px] font-light", selected === d.id ? "border-accent text-strong" : "border-line-strong text-mut")}>{i + 1}</span>
          <span className="w-full truncate text-[12px] text-fg2" title={d.label}>{d.label}</span>
          <span className="text-[10px] text-mut">{d.width} × {d.height}{d.primary ? " · Main" : ""}</span>
        </button>)}
      </div>
      {chosen && chosen.capacity < prompt.count && <p className="text-[12px] text-mut">This screen fits {chosen.capacity} readable notes. The remaining tasks will stay in the planner.</p>}
      <label className="flex items-center gap-2 text-[12px] text-fg2"><input type="checkbox" checked={remember} disabled={pending} onChange={e => setRemember(e.target.checked)} />Remember this screen on this computer</label>
      {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
      <div className="flex justify-end gap-2"><Button type="button" variant="ghost" disabled={pending} onClick={() => void answer(true)}>Cancel</Button><Button type="submit" variant="primary" disabled={pending || !chosen}>Show notes</Button></div>
    </form>
  </dialog>, document.body);
}
