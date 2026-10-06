"use client";
import { useTranslation } from "@/components/language";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { linkFoundFolderAction, updateProjectAction } from "@/app/actions";
import { repoLink, type FoundFolder, type Project } from "@/lib/types";
import { useExecution } from "./execution-context";
import { Icon } from "./icons";
import { Button, IconButton, Menu, cx, useAction } from "./ui";

/** The system's folder dialog, in the desktop app; null in a browser (`npm run dev`) and in apps built before it. */
export const folderDialog = () => (typeof window === "undefined" ? null : window.pacedMindDesktop?.pickFolder ?? null);

const within = (folder: string, root: string) => {
  const norm = (p: string) => p.replace(/[\\/]+$/, "").toLowerCase();
  const f = norm(folder);
  const r = norm(root);
  return f === r || f.startsWith(`${r}\\`) || f.startsWith(`${r}/`);
};

/** Whether a folder is one PacedMind made for a task without one (in its data folder), not one of yours. */
export function usePacedMindFolder() {
  const root = useExecution().folders?.workspaces;
  return (folder: string | null | undefined) => !!root && !!folder && within(folder, root);
}

/** Where PacedMind makes the folder of a task without one (task-folder.ts), spelled like `root`. */
export const taskWorkspace = (root: string, key: string) => `${root}${root.includes("\\") ? "\\" : "/"}${key.toLowerCase()}`;

/** The last part of a path, for tight spots. */
export const folderName = (folder: string) => folder.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || folder;

/** The last two parts of a path ("…\Preseed\ChessV2"), which usually tell folders apart. */
export function shortFolder(folder: string): string {
  const sep = folder.includes("\\") ? "\\" : "/";
  const parts = folder.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts.length > 3 ? `…${sep}${parts.slice(-2).join(sep)}` : folder;
}

/**
 * A folder on this computer for a task, project or area. Clicking it opens the system's folder dialog (the desktop
 * app; a browser types the path instead). It says whose folder it is: its own, the one it inherits, or PacedMind's
 * (the empty folder made for a task that has none). `found`: copies of the project or area found on this computer
 * (folder-hints.ts), which `onUse` gives it in one click.
 */
export function FolderField({ label, value, inherited, own = "own", empty, emptyTitle, clear, found = [], foundFor, onUse, onChange, variant = "box", disabled }: {
  label: string;
  /** Its own folder, or null. */
  value: string | null;
  /** The folder it uses without its own, and whose ("project's"). */
  inherited?: { folder: string; from: string } | null;
  /** What its own folder is called next to it ("own" for a task's); empty for none. */
  own?: string;
  /** Without any folder, what its sessions get, in a few words, and in a sentence on hover. */
  empty: string;
  emptyTitle?: string;
  /** What removing its own folder does, for the × button ("Use the project's folder again"). */
  clear: string;
  found?: FoundFolder[];
  /** Whose copy `found` is, when not this field's ("Q4 planning"). */
  foundFor?: string;
  onUse?: (folder: string) => void;
  onChange: (folder: string | null) => void;
  variant?: "box" | "row";
  disabled?: boolean;
}) {
  const tx = useTranslation();
  const ours = usePacedMindFolder();
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState("");
  const shown = value ?? inherited?.folder ?? null;
  const tag = !shown ? null : ours(shown) ? tx("PacedMind's") : value ? own : inherited!.from;
  const choose = async () => {
    const dialog = folderDialog();
    if (!dialog) {
      setDraft(value ?? "");
      setTyping(true);
      return;
    }
    const picked = await dialog(shown ?? found[0]?.folder ?? null);
    if (picked && picked !== value) onChange(picked);
  };
  const finish = () => {
    setTyping(false);
    const next = draft.trim() || null;
    if (next !== value) onChange(next);
  };

  const box = variant === "box";
  const field = typing
    ? <input autoFocus value={draft} aria-label={label} placeholder={shown ?? tx("Absolute folder path")}
        onChange={(e) => setDraft(e.target.value)} onBlur={finish}
        onKeyDown={(e) => {
          if (e.key === "Enter") finish();
          if (e.key === "Escape") { e.stopPropagation(); setTyping(false); }
        }}
        className={cx("w-full min-w-0 rounded-md border border-ctl bg-input px-2 font-mono text-[11.5px] text-fg2 outline-none", box ? "h-8" : "h-7")} />
    : <div className={cx("flex min-w-0 items-center", box ? "h-8 rounded-md border border-ctl bg-input pr-1" : "h-7")}>
        <button type="button" onClick={choose} disabled={disabled} aria-label={label}
          title={tx("{0}\nClick to choose a folder", [shown ?? emptyTitle ?? empty])}
          className={cx("flex h-full min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left hover:bg-hover disabled:opacity-50", !box && "text-fg2")}>
          <Icon name="folder" size={14} className="shrink-0 text-mut" />
          {shown
            ? <Path folder={shown} className="text-fg2" />
            : <span className="min-w-0 truncate text-[12.5px] text-mut2">{empty}</span>}
          {tag && <span className="shrink-0 text-[11.5px] text-mut2">{tag}</span>}
          {box && <span className="ml-auto shrink-0 pl-2 text-[12px] text-mut">{tx("Choose…")}</span>}
        </button>
        {value && <IconButton label={clear} onClick={() => onChange(null)} disabled={disabled} className="shrink-0"><Icon name="x" size={13} /></IconButton>}
      </div>;

  return <div className="min-w-0">
    {field}
    {!value && !typing && found.length > 0 && onUse && <Found found={found} foundFor={foundFor} onUse={onUse} disabled={disabled} className={box ? "mt-1.5" : "px-2 pb-1"} />}
  </div>;
}

