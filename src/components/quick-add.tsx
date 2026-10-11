"use client";
import { useTranslation } from "@/components/language";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { addMinutes} from "date-fns";
import { createEventAction, createTaskAction } from "@/app/actions";
import { parseQuickAdd } from "@/lib/parse";
import { hhmm, parseLocal, timeOf, toDateTimeStr, dateOnly } from "@/lib/dates";
import {
  APP_LABEL, CLOUD_LABEL, DOER_LABEL, PRIORITY_LABEL, STATUS_LABEL, agentOf, surfaceOf,
  type Area, type Doer, type Priority, type Project, type Status, type Surface,
} from "@/lib/types";
import { AgentIcon, AreaMark, Icon, PriorityIcon, StatusIcon, SurfaceIcon } from "./icons";
import { ComputerPicker, Issues, NeedsPicker, useComputerChoice, useExecutionIssues, useTaskDevice } from "./execution-context";
import { DateField } from "./date-field";
import { MarkdownEditor } from "./markdown-editor";
import { ModelChips, useModelProblem } from "./model-picker";
import type { ModelSelection } from "@/lib/agent-models";
import { Button, Menu, Segmented, Switch, cx, toast, useAction } from "./ui";

/**
 * What quick add starts with. `plannedDate` is the day it was opened for (a click on a day, say); `start`, when an
 * activity would begin, for a click that had a time as well (the week's grid).
 */
export type QuickAddDefaults = {
  deviceId?: string | null; agent?: Doer | null; runIn?: Surface | null;
  projectId?: string | null; areaId?: string | null; plannedDate?: string | null; mode?: "task" | "activity"; start?: string | null;
  /** A project the new task is about without being part of it (from its page's Related group). */
  relatedProjectId?: string | null;
};

// The project a page shows when its address doesn't say which (Roadmap picks one), while that page is open.
let shownProject: string | null = null;

/** Tells quick add opened without a place (C, the pen button, the command menu) which project this page shows. */
export function useQuickAddProject(id: string | null) {
  useEffect(() => {
    shownProject = id;
    return () => { if (shownProject === id) shownProject = null; };
  }, [id]);
}

const HIGHLIGHT: Record<string, string> = {
  date: "bg-accent/20 text-accent-fg",
  priority: "bg-accent/20 text-accent-fg",
  label: "bg-accent/20 text-accent-fg",
  project: "bg-accent/20 text-accent-fg",
  duration: "bg-ink/10 text-fg2",
  repeat: "bg-accent/20 text-accent-fg",
};

