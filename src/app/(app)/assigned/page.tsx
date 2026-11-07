import { getTranslation } from "@/server/i18n";
import { TaskList } from "@/components/task-list";
import * as repo from "@/server/repo";
import { groupByStatus, isOpen, taskContext } from "@/server/views";

/** The open tasks assigned to you: your own and your team workspaces'. */
export default async function AssignedPage(props: PageProps<"/assigned">) {
  const tx = await getTranslation();
  const sp = await props.searchParams;
  const me = await repo.currentUserId();
  const tasks = me ? (await repo.listTasks({ assigneeId: me })).filter((t) => isOpen(t) || t.key === sp.task) : [];
  return (
    <TaskList
      icon="user"
      title={tx("Assigned to me")}
      subtitle={tx("Tasks assigned to you, in your own areas and your team workspaces")}
      groups={groupByStatus(tasks)}
      ctx={await taskContext(tasks)}
      initialKey={typeof sp.task === "string" ? sp.task : null}
      empty={tx("Nothing is assigned to you")}
    />
  );
}
