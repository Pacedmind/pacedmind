"use client";

import { updateProjectAction } from "@/app/actions";
import type { Area, Project } from "@/lib/types";
import { projectColor } from "@/lib/colors";
import { useTranslation } from "./language";
import { Button, Dot, useAction } from "./ui";

export function HiddenProjectsSettings({ projects, areas }: { projects: Project[]; areas: Area[] }) {
  const tx = useTranslation();
  const { run, pending } = useAction();
  return <div className="rounded-lg border border-line2">
    <p className="border-b border-line px-3.5 py-3 text-[12.5px] leading-relaxed text-mut">
      {tx("Hidden projects and their tasks stay out of your views, search, planning and notifications. Their dates and history are kept.")}
    </p>
    {projects.length ? projects.map((project) => <div key={project.id} className="flex items-center gap-3 border-b border-line px-3.5 py-3 last:border-b-0">
      <Dot color={projectColor(project, areas)} size={7} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] text-fg">{project.name}</p>
        <p className="text-[12px] text-mut">{areas.find((a) => a.id === project.areaId)?.name}</p>
      </div>
      <Button size="sm" disabled={pending} onClick={() => run(() => updateProjectAction(project.id, { hidden: false }), tx("Project restored"))}>
        {tx("Restore project")}
      </Button>
    </div>) : <p className="px-3.5 py-6 text-[13px] text-mut">{tx("No hidden projects. Use Hide project in a project's menu to put it aside.")}</p>}
  </div>;
}
