"use client";
import { useTranslation } from "@/components/language";
import { createTranslator, type Translator } from "@/lib/i18n";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { differenceInCalendarDays } from "date-fns";
import { dismissImportAction, findWorkAction, importProjectsAction } from "@/app/actions";
import type { FoundArea, FoundProject, ImportSource } from "@/server/import";
import type { AgentId, Area } from "@/lib/types";
import { AgentIcon, AreaMark, Icon } from "./icons";
import { Button, Menu, cx, useAction } from "./ui";

const SOURCE_LABEL = (tx: Translator): Record<ImportSource, string> => ({
  "claude-app": tx("Claude app"), "claude-cli": tx("Claude Code CLI"), "codex-app": tx("Codex app"), "codex-cli": tx("Codex CLI"),
});

const HOW_LABEL = (tx: Translator): Record<NonNullable<FoundArea["joins"]>["how"], string> => ({
  marker: "pacedmind.md", repo: tx("repository"), projects: tx("its projects"), name: tx("same name"),
});

/** An area folder's choice: a new area, taken as one project, or (any other value) the id of an area you have. */
const NEW = "new";
const ONE = "one";

/** "today", "yesterday", "5 days ago", "3 months ago", in calendar days. */
function ago(ms: number, now: number, tx: Translator = createTranslator("en")): string {
  const days = differenceInCalendarDays(now, ms);
  if (days < 1) return tx("today");
  if (days < 2) return tx("yesterday");
  if (days < 31) return tx("{0} days ago", [days]);
  const months = Math.round(days / 30.4);
  return months < 12 ? tx("{0} month{1} ago", [months, months > 1 ? "s" : ""]) : tx("over a year ago");
}

/** When anything last happened there: an agent's session, or git's own files. */
const lastOf = (p: FoundProject) => Math.max(p.touched, ...Object.values(p.used).map((v) => v ?? 0));

/** The agent a project should start with: the one that worked there last. */
function lastAgent(p: FoundProject): AgentId | null {
  const c = p.used.claude;
  const x = p.used.codex;
  if (c === undefined) return x === undefined ? null : "codex";
  if (x === undefined) return "claude";
  return x > c ? "codex" : "claude";
}

/** The area imported projects go to at first: one that already holds code projects, else one that sounds like it. */
function defaultArea(areas: Area[]): string {
  return (areas.find((a) => /dev|code|project|build/i.test(a.name)) ?? areas[0])?.id ?? "";
}

function Check({ on, off, label, onClick }: { on: boolean; off?: boolean; label: string; onClick: () => void }) {
  return (
    <button type="button" role="checkbox" aria-checked={on} disabled={off} aria-label={label} onClick={onClick}
      className={cx("flex h-4 w-4 shrink-0 items-center justify-center rounded border-[1.5px]",
        on ? "border-accent bg-accent" : off ? "border-line" : "border-line-strong")}>
      {on && <Icon name="check" size={11} strokeWidth={3} className="text-white" />}
    </button>
  );
}

/** A found folder's name you can change before it becomes a new project or area. */
function NameField({ value, label, onChange }: { value: string; label: string; onChange: (v: string) => void }) {
  return (
    <input value={value} aria-label={label} onChange={(e) => onChange(e.target.value)}
      className="-mx-1 h-[22px] min-w-0 flex-1 rounded bg-transparent px-1 text-[13px] text-fg outline-none hover:bg-input focus:bg-input" />
  );
}

/**
 * Brings what you work on with Claude Code and Codex on this computer over: a folder of repositories as an area (a new
 * one, or one you have, as its workspace here), the repositories in it as its projects, and the other folders you work
 * in as projects. What you have on your other computers joins what it is. Opens by itself the first time PacedMind
 * starts (`auto`, only when it finds something), and from Settings.
 */
