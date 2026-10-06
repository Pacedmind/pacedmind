"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { NoteDisplay, NoteLayoutChange, NoteLayoutSettings, NoteRegion, NoteWorkspace } from "@/lib/task-note-workspace";
import { Icon } from "./icons";
import { Popover, type Anchor } from "./popover";
import { Button, cx } from "./ui";

const field = "h-8 max-w-[166px] rounded-md border border-ctl bg-panel px-2 text-[12px] text-fg2";
const subscribeDesktop = () => () => {};
const groups: { value: NoteLayoutSettings["group"]; label: string; description: string }[] = [
  { value: "none", label: "None", description: "Keep all cards together." },
  { value: "focus", label: "Focus", description: "Separate what needs attention, work in progress and later tasks." },
  { value: "project", label: "Project", description: "Give each project its own space." },
  { value: "area", label: "Area", description: "Keep work, personal and other areas apart." },
  { value: "priority", label: "Priority", description: "Put urgent and high-priority tasks first." },
  { value: "status", label: "Status", description: "Arrange tasks by their stage of work." },
  { value: "deadline", label: "Due date", description: "Overdue, today, the next 7 days and later." },
];
export function TaskNoteLayout() {
  const supported = useSyncExternalStore(subscribeDesktop, () => !!window.pacedMindDesktop?.taskNoteLayout, () => false);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [workspace, setWorkspace] = useState<NoteWorkspace | null>(null);
  const [displayId, setDisplayId] = useState("");
  const [error, setError] = useState("");
  const [editor, setEditor] = useState(false);
  const serial = useRef(Promise.resolve());
  const sequence = useRef(0);
  const trigger = useRef<HTMLButtonElement>(null);
  async function read() {
    setError("");
    const result = await window.pacedMindDesktop?.taskNoteLayout?.().catch(() => null);
    if (!result?.workspace) { setError("Couldn't load the layout. Try again."); return; }
    setWorkspace(result.workspace);
    const { displays, defaultDisplay } = result.workspace;
    setDisplayId(displays.find(d => d.id === defaultDisplay)?.id ?? displays.find(d => d.openCount)?.id ?? displays[0]?.id ?? "");
  }
  function update(change: NoteLayoutChange) {
    const version = ++sequence.current;
    setError("");
    if (change.settings) setWorkspace(w => w ? { ...w, displays: w.displays.map(d => d.id === change.displayId ? { ...d, settings: { ...d.settings, ...change.settings } } : d) } : w);
    serial.current = serial.current.then(async () => {
      const result = await window.pacedMindDesktop?.setTaskNoteLayout?.(change).catch(() => null);
      if (version !== sequence.current) return;
      if (result?.workspace) setWorkspace(result.workspace);
      if (!result?.ok) {
        setError(result?.error ?? "Couldn't update the layout. Try again.");
        const current = await window.pacedMindDesktop?.taskNoteLayout?.().catch(() => null);
        if (version === sequence.current && current?.workspace) setWorkspace(current.workspace);
      }
    });
  }
  const display = workspace?.displays.find(d => d.id === displayId);
  const set = (settings: Partial<NoteLayoutSettings>) => update({ displayId, settings });
  if (!supported) return null;
  return <>
    <button ref={trigger} type="button" className="app-titlebar__button" title="Layout" aria-label="Task note layout" aria-haspopup="dialog" aria-expanded={!!anchor || editor}
      onClick={e => { if (anchor) { setAnchor(null); return; } const r = e.currentTarget.getBoundingClientRect(); setAnchor({ x: r.left - 6, y: r.bottom + 4 }); void read(); }}>
      <Icon name="appWindow" size={15} />
    </button>
    {anchor && <Popover anchor={anchor} width={330} onClose={() => setAnchor(null)} className="p-4">
      <div className="mb-3 text-[13px] font-medium text-strong">Layout</div>
      {!workspace && !error && <p className="text-[12px] text-mut">Loading…</p>}
      {display && <div className="flex flex-col gap-3.5 text-[12px] text-fg2">
        <label className="flex items-center justify-between gap-3">Screen
          <select aria-label="Task note screen" className={field} value={displayId} onChange={e => { setDisplayId(e.target.value); update({ displayId: e.target.value, move: true }); }}>
            {workspace?.displays.map((d, i) => <option key={d.id} value={d.id}>{i + 1}. {d.label}{d.primary ? " (main)" : ""}</option>)}
          </select>
        </label>
        <div className="flex items-center justify-between gap-3">Card size
          <div role="group" aria-label="Card size" className="flex rounded-md border border-ctl p-0.5">
            {(["xs", "small", "medium", "large"] as const).map((size, i) => <button key={size} type="button" aria-label={`${size} task notes`} aria-pressed={display.settings.size === size} title={size === "xs" ? "Titles only" : undefined}
              className={cx("h-7 w-9 rounded text-[12px]", display.settings.size === size ? "bg-sel text-strong" : "text-mut hover:bg-hover")}
              onClick={() => set({ size })}>{["XS", "S", "M", "L"][i]}</button>)}
          </div>
        </div>
        {display.settings.size === "xs" && <p className="-mt-2 text-[11px] text-mut">Titles only. Select a title to open the task.</p>}
        <div className="flex flex-col gap-2"><span>Arrangement</span><div role="group" aria-label="Arrangement" className="grid grid-cols-3 gap-2">
          {(["grid", "columns", "rows"] as const).map(value => <button key={value} type="button" aria-label={`Arrange in ${value}`} aria-pressed={display.settings.arrangement === value}
            onClick={() => set({ arrangement: value, regions: {} })} className={cx("flex flex-col items-center gap-2 rounded-md border px-2 py-2", display.settings.arrangement === value ? "border-accent bg-sel text-strong" : "border-line2 text-mut hover:bg-hover")}>
            <span aria-hidden className={cx("grid h-6 w-10 gap-0.5", value === "grid" ? "grid-cols-3" : value === "columns" ? "grid-cols-3" : "grid-rows-3")}>
              {Array.from({ length: value === "grid" ? 6 : 3 }, (_, i) => <span key={i} className="rounded-[1px] bg-current opacity-50" />)}
            </span>{({ grid: "Grid", columns: "Columns", rows: "Rows" })[value]}</button>)}
        </div></div>
        <div className="flex flex-col gap-2"><span>Group by</span><div role="group" aria-label="Group task notes" className="flex flex-wrap gap-1.5">
          {groups.map(g => <button key={g.value} type="button" aria-label={`Group by ${g.label}`} aria-pressed={display.settings.group === g.value}
            onClick={() => set({ group: g.value, regions: {} })} className={cx("rounded-md border px-2.5 py-1.5 text-[11px]", display.settings.group === g.value ? "border-line-strong bg-sel text-strong" : "border-line2 text-mut hover:bg-hover")}>{g.label}</button>)}
        </div><p className="min-h-7 text-[11px] leading-relaxed text-mut">{groups.find(g => g.value === display.settings.group)?.description}</p></div>
        {!!display.groups.length && <button type="button" aria-label="Edit arrangement preview" title="Edit these spaces" onClick={() => { setAnchor(null); setEditor(true); }} className="relative h-20 overflow-hidden rounded-md border border-line2 bg-bg">
          {display.groups.map(g => <span key={g.key} className="absolute overflow-hidden rounded border border-line2 bg-panel p-1.5 text-left text-[10px] text-mut" style={{ left: `${g.x * 100}%`, top: `${g.y * 100}%`, width: `${g.width * 100}%`, height: `${g.height * 100}%` }}>{g.name} <span className="text-fg2">{g.count}</span></span>)}
        </button>}
        <label className="flex items-center justify-between gap-3">Order<select aria-label="Order task notes" className={field} value={display.settings.order} onChange={e => set({ order: e.target.value as NoteLayoutSettings["order"] })}>
          <option value="manual">Manual</option><option value="relevance">Relevance</option><option value="deadline">Due date</option>
        </select></label>
        <div className="border-t border-line" />
        <label className="flex items-center justify-between gap-3">Emphasize important<input type="checkbox" checked={display.settings.emphasis} onChange={e => set({ emphasis: e.target.checked })} /></label>
        <label className="flex items-center justify-between gap-3">Animation<select aria-label="Task note animation" className={field} value={display.settings.animation} onChange={e => set({ animation: e.target.value as NoteLayoutSettings["animation"] })}>
          <option value="shuffle">Shuffle</option><option value="right">Right to left</option><option value="diagonal">Corner to corner</option><option value="together">Together</option><option value="none">None</option>
        </select></label>
        <button type="button" className="flex h-8 items-center gap-2 text-mut hover:text-fg" onClick={() => { setAnchor(null); setEditor(true); }}><Icon name="pen" size={13} />Arrange spaces</button>
        {display.compact && <p className="text-[11px] text-mut">A compact grid keeps all notes on this screen. Use fewer groups to edit spaces.</p>}
      </div>}
      {error && <p role="alert" className="mt-3 text-[12px] text-danger">{error}</p>}
    </Popover>}
    {editor && display && <SpacesEditor display={display} error={error} update={update} onClose={() => { setEditor(false); trigger.current?.focus(); }} />}
  </>;
}

