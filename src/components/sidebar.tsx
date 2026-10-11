"use client";
import { useTranslation } from "@/components/language";
import { type Translator } from "@/lib/i18n";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useOptimistic, useRef, useState, type CSSProperties, type DragEvent, type MouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import {
  createAreaAction, createProjectAction, moveProjectsAction, reorderAreasAction, reorderProjectsAction, updateAreaAction, updateProjectAction,
} from "@/app/actions";
import { nextColor, projectColor } from "@/lib/colors";
import { fmtShort } from "@/lib/dates";
import type { Area, Project, Usage } from "@/lib/types";
import { AreaMenu, AreasMenu, InlineName, MoreButton, ProjectMenu, ProjectsMenu, type OpenMenu } from "./entity-menu";
import { AreaIconSvg, AreaPicture, Icon, ProgressRing, type IconName } from "./icons";
import { anchorOf, type Anchor } from "./popover";
import { SIDEBAR_DEFAULT, SIDEBAR_MIN, clampWidth, setSidebarLayout, toggleSidebar, useSidebarLayout } from "./sidebar-layout";
import { cx, useAction } from "./ui";
import { ThemeToggle } from "./theme";

const NAV = (tx: Translator): { href: string; label: string; icon: IconName; count?: "inbox" | "today" | "sessions" }[] => ([
  { href: "/inbox", label: tx("Inbox"), icon: "inbox", count: "inbox" },
  { href: "/today", label: tx("Today"), icon: "sun", count: "today" },
  { href: "/upcoming", label: tx("Upcoming"), icon: "clock" },
  { href: "/calendar", label: tx("Calendar"), icon: "calendar" },
  { href: "/timeline", label: tx("Timeline"), icon: "timeline" },
  { href: "/projects", label: tx("Projects"), icon: "box" },
  { href: "/roadmap", label: tx("Roadmap"), icon: "roadmap" },
  { href: "/sessions", label: tx("Sessions"), icon: "terminal", count: "sessions" },
]);

export function openQuickAdd() {
  window.dispatchEvent(new CustomEvent("organizer:new"));
}

const item = "flex h-[30px] items-center gap-2.5 rounded-md px-2 text-fg3 hover:bg-hover";
const editing = "flex h-[30px] items-center gap-2.5 rounded-md bg-hover px-2";

/** The area's picture, else its icon in its color, else its dot on a faint square, all as wide as the icons above. */
function AreaDot({ area }: { area: Pick<Area, "id" | "color" | "icon" | "picture"> }) {
  if (area.picture) return <AreaPicture area={area} size={16} />;
  if (area.icon) {
    return <span className="flex h-4 w-4 shrink-0 items-center justify-center"><AreaIconSvg icon={area.icon} color={area.color} size={16} /></span>;
  }
  return (
    <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded bg-ink/[0.06]">
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: area.color }} />
    </span>
  );
}

function SectionHeader({ label, addLabel, onAdd }: { label: string; addLabel: string; onAdd: (a: Anchor) => void }) {
  const tx = useTranslation();
  return (
    <div className="group flex h-[26px] items-center pl-2 pr-1">
      <Link href="/projects" title={tx("All areas and projects")} className="mr-auto text-[12px] font-medium text-mut2 hover:text-fg3">{label}</Link>
      <button type="button" aria-label={addLabel} title={addLabel} onMouseDown={(e) => e.stopPropagation()} onClick={(e) => onAdd(anchorOf(e.currentTarget))}
        className="flex h-5 w-5 items-center justify-center rounded text-mut opacity-0 hover:bg-hover hover:text-fg2 focus-visible:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100">
        <Icon name="plus" size={13} />
      </button>
    </div>
  );
}

type Kind = "area" | "project";
/** Rows selected together, all areas or all projects. Shift-click selects the rows from `from` to the one clicked. */
type Selection = { kind: Kind; ids: string[]; from: string } | null;
/** Where the dragged rows would land: before or after this row. */
type DropAt = { id: string; after: boolean };
type RowDrag = { onDragStart: (e: DragEvent) => void; onDragOver: (e: DragEvent) => void; onDragEnd: () => void };

const DRAG_TYPE = "application/x-pacedmind-sidebar";

