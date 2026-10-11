import { getTranslation } from "@/server/i18n";
import { Roadmap, type RoadmapItem } from "@/components/views/roadmap";
import * as repo from "@/server/repo";
import { taskContext } from "@/server/views";
import { deviceConfig } from "@/server/device";
import { MODE } from "@/server/supabase";
import { latestSessions, projectStats, taskStates } from "@/server/timeline";
import { addDaysStr, mondayOf, toDateStr, toStamp } from "@/lib/dates";
import type { Task } from "@/lib/types";
import { terminalFor } from "@/lib/terminals";

/** The project timeline shows 14 weeks, starting on the Monday two weeks ago. */
const WEEKS = 14;

export default async function RoadmapPage(props: PageProps<"/roadmap">) {
  const tx = await getTranslation();
  const sp = await props.searchParams;
  const now = new Date();
  const [projects, tasks, edges, all, areas] = await Promise.all([
    repo.listProjects(), repo.listTasks(), repo.listEdges(), repo.listSessions(), repo.listAreas(),
  ]);
  const sessions = latestSessions(all);

  // Without one in the address, the first project with open tasks.
  const busy = projects.find((p) => tasks.some((t) => t.projectId === p.id && t.status !== "done" && t.status !== "canceled"));
  const project = projects.find((p) => p.id === sp.p) ?? busy ?? projects[0] ?? null;
  const own = project ? tasks.filter((t) => t.projectId === project.id && t.status !== "canceled") : [];
  const states = await taskStates(tasks, sessions, edges, now);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const items: RoadmapItem[] = own.map((t) => {
    const before = edges
      .filter((e) => e.toTaskId === t.id)
      .map((e) => byId.get(e.fromTaskId))
      .filter((x): x is Task => !!x)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
    return {
      task: t, after: before.map((x) => x.key), state: states[t.id],
      session: sessions[t.id] ?? null,
    };
  });

  return (
    <Roadmap
      from={addDaysStr(toDateStr(mondayOf(now)), -14)}
      days={WEEKS * 7}
      now={toStamp(now)}
      areas={areas}
      projects={projects}
      stats={projectStats(projects, tasks)}
      selectedId={project?.id ?? null}
      items={items}
      terminal={MODE !== "desktop" ? tx("a terminal on your computer") : terminalFor(deviceConfig().terminal, process.platform).label}
      waiting={all.filter((s) => s.status === "finished").length}
      ctx={await taskContext(own)}
      initialKey={typeof sp.task === "string" ? sp.task : null}
    />
  );
}
