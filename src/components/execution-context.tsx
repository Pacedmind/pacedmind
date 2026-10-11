"use client";
import { useTranslation } from "@/components/language";
import { createTranslator, type Translator } from "@/lib/i18n";

import { createContext, useContext, type ReactNode } from "react";
import { MAX_NEEDS, cleanNeeds, deviceWithNeeds, missingOn, needKey, toolsOn } from "@/lib/needs";
import { AGENT_LABEL, APP_LABEL, deviceOnline, mcpReaches, surfaceOf, type AgentId, type Device, type FolderHints, type Surface } from "@/lib/types";
import { Icon } from "./icons";
import { Picker } from "./picker";

/** `folders`: where projects and areas are on this computer (folder-hints.ts); null in the web app. */
type ExecutionContext = { devices: Device[]; hereId: string | null; desktop: boolean; folders: FolderHints | null };
const Context = createContext<ExecutionContext>({ devices: [], hereId: null, desktop: false, folders: null });
export function ExecutionProvider({ children, ...value }: ExecutionContext & { children: ReactNode }) {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export const useExecution = () => useContext(Context);

export function harnesses(d: Device, tx: Translator = createTranslator("en")): string[] {
  return (["claude", "codex"] as const).flatMap((a) => [
    ...(d.agents[a].cli ? [tx(AGENT_LABEL[a])] : []), ...(d.agents[a].app ? [tx(APP_LABEL[a])] : []),
  ]);
}

/** "This computer", "Online" or "Offline". */
export const deviceState = (d: Device, hereId: string | null, tx: Translator = createTranslator("en")) => d.id === hereId ? tx("This computer") : deviceOnline(d) ? tx("Online") : tx("Offline");

/**
 * The computer a task's sessions go to: the one it or its project names, else the one PacedMind picks (this computer in
 * the desktop app; in the web app one whose agent has what the task needs, else the default). Null when none is known.
 */
export function useTaskDevice(deviceId: string | null, agent: AgentId, needs: string[] = []) {
  const { devices, hereId, desktop } = useExecution();
  const fallback = devices.find((d) => d.isDefault);
  const device = deviceId ? devices.find((d) => d.id === deviceId)
    : desktop ? devices.find((d) => d.id === hereId)
    : (needs.length ? deviceWithNeeds(needs, agent, devices, fallback?.id) : null) ?? fallback;
  return { device: device ?? null, local: desktop && !!device && device.id === hereId };
}

/** Whether there is a computer to choose: with only one, sessions go there anyway. */
export function useComputerChoice(value: string | null) {
  return useExecution().devices.filter((d) => !!d.id).length > 1 || !!value;
}

/**
 * The task's own computer (`value`), else its project's (`inherited`). The trigger (`trigger`, its classes) names the
 * computer its sessions go to, and says when PacedMind picked it.
 */
export function ComputerPicker({ value, inherited, agent, needs, onChange, trigger }: {
  value: string | null; inherited?: string | null; agent: AgentId; needs?: string[]; onChange: (id: string | null) => void; trigger: string;
}) {
  const tx = useTranslation();
  const { devices, hereId, desktop } = useExecution();
  const { device } = useTaskDevice(value ?? inherited ?? null, agent, needs);
  const parent = devices.find((d) => d.id === inherited);
  const options = [
    parent ? { value: "", label: tx("Project's computer, {0}", [parent.name]) }
      : { value: "", label: tx("Automatic"), detail: desktop ? tx("This computer, or one that has what the task needs") : tx("One that has what the task needs, else your default") },
    ...devices.filter((d) => !!d.id).map((d) => ({ value: d.id, label: d.name,
      detail: [deviceState(d, hereId, tx), harnesses(d).join(", ") || tx("No agents found")].join(" · ") })),
  ];
  if (value && !options.some((o) => o.value === value)) options.push({ value, label: tx("Unavailable computer") });
  const picked = value ? null : inherited ? "project" : "auto";
  return <Picker label={tx("Computer")} values={[value ?? ""]} options={options} onChange={([id]) => onChange(id || null)} trigger={trigger}
    title={device ? tx("Runs on {0}{1}", [device.name, picked === "auto" ? tx(", picked automatically") : picked === "project" ? tx(", the project's computer") : ""]) : undefined}
    content={<>
      <Icon name="laptop" size={13} className="shrink-0" />
      <span className="truncate">{device?.name ?? (value ? tx("Unavailable computer") : tx("Computer"))}</span>
      {picked && device && <span className="text-[11px] text-mut2">{picked}</span>}
    </>} />;
}

/** What the task's agent needs from the computer: MCP servers or claude.ai connectors, suggested from what computers reported. */
export function NeedsPicker({ values, onChange, agent, tools, deferred = false, trigger, empty }: {
  values: string[]; onChange: (values: string[]) => void; agent?: AgentId; deferred?: boolean; tools?: { name: string; on: string[] }[]; trigger: string; empty?: string;
}) {
  const tx = useTranslation();
  empty ??= tx("MCP servers");
  const { devices } = useExecution();
  const choices = new Map<string, { name: string; on: Set<string> }>();
  const add = (name: string, on: string[]) => {
    const clean = cleanNeeds([name])[0];
    if (!clean) return;
    const key = needKey(clean);
    const item = choices.get(key) ?? { name: clean, on: new Set<string>() };
    on.forEach((d) => item.on.add(d)); choices.set(key, item);
  };
  if (tools) tools.forEach((t) => add(t.name, t.on));
  else devices.forEach((d) => (agent ? [agent] : ["claude", "codex"] as const).forEach((a) => (toolsOn(d, a) ?? []).forEach((name) => add(name, [d.name]))));
  values.forEach((v) => add(v, []));
  return <Picker label={tx("MCP servers and connectors")} multiple deferred={deferred} values={values.map(needKey)} max={MAX_NEEDS} trigger={trigger}
    title={tx("MCP servers or connectors its agent needs on the computer")}
    content={<>
      <Icon name="plug" size={13} className="shrink-0" />
      <span className="truncate">{values.length ? values.join(", ") : empty}</span>
    </>}
    options={[...choices].sort((a, b) => a[1].name.localeCompare(b[1].name)).map(([key, t]) => ({
      value: key, label: t.name, detail: t.on.size ? tx("On {0}", [[...t.on].join(", ")]) : tx("Not reported by a computer"),
    }))} custom={(text) => cleanNeeds([text])[0] ?? null}
    onChange={(keys) => onChange(cleanNeeds(keys.map((k) => choices.get(k)?.name ?? k)))} />;
}

/** What would keep the task's session from starting where it goes, in short lines; none when nothing would. */
export function useExecutionIssues(deviceId: string | null, agent: AgentId, runIn: Surface | null, needs: string[] = []): string[] {
  const tx = useTranslation();
  const { device, local } = useTaskDevice(deviceId, agent, needs);
  if (deviceId && !device) return [tx("The chosen computer isn't available any more")];
  if (!device) return [];
  const tools = device.agents[agent];
  const surface = surfaceOf(runIn, device.checkedAt ? tools : undefined);
  if (surface === "cloud") return [];
  const issues: string[] = [];
  if (tools && device.checkedAt && !(surface === "desktop" ? tools.app : tools.cli)) {
    issues.push(tx("{0} isn't installed on {1}", [surface === "desktop" ? tx(APP_LABEL[agent]) : tx(AGENT_LABEL[agent]), device.name]));
  } else if (tools && surface === "desktop" && !mcpReaches(tools.mcp)) issues.push(tx("{0} isn't connected to PacedMind", [tx(APP_LABEL[agent])]));
  if (!local && device.remoteStart === "off") issues.push(tx("{0} refuses starts from other computers", [device.name]));
  const missing = missingOn(needs, device, agent);
  if (missing.length) issues.push(tx("Not reported on {0}: {1}", [device.name, missing.join(", ")]));
  return issues;
}

export function Issues({ items, className }: { items: (string | null | undefined)[]; className?: string }) {
  const shown = [...new Set(items.filter((t): t is string => !!t))];
  if (!shown.length) return null;
  return <div role="status" className={className}>
    {shown.map((t) => <p key={t} className="flex items-start gap-1.5 text-[11.5px] leading-5 text-mut">
      <Icon name="alert" size={12} className="mt-1 shrink-0 text-mut2" />{t}
    </p>)}
  </div>;
}
