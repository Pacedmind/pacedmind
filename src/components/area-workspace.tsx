"use client";
import { useTranslation } from "@/components/language";

import { useState } from "react";
import { setAreaFolderAction } from "@/app/actions";
import { repoLink, type Area, type FoundFolder } from "@/lib/types";
import { useExecution } from "./execution-context";
import { FolderField } from "./folder-field";
import { useAction } from "./ui";

/**
 * An area's folder on this computer, which its tasks use unless their project or they have one, saved as it's chosen.
 * `found`: this computer's copies of the repository the area's workspace holds on your other computers (Area.repo),
 * offered along with what folder-hints.ts found. `bare` leaves out the heading (the area's details have their own).
 */
export function AreaWorkspace({ area, onSaved, found = [], bare = false }: { area: Area; onSaved?: () => void; found?: string[]; bare?: boolean }) {
  const tx = useTranslation();
  const hints = useExecution().folders?.areas[area.id] ?? [];
  const [folder, setFolder] = useState(area.folder);
  const { pending, run } = useAction();
  const link = repoLink(area.repo);
  const copies: FoundFolder[] = [...hints, ...found.filter((f) => !hints.some((h) => h.folder === f)).map((f) => ({ folder: f, repo: area.repo, how: "repo" as const }))];
  const save = (next: string | null) => {
    if (next === area.folder) return;
    setFolder(next);
    run(async () => {
      const result = await setAreaFolderAction(area.id, next);
      if (result.ok) onSaved?.();
      else setFolder(area.folder);
      return result;
    });
  };
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {!bare && <span className="flex min-w-0 items-baseline gap-2 text-[12px] text-fg2">
        {tx("Workspace for")}{area.name}
        {link && <a href={link.url} target="_blank" rel="noreferrer" className="min-w-0 truncate text-[11.5px] text-mut2 hover:text-fg2">{link.label}</a>}
      </span>}
      <FolderField label={tx("Workspace for {0}", [area.name])} value={folder} own="" empty={tx("PacedMind's folder per task")} emptyTitle="No folder: PacedMind makes an empty folder for each task, in its data folder"
        clear="Remove the workspace" found={copies} onUse={save} onChange={save} disabled={pending} />
    </div>
  );
}
