"use client";

import { updateAreaAction, updateProjectAction } from "@/app/actions";
import type { Area, Project } from "@/lib/types";
import { projectColor } from "@/lib/colors";
import { useTranslation } from "./language";
import { AreaMark } from "./icons";
import { Button, Dot, useAction } from "./ui";

export function HiddenProjectsSettings({ projects, areas }: { projects: Project[]; areas: Area[] }) {
  const tx = useTranslation();
  const { run, pending } = useAction();
  const hiddenAreas = areas.filter((a) => a.hidden);
  const hiddenAreaIds = new Set(hiddenAreas.map((a) => a.id));
  const hiddenProjects = projects.filter((p) => p.hidden && !hiddenAreaIds.has(p.areaId));
  return <div className="rounded-lg border border-line2">
    <p className="border-b border-line px-3.5 py-3 text-[12.5px] leading-relaxed text-mut">
      {tx("Hidden areas, projects and their contents stay out of your views, search, planning and notifications. Their dates and history are kept.")}
    </p>
    {hiddenAreas.map((area) => <div key={area.id} className="flex items-center gap-3 border-b border-line px-3.5 py-3 last:border-b-0">
      <AreaMark area={area} dot={7} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] text-fg">{area.name}</p>
        <p className="text-[12px] text-mut">{tx("Area with its projects, to-dos and calendar activities")}</p>
      </div>
      <Button size="sm" disabled={pending} onClick={() => run(() => updateAreaAction(area.id, { hidden: false }), tx("Area restored"))}>
        {tx("Restore area")}
      </Button>
    </div>)}
    {hiddenProjects.map((project) => <div key={project.id} className="flex items-center gap-3 border-b border-line px-3.5 py-3 last:border-b-0">
      <Dot color={projectColor(project, areas)} size={7} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] text-fg">{project.name}</p>
        <p className="text-[12px] text-mut">{areas.find((a) => a.id === project.areaId)?.name}</p>
      </div>
      <Button size="sm" disabled={pending} onClick={() => run(() => updateProjectAction(project.id, { hidden: false }), tx("Project restored"))}>
        {tx("Restore project")}
      </Button>
    </div>)}
    {!hiddenAreas.length && !hiddenProjects.length && <p className="px-3.5 py-6 text-[13px] text-mut">{tx("Nothing hidden. Use Hide area or Hide project in its menu to put it aside.")}</p>}
    {hiddenAreas.length > 0 && <p className="border-t border-line px-3.5 py-3 text-[12px] text-mut">{tx("Restoring an area keeps individually hidden projects hidden. You can then restore them here separately.")}</p>}
  </div>;
}
