"use client";
import { useTranslation } from "@/components/language";
import { type Translator } from "@/lib/i18n";

import { useEffect, useRef, useState, useSyncExternalStore, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import type { NoteFill, NoteDisplay, NoteLayoutChange, NoteLayoutSettings, NoteRegion, NoteWorkspace } from "@/lib/task-note-workspace";
import { spacePreviews, spaceRegions } from "@/lib/task-note-preview";
import { Icon } from "./icons";
import { Popover, type Anchor } from "./popover";
import { Button, cx } from "./ui";

const field = "h-8 max-w-[166px] rounded-md border border-ctl bg-panel px-2 text-[12px] text-fg2";
const subscribeDesktop = () => () => {};
const groups = (tx: Translator): { value: NoteLayoutSettings["group"]; label: string; description: string }[] => ([
  { value: "none", label: tx("None"), description: tx("Keep all cards together.") },
  { value: "focus", label: tx("Focus"), description: tx("Separate what needs attention, work in progress and later tasks.") },
  { value: "project", label: tx("Project"), description: tx("Give each project its own space.") },
  { value: "area", label: tx("Area"), description: tx("Keep work, personal and other areas apart.") },
  { value: "priority", label: tx("Priority"), description: tx("Put urgent and high-priority tasks first.") },
  { value: "status", label: tx("Status"), description: tx("Arrange tasks by their stage of work.") },
  { value: "deadline", label: tx("Due date"), description: tx("Overdue, today, the next 7 days and later.") },
]);
export function TaskNoteLayout() {
  const tx = useTranslation();
  const supported = useSyncExternalStore(subscribeDesktop, () => !!window.pacedMindDesktop?.taskNoteLayout, () => false);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [workspace, setWorkspace] = useState<NoteWorkspace | null>(null);
  const [displayId, setDisplayId] = useState("");
  const [error, setError] = useState("");
  const [editor, setEditor] = useState(false);
  const serial = useRef(Promise.resolve());
  const sequence = useRef(0);
  const settled = useRef(0);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!anchor && !editor) return;
    let active = true;
    const timer = setInterval(async () => {
      if (settled.current !== sequence.current) return;
      const version = sequence.current;
      const result = await window.pacedMindDesktop?.taskNoteLayout?.().catch(() => null);
      if (active && version === sequence.current && result?.workspace) setWorkspace(result.workspace);
    }, 2000);
    return () => { active = false; clearInterval(timer); };
  }, [anchor, editor]);
  async function read() {
    setError("");
    const result = await window.pacedMindDesktop?.taskNoteLayout?.().catch(() => null);
    if (!result?.workspace) { setError(tx("Couldn't load the layout. Try again.")); return; }
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
      settled.current = version;
      if (version !== sequence.current) return;
      if (result?.workspace) setWorkspace(result.workspace);
      if (!result?.ok) {
        setError(result?.error ?? tx("Couldn't update the layout. Try again."));
        const current = await window.pacedMindDesktop?.taskNoteLayout?.().catch(() => null);
        if (version === sequence.current && current?.workspace) setWorkspace(current.workspace);
      }
    });
  }
  const display = workspace?.displays.find(d => d.id === displayId);
  const set = (settings: Partial<NoteLayoutSettings>) => update({ displayId, settings });
  if (!supported) return null;
  return <>
    <button ref={trigger} type="button" className="app-titlebar__button" title={tx("Layout")} aria-label={tx("Task note layout")} aria-haspopup="dialog" aria-expanded={!!anchor || editor}
      onClick={e => { if (anchor) { setAnchor(null); return; } const r = e.currentTarget.getBoundingClientRect(); setAnchor({ x: r.left - 6, y: r.bottom + 4 }); void read(); }}>
      <Icon name="appWindow" size={15} />
    </button>
    {anchor && <Popover anchor={anchor} width={330} onClose={() => setAnchor(null)} className="p-4">
      <div className="mb-3 text-[13px] font-medium text-strong">{tx("Layout")}</div>
      {!workspace && !error && <p className="text-[12px] text-mut">{tx("Loading…")}</p>}
      {display && <div className="flex flex-col gap-3.5 text-[12px] text-fg2">
        <label className="flex items-center justify-between gap-3">{tx("Screen")}<select aria-label={tx("Task note screen")} className={field} value={displayId} onChange={e => { setDisplayId(e.target.value); update({ displayId: e.target.value, move: true }); }}>
            {workspace?.displays.map((d, i) => <option key={d.id} value={d.id}>{i + 1}. {d.label}{d.primary ? tx(" (main)") : ""}</option>)}
          </select>
        </label>
        <div className="flex items-center justify-between gap-3">{tx("Card size")}<div role="group" aria-label={tx("Card size")} className="flex rounded-md border border-ctl p-0.5">
            {(["xs", "small", "medium", "large"] as const).map((size, i) => <button key={size} type="button" aria-label={tx("{0} task notes", [tx(size)])} aria-pressed={display.settings.size === size} title={size === "xs" ? tx("Titles only") : undefined}
              className={cx("h-7 w-9 rounded text-[12px]", display.settings.size === size ? "bg-sel text-strong" : "text-mut hover:bg-hover")}
              onClick={() => set({ size })}>{["XS", "S", "M", "L"][i]}</button>)}
          </div>
        </div>
        {display.settings.size === "xs" && <p className="-mt-2 text-[11px] text-mut">{tx("Titles only. Select a title to open the task.")}</p>}
        <div className="flex flex-col gap-2"><span>{tx("Arrangement")}</span><div role="group" aria-label={tx("Arrangement")} className="grid grid-cols-3 gap-2">
          {(["grid", "columns", "rows"] as const).map(value => <button key={value} type="button" aria-label={tx("Arrange in {0}", [tx(value)])} aria-pressed={display.settings.arrangement === value}
            onClick={() => set({ arrangement: value, regions: {} })} className={cx("flex flex-col items-center gap-2 rounded-md border px-2 py-2", display.settings.arrangement === value ? "border-accent bg-sel text-strong" : "border-line2 text-mut hover:bg-hover")}>
            <span aria-hidden className={cx("grid h-6 w-10 gap-0.5", value === "grid" ? "grid-cols-3" : value === "columns" ? "grid-cols-3" : "grid-rows-3")}>
              {Array.from({ length: value === "grid" ? 6 : 3 }, (_, i) => <span key={i} className="rounded-[1px] bg-current opacity-50" />)}
            </span>{({ grid: tx("Grid"), columns: tx("Columns"), rows: tx("Rows") })[value]}</button>)}
        </div></div>
        <div className="flex items-center gap-2">
          <Button onClick={() => { setAnchor(null); setEditor(true); }}><Icon name="pen" size={13} />{tx("Arrange spaces")}</Button>
          <Button onClick={() => update({ displayId, rearrange: true })}>{tx("Rearrange cards")}</Button>
        </div>
        <div className="flex flex-col gap-2"><span>{tx("Group by")}</span><div role="group" aria-label={tx("Group task notes")} className="flex flex-wrap gap-1.5">
          {groups(tx).map(g => <button key={g.value} type="button" aria-label={tx("Group by {0}", [g.label])} aria-pressed={display.settings.group === g.value}
            onClick={() => set({ group: g.value, regions: {} })} className={cx("rounded-md border px-2.5 py-1.5 text-[11px]", display.settings.group === g.value ? "border-line-strong bg-sel text-strong" : "border-line2 text-mut hover:bg-hover")}>{g.label}</button>)}
        </div><p className="min-h-7 text-[11px] leading-relaxed text-mut">{groups(tx).find(g => g.value === display.settings.group)?.description}</p></div>
        {!!display.groups.length && <button type="button" aria-label={tx("Edit arrangement preview")} title={tx("Edit these spaces")} onClick={() => { setAnchor(null); setEditor(true); }} className="relative h-20 overflow-hidden rounded-md border border-line2 bg-bg">
          {display.groups.map(g => <span key={g.key} className="absolute overflow-hidden rounded border border-line2 bg-panel p-1.5 text-left text-[10px] text-mut" style={{ left: `${g.x * 100}%`, top: `${g.y * 100}%`, width: `${g.width * 100}%`, height: `${g.height * 100}%` }}>{["project", "area"].includes(display.settings.group) ? g.name : tx(g.name)} <span className="text-fg2">{g.count}</span></span>)}
        </button>}
        <label className="flex items-center justify-between gap-3">{tx("Order")}<select aria-label={tx("Order task notes")} className={field} value={display.settings.order} onChange={e => set({ order: e.target.value as NoteLayoutSettings["order"] })}>
          <option value="manual">{tx("Manual")}</option><option value="relevance">{tx("Relevance")}</option><option value="deadline">{tx("Due date")}</option>
        </select></label>
        <div className="border-t border-line" />
        <label className="flex items-center justify-between gap-3">{tx("Emphasize important")}<input type="checkbox" checked={display.settings.emphasis} onChange={e => set({ emphasis: e.target.checked })} /></label>
        <label className="flex items-center justify-between gap-3">{tx("Animation")}<select aria-label={tx("Task note animation")} className={field} value={display.settings.animation} onChange={e => set({ animation: e.target.value as NoteLayoutSettings["animation"] })}>
          <option value="shuffle">{tx("Shuffle")}</option><option value="right">{tx("Right to left")}</option><option value="diagonal">{tx("Corner to corner")}</option><option value="cascade">{tx("Top to bottom")}</option><option value="center">{tx("Center outward")}</option><option value="together">{tx("Together")}</option><option value="none">{tx("None")}</option>
        </select></label>
        <Presets key={display.id} display={display} update={update} />
        {display.compact && <p className="text-[11px] text-mut">{tx("A compact grid keeps all notes on this screen. Use fewer groups to edit spaces.")}</p>}
      </div>}
      {error && <p role="alert" className="mt-3 text-[12px] text-danger">{tx.generated(error)}</p>}
    </Popover>}
    {editor && display && <SpacesEditor display={display} error={error} update={update} onClose={() => { setEditor(false); trigger.current?.focus(); }} />}
  </>;
}