export function ImportProjects({ areas, auto = false, onClose }: { areas: Area[]; auto?: boolean; onClose: () => void }) {
  const tx = useTranslation();
  const { run, pending } = useAction();
  const [found, setFound] = useState<{ projects: FoundProject[]; areas: FoundArea[] } | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [names, setNames] = useState<Record<string, string>>({});
  // Folders that could join a project you have but should become projects of their own.
  const [apart, setApart] = useState<Set<string>>(new Set());
  // Area folders to set up, what each becomes (NEW, ONE or an area's id), and the names of new ones.
  const [boxOn, setBoxOn] = useState<Set<string>>(new Set());
  const [target, setTarget] = useState<Record<string, string>>({});
  const [boxNames, setBoxNames] = useState<Record<string, string>>({});
  const [areaId, setAreaId] = useState(() => defaultArea(areas));
  const [now] = useState(() => Date.now());
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; });

  // Looks once when it opens; pages refreshing behind it don't start over.
  useEffect(() => {
    let live = true;
    findWorkAction().then((work) => {
      if (!live) return;
      const open = work.projects.filter((p) => !p.projectId && !p.problem);
      const boxes = work.areas.filter((b) => !b.areaId && !b.problem);
      // Nothing to bring over: the first-start offer quietly goes away.
      if (auto && !open.length && !boxes.length) {
        void dismissImportAction();
        closeRef.current();
        return;
      }
      setFound(work);
      setPicked(new Set(work.projects.filter((p) => p.suggested).map((p) => p.folder)));
      setBoxOn(new Set(boxes.filter((b) => b.suggested).map((b) => b.folder)));
      setTarget(Object.fromEntries(work.areas.map((b) => [b.folder, b.joins?.id ?? NEW])));
    }, () => {
      if (live && auto) closeRef.current();
    });
    return () => { live = false; };
  }, [auto]);

  const close = () => {
    if (auto) void dismissImportAction();
    onClose();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (auto && !found) return null;
  const flip = (set: typeof setPicked, folder: string) =>
    set((s) => {
      const next = new Set(s);
      if (next.has(folder)) next.delete(folder);
      else next.add(folder);
      return next;
    });

  const boxes = found?.areas ?? [];
  const projects = found?.projects ?? [];
  const isOne = (b: FoundArea) => !b.areaId && target[b.folder] === ONE;
  // An area folder whose projects go to its area: one already set up here, or one picked as an area.
  const active = (b: FoundArea) => !!b.areaId || (boxOn.has(b.folder) && !isOne(b));
  const boxOf = (p: FoundProject) => (p.area ? boxes.find((b) => b.folder === p.area) : undefined);
  // The projects in a folder taken as one project are part of it.
  const shown = projects.filter((p) => { const b = boxOf(p); return !(b && boxOn.has(b.folder) && isOne(b)); });
  const available = shown.filter((p) => !p.projectId && !p.problem);
  const joining = (p: FoundProject) => !!p.joins && !apart.has(p.folder);
  const pickedProjects = available.filter((p) => picked.has(p.folder));
  const pickedBoxes = boxes.filter((b) => !b.areaId && !b.problem && boxOn.has(b.folder));
  const newAreas = pickedBoxes.filter((b) => !isOne(b) && target[b.folder] === NEW).length;
  const spaces = pickedBoxes.filter((b) => !isOne(b) && target[b.folder] !== NEW).length;
  const ones = pickedBoxes.filter(isOne);
  const projectCount = pickedProjects.length + ones.length;
  // New projects outside a picked area go to the area chosen at the bottom.
  const needsArea = pickedProjects.some((p) => !joining(p) && !(boxOf(p) && active(boxOf(p)!))) || ones.some((b) => !b.asProject);
  const area = areas.find((a) => a.id === areaId);

  const submit = () => {
    const items = [
      ...pickedProjects.map((p) => ({
        folder: p.folder, name: (names[p.folder] ?? p.name).trim() || p.name, agent: lastAgent(p), projectId: joining(p) ? p.joins!.id : null,
        area: boxOf(p) && active(boxOf(p)!) ? p.area : null,
      })),
      ...ones.map((b) => ({ folder: b.folder, name: (boxNames[b.folder] ?? b.name).trim() || b.name, agent: null, projectId: b.asProject?.id ?? null, area: null })),
    ];
    const areaItems = pickedBoxes.filter((b) => !isOne(b)).map((b) => ({
      folder: b.folder, name: (boxNames[b.folder] ?? b.name).trim() || b.name, areaId: target[b.folder] === NEW ? null : target[b.folder],
    }));
    run(async () => {
      const r = await importProjectsAction(items, areaId, areaItems);
      if (r.ok) onClose();
      return r;
    });
  };

  const projectRow = (p: FoundProject, indent: boolean) => {
    const taken = !!p.projectId;
    const off = taken || !!p.problem;
    const on = !off && picked.has(p.folder);
    const last = lastOf(p);
    const agents = (["claude", "codex"] as AgentId[]).filter((a) => p.used[a] !== undefined);
    return (
      <div key={p.folder} className={cx("flex items-center gap-3 rounded-lg py-2 pr-3", indent ? "pl-9" : "pl-3", !off && "hover:bg-hover")}>
        <Check on={on} off={off} label={tx("Import {0}", [p.name])} onClick={() => flip(setPicked, p.folder)} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex min-w-0 items-center gap-2">
            {joining(p) ? (
              <span className={cx("truncate text-[13px]", on ? "text-fg" : "text-fg2")}>{p.joins!.name}</span>
            ) : on ? (
              <NameField value={names[p.folder] ?? p.name} label={tx("Name for {0}", [p.folder])} onChange={(v) => setNames((n) => ({ ...n, [p.folder]: v }))} />
            ) : (
              <span className={cx("truncate text-[13px]", off ? "text-mut2" : "text-fg2")}>{p.name}</span>
            )}
            {p.joins && !off && (
              <button type="button" onClick={() => flip(setApart, p.folder)}
                title={joining(p) ? tx("Your project {0} gets this folder here. Select to make a new project instead.", [p.joins.name]) : tx("Select to give this folder to your project {0} instead.", [p.joins.name])}
                className={cx("flex h-5 shrink-0 items-center gap-1 rounded border px-1.5 text-[11px]",
                  joining(p) ? "border-accent/50 text-accent-fg" : "border-line2 text-mut2 hover:text-fg3")}>
                <Icon name={joining(p) ? "link" : "plus"} size={11} />{joining(p) ? tx("Existing project") : tx("New project")}
              </button>
            )}
            {p.holds > 1 && <span className="shrink-0 text-[11px] text-mut2">{p.holds} {" "}{tx("repositories")}</span>}
            {p.copyOf && !off && <span title={tx("Another copy of the same repository")} className="shrink-0 text-[11px] text-mut2">{tx("copy of")}{" "}{p.copyOf}</span>}
          </div>
          <span title={p.folder} className="truncate font-mono text-[11px] text-mut2">{p.folder}</span>
        </div>
        <span title={p.sources.map((s) => tx(SOURCE_LABEL(tx)[s])).join(", ")} className="flex shrink-0 items-center gap-1.5 text-mut">
          {agents.map((a) => <AgentIcon key={a} agent={a} size={13} />)}
        </span>
        <span title={p.problem ?? undefined} className="w-[112px] shrink-0 text-right text-[12px] text-mut2 max-sm:w-[76px]">
          {taken ? tx("Already a project") : p.problem ? tx("Can't be used") : last ? ago(last, now, tx) : ""}
        </span>
      </div>
    );
  };

  const areaRow = (b: FoundArea) => {
    const linked = !!b.areaId;
    const on = linked || boxOn.has(b.folder);
    const t = target[b.folder] ?? NEW;
    const mine = linked ? areas.find((a) => a.id === b.areaId) : t !== NEW && t !== ONE ? areas.find((a) => a.id === t) : undefined;
    const choice: ReactNode = linked ? null : (
      <Menu width={230}
        trigger={
          <button type="button" className={cx("flex h-5 shrink-0 items-center gap-1 rounded border px-1.5 text-[11px]",
            t === NEW ? "border-line2 text-mut2 hover:text-fg3" : "border-accent/50 text-accent-fg")}>
            <Icon name={t === ONE ? "layers" : t === NEW ? "plus" : "link"} size={11} />
            {t === ONE ? (b.asProject ? tx("Project {0}", [b.asProject.name]) : tx("One project")) : t === NEW ? tx("New area") : tx("Existing area")}
            <Icon name="chevronDown" size={10} />
          </button>
        }
        items={[
          { value: NEW, label: tx("New area"), icon: <Icon name="plus" size={13} /> },
          ...areas.map((a) => ({ value: a.id, label: a.name, icon: <AreaMark area={a} size={13} />,
            hint: b.joins?.id === a.id ? tx(HOW_LABEL(tx)[b.joins.how]) : undefined })),
          { value: ONE, label: b.asProject ? tx("One project: {0}", [b.asProject.name]) : tx("One project, not an area"), icon: <Icon name="layers" size={13} /> },
        ]}
        onSelect={(v) => { setTarget((x) => ({ ...x, [b.folder]: v })); setBoxOn((s) => new Set(s).add(b.folder)); }} />
    );
    return (
      <div className="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-hover">
        <Check on={on} off={linked || !!b.problem} label={tx("Set up {0}", [b.name])} onClick={() => flip(setBoxOn, b.folder)} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex min-w-0 items-center gap-2">
            {mine ? <AreaMark area={mine} size={14} /> : <Icon name={t === ONE ? "layers" : "folder"} size={14} className="shrink-0 text-mut2" />}
            {mine ? (
              <span className={cx("truncate text-[13px] font-medium", on ? "text-fg" : "text-fg2")}>{mine.name}</span>
            ) : on && !linked ? (
              <NameField value={boxNames[b.folder] ?? b.name} label={tx("Name for {0}", [b.folder])} onChange={(v) => setBoxNames((n) => ({ ...n, [b.folder]: v }))} />
            ) : (
              <span className="truncate text-[13px] font-medium text-fg2">{b.name}</span>
            )}
            {choice}
            {linked && <span className="shrink-0 text-[11px] text-mut2">{tx("workspace here")}</span>}
          </div>
          <span title={b.folder} className="truncate font-mono text-[11px] text-mut2">{b.folder}</span>
        </div>
        <span title={b.problem ?? undefined} className="shrink-0 text-right text-[12px] text-mut2">
          {b.problem ? tx("Can't be used") : !linked && t !== NEW && t !== ONE && b.joins?.id === t ? tx(HOW_LABEL(tx)[b.joins.how]) : ""}
        </span>
      </div>
    );
  };

  const loose = shown.filter((p) => !boxOf(p));
  const joins = available.filter(joining).length;
  const parts = [newAreas && tx.count(newAreas, "area"), spaces && tx.count(spaces, "workspace"), projectCount && tx.count(projectCount, "project")].filter(Boolean);

  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-start justify-center bg-overlay px-4 pt-[9vh]" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div role="dialog" aria-modal="true" aria-label={tx("Bring your projects over")}
        className="flex max-h-[80vh] w-[720px] max-w-full flex-col overflow-hidden rounded-xl border border-line2 bg-raised shadow-[var(--shadow-popover)]">
        <div className="flex flex-col gap-1.5 border-b border-line px-6 pb-4 pt-5 max-sm:px-4">
          <div className="flex items-center gap-2">
            <AgentIcon agent="claude" size={15} className="text-fg3" />
            <AgentIcon agent="codex" size={15} className="text-fg3" />
            <h2 className="ml-1 text-[15px] font-semibold text-strong">{tx("Bring your projects over")}</h2>
          </div>
          <p className="text-[12.5px] leading-relaxed text-mut">
            {found
              ? available.length || boxes.some((b) => !b.areaId)
                ? <>
                  {tx("A folder of repositories becomes an area, and the repositories in it its projects.")}{joins > 0 && tx(" {0}: {1} {2} here.", [joins === 1 ? tx("One is a project you already have") : tx("{0} are projects you already have", [joins]), joins === 1 ? tx("it gets") : tx("they get"), joins === 1 ? tx("its folder") : tx("their folders")])}
                </>
                : tx("Everything you work on with Claude Code and Codex on this computer is already here.")
              : tx("Looking through your folders, Claude Code and Codex on this computer…")}
          </p>
        </div>

        <div className="min-h-[120px] flex-1 overflow-y-auto px-3 py-2">
          {boxes.map((b) => (
            <div key={b.folder} className="border-b border-line py-1 last:border-b-0">
              {areaRow(b)}
              {!(boxOn.has(b.folder) && isOne(b)) && shown.filter((p) => boxOf(p) === b).map((p) => projectRow(p, true))}
            </div>
          ))}
          {loose.length > 0 && boxes.length > 0 && <h3 className="px-3 pb-1 pt-3 text-[12px] font-medium text-mut2">{tx("Other folders")}</h3>}
          {loose.map((p) => projectRow(p, false))}
        </div>

        {/* On a narrow phone the buttons go to a line of their own, on the right. */}
        <div className="flex items-center gap-2 border-t border-line px-6 py-3.5 max-sm:flex-wrap max-sm:px-4">
          {needsArea && (
            <>
              <span className="whitespace-nowrap text-[12.5px] text-mut2">{boxes.length ? tx("Other projects to") : tx("Add to")}</span>
              <Menu width={200}
                trigger={
                  <button type="button" className="flex h-7 items-center gap-1.5 rounded-md border border-line2 px-2 text-[12.5px] text-fg2 hover:bg-hover">
                    {area && <AreaMark area={area} size={13} />}{area?.name ?? tx("Pick an area")}<Icon name="chevronDown" size={11} className="text-mut2" />
                  </button>
                }
                items={areas.map((a) => ({ value: a.id, label: a.name, icon: <AreaMark area={a} size={13} /> }))}
                onSelect={setAreaId} />
            </>
          )}
          <span className="flex-1" />
          <div className="ml-auto flex gap-2">
            <Button variant="ghost" onClick={close}>{auto ? tx("Not now") : tx("Cancel")}</Button>
            <Button variant="primary" disabled={pending || !parts.length || (needsArea && !areaId)} onClick={submit}>
              {parts.length ? tx("Add {0}", [parts.length > 1 ? tx("{0} and {1}", [parts.slice(0, -1).join(", "), parts[parts.length - 1]]) : parts[0]]) : tx("Add projects")}
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Offers the import once, the first time PacedMind opens. */
export function ImportOffer({ areas }: { areas: Area[] }) {
  const [open, setOpen] = useState(true);
  return open ? <ImportProjects areas={areas} auto onClose={() => setOpen(false)} /> : null;
}