function SpacesEditor({ display, error, update, onClose }: { display: NoteDisplay; error: string; update: (change: NoteLayoutChange) => void; onClose: () => void }) {
  const [selected, setSelected] = useState("");
  const [kind, setKind] = useState<"spaces" | "cards">("spaces");
  const [draft, setDraft] = useState<NoteRegion | null>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const items = kind === "spaces" ? display.groups.map(g => ({ ...g, id: g.key, label: `${g.name} · ${g.count}` })) : display.notes.map(n => ({ ...n, id: n.ref, label: n.title }));
  const item = items.find(i => i.id === selected);
  const region = draft ?? item;
  const drag = useRef<{ x: number; y: number; region: NoteRegion; id: string; resize: boolean } | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key !== "Tab") return;
      const all = [...dialog.current?.querySelectorAll<HTMLElement>("button,select,input") ?? []].filter(el => !el.hasAttribute("disabled"));
      if (e.shiftKey && document.activeElement === all[0]) { e.preventDefault(); all.at(-1)?.focus(); }
      if (!e.shiftKey && document.activeElement === all.at(-1)) { e.preventDefault(); all[0]?.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  function commit(id: string, bounds: NoteRegion) {
    if (kind === "cards") update({ displayId: display.id, ref: id, bounds });
    else update({ displayId: display.id, settings: { regions: { ...Object.fromEntries(display.groups.map(g => [g.key, { x: g.x, y: g.y, width: g.width, height: g.height }])), [id]: bounds } } });
  }
  const minWidth = kind === "cards" ? (display.settings.size === "xs" ? 220 : 280) / display.width : .01;
  const minHeight = kind === "cards" ? (display.settings.size === "xs" ? 72 : 200) / display.height : .01;
  const clamp = (r: NoteRegion): NoteRegion => { const width = Math.min(1, Math.max(minWidth, r.width)), height = Math.min(1, Math.max(minHeight, r.height)); return { x: Math.max(0, Math.min(1 - width, r.x)), y: Math.max(0, Math.min(1 - height, r.y)), width, height }; };
  return createPortal(<div className="fixed inset-0 z-[70] flex items-center justify-center bg-overlay p-5" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div ref={dialog} role="dialog" aria-modal="true" aria-label="Arrange task spaces" className="flex max-h-[90vh] w-[800px] max-w-full flex-col gap-4 overflow-y-auto rounded-xl border border-line2 bg-raised p-5 shadow-[var(--shadow-popover)]">
      <div className="flex items-center justify-between"><h2 className="text-[15px] font-medium text-strong">Arrange spaces · {display.label}</h2><Button autoFocus variant="ghost" onClick={onClose}>Done</Button></div>
      <div className="flex flex-wrap items-center gap-3 text-[12px] text-mut"><label>Edit <select aria-label="Edit spaces or cards" className={field} value={kind} onChange={e => { setKind(e.target.value as typeof kind); setSelected(""); setDraft(null); }}><option value="spaces">Spaces</option><option value="cards">Cards</option></select></label><span>Drag to move. Use the corner to resize. Changes apply immediately.</span></div>
      <div ref={canvas} className="relative min-h-[220px] w-full overflow-hidden rounded-lg border border-line2 bg-bg" style={{ aspectRatio: `${display.width}/${display.height}` }}>
        {items.map(i => { const r = i.id === selected && draft ? draft : i; return <div key={i.id} className={cx("absolute rounded border bg-panel", selected === i.id ? "border-accent" : "border-line-strong")} style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.width * 100}%`, height: `${r.height * 100}%` }}>
          <button type="button" className="h-full w-full touch-none overflow-hidden p-2 text-left text-[11px] text-fg2" aria-label={`Move ${i.label}`}
            onClick={() => { setSelected(i.id); setDraft(null); }}
            onPointerDown={e => { if (e.button !== 0) return; setSelected(i.id); setDraft(i); drag.current = { x: e.clientX, y: e.clientY, region: i, id: i.id, resize: false }; e.currentTarget.setPointerCapture(e.pointerId); }}
            onPointerMove={e => { if (!drag.current || !canvas.current) return; const b = canvas.current.getBoundingClientRect(), d = drag.current; setDraft(clamp({ ...d.region, x: d.region.x + (e.clientX - d.x) / b.width, y: d.region.y + (e.clientY - d.y) / b.height })); }}
            onPointerUp={() => { if (drag.current && draft) commit(i.id, clamp(draft)); drag.current = null; setDraft(null); }}
            onPointerCancel={() => { drag.current = null; setDraft(null); }}>{i.label}</button>
          <button type="button" aria-label={`Resize ${i.label}`} className="absolute bottom-0 right-0 h-5 w-5 touch-none cursor-se-resize text-mut" onPointerDown={e => { setSelected(i.id); setDraft(i); drag.current = { x: e.clientX, y: e.clientY, region: i, id: i.id, resize: true }; e.currentTarget.setPointerCapture(e.pointerId); }}
            onPointerMove={e => { if (!drag.current || !canvas.current) return; const b = canvas.current.getBoundingClientRect(), d = drag.current; setDraft({ ...d.region, width: Math.min(1 - d.region.x, Math.max(minWidth, d.region.width + (e.clientX - d.x) / b.width)), height: Math.min(1 - d.region.y, Math.max(minHeight, d.region.height + (e.clientY - d.y) / b.height)) }); }}
            onPointerUp={() => { if (drag.current && draft) commit(i.id, draft); drag.current = null; setDraft(null); }} onPointerCancel={() => { drag.current = null; setDraft(null); }}>↘</button>
        </div>; })}
        {!items.length && <p className="p-5 text-[12px] text-mut">{kind === "spaces" ? "Show notes and choose a grouping to arrange spaces." : "Show notes to arrange them here."}</p>}
      </div>
      {item && region && <div className="flex flex-wrap gap-3 text-[12px] text-mut">{(["x", "y", "width", "height"] as const).map(key => <label key={key}>{({ x: "Left", y: "Top", width: "Width", height: "Height" })[key]} %<input type="number" min={0} max={100} aria-label={`${key} percent`} className="ml-2 w-16 rounded border border-ctl bg-panel px-2 py-1 text-fg2" value={Math.round(region[key] * 100)} onChange={e => { const value = Number(e.target.value) / 100; if (Number.isFinite(value)) { const next = clamp({ ...region, [key]: value }); setDraft(next); } }} onBlur={() => { if (draft) { commit(item.id, clamp(draft)); setDraft(null); } }} /></label>)}</div>}
      {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
      <div className="flex justify-between text-[11px] text-mut"><span>Saved for this account and display on this computer.</span><Button variant="ghost" onClick={() => { setDraft(null); update({ displayId: display.id, settings: { regions: {} } }); }}>Reset spaces</Button></div>
    </div>
  </div>, document.body);
}
