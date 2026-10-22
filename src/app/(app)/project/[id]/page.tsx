import { getTranslation } from "@/server/i18n";
import Link from "next/link";
import { redirect } from "next/navigation";
import { TaskList } from "@/components/task-list";
import { Icon } from "@/components/icons";
import { ProjectFolderChip } from "@/components/folder-field";
import { RepoLink } from "@/components/repo-link";
import * as repo from "@/server/repo";
import { groupByStatus, taskContext } from "@/server/views";
import { fmtShort } from "@/lib/dates";
import { NO_USE, addUse, agentUseShort, hasUse } from "@/lib/usage";

export default async function ProjectPage(props: PageProps<"/project/[id]">) {
  const tx = await getTranslation();
  const { id } = await props.params;
  const sp = await props.searchParams;
  const project = await repo.getProject(id);
  // Deleted (maybe just now, from its own menu): show the overview instead of a 404.
  if (!project || project.hidden) redirect("/projects");
  const [areas, tasks, areaTasks] = await Promise.all([repo.listAreas(), repo.listTasks({ projectId: id }), repo.listTasks({ areaId: project.areaId })]);
  // Tasks about the project without being part of it: they live in its area's To-dos and count nowhere here.
  const related = areaTasks.filter((t) => t.relatedProjectId === id && !t.projectId && t.status !== "canceled");
  const area = areas.find((a) => a.id === project.areaId);
  const link = "inline-flex h-7 items-center gap-1.5 rounded-md border border-ctl px-2.5 text-[12.5px] text-fg2 hover:bg-hover";
  const ctx = await taskContext([...tasks, ...related]);
  // What the agents used on the project's tasks, as they reported it.
  const use = Object.values(ctx.agentUse ?? {}).reduce(addUse, NO_USE);
  return (
    <TaskList
      icon="layers"
      title={project.name}
      subtitle={[area?.name, project.targetDate && tx("target {0}", [fmtShort(project.targetDate, tx.language)]), hasUse(use) && agentUseShort(use, tx.language)].filter(Boolean).join(" · ")}
      groups={[
        ...groupByStatus(tasks),
        ...(related.length ? [{
          id: "related", name: tx("Related"), folded: related.every((t) => t.status === "done"),
          tasks: related.sort((a, b) => Number(a.status === "done") - Number(b.status === "done") || a.sortOrder - b.sortOrder),
          add: { projectId: null, areaId: project.areaId, relatedProjectId: id },
        }] : []),
      ]}
      ctx={ctx}
      initialKey={typeof sp.task === "string" ? sp.task : null}
      addDefaults={{ projectId: id }}
      headerRight={
        // In a narrow list (a phone, or a task's details open), icons only: the title needs the room.
        <>
          <ProjectFolderChip project={project} areaFolder={area?.folder ?? null} />
          <RepoLink repo={project.repo ?? area?.repo} />
          <Link href={`/roadmap?p=${id}`} aria-label={tx("Roadmap")} className={link}><Icon name="roadmap" size={13} /><span className="@max-xl:hidden">{tx("Roadmap")}</span></Link>
        </>
      }
      empty={tx("No tasks in {0} yet", [project.name])}
    />
  );
}
