"use client";
import { useTranslation } from "@/components/language";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type MouseEvent } from "react";
import { createAreaAction, createProjectAction, updateAreaAction, updateProjectAction } from "@/app/actions";
import { DateField } from "@/components/date-field";
import { AreaMenu, InlineName, MoreButton, ProjectMenu, type OpenMenu } from "@/components/entity-menu";
import { AreaMark, Icon, ProgressRing } from "@/components/icons";
import type { Anchor } from "@/components/popover";
import { Button, Menu, cx, useAction } from "@/components/ui";
import { nextColor, projectColor } from "@/lib/colors";
import { fmtShort } from "@/lib/dates";
import { AGENT_LABEL, type Area, type Project, type Usage } from "@/lib/types";
import { ViewHeader } from "./calendar-parts";

// On a phone: the name (its ring shows the progress), the target date and the menu.
const COLS = "grid grid-cols-[minmax(160px,1fr)_128px_56px_96px_96px_minmax(0,1fr)_24px] items-center gap-3 max-sm:grid-cols-[minmax(0,1fr)_auto_24px]";
const WIDE = "max-sm:hidden";

type Draft = { kind: "area" } | { kind: "project"; areaId: string } | null;

const atPointer = (e: MouseEvent): Anchor => ({ x: e.clientX, y: e.clientY });

