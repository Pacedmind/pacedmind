import { getTranslation } from "@/server/i18n";
import { redirect } from "next/navigation";
import { AreaMark } from "@/components/icons";
import { RepoLink } from "@/components/repo-link";
import { TaskList } from "@/components/task-list";
import * as repo from "@/server/repo";
import { groupByStatus, taskContext } from "@/server/views";

export default async function AreaPage(props: PageProps<"/area/[id]">) {
  const tx = await getTranslation();
  const { id } = await props.params;
  const sp = await props.searchParams;
  const area = (await repo.listAreas()).find((a) => a.id === id);
  // Deleted (maybe just now, from its own menu): show the overview instead of a 404.
  if (!area) redirect("/projects");
  const tasks = await repo.listTasks({ areaId: id });
  return (
    <TaskList
      key={area.id}
      areaDetails={area}
      icon="layers"
      mark={area.picture || area.icon ? <AreaMark area={area} size={16} /> : undefined}
      title={area.name}
      subtitle={tx("{0} · {1} open", [area.key, tasks.filter((t) => t.status !== "done" && t.status !== "canceled").length])}
      groups={groupByStatus(tasks)}
      ctx={await taskContext(tasks)}
      initialKey={typeof sp.task === "string" ? sp.task : null}
      addDefaults={{ areaId: id }}
      headerRight={<RepoLink repo={area.repo} />}
      empty={tx("No tasks in {0} yet", [area.name])}
    />
  );
}