function Presets({ display, update, disabledSave = false }: { display: NoteDisplay; update: (change: NoteLayoutChange) => void; disabledSave?: boolean }) {
  const tx = useTranslation();
  const [name, setName] = useState("");
  const [chosen, setChosen] = useState("");
  return <details className="text-[12px] text-fg2"><summary className="cursor-pointer text-mut">{tx("Saved presets")}{display.presets.length ? ` · ${display.presets.length}` : ""}</summary><div className="mt-2 flex flex-col gap-2">
    <label className="flex items-center justify-between gap-2">{tx("Preset")}<select aria-label={tx("Saved layout preset")} className={field} value={chosen} onChange={e => setChosen(e.target.value)}>
      <option value="">{tx("Choose a preset…")}</option>{display.presets.map(p => <option key={p.name}>{p.name}</option>)}
    </select></label>
    {chosen && <div className="flex gap-2"><Button onClick={() => update({ displayId: display.id, preset: { action: "load", name: chosen } })}>{tx("Apply preset")}</Button><Button variant="ghost" onClick={() => { update({ displayId: display.id, preset: { action: "delete", name: chosen } }); setChosen(""); }}>{tx("Delete preset")}</Button></div>}
    <form className="flex gap-2" onSubmit={e => { e.preventDefault(); if (name.trim() && !disabledSave) { update({ displayId: display.id, preset: { action: "save", name: name.trim() } }); setName(""); } }}>
      <input aria-label={tx("Preset name")} placeholder={tx("Preset name")} maxLength={60} className="min-w-0 flex-1 rounded-md border border-ctl bg-panel px-2 text-[12px]" value={name} onChange={e => setName(e.target.value)} />
      <Button type="submit" disabled={!name.trim() || disabledSave}>{tx("Save preset")}</Button>
    </form>
    <span className="text-[11px] text-mut">{tx("Saves size, grouping, spaces, order and animation.")}</span>
  </div></details>;
}