export function QuickAdd({ areas, projects }: { areas: Area[]; projects: Project[] }) {
  const tx = useTranslation();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"task" | "activity">("task");
  const [text, setText] = useState("");
  const [desc, setDesc] = useState("");
  // "Done when" items, one per line; null while the field is hidden.
  const [doneWhen, setDoneWhen] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [scroll, setScroll] = useState(0);
  const [defaults, setDefaults] = useState<QuickAddDefaults>({});
  const [ov, setOv] = useState<{
    areaId?: string | null; projectId?: string | null; status?: Status; priority?: Priority; due?: string | null; planned?: string | null; weekly?: boolean; duration?: number;
    agent?: Doer | null; runIn?: Surface | null; deviceId?: string | null; needs?: string[];
    modelSettings?: ModelSelection | null; modelProject?: string | null; related?: string | null;
  }>({});
  const input = useRef<HTMLInputElement>(null);
  const { pending, run } = useAction();
  const path = usePathname();

  useEffect(() => {
    // Opened without a place (C, the pen button, the command menu) on a project's or an area's page, or on a page that
    // shows one project (Roadmap), a task goes there.
    const [, page, id] = path.split("/");
    const here = (): QuickAddDefaults =>
      page === "project" && projects.some((p) => p.id === id) ? { projectId: id }
      : page === "area" && areas.some((a) => a.id === id) ? { areaId: id }
      : shownProject && projects.some((p) => p.id === shownProject) ? { projectId: shownProject }
      : {};
    const show = (e: Event) => {
      const d = ((e as CustomEvent).detail as QuickAddDefaults | null) ?? here();
      setDefaults(d);
      setMode(d.mode ?? "task");
      setOpen(true);
    };
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const typing = el.closest("input, textarea, select, [contenteditable=true]");
      if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === "c") {
        e.preventDefault();
        setDefaults(here());
        setMode("task");
        setOpen(true);
      }
    };
    window.addEventListener("organizer:new", show);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("organizer:new", show); window.removeEventListener("keydown", onKey); };
  }, [path, projects, areas]);

  useEffect(() => {
    if (open) setTimeout(() => input.current?.focus(), 0);
  }, [open, mode]);

  const parsed = useMemo(() => parseQuickAdd(text), [text]);
  const planned = ov.planned !== undefined ? ov.planned : (defaults.plannedDate ?? null);
  const related = ov.related !== undefined ? ov.related : (defaults.relatedProjectId ?? null);
  // A time typed without a day is on the planned day, when there is one: the day quick add was opened for, say.
  const typed = parsed.date && parsed.timeOnly && planned ? `${planned}T${timeOf(parsed.date)}` : parsed.date;
  const projectFromText = parsed.projectQuery
    ? projects.find((p) => p.id.startsWith(parsed.projectQuery!) || p.name.toLowerCase().startsWith(parsed.projectQuery!))
    : undefined;
  const projectId = ov.projectId !== undefined ? ov.projectId : (projectFromText?.id ?? defaults.projectId ?? null);
  const project = projects.find((p) => p.id === projectId) ?? null;
  const doer = ov.agent !== undefined ? ov.agent : defaults.agent ?? null;
  const deviceId = ov.deviceId !== undefined ? ov.deviceId : defaults.deviceId ?? null;
  const needs = ov.needs ?? [];
  const agent = agentOf({ agent: doer }, project?.agent);
  const runIn = agent ? (ov.runIn !== undefined ? ov.runIn : defaults.runIn ?? null) : null;
  const modelSettings = agent && ov.modelSettings?.agent === agent && ov.modelProject === projectId ? ov.modelSettings : null;
  const doerLabel = tx(DOER_LABEL[doer ?? agent!]);
  // Where its sessions go: the task's computer, else its project's, else the one PacedMind picks.
  const runsOn = deviceId ?? project?.deviceId ?? null;
  const { device } = useTaskDevice(runsOn, agent ?? "claude", needs);
  const place = runIn ?? surfaceOf(null, device?.checkedAt ? device.agents[agent ?? "claude"] : undefined);
  const chooseComputer = useComputerChoice(deviceId);
  const issues = [
    ...useExecutionIssues(runsOn, agent ?? "claude", runIn, needs),
    useModelProblem(agent ?? "claude", runsOn, needs, runIn, modelSettings),
  ];
  const areaId = ov.areaId !== undefined ? ov.areaId : (project?.areaId ?? defaults.areaId ?? null);
  const area = areas.find((a) => a.id === areaId) ?? null;
  const status = ov.status ?? "todo";
  const priority = ov.priority ?? parsed.priority ?? 0;
  const due = ov.due !== undefined ? ov.due : typed;
  const weekly = ov.weekly ?? parsed.weekly;
  const duration = ov.duration ?? parsed.durationMin ?? 60;
  // An activity starts at a typed time, else at When, else on the planned day: at the half hour clicked in the week's
  // grid, or at the next full hour. With none of these, it starts now.
  const start = mode !== "activity" ? null
    : typed && parsed.hasTime ? typed
    : ov.due !== undefined ? ov.due
    : !planned ? null
    : defaults.start && dateOnly(defaults.start) === planned ? defaults.start
    : `${planned}T${hhmm(Math.min(23, new Date().getHours() + 1) * 60)}`;

  // One item per line; list markers someone typed or pasted ("- ", "1. ") are dropped.
  const doneItems = (doneWhen ?? "").split("\n").map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim()).filter(Boolean);

  const close = () => {
    setOpen(false);
    setText("");
    setDesc("");
    setDoneWhen(null);
    setOv({});
  };

  const submit = () => {
    const title = parsed.title || text.trim();
    if (!title) { toast(tx("Give it a title first"), "error"); return; }
    if (mode === "task") {
      run(async () => {
        const r = await createTaskAction({
          title, description: desc, areaId, projectId, status, priority, dueDate: due, plannedDate: planned,
          relatedProjectId: projectId ? null : related,
          labels: parsed.labels, estimateMin: parsed.durationMin ?? undefined, doneWhen: doneItems,
          agent: doer, runIn, modelSettings, deviceId: agent ? deviceId : null, needs: agent ? needs : [],
        });
        if (r.ok) toast(tx("Created {0}", [r.key]));
        return r.ok ? undefined : r;
      });
    } else {
      const st = start ?? toDateTimeStr(new Date());
      const s = parseLocal(st);
      run(async () => {
        const r = await createEventAction({
          title, areaId, start: toDateTimeStr(s), end: toDateTimeStr(addMinutes(s, duration)), recurrence: weekly ? "weekly" : null,
        });
        if (r.ok) toast(tx("Added {0} to the calendar", [title]));
        return r.ok ? undefined : r;
      });
    }
    if (more) { setText(""); setDesc(""); setDoneWhen(null); setOv({}); input.current?.focus(); } else close();
  };

  if (!open) return null;

  const segments: { text: string; cls?: string }[] = [];
  let pos = 0;
  for (const t of parsed.tokens) {
    if (t.index < pos) continue;
    segments.push({ text: text.slice(pos, t.index) });
    segments.push({ text: text.slice(t.index, t.index + t.text.length), cls: HIGHLIGHT[t.kind] });
    pos = t.index + t.text.length;
  }
  segments.push({ text: text.slice(pos) });

  const summary = mode === "task"
    ? [due && tx("due {0}", [tx.date(parseLocal(due), timeOf(due) ? "EEE d MMM 'at' HH:mm" : "EEE d MMM")]),
      priority ? tx("{0} priority", [tx(PRIORITY_LABEL[priority]).toLowerCase()]) : null,
      parsed.labels.length ? tx("label {0}", [parsed.labels.join(", ")]) : null,
      project && tx("in {0}", [project.name]),
      parsed.durationMin && tx("about {0} min", [parsed.durationMin])].filter(Boolean).join(", ")
    : [start ? tx.date(parseLocal(start), "EEE d MMM, HH:mm") : tx("Starts now"), `${duration} min`, weekly && tx("repeats weekly")].filter(Boolean).join(", ");

  const chip = "flex h-7 items-center gap-1.5 rounded-md border border-ctl bg-hover px-2 text-[12.5px] text-fg3 hover:bg-sel";
  // For values that can be long (computer, servers, model): they shorten instead of taking the row.
  const wide = cx(chip, "max-w-[220px]");
  const placeLabel = (surface: Surface) => surface === "desktop" ? tx(APP_LABEL[agent!]) : surface === "cloud" ? tx("Cloud") : tx("Terminal");
  const found = "border-accent/45 bg-accent/10 text-accent-fg";

  return (
    <div className="fixed inset-0 z-50 flex justify-center bg-overlay pt-24 max-md:px-3 max-md:pt-3" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div role="dialog" aria-label={mode === "task" ? tx("New task") : tx("New activity")}
        className="flex h-fit max-h-[calc(100dvh-7rem)] w-[640px] max-w-full flex-col rounded-xl border border-line2 bg-raised shadow-[var(--shadow-popover)] max-md:max-h-[calc(100dvh-1.5rem)]"
        onKeyDown={(e) => {
          if (e.key === "Escape") close();
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); }
        }}>
        <div className="flex h-12 shrink-0 items-center gap-2 pl-4 pr-3">
          <Menu
            trigger={<button type="button" className={chip}>{area ? <AreaMark area={area} size={13} /> : <Icon name="inbox" size={13} />}{area?.name ?? tx("Inbox")}<Icon name="chevronDown" size={12} /></button>}
            items={[{ value: null as string | null, label: tx("Inbox, no area"), icon: <Icon name="inbox" size={13} /> },
              ...areas.map((a) => ({ value: a.id as string | null, label: a.name, icon: <AreaMark area={a} size={13} /> }))]}
            onSelect={(v) => setOv((o) => ({ ...o, areaId: v, projectId: project?.areaId !== v ? null : o.projectId }))}
          />
          <span className="text-faint">›</span>
          <span className="text-[12.5px] text-mut">{mode === "task" ? tx("New task") : tx("New activity")}</span>
          <span className="flex-1" />
          <Segmented value={mode} onChange={setMode} options={[{ value: "task", label: tx("Task") }, { value: "activity", label: tx("Activity") }]} />
          <button type="button" aria-label={tx("Close")} onClick={close} className="flex h-7 w-7 items-center justify-center rounded-md text-mut hover:bg-hover">
            <Icon name="x" size={15} />
          </button>
        </div>

        <div className="min-h-0 overflow-y-auto">
        <div className="flex flex-col gap-2 px-5 pb-4 pt-1.5">
          <div className="relative overflow-hidden">
            <div aria-hidden className="pointer-events-none absolute inset-0 whitespace-pre text-[18px] font-medium leading-7 text-strong" style={{ transform: `translateX(${-scroll}px)` }}>
              {segments.map((s, i) => <span key={i} className={cx(s.cls, s.cls && "rounded-[3px]")}>{s.text}</span>)}
            </div>
            <input
              ref={input}
              value={text}
              onChange={(e) => { setText(e.target.value); setScroll(e.target.scrollLeft); }}
              onKeyUp={(e) => setScroll(e.currentTarget.scrollLeft)}
              onScroll={(e) => setScroll(e.currentTarget.scrollLeft)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) { e.preventDefault(); submit(); } }}
              aria-label={mode === "task" ? tx("Task title") : tx("Activity title")}
              placeholder={mode === "task" ? tx("Send invoice to Acme friday 10:00 !high #finance") : tx("Climbing with Tomek friday 18:00 for 2h every week")}
              className="relative w-full bg-transparent text-[18px] font-medium leading-7 text-transparent caret-strong outline-none placeholder:text-dim"
            />
          </div>
          <MarkdownEditor label={tx("Description")} value={desc} onChange={setDesc} placeholder={tx("Add description… Markdown works")}
            className="max-h-[40vh] min-h-[44px] overflow-y-auto text-[13.5px] text-fg3" />
          {mode === "task" && doneWhen !== null && (
            <div className="flex flex-col gap-1 border-t border-line pb-1 pt-2.5">
              <span className="text-[12px] font-medium text-fg3">{tx("Done when")}</span>
              <textarea aria-label={tx("Done when")} value={doneWhen} onChange={(e) => setDoneWhen(e.target.value)} rows={3} autoFocus
                placeholder={tx("One per line, e.g.\nThe export downloads the rows for the current filters\nA screenshot of the new button")}
                className="field-sizing-content min-h-[60px] w-full resize-none bg-transparent text-[13px] leading-relaxed text-fg3 outline-none placeholder:text-dim" />
            </div>
          )}
        </div>

        {mode === "task" && <h3 className="px-5 pb-2 text-[12px] font-medium text-fg2">{tx("General")}</h3>}
        <div className="flex flex-wrap gap-1.5 px-5 pb-3.5">
          {mode === "task" ? (
            <>
              <Menu trigger={<button type="button" className={chip}><StatusIcon status={status} size={13} />{tx(STATUS_LABEL[status])}</button>}
                items={(["backlog", "todo", "progress"] as Status[]).map((s) => ({ value: s, label: tx(STATUS_LABEL[s]), icon: <StatusIcon status={s} size={13} /> }))}
                onSelect={(v) => setOv((o) => ({ ...o, status: v }))} />
              <Menu trigger={<button type="button" className={cx(chip, parsed.priority && ov.priority === undefined && found)}><PriorityIcon priority={priority} size={13} />{tx(PRIORITY_LABEL[priority])}</button>}
                items={([1, 2, 3, 4, 0] as Priority[]).map((p) => ({ value: p, label: tx(PRIORITY_LABEL[p]), icon: <PriorityIcon priority={p} size={13} /> }))}
                onSelect={(v) => setOv((o) => ({ ...o, priority: v }))} />
              <DateField value={due} onChange={(v) => setOv((o) => ({ ...o, due: v }))}
                trigger={<button type="button" className={cx(chip, parsed.date && ov.due === undefined && found)}><Icon name="flag" size={13} />{due ? tx.date(parseLocal(due), timeOf(due) ? "EEE d MMM, HH:mm" : "EEE d MMM") : tx("Due date")}</button>} />
              <DateField value={planned} withTime={false} onChange={(v) => setOv((o) => ({ ...o, planned: v ? dateOnly(v) : null }))}
                trigger={<button type="button" className={chip}><Icon name="calendarCheck" size={13} />{planned ? tx("Planned {0}", [tx.date(parseLocal(planned), "EEE d MMM")]) : tx("Plan for a day")}</button>} />
              <Menu trigger={<button type="button" className={cx(chip, projectFromText && ov.projectId === undefined && found)}><Icon name="layers" size={13} />{project?.name ?? tx("Project")}</button>}
                items={[{ value: null as string | null, label: tx("No project") },
                  ...projects.filter((p) => !areaId || p.areaId === areaId).map((p) => ({ value: p.id as string | null, label: p.name }))]}
                onSelect={(v) => setOv((o) => ({ ...o, projectId: v, areaId: v ? projects.find((p) => p.id === v)?.areaId ?? o.areaId : o.areaId }))} />
              {!projectId && related && (
                <button type="button" onClick={() => setOv((o) => ({ ...o, related: null }))} title={tx("About this project, without being part of it. Click to remove")}
                  className={chip}><Icon name="link" size={13} />{tx("About")}{" "}{projects.find((p) => p.id === related)?.name ?? tx("a project")}<Icon name="x" size={11} /></button>
              )}
              {parsed.labels.map((l) => (
                <span key={l} className={cx(chip, found)}><Icon name="tag" size={13} />{l}</span>
              ))}
              <button type="button" aria-pressed={doneWhen !== null} onClick={() => setDoneWhen((d) => (d === null ? "" : d.trim() ? d : null))}
                title={tx("What must be true when it's done")} className={cx(chip, doneItems.length > 0 && found)}>
                <Icon name="target" size={13} />{doneItems.length ? tx("Done when · {0}", [doneItems.length]) : tx("Done when")}
              </button>
            </>
          ) : (
            <>
              <DateField value={start} onChange={(v) => setOv((o) => ({ ...o, due: v }))}
                trigger={<button type="button" className={cx(chip, parsed.date && found)}><Icon name="calendar" size={13} />{start ? tx.date(parseLocal(start), "EEE d MMM, HH:mm") : tx("When")}</button>} />
              <Menu trigger={<button type="button" className={cx(chip, parsed.durationMin && found)}><Icon name="clock" size={13} />{duration} min</button>}
                items={[15, 30, 45, 60, 90, 120, 180].map((m) => ({ value: m, label: `${m} min` }))}
                onSelect={(v) => setOv((o) => ({ ...o, duration: v }))} />
              <button type="button" onClick={() => setOv((o) => ({ ...o, weekly: !weekly }))} className={cx(chip, weekly && found)}>
                <Icon name="repeat" size={13} />{weekly ? tx("Every week") : tx("Does not repeat")}
              </button>
            </>
          )}
        </div>

        {/* Who does it and, for an agent, where its sessions run: a section of its own, apart from the general fields. */}
        {mode === "task" && <section aria-label={agent ? tx("Agent") : tx("Done by")} className="mx-5 mb-3.5 border-t border-line pt-3">
          <h3 className="pb-2 text-[12px] font-medium text-fg2">{agent ? tx("Agent") : tx("Done by")}</h3>
          <div className="flex flex-wrap gap-1.5">
            <Menu width={260}
              trigger={<button type="button" aria-label={tx("Done by: {0}", [doerLabel])} title={doer ? undefined : tx("The project's default")} className={chip}>
                {agent ? <AgentIcon agent={agent} size={12} /> : <Icon name="user" size={13} />}{doerLabel}
              </button>}
              items={[
                { value: "human" as Doer | null, label: tx(DOER_LABEL.human), icon: <Icon name="user" size={13} />, hint: tx("No agent session") },
                ...(["claude", "codex"] as const).map((a) => ({ value: a as Doer | null, label: tx(DOER_LABEL[a]), icon: <AgentIcon agent={a} size={12} /> })),
                { value: null, label: project?.agent ? tx("Project default, {0}", [tx(DOER_LABEL[project.agent])]) : tx("Default, Claude Code"), icon: <Icon name="layers" size={13} /> },
              ]}
              onSelect={(v) => setOv((o) => ({ ...o, agent: v, modelSettings: null, ...(v === "human" ? { runIn: null } : {}) }))} />
            {agent && <>
              <Menu width={280}
                trigger={<button type="button" aria-label={tx("Run in: {0}", [runIn ? placeLabel(runIn) : tx("Automatic")])} className={chip}
                  title={runIn ? undefined : tx("Picked automatically: the terminal when the CLI is installed, else the app")}>
                  <SurfaceIcon surface={place} size={13} />{placeLabel(place)}{!runIn && <span className="text-[11px] text-mut2">auto</span>}
                </button>}
                items={[
                  { value: null as Surface | null, label: tx("Automatic"), hint: tx("Terminal, else the app"), icon: <Icon name="laptop" size={13} /> },
                  ...(["terminal", "desktop", "cloud"] as const).map((s) => ({ value: s as Surface | null, label: s === "cloud" ? tx(CLOUD_LABEL[agent]) : placeLabel(s), icon: <SurfaceIcon surface={s} size={13} /> })),
                ]}
                onSelect={(v) => setOv((o) => ({ ...o, runIn: v, ...(v && v !== "terminal" ? { modelSettings: null } : {}) }))} />
              {chooseComputer && <ComputerPicker value={deviceId} inherited={project?.deviceId} agent={agent} needs={needs} trigger={wide}
                onChange={(v) => setOv((o) => ({ ...o, deviceId: v, modelSettings: null }))} />}
              <NeedsPicker values={needs} agent={agent} trigger={wide} onChange={(v) => setOv((o) => ({ ...o, needs: v }))} />
              <ModelChips agent={agent} deviceId={runsOn} needs={needs} surface={runIn} value={modelSettings} trigger={wide}
                onChange={(value, pin) => setOv((o) => ({ ...o, modelSettings: value, modelProject: projectId, ...(pin !== undefined ? { deviceId: pin } : {}), ...(value ? { runIn: "terminal" } : {}) }))} />
            </>}
          </div>
          {agent && <Issues items={issues} className="mt-2" />}
        </section>}

        {summary && (
          <div className="flex h-9 items-center gap-2 border-t border-line px-5 text-[12px] text-mut2">
            <Icon name="check" size={13} className="text-accent" />
            <span className="flex-1 truncate">{summary}</span>
          </div>
        )}
        </div>
        <div className="flex h-14 shrink-0 items-center gap-2 border-t border-line pl-5 pr-3">
          <Switch on={more} onChange={setMore} label={tx("Create more")} />
          <span className="text-[12.5px] text-mut">{tx("Create more")}</span>
          <span className="flex-1" />
          <Button variant="ghost" onClick={close}>{tx("Cancel")}</Button>
          <Button variant="primary" disabled={pending} onClick={submit} className="h-8 px-3">
            {mode === "task" ? tx("Create task") : tx("Add to calendar")} <span className="rounded bg-ink/15 px-1.5 font-mono text-[10.5px] max-md:hidden">Ctrl ↵</span>
          </Button>
        </div>
      </div>
    </div>
  );
}