/** `ids` with `moving` taken out and put back, in their order, before or after `at`. */
function moveIds(ids: string[], moving: string[], at: DropAt): string[] {
  const rest = ids.filter((id) => !moving.includes(id));
  const i = rest.indexOf(at.id) + (at.after ? 1 : 0);
  return [...rest.slice(0, i), ...moving, ...rest.slice(i)];
}

/**
 * A sidebar link with a "…" menu on hover and the same menu on right-click. A touch screen has no hover (and iPhones
 * no long-press menu), so there the "…" always shows, beside the key or date. Ctrl-click (⌘-click on a Mac) and
 * Shift-click select the row instead of opening it; dragging it moves it in the list.
 */
function MenuRow({ href, active, open, selected, dragged, drop, label, onMenu, onClose, onSelect, drag, children, trailing, group }: {
  href: string; active: boolean; open: boolean; selected: boolean; dragged: boolean; drop: "before" | "after" | null; label: string;
  onMenu: (a: Anchor) => void; onClose: () => void; onSelect: (range: boolean) => void; drag: RowDrag;
  children: ReactNode; trailing?: ReactNode;
  group?: { expanded: boolean; onToggle: () => void; onAdd: () => void };
}) {
  const tx = useTranslation();
  const onContextMenu = (e: MouseEvent) => { e.preventDefault(); onMenu({ x: e.clientX, y: e.clientY }); };
  // With Ctrl, ⌘ or Shift the browser would open the page in a new tab or window.
  const onClick = (e: MouseEvent) => {
    if (!e.ctrlKey && !e.metaKey && !e.shiftKey) {
      if (href.startsWith("/area/")) window.dispatchEvent(new CustomEvent("organizer:area-details", { detail: href.slice(6) }));
      return;
    }
    e.preventDefault();
    onSelect(e.shiftKey);
  };
  return (
    <div className={cx("group relative", group && "flex items-center", dragged && "opacity-40")} onContextMenu={onContextMenu} draggable {...drag}>
      {group && <button type="button" aria-label={`${group.expanded ? tx("Collapse") : tx("Expand")} ${label}`} aria-expanded={group.expanded}
        onClick={group.onToggle} className="flex h-6 w-5 shrink-0 items-center justify-center rounded text-mut2 hover:bg-hover hover:text-fg2">
        <Icon name={group.expanded ? "chevronDown" : "chevronRight"} size={12} />
      </button>}
      <Link href={href} draggable onClick={onClick} title={group ? tx("{0} · Drag to reorder area", [label]) : label}
        className={cx(item, group && "min-w-0 flex-1 gap-2 px-1 text-[12px] font-medium", active && "bg-sel text-strong", open && "bg-hover", selected && "bg-accent/[0.17] text-strong hover:bg-accent/[0.22]")}>
        {children}
        {trailing && <span className={cx("group-hover:opacity-0 group-has-[:focus-visible]:opacity-0 pointer-coarse:mr-7 pointer-coarse:opacity-100", open && "opacity-0")}>{trailing}</span>}
      </Link>
      {group && <button type="button" aria-label={tx("New project in {0}", [label])} title={tx("New project in {0}", [label])} onClick={group.onAdd}
        // Like the "…", only while the row is hovered or its menu is open; a touch screen always shows it.
        className={cx("flex h-6 w-6 shrink-0 items-center justify-center rounded text-mut2 opacity-0 hover:bg-hover hover:text-fg2 focus-visible:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100",
          open && "opacity-100")}>
        <Icon name="plus" size={13} />
      </button>}
      <MoreButton label={tx("{0} options", [label])} open={open} onOpen={onMenu} onClose={onClose}
        className={cx(!group && "absolute right-1 top-[3px]", "pointer-coarse:opacity-100")} />
      {drop && <span aria-hidden className={cx("pointer-events-none absolute inset-x-1 h-0.5 rounded-full bg-accent", drop === "before" ? "-top-px" : "-bottom-px")} />}
    </div>
  );
}

type Draft = { kind: "area" } | { kind: "project"; areaId: string } | null;