const handles = [
  { edge: "n", label: "top edge", style: { top: 0, left: 12, right: 12, height: 10, cursor: "ns-resize" } },
  { edge: "s", label: "bottom edge", style: { bottom: 0, left: 12, right: 12, height: 10, cursor: "ns-resize" } },
  { edge: "w", label: "left edge", style: { left: 0, top: 12, bottom: 12, width: 10, cursor: "ew-resize" } },
  { edge: "e", label: "right edge", style: { right: 0, top: 12, bottom: 12, width: 10, cursor: "ew-resize" } },
  { edge: "nw", label: "top-left corner", style: { top: 0, left: 0, width: 12, height: 12, cursor: "nwse-resize" } },
  { edge: "ne", label: "top-right corner", style: { top: 0, right: 0, width: 12, height: 12, cursor: "nesw-resize" } },
  { edge: "sw", label: "bottom-left corner", style: { bottom: 0, left: 0, width: 12, height: 12, cursor: "nesw-resize" } },
  { edge: "se", label: "bottom-right corner", style: { bottom: 0, right: 0, width: 12, height: 12, cursor: "nwse-resize" } },
];
function SpacesEditor({ display, error, update, onClose }: { display: NoteDisplay; error: string; update: (change: NoteLayoutChange) => void; onClose: () => void }) {
  const tx = useTranslation();
  const [selected, setSelected] = useState("");
  const [kind, setKind] = useState<"spaces" | "cards">("spaces");
  const [draft, setDraft] = useState<NoteRegion | null>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const items = kind === "spaces" ? display.groups.map(g => ({ ...g, id: g.key, label: `${["project", "area"].includes(display.settings.group) ? g.name : tx(g.name)} · ${g.count}` })) : display.notes.map(n => ({ ...n, id: n.ref, label: n.title }));
  const item = items.find(i => i.id === selected);
  const region = draft ?? item;
  const drag = useRef<{ x: number; y: number; region: NoteRegion; id: string; edge: string } | null>(null);
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
  const previews = kind === "spaces" ? spacePreviews(display, selected && draft ? spaceRegions(display, selected, draft) : {}) : [];
  const selectedPreview = previews.find(g => g.key === selected);
  const invalidPreview = previews.some(g => !g.preview.fits || g.overlap);
  function commit(id: string, bounds: NoteRegion) {
    if (kind === "cards") update({ displayId: display.id, ref: id, bounds });
    else {
      const regions = spaceRegions(display, id, bounds);
      if (spacePreviews(display, regions).some(g => !g.preview.fits || g.overlap)) {
        setSelected(id); setDraft(bounds); return false;
      }
      update({ displayId: display.id, settings: { regions } });
    }
    return true;
  }
  function start(e: PointerEvent<HTMLButtonElement>, id: string, region: NoteRegion, edge = "") {
    if (e.button !== 0) return;
    setSelected(id); setDraft(region);
    drag.current = { x: e.clientX, y: e.clientY, region, id, edge };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function moved(e: PointerEvent<HTMLButtonElement>) {
    const d = drag.current, b = canvas.current?.getBoundingClientRect();
    if (!d || !b) return null;
    const dx = (e.clientX - d.x) / b.width, dy = (e.clientY - d.y) / b.height, r = d.region;
    if (!d.edge) return clamp({ ...r, x: r.x + dx, y: r.y + dy });
    let left = r.x, top = r.y, right = r.x + r.width, bottom = r.y + r.height;
    if (d.edge.includes("w")) left = Math.max(0, Math.min(right - minWidth, left + dx));
    if (d.edge.includes("e")) right = Math.min(1, Math.max(left + minWidth, right + dx));
    if (d.edge.includes("n")) top = Math.max(0, Math.min(bottom - minHeight, top + dy));
    if (d.edge.includes("s")) bottom = Math.min(1, Math.max(top + minHeight, bottom + dy));
    return { x: left, y: top, width: right - left, height: bottom - top };
  }
  function move(e: PointerEvent<HTMLButtonElement>) { const next = moved(e); if (next) setDraft(next); }
  function finish(e: PointerEvent<HTMLButtonElement>) {
    const next = moved(e), d = drag.current;
    const changed = next && d && (Math.abs(e.clientX - d.x) > 1 || Math.abs(e.clientY - d.y) > 1);
    const saved = !changed || commit(d.id, next);
    drag.current = null; if (saved) setDraft(null);
  }
  function cancel() { drag.current = null; setDraft(null); }
  const fill = display.settings.fills[selected] ?? { corner: "auto", axis: display.settings.arrangement === "columns" ? "vertical" : "horizontal" };
  const setFill = (change: Partial<NoteFill>) => update({ displayId: display.id, settings: { fills: { ...display.settings.fills, [selected]: { ...fill, ...change } } } });
  const minWidth = kind === "cards" ? (display.settings.size === "xs" ? 220 : 280) / display.width : .01;
  const minHeight = kind === "cards" ? (display.settings.size === "xs" ? 72 : 200) / display.height : .01;
  const clamp = (r: NoteRegion): NoteRegion => { const width = Math.min(1, Math.max(minWidth, r.width)), height = Math.min(1, Math.max(minHeight, r.height)); return { x: Math.max(0, Math.min(1 - width, r.x)), y: Math.max(0, Math.min(1 - height, r.y)), width, height }; };
  return createPortal(<div className="fixed inset-0 z-[70] flex items-center justify-center bg-overlay p-5" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div ref={dialog} role="dialog" aria-modal="true" aria-label={tx("Arrange task spaces")} className="flex max-h-[90vh] w-[900px] max-w-full flex-col gap-4 overflow-y-auto rounded-xl border border-line2 bg-raised p-5 shadow-[var(--shadow-popover)]">
      <div className="flex items-center justify-between"><h2 className="text-[15px] font-medium text-strong">{tx("Arrange spaces ·")} {display.label}</h2><Button autoFocus variant="ghost" onClick={onClose}>{tx("Done")}</Button></div>
      <div className="flex flex-wrap items-center gap-3 text-[12px] text-mut"><label>{tx("Edit")} <select aria-label={tx("Edit spaces or cards")} className={field} value={kind} onChange={e => { setKind(e.target.value as typeof kind); setSelected(""); setDraft(null); }}><option value="spaces">{tx("Spaces")}</option><option value="cards">{tx("Cards")}</option></select></label><span>{tx("Drag anywhere inside to move. Resize from any edge or corner.")}</span><Button onClick={() => { setDraft(null); update({ displayId: display.id, rearrange: true }); }}>{tx("Rearrange cards")}</Button></div>
      <div ref={canvas} className="relative min-h-[220px] w-full overflow-hidden rounded-lg border border-line2 bg-bg" style={{ aspectRatio: `${display.width}/${display.height}` }}>
        {items.map(i => { const preview = previews.find(g => g.key === i.id); const r = preview?.region ?? (i.id === selected && draft ? draft : i); return <div key={i.id} className={cx("absolute rounded border bg-panel", preview && (!preview.preview.fits || preview.overlap) ? "border-danger" : selected === i.id ? "border-accent" : "border-line-strong")} style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.width * 100}%`, height: `${r.height * 100}%` }}>
          <button type="button" className="h-full w-full touch-none cursor-move select-none overflow-hidden text-left text-[11px] text-fg2" aria-label={tx("Move {0}", [i.label])} aria-pressed={selected === i.id}
            onPointerDown={e => start(e, i.id, r)} onPointerMove={move} onPointerUp={finish} onPointerCancel={cancel}
            onClick={() => { if (selected !== i.id) setDraft(null); setSelected(i.id); }} onKeyDown={e => {
              if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
              e.preventDefault(); setSelected(i.id);
              const dx = e.key === "ArrowLeft" ? -.01 : e.key === "ArrowRight" ? .01 : 0, dy = e.key === "ArrowUp" ? -.01 : e.key === "ArrowDown" ? .01 : 0;
              commit(i.id, clamp(e.shiftKey ? { ...r, width: r.width + dx, height: r.height + dy } : { ...r, x: r.x + dx, y: r.y + dy }));
            }}><span className="pointer-events-none absolute left-2 top-2 z-20 max-w-[calc(100%-16px)] rounded border border-line2 bg-raised px-1.5 py-1 text-[10px] shadow-sm">{i.label}{preview && <span className="ml-2 text-mut">{tx("Room for {0}", [preview.preview.capacity])}</span>}</span></button>
          {handles.map(h => <button key={h.edge} type="button" aria-label={tx("Resize {0} from {1}", [i.label, tx(h.label)])} title={tx("Resize from {0}", [tx(h.label)])} className="absolute z-30 touch-none rounded-sm hover:bg-sel focus-visible:bg-sel" style={h.style}
            onFocus={() => { if (selected !== i.id) setDraft(null); setSelected(i.id); }} onPointerDown={e => start(e, i.id, r, h.edge)} onPointerMove={move} onPointerUp={finish} onPointerCancel={cancel}>
            {h.edge.length === 2 && <span aria-hidden className="absolute inset-[3px] rounded-sm border border-line-strong bg-raised" />}
          </button>)}
        </div>; })}
        {previews.flatMap(g => g.preview.cards.map((card, index) => <span key={`${g.key}:${index}`} role="img" aria-label={tx("Card preview: {0}", [g.notes[index]?.title ?? String(index + 1)])} data-note-preview={g.notes[index]?.ref ?? `${g.key}:${index}`} data-preview-overflow={card.overflow} className={cx("pointer-events-none absolute z-10 overflow-hidden rounded border px-1 py-0.5 text-[9px] leading-tight", card.overflow ? "border-dashed border-danger bg-danger-bg text-danger" : "border-line-strong bg-sel text-fg2")}
          style={{ left: `${card.x / display.width * 100}%`, top: `${card.y / display.height * 100}%`, width: `${card.width / display.width * 100}%`, height: `${card.height / display.height * 100}%` }}><span className="mr-1 font-medium">{index + 1}.</span>{g.notes[index]?.title}</span>))}
        {!items.length && <p className="p-5 text-[12px] text-mut">{kind === "spaces" ? tx("Show notes and choose a grouping to arrange spaces.") : tx("Show notes to arrange them here.")}</p>}
      </div>
      {item && region && <div className="flex flex-wrap gap-3 text-[12px] text-mut">{(["x", "y", "width", "height"] as const).map(key => <label key={key}>{({ x: tx("Left"), y: tx("Top"), width: tx("Width"), height: tx("Height") })[key]}  %<input type="number" min={0} max={100} aria-label={tx("{0} percent", [({ x: tx("Left"), y: tx("Top"), width: tx("Width"), height: tx("Height") })[key]])} className="ml-2 w-16 rounded border border-ctl bg-panel px-2 py-1 text-fg2" value={Math.round(region[key] * 100)} onChange={e => { const value = Number(e.target.value) / 100; if (Number.isFinite(value)) { const next = clamp({ ...region, [key]: value }); setDraft(next); } }} onBlur={() => { if (draft && commit(item.id, clamp(draft))) setDraft(null); }} /></label>)}</div>}
      {selectedPreview && <div className="flex flex-col gap-1 text-[11px] text-mut" aria-live="polite">
        <span>{tx("{0} cards · room for {1}", [selectedPreview.count, selectedPreview.preview.capacity])}{selectedPreview.preview.cards[0] && ` · ${tx("{0} × {1} px cards · {2} px gaps", [selectedPreview.preview.cards[0].width, selectedPreview.preview.cards[0].height, selectedPreview.preview.gap])}`}</span>
        {selectedPreview.preview.clearance && <span>{tx("Free to edges: left {0}, top {1}, right {2}, bottom {3} px", [selectedPreview.preview.clearance.left, selectedPreview.preview.clearance.top, selectedPreview.preview.clearance.right, selectedPreview.preview.clearance.bottom].map(Math.round))}</span>}
      </div>}
      {invalidPreview && <div role="status" className="rounded-md border border-danger-line bg-danger-bg px-3 py-2 text-[12px] text-danger">
        {previews.filter(g => !g.preview.fits || g.overlap).map(g => <p key={g.key}>{["project", "area"].includes(display.settings.group) ? g.name : tx(g.name)}: {g.overlap ? tx("Overlaps another space.") : tx("{0} cards need more room. Enlarge this space or choose smaller cards.", [Math.max(0, g.count - g.preview.capacity)])}</p>)}
        <p className="mt-1">{tx("Preview only. Changes apply when every space fits.")}</p>
      </div>}
      {item && kind === "spaces" && <div className="flex flex-wrap items-center gap-3 text-[12px] text-fg2">
        <span>{item.label}</span><label>{tx("Start from")} <select aria-label={tx("Space starting corner")} className={field} value={fill.corner} onChange={e => setFill({ corner: e.target.value as NoteFill["corner"] })}><option value="auto">{tx("Screen edge (automatic)")}</option><option value="top-left">{tx("Top left")}</option><option value="top-right">{tx("Top right")}</option><option value="bottom-left">{tx("Bottom left")}</option><option value="bottom-right">{tx("Bottom right")}</option></select></label>
        <label>{tx("Fill")} <select aria-label={tx("Space fill direction")} className={field} value={fill.axis} onChange={e => setFill({ axis: e.target.value as NoteFill["axis"] })}><option value="horizontal">{tx("Across, then down / up")}</option><option value="vertical">{tx("Down / up, then across")}</option></select></label>
      </div>}
      {item && <p className="text-[11px] text-mut">{tx("Arrow keys move the selected item. Shift + arrow keys resize it.")}</p>}
      <Presets key={display.id} display={display} disabledSave={invalidPreview} update={change => { if (change.preset?.action === "load") setDraft(null); update(change); }} />
      {error && <p role="alert" className="text-[12px] text-danger">{tx.generated(error)}</p>}
      <div className="flex justify-between text-[11px] text-mut"><span>{tx("Saved for this account and display on this computer. Cards rearrange when tasks change.")}</span><Button variant="ghost" onClick={() => { setDraft(null); update({ displayId: display.id, settings: { regions: {}, fills: {} } }); }}>{tx("Reset spaces")}</Button></div>
    </div>
  </div>, document.body);
}