export function ProjectsView({ areas, projects, usage, today, desktop }: {
  areas: Area[];
  projects: Project[];
  usage: Usage;
  today: string;
  desktop: boolean;
}) {
  const tx = useTranslation();
  const router = useRouter();
  const { run } = useAction();
  const [menu, setMenu] = useState<OpenMenu>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const closeMenu = () => setMenu(null);

  const startProject = (areaId: string) => {
    setCollapsed((c) => ({ ...c, [areaId]: false }));
    setDraft({ kind: "project", areaId });
  };
  const createProject = (name: string, areaId: string) => {
    setDraft(null);
    run(async () => {
      const r = await createProjectAction({ name, areaId });
      if (r.ok && r.id) router.push(`/project/${r.id}`);
      return r;
    });
  };
  const createArea = (name: string) => {
    setDraft(null);
    run(() => createAreaAction({ name, color: nextColor(areas.map((a) => a.color)) }));
  };

  const menuArea = menu?.kind === "area" ? areas.find((a) => a.id === menu.id) : undefined;
  const menuProject = menu?.kind === "project" ? projects.find((p) => p.id === menu.id) : undefined;

  return (
    <section aria-label={tx("Projects")} className="flex min-w-0 flex-1 flex-col">
      <ViewHeader icon="box" title={tx("Projects")} subtitle={`${tx.count(areas.length, "area")} · ${tx.count(projects.length, "project")}`}>
        <span className="flex-1" />
        <Button onClick={() => setDraft({ kind: "area" })}><Icon name="plus" size={13} />{tx("New area")}</Button>
        {areas.length > 0 && (
          <Menu align="right" width={200} onSelect={startProject}
            trigger={<Button><Icon name="plus" size={13} />{tx("New project")}</Button>}
            items={areas.map((a) => ({ value: a.id, label: a.name, icon: <AreaMark area={a} dot={8} /> }))} />
        )}
      </ViewHeader>

      {areas.length === 0 && draft?.kind !== "area" ? (
        <div className="flex flex-col items-center gap-3 px-8 py-24 text-center">
          <div className="text-[14px] text-fg2">{tx("No areas yet")}</div>
          <div className="max-w-sm text-[12.5px] leading-relaxed text-mut2">{tx("Areas group your projects and tasks, like Work, Personal or Health. Each one gets a key for its task numbers.")}</div>
          <Button variant="primary" onClick={() => setDraft({ kind: "area" })}><Icon name="plus" size={13} />{tx("New area")}</Button>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className={cx(COLS, "h-8 border-b border-line pl-5 pr-3 text-[11.5px] text-mut2")}>
            <span>{tx("Name")}</span><span className={WIDE}>{tx("Progress")}</span><span className={WIDE}>{tx("Open")}</span><span>{tx("Target")}</span>
            <span className={WIDE}>{tx("Agent")}</span><span className={WIDE}>{tx("Folder")}</span><span />
          </div>

          {areas.map((a) => {
            const au = usage.areas[a.id] ?? { projects: 0, tasks: 0, open: 0 };
            const list = projects.filter((p) => p.areaId === a.id);
            const shut = collapsed[a.id];
            return (
              <div key={a.id}>
                <div className="group flex h-[38px] items-center gap-2 border-b border-line bg-raised pl-5 pr-3"
                  onContextMenu={(e) => { e.preventDefault(); setMenu({ kind: "area", id: a.id, anchor: atPointer(e) }); }}>
                  <button type="button" aria-expanded={!shut} aria-label={shut ? tx("Expand {0}", [a.name]) : tx("Collapse {0}", [a.name])}
                    onClick={() => setCollapsed((c) => ({ ...c, [a.id]: !shut }))}
                    className="-ml-1 flex h-5 w-5 items-center justify-center rounded text-mut2 hover:bg-hover">
                    <Icon name={shut ? "chevronRight" : "chevronDown"} size={12} strokeWidth={2.4} />
                  </button>
                  <AreaMark area={a} dot={8} />
                  {renaming === `area:${a.id}` ? (
                    <InlineName initial={a.name} placeholder={tx("Area name")} className="max-w-60 flex-none" onCancel={() => setRenaming(null)}
                      onSave={(name) => { setRenaming(null); run(() => updateAreaAction(a.id, { name })); }} />
                  ) : (
                    <Link href={`/area/${a.id}`} className="truncate text-[13px] font-medium text-fg hover:text-strong">{a.name}</Link>
                  )}
                  <span className="font-mono text-[11px] text-mut2">{a.key}</span>
                  <span className="truncate text-[12px] text-mut2">
                    {tx.count(au.projects, "project")} · {tx("Open tasks: {0}", [au.open])}
                  </span>
                  <span className="flex-1" />
                  <button type="button" aria-label={tx("New project in {0}", [a.name])} title={tx("New project in {0}", [a.name])} onClick={() => startProject(a.id)}
                    className="flex h-6 w-6 items-center justify-center rounded text-mut opacity-0 hover:bg-hover hover:text-fg2 focus-visible:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100">
                    <Icon name="plus" size={13} strokeWidth={2} />
                  </button>
                  <MoreButton label={tx("{0} options", [a.name])} open={menu?.kind === "area" && menu.id === a.id} onClose={closeMenu} className="pointer-coarse:opacity-100"
                    onOpen={(anchor) => setMenu({ kind: "area", id: a.id, anchor })} />
                </div>

                {!shut && list.map((p) => {
                  const u = usage.projects[p.id] ?? { tasks: 0, open: 0, done: 0, pct: 0 };
                  const color = projectColor(p, areas);
                  const open = menu?.kind === "project" && menu.id === p.id;
                  const late = !!p.targetDate && p.targetDate < today && u.open > 0;
                  return (
                    <div key={p.id} className={cx("group border-b border-hover pl-5 pr-3 hover:bg-hover", open && "bg-hover")}
                      onContextMenu={(e) => { e.preventDefault(); setMenu({ kind: "project", id: p.id, anchor: atPointer(e) }); }}>
                      <div className={cx(COLS, "h-[42px]")}>
                        <div className="flex min-w-0 items-center gap-2.5 pl-6">
                          <ProgressRing pct={u.pct} color={color} size={16} />
                          {renaming === `project:${p.id}` ? (
                            <InlineName initial={p.name} placeholder={tx("Project name")} onCancel={() => setRenaming(null)}
                              onSave={(name) => { setRenaming(null); run(() => updateProjectAction(p.id, { name })); }} />
                          ) : (
                            <Link href={`/project/${p.id}`} className="truncate text-[13px] text-fg hover:text-strong">{p.name}</Link>
                          )}
                        </div>
                        <div className={cx("flex items-center gap-2", WIDE)}>
                          <span className="h-1 w-14 overflow-hidden rounded-full bg-track">
                            <span className="block h-full rounded-full" style={{ width: `${u.pct}%`, background: color }} />
                          </span>
                          <span className="text-[12px] text-mut">{u.pct}%</span>
                        </div>
                        <span className={cx("text-[12px] text-mut", WIDE)}>{u.open || "–"}</span>
                        <DateField value={p.targetDate} withTime={false}
                          onChange={(v) => run(() => updateProjectAction(p.id, { targetDate: v }))}
                          trigger={
                            <button type="button" aria-label={tx("Target date for {0}", [p.name])}
                              className={cx("h-6 rounded px-1.5 -ml-1.5 text-[12px] hover:bg-hover", late ? "text-danger" : p.targetDate ? "text-fg3" : "text-dim group-hover:text-mut2")}>
                              {p.targetDate ? fmtShort(p.targetDate, tx.language) : tx("Set date")}
                            </button>
                          } />
                        <span className={cx("truncate text-[12px] text-mut", WIDE)}>{p.agent ? tx(AGENT_LABEL[p.agent]) : "–"}</span>
                        <span className={cx("truncate font-mono text-[11px] text-mut2", WIDE)} title={p.folder ?? undefined}>{p.folder ?? "–"}</span>
                        <MoreButton label={tx("{0} options", [p.name])} open={open} onClose={closeMenu} className="pointer-coarse:opacity-100"
                          onOpen={(anchor) => setMenu({ kind: "project", id: p.id, anchor })} />
                      </div>
                    </div>
                  );
                })}

                {!shut && (draft?.kind === "project" && draft.areaId === a.id ? (
                  <div className="flex h-[42px] items-center gap-2.5 border-b border-hover bg-hover pl-11 pr-3">
                    <ProgressRing pct={0} color={a.color} size={16} />
                    <InlineName initial="" placeholder={tx("Project in {0}", [a.name])} className="max-w-80" onCancel={() => setDraft(null)}
                      onSave={(name) => createProject(name, a.id)} />
                  </div>
                ) : !list.length && (
                  <button type="button" onClick={() => startProject(a.id)}
                    className="flex h-[38px] w-full items-center gap-2 border-b border-hover pl-11 text-left text-[12.5px] text-mut2 hover:bg-hover hover:text-fg3">
                    <Icon name="plus" size={13} />{tx("New project in")}{" "}{a.name}
                  </button>
                ))}
              </div>
            );
          })}

          {draft?.kind === "area" && (
            <div className="flex h-[38px] items-center gap-2 border-b border-line bg-raised pl-11 pr-3">
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: nextColor(areas.map((a) => a.color)) }} />
              <InlineName initial="" placeholder={tx("Area name, like Work or Health")} className="max-w-80" onSave={createArea} onCancel={() => setDraft(null)} />
            </div>
          )}

          <p className="px-5 py-4 text-[12px] leading-relaxed text-mut2">
            {tx("Right-click an area or project, or use its")}<Icon name="more" size={13} className="inline-block align-[-2px]" /> {tx("menu, to rename it, change its color or delete it. Deleting keeps the tasks: a project's tasks stay in its area, an area's tasks move to the Inbox.")}</p>
        </div>
      )}

      {menuArea && menu && (
        <AreaMenu area={menuArea} anchor={menu.anchor} usage={usage} desktop={desktop} onClose={closeMenu}
          onRename={() => setRenaming(`area:${menuArea.id}`)} onNewProject={() => startProject(menuArea.id)} />
      )}
      {menuProject && menu && (
        <ProjectMenu project={menuProject} projects={projects} areas={areas} anchor={menu.anchor} usage={usage} onClose={closeMenu}
          onRename={() => setRenaming(`project:${menuProject.id}`)} />
      )}
    </section>
  );
}