export function Sidebar({ areas: savedAreas, projects: savedProjects, counts, usage, desktop }: {
  areas: Area[];
  projects: Project[];
  counts: { inbox: number; today: number; sessions: number };
  usage: Usage;
  desktop: boolean;
}) {
  const tx = useTranslation();
  const path = usePathname();
  const router = useRouter();
  const { run } = useAction();
  // A new order shows at once, while it's being saved.
  const [areas, showAreas] = useOptimistic(savedAreas);
  const [projects, showProjects] = useOptimistic(savedProjects);
  const [menu, setMenu] = useState<OpenMenu>(null);
  // The menu of several selected rows, opened on the row `from`.
  const [bulk, setBulk] = useState<{ kind: Kind; ids: string[]; from: string; anchor: Anchor } | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [drag, setDrag] = useState<{ kind: Kind; ids: string[] } | null>(null);
  const dragging = useRef<{ kind: Kind; ids: string[] } | null>(null);
  const [dropArea, setDropArea] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<DropAt | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  // On a phone the sidebar is a panel over the page, opened from the header's menu button (app-header.tsx).
  const [drawer, setDrawer] = useState(false);
  // On a wider screen: its width (dragged at its right edge) and whether Ctrl+B hid it. Hidden, it slides out over
  // the page while the pointer is at the window's left edge (peek).
  const layout = useSidebarLayout();
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const [peek, setPeek] = useState(false);
  const width = dragWidth ?? layout.width;
  const nav = useRef<HTMLElement>(null);
  const active = (href: string) => path === href || path.startsWith(`${href}/`);
  const closeMenu = () => { setMenu(null); setBulk(null); };

  useEffect(() => {
    const toggle = () => setDrawer((open) => !open);
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "b" && !(e.target as HTMLElement).isContentEditable) {
        e.preventDefault();
        if (window.matchMedia("(max-width: 767.98px)").matches) setDrawer((open) => !open);
        else { setPeek(false); toggleSidebar(); }
        return;
      }
      if (e.key !== "Escape") return;
      setDrawer(false);
      setPeek(false);
      setSelection(null);
    };
    window.addEventListener("organizer:menu", toggle);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("organizer:menu", toggle);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  // A press outside the sidebar ends the selection, unless it's in the selection's menu or its confirmation.
  useEffect(() => {
    if (!selection) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element;
      if (!nav.current?.contains(t) && !t.closest('[role="menu"], [role="alertdialog"]')) setSelection(null);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [selection]);

  // Selection follows the visible hierarchy, including the saved order within each area.
  const idsOf = (kind: Kind) => kind === "area" ? areas.map((a) => a.id)
    : areas.flatMap((a) => collapsed[a.id] ? [] : projects.filter((p) => p.areaId === a.id).map((p) => p.id));
  const isSelected = (kind: Kind, id: string) => selection?.kind === kind && selection.ids.includes(id);

  /** Ctrl-click (⌘-click) adds the row to the selection or takes it out; Shift-click selects a run of rows. */
  const select = (kind: Kind, id: string, range: boolean) => {
    const ids = idsOf(kind);
    // The row whose page is open counts as selected, as if it had been clicked first.
    const open = ids.find((x) => active(`/${kind}/${x}`));
    const mine = selection?.kind === kind ? selection : null;
    if (range) {
      const from = mine?.from ?? open ?? id;
      const [a, b] = [ids.indexOf(from), ids.indexOf(id)].sort((x, y) => x - y);
      setSelection({ kind, ids: a < 0 ? [id] : ids.slice(a, b + 1), from });
      return;
    }
    const current = mine?.ids ?? (open ? [open] : []);
    const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
    setSelection(next.length ? { kind, ids: next, from: id } : null);
  };

  const openMenu = (kind: Kind, id: string, anchor: Anchor) => {
    if (isSelected(kind, id) && selection!.ids.length > 1) {
      setMenu(null);
      setBulk({ kind, ids: selection!.ids, from: id, anchor });
    } else {
      setSelection(null);
      setBulk(null);
      setMenu({ kind, id, anchor });
    }
  };

  const rowDrag = (kind: Kind, id: string): RowDrag => ({
    onDragStart: (e) => {
      e.stopPropagation();
      // A selected row takes the whole selection along, in list order; any other row goes on its own.
      const together = isSelected(kind, id);
      const moving = together ? idsOf(kind).filter((x) => selection!.ids.includes(x)) : [id];
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData(DRAG_TYPE, kind);
      const started = { kind, ids: moving };
      dragging.current = started;
      // After the browser has taken its picture of the row: changing it now could cancel the drag.
      setTimeout(() => {
        if (dragging.current !== started) return;
        if (!together) setSelection(null);
        closeMenu();
        setDrag({ kind, ids: moving });
      });
    },
    onDragOver: (e) => {
      const drag = dragging.current;
      if (drag?.kind === "project" && kind === "area") {
        e.stopPropagation(); e.preventDefault(); e.dataTransfer.dropEffect = "move";
        setDropArea(id); setDropAt(null); return;
      }
      if (drag?.kind !== kind) return;
      e.stopPropagation();
      if (kind === "project") setDropArea(projects.find((p) => p.id === id)?.areaId ?? null);
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const r = e.currentTarget.getBoundingClientRect();
      const at = drag.ids.includes(id) ? null : { id, after: e.clientY > r.top + r.height / 2 };
      setDropAt((d) => (d?.id === at?.id && d?.after === at?.after ? d : at));
    },
    onDragEnd: () => { dragging.current = null; setDrag(null); setDropAt(null); setDropArea(null); },
  });

  const dropProjects = (e: DragEvent, areaId: string) => {
    const drag = dragging.current;
    if (drag?.kind !== "project") return;
    e.stopPropagation(); e.preventDefault();
    const moving = drag.ids;
    const at = dropArea === areaId ? dropAt : null;
    const before = projects.map((p) => p.id);
    const last = projects.filter((p) => p.areaId === areaId && !moving.includes(p.id)).at(-1);
    const target = at && projects.some((p) => p.id === at.id && p.areaId === areaId) ? at : last ? { id: last.id, after: true } : null;
    const ids = target ? moveIds(before, moving, target) : [...before.filter((id) => !moving.includes(id)), ...moving];
    dragging.current = null;
    setDrag(null); setDropAt(null); setDropArea(null); setSelection(null);
    setCollapsed((c) => ({ ...c, [areaId]: false }));
    if (ids.join() === before.join() && moving.every((id) => projects.find((p) => p.id === id)?.areaId === areaId)) return;
    run(() => {
      showProjects(ids.map((id) => { const p = projects.find((p) => p.id === id)!; return moving.includes(id) ? { ...p, areaId } : p; }));
      return moveProjectsAction(moving, areaId, ids);
    });
  };

  /** The list takes the drop, so a row dropped in the gap between two rows still lands where its line shows. */
  const listDrop = (kind: Kind, areaId?: string) => ({
    onDragOver: (e: DragEvent) => {
      const drag = dragging.current;
      if (drag?.kind !== kind) return;
      e.stopPropagation();
      if (kind === "project" && areaId) {
        if (dropArea !== areaId) setDropAt(null);
        setDropArea(areaId);
      }
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    },
    onDragLeave: (e: DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) { setDropAt(null); setDropArea(null); }
    },
    onDrop: (e: DragEvent) => {
      const drag = dragging.current;
      if (kind === "project" && areaId) { dropProjects(e, areaId); return; }
      if (drag?.kind !== kind) return;
      e.stopPropagation();
      e.preventDefault();
      dragging.current = null;
      setDrag(null);
      setDropAt(null);
      if (!dropAt) return;
      if (kind === "project" && !drag.ids.every((id) => projects.find((p) => p.id === id)?.areaId === areaId)) return;
      const before = kind === "area" ? idsOf(kind) : projects.map((p) => p.id);
      if (!before.includes(dropAt.id)) return;
      const ids = moveIds(before, drag.ids, dropAt);
      if (ids.join("\n") === before.join("\n")) return;
      if (kind === "area") {
        saveAreaOrder(ids);
      } else {
        run(() => {
          showProjects(ids.map((id) => projects.find((p) => p.id === id)!));
          return reorderProjectsAction(ids);
        });
      }
    },
  });

  const rowState = (kind: Kind, id: string) => ({
    open: (menu?.kind === kind && menu.id === id) || (bulk?.kind === kind && bulk.from === id),
    selected: isSelected(kind, id),
    dragged: drag?.kind === kind && drag.ids.includes(id),
    drop: drag?.kind === kind && dropAt?.id === id ? (dropAt.after ? "after" as const : "before" as const) : null,
    onClose: closeMenu,
    onMenu: (anchor: Anchor) => openMenu(kind, id, anchor),
    onSelect: (range: boolean) => select(kind, id, range),
  });

  const saveAreaOrder = (ids: string[]) => {
    run(() => {
      showAreas(ids.map((id) => areas.find((a) => a.id === id)!));
      return reorderAreasAction(ids);
    });
  };
  const moveArea = (id: string, direction: -1 | 1) => {
    const ids = idsOf("area");
    const i = ids.indexOf(id);
    if (i < 0 || i + direction < 0 || i + direction >= ids.length) return;
    saveAreaOrder(moveIds(ids, [id], { id: ids[i + direction], after: direction === 1 }));
  };
  const newProject = (areaId: string) => {
    setCollapsed((c) => ({ ...c, [areaId]: false }));
    setDraft({ kind: "project", areaId });
  };
  const createArea = (name: string) => {
    setDraft(null);
    run(() => createAreaAction({ name, color: nextColor(areas.map((a) => a.color)) }));
  };
  const createProject = (name: string, areaId: string) => {
    setDraft(null);
    run(async () => {
      const r = await createProjectAction({ name, areaId });
      if (r.ok && r.id) router.push(`/project/${r.id}`);
      return r;
    });
  };

  const menuArea = menu?.kind === "area" ? areas.find((a) => a.id === menu.id) : undefined;
  const menuProject = menu?.kind === "project" ? projects.find((p) => p.id === menu.id) : undefined;

  // Dragging the right edge sets the width; let go far enough left of the narrowest and it hides instead.
  const startResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    const x0 = e.clientX, w0 = layout.width;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => setDragWidth(clampWidth(w0 + ev.clientX - x0));
    const up = (ev: PointerEvent) => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      const w = w0 + ev.clientX - x0;
      setSidebarLayout(w < SIDEBAR_MIN - 80 ? { hidden: true } : { width: clampWidth(w) });
      setDragWidth(null);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  return (
    <>
      {drawer && <div aria-hidden className="fixed inset-0 z-40 bg-overlay md:hidden" onClick={() => setDrawer(false)} />}
      {/* Takes the sidebar's room beside the page, or, hidden, a strip at the window's edge that brings it out. On a phone it isn't there. */}
      <div className="relative shrink-0 max-md:contents" style={{ width: layout.hidden ? 8 : width }}
        onMouseEnter={() => { if (layout.hidden) setPeek(true); }}
        // Out of the strip and the sidebar over the page, a peek goes back, unless one of its menus is open.
        onMouseLeave={() => { if (!menu && !bulk) setPeek(false); }}>
      <nav ref={nav} aria-label={tx("Main")}
        // A link opens its page and ends the selection; on a phone the panel gets out of the way. A click with
        // Ctrl, ⌘ or Shift selected a row instead.
        onClick={(e) => {
          if (e.ctrlKey || e.metaKey || e.shiftKey || !(e.target as HTMLElement).closest("a")) return;
          setDrawer(false);
          setPeek(false);
          setSelection(null);
        }}
        style={{ "--sidebar-w": `${width}px` } as CSSProperties}
        className={cx("flex h-full w-[var(--sidebar-w)] shrink-0 flex-col gap-[18px] overflow-y-auto px-2.5 py-3",
          "max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-50 max-md:w-[280px] max-md:border-r max-md:border-line max-md:bg-bg max-md:transition-[transform,visibility] max-md:duration-200",
          !drawer && "max-md:invisible max-md:-translate-x-full",
          layout.hidden && "md:absolute md:inset-y-0 md:left-0 md:z-50 md:rounded-r-[10px] md:border md:border-l-0 md:border-line md:bg-bg md:shadow-[var(--shadow-popover)] md:transition-[transform,visibility] md:duration-150",
          layout.hidden && !peek && "md:invisible md:-translate-x-full")}>
        <div className="flex items-center gap-1.5">
          <button type="button" onClick={() => { setDrawer(false); window.dispatchEvent(new CustomEvent("organizer:palette")); }} aria-label={tx("Search (Ctrl+K)")} title={tx("Search (Ctrl+K)")}
            className="flex h-[30px] flex-1 items-center gap-2 rounded-md px-2 text-mut hover:bg-hover">
            <Icon name="search" size={14} />
            <span className="text-[12px]">{tx("Search")}</span>
            <kbd className="ml-auto text-[10px] text-dim max-md:hidden">Ctrl K</kbd>
          </button>
          <button type="button" onClick={() => { setDrawer(false); openQuickAdd(); }} aria-label={tx("New task (C)")} title={tx("New task (C)")}
            className="flex h-[30px] w-[30px] items-center justify-center rounded-md border border-line2 bg-raised text-fg2 hover:bg-hover">
            <Icon name="pen" size={15} />
          </button>
        </div>

        <div className="flex flex-col gap-px">
          {NAV(tx).map((n) => (
            <Link key={n.href} href={n.href} className={cx(item, active(n.href) && "bg-sel text-strong")}>
              <Icon name={n.icon} />
              <span className="flex-1">{n.label}</span>
              {n.count && counts[n.count] > 0 && <span className="text-[11.5px] text-mut2">{counts[n.count]}</span>}
            </Link>
          ))}
        </div>

        <div className="flex flex-col gap-px" {...listDrop("area")}>
          <SectionHeader label={tx("Areas & projects")} addLabel={tx("New area")} onAdd={() => setDraft({ kind: "area" })} />
          {areas.map((a, index) => {
            const list = projects.filter((p) => p.areaId === a.id);
            const shut = collapsed[a.id];
            const state = rowState("area", a.id);
            return (
              <section key={a.id} aria-label={tx("{0} projects", [a.name])}
                className={cx("relative pb-1", index > 0 && "mt-1 border-t border-line pt-2", state.dragged && "opacity-40", dropArea === a.id && "rounded-md bg-accent/10 ring-1 ring-inset ring-accent/40")}
                onDrop={(e) => dropProjects(e, a.id)} onDragOver={(e) => rowDrag("area", a.id).onDragOver(e)}>
                {renaming === `area:${a.id}` ? (
                  <div className={cx(editing, "pl-6")}>
                    <AreaDot area={a} />
                    <InlineName initial={a.name} placeholder={tx("Area name")} onCancel={() => setRenaming(null)}
                      onSave={(name) => { setRenaming(null); run(() => updateAreaAction(a.id, { name })); }} />
                  </div>
                ) : (
                  <MenuRow href={`/area/${a.id}`} active={path === `/area/${a.id}`} label={a.name} {...state} drag={rowDrag("area", a.id)} drop={null} dragged={false}
                    group={{ expanded: !shut, onToggle: () => setCollapsed((c) => ({ ...c, [a.id]: !shut })), onAdd: () => newProject(a.id) }}>
                    <AreaDot area={a} />
                    <span className="flex-1 truncate">{a.name}</span>
                  </MenuRow>
                )}
                {!shut && <div className="ml-7 flex flex-col gap-px border-l border-line pl-2" {...listDrop("project", a.id)}>
                  {/* The area's own tasks, outside its projects: small things like replying to an email or logging hours. */}
                  <Link href={`/area/${a.id}/todos`} title={tx("Tasks in {0} outside its projects", [a.name])}
                    className={cx(item, active(`/area/${a.id}/todos`) && "bg-sel text-strong")}>
                    <Icon name="check" size={15} className="shrink-0 text-mut2" />
                    <span className="flex-1 truncate">{tx("To-dos")}</span>
                    {(usage.areas[a.id]?.loose ?? 0) > 0 && <span className="text-[11.5px] text-mut2">{usage.areas[a.id].loose}</span>}
                  </Link>
                  {list.map((p) => renaming === `project:${p.id}` ? (
                    <div key={p.id} className={editing}>
                      <ProgressRing pct={usage.projects[p.id]?.pct ?? 0} color={projectColor(p, areas)} size={16} />
                      <InlineName initial={p.name} placeholder={tx("Project name")} onCancel={() => setRenaming(null)}
                        onSave={(name) => { setRenaming(null); run(() => updateProjectAction(p.id, { name })); }} />
                    </div>
                  ) : (
                    <MenuRow key={p.id} href={`/project/${p.id}`} active={active(`/project/${p.id}`)} label={p.name} {...rowState("project", p.id)} drag={rowDrag("project", p.id)}
                      trailing={p.targetDate && <span className="text-[11.5px] text-mut2">{fmtShort(p.targetDate, tx.language)}</span>}>
                      <ProgressRing pct={usage.projects[p.id]?.pct ?? 0} color={projectColor(p, areas)} size={16} />
                      <span className="flex-1 truncate">{p.name}</span>
                    </MenuRow>
                  ))}
                  {draft?.kind === "project" && draft.areaId === a.id ? (
                    <div className={editing}>
                      <ProgressRing pct={0} color={a.color} size={16} />
                      <InlineName initial="" placeholder={tx("Project in {0}", [a.name])} onCancel={() => setDraft(null)}
                        onSave={(name) => createProject(name, a.id)} />
                    </div>
                  ) : !list.length && (
                    <button type="button" onClick={() => newProject(a.id)} className={cx(item, "text-[12px] text-mut2")}>
                      <Icon name="plus" size={13} />{tx("New project")}</button>
                  )}
                </div>}
                {state.drop && <span aria-hidden className={cx("pointer-events-none absolute inset-x-1 h-0.5 rounded-full bg-accent", state.drop === "before" ? "-top-px" : "-bottom-px")} />}
              </section>
            );
          })}
          {draft?.kind === "area" ? (
            <div className={editing}>
              <AreaDot area={{ id: "new", color: nextColor(areas.map((a) => a.color)), icon: null, picture: null }} />
              <InlineName initial="" placeholder={tx("Area name")} onSave={createArea} onCancel={() => setDraft(null)} />
            </div>
          ) : !areas.length && (
            <button type="button" onClick={() => setDraft({ kind: "area" })} className={cx(item, "text-mut")}>
              <Icon name="plus" size={14} />{tx("New area")}</button>
          )}
        </div>

        <div className="flex-1" />
        <div className="flex items-center gap-1.5">
          <Link href="/settings" className={cx(item, "flex-1 text-mut", active("/settings") && "bg-sel text-strong")}>
            <Icon name="settings" />
            <span className="flex-1">{tx("Settings")}</span>
          </Link>
          <ThemeToggle />
        </div>

        {menuArea && menu && (
          <AreaMenu area={menuArea} anchor={menu.anchor} usage={usage} desktop={desktop} onClose={closeMenu}
            onRename={() => setRenaming(`area:${menuArea.id}`)} onNewProject={() => newProject(menuArea.id)}
            onMoveUp={areas[0]?.id !== menuArea.id ? () => moveArea(menuArea.id, -1) : undefined}
            onMoveDown={areas.at(-1)?.id !== menuArea.id ? () => moveArea(menuArea.id, 1) : undefined} />
        )}
        {bulk?.kind === "area" && (
          <AreasMenu areas={areas.filter((a) => bulk.ids.includes(a.id))} anchor={bulk.anchor} usage={usage} onClose={closeMenu}
            onDeleted={() => setSelection(null)} />
        )}
        {bulk?.kind === "project" && (
          <ProjectsMenu projects={projects.filter((p) => bulk.ids.includes(p.id))} areas={areas} anchor={bulk.anchor} usage={usage}
            onClose={closeMenu} onDeleted={() => setSelection(null)} />
        )}
        {menuProject && menu && (
          <ProjectMenu project={menuProject} projects={projects} areas={areas} anchor={menu.anchor} usage={usage} onClose={closeMenu}
            onRename={() => setRenaming(`project:${menuProject.id}`)} />
        )}
      </nav>
      {!layout.hidden && (
        <div role="separator" aria-orientation="vertical" aria-label={tx("Sidebar width")} aria-valuenow={width} tabIndex={0}
          title={tx("Drag to resize, double-click to reset. Ctrl+B hides the sidebar.")}
          onPointerDown={startResize} onDoubleClick={() => setSidebarLayout({ width: SIDEBAR_DEFAULT })}
          onKeyDown={(e) => {
            const step = e.key === "ArrowLeft" ? -16 : e.key === "ArrowRight" ? 16 : 0;
            if (step) { e.preventDefault(); setSidebarLayout({ width: clampWidth(width + step) }); }
          }}
          className="group absolute inset-y-0 -right-1 z-10 flex w-2 cursor-col-resize justify-center outline-none max-md:hidden">
          <span className={cx("h-full w-0.5 rounded-full transition-colors group-hover:bg-line2 group-focus-visible:bg-line2", dragWidth !== null && "bg-line2")} />
        </div>
      )}
      </div>
    </>
  );
}
