import { TaskList } from "@/components/task-list";
import * as repo from "@/server/repo";
import { groupByStatus, isOpen, taskContext } from "@/server/views";

export default async function InboxPage(props: PageProps<"/inbox">) {
  const sp = await props.searchParams;
  // A note can link back to a completed task that is normally absent from the inbox.
  const tasks = (await repo.listTasks({ areaId: null, projectId: null })).filter((t) => isOpen(t) || t.key === sp.task);
  return (
    <TaskList
      icon="inbox"
      title="Inbox"
      subtitle="Tasks without an area or project"
      groups={groupByStatus(tasks)}
      ctx={await taskContext(tasks)}
      initialKey={typeof sp.task === "string" ? sp.task : null}
      empty="Your inbox is clear"
    />
  );
}