/**
 * A path that doesn't fit loses its start, not its end, which names the folder: right to left, with the path itself
 * isolated so its separators stay where they are.
 */
export function Path({ folder, className }: { folder: string; className?: string }) {
  return <span dir="rtl" className={cx("min-w-0 truncate text-left font-mono text-[11.5px]", className)}><bdi>{folder}</bdi></span>;
}

/** "Found on this computer: …\pacedmind · Use": copies of a project or area found here, one click to use one. */
export function Found({ found, foundFor, onUse, disabled, className }: {
  found: FoundFolder[]; foundFor?: string; onUse: (folder: string) => void; disabled?: boolean; className?: string;
}) {
  const tx = useTranslation();
  const [first, ...more] = found;
  const why = (f: FoundFolder) => f.how === "marker" ? tx("Its pacedmind.md names it")
    : f.how === "repo" ? tx("It holds {0}", [repoLink(f.repo)?.label ?? f.repo]) : f.how === "projects" ? tx("Its projects are this area's") : tx("It has the same name");
  return <div className={cx("flex min-w-0 items-center gap-1.5 text-[11.5px] text-mut2", className)}>
    <span className="shrink-0">{tx("Found here:")}</span>
    <span className="min-w-0 truncate font-mono text-fg3" title={tx("Found on this computer{0}: {1}\n{2}", [foundFor ? tx(" for {0}", [foundFor]) : "", first.folder, why(first)])}>
      {shortFolder(first.folder)}
    </span>
    {more.length > 0 && <Menu align="right" width={320} trigger={<button type="button" className="shrink-0 rounded px-1 hover:bg-hover hover:text-fg2">+{more.length}</button>}
      items={found.map((f) => ({ value: f.folder, label: <span className="font-mono text-[11.5px]" title={f.folder}>{f.folder}</span>, hint: f.how === "marker" ? "pacedmind.md" : f.how === "repo" ? "repository" : f.how === "projects" ? tx("its projects") : "name" }))}
      onSelect={onUse} />}
    <Button size="sm" disabled={disabled} onClick={() => onUse(first.folder)} className="shrink-0" title={why(first)}>{tx("Use")}</Button>
  </div>;
}

/**
 * Whether a project is on this computer, in its page's header (desktop app): its folder here, a copy found here to use
 * in one click, or none yet. A click chooses the folder in the system's dialog (a browser goes to Settings → Projects).
 */
export function ProjectFolderChip({ project, areaFolder }: { project: Pick<Project, "id" | "name" | "folder">; areaFolder: string | null }) {
  const tx = useTranslation();
  const { desktop, folders } = useExecution();
  const { pending, run } = useAction();
  const ours = usePacedMindFolder();
  const router = useRouter();
  if (!desktop) return null;
  const found = project.folder ? [] : folders?.projects[project.id] ?? [];
  const chip = "inline-flex h-7 max-w-[220px] items-center gap-1.5 rounded-md border border-ctl px-2.5 text-[12.5px] text-fg2 hover:bg-hover disabled:opacity-50";
  if (found.length) {
    return <button type="button" disabled={pending} className={chip} onClick={() => run(() => linkFoundFolderAction(project.id, found[0].folder))}
      title={tx("Found on this computer: {0}\nClick to use it for {1}", [found[0].folder, project.name])}>
      <Icon name="folder" size={13} className="shrink-0" /><span className="truncate @max-2xl:hidden">{tx("Found here · Use")}</span>
    </button>;
  }
  const choose = async () => {
    const dialog = folderDialog();
    if (!dialog) return router.push("/settings/projects");
    const picked = await dialog(project.folder ?? areaFolder);
    if (picked && picked !== project.folder) run(() => updateProjectAction(project.id, { folder: picked }), tx("Folder saved"));
  };
  const label = project.folder ? (ours(project.folder) ? tx("PacedMind's folder") : folderName(project.folder)) : areaFolder ? tx("Area's workspace") : tx("Not on this computer");
  return <button type="button" disabled={pending} className={chip} onClick={choose}
    title={tx("{0}\nClick to choose {1}'s folder", [project.folder ?? (areaFolder ? tx("No folder of its own: the area's workspace, {0}", [areaFolder]) : tx("No folder on this computer: each task gets its own PacedMind folder")), project.name])}>
    <Icon name="folder" size={13} className="shrink-0" /><span className={cx("truncate @max-2xl:hidden", !project.folder && "text-mut")}>{label}</span>
  </button>;
}
