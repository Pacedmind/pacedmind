"use client";
import { useTranslation } from "@/components/language";

import { useState } from "react";
import { taskModelsAction } from "@/app/model-actions";
import { modelSelectionProblem, type ModelSelection } from "@/lib/agent-models";
import { fmtTime, toDateTimeStr } from "@/lib/dates";
import { AGENT_LABEL, type AgentId, type Surface } from "@/lib/types";
import { useTaskDevice } from "./execution-context";
import { Icon } from "./icons";
import { Menu, toast } from "./ui";

type ModelProps = {
  agent: AgentId; deviceId: string | null; needs?: string[]; surface: Surface | null; value: ModelSelection | null;
  /** `pin`: the computer whose agent account offered the model, when one was chosen (models differ by account). */
  onChange: (value: ModelSelection | null, pin?: string | null) => void;
  /** The trigger's classes (a chip in quick add, a property in the task's details), and what it says for the default. */
  trigger: string; empty?: string; disabled?: boolean;
};

const REFRESH = "\u0000refresh";

/**
 * Model, thinking and speed for the task's terminal sessions, from the models its computer's agent account reported.
 * Nothing when it runs in the agent's app or cloud, which pick their own.
 */
export function ModelChips({ agent, deviceId, needs, surface, value, onChange, trigger, empty: unset, disabled = false }: ModelProps) {
  const tx = useTranslation();
  unset ??= tx("Model");
  const { device } = useTaskDevice(deviceId, agent, needs);
  const [checking, setChecking] = useState(false);
  if (surface && surface !== "terminal") return null;
  const catalog = device?.agents[agent]?.models;
  const models = catalog?.available ? catalog.models : [];
  const selection = value?.agent === agent ? value : null;
  const model = models.find((m) => m.id === selection?.model);
  const update = (patch: Partial<ModelSelection>) => selection && onChange({ ...selection, ...patch });
  // A fresh list from this computer's CLI, or the other computer's latest report; the page refreshes with it.
  const refresh = () => {
    setChecking(true);
    taskModelsAction(agent, device ? device.id : deviceId)
      .then((r) => { if (!r.catalog?.available) toast(tx("Sign in to {0}{1} to list its models", [tx(AGENT_LABEL[agent]), r.name ? tx(" on {0}", [r.name]) : ""]), "error"); })
      .catch(() => toast(tx("Couldn't check the models"), "error"))
      .finally(() => setChecking(false));
  };
  const empty = !device ? tx("No computer to ask") : checking ? tx("Checking…")
    : catalog && !catalog.available ? tx("Sign in to {0} on {1}", [tx(AGENT_LABEL[agent]), device.name]) : !catalog ? tx("Not checked yet") : null;
  return <>
    <Menu width={260}
      trigger={<button type="button" className={trigger} aria-label={tx("Model")} disabled={disabled}
        title={selection ? undefined : tx("The agent's own model settings")}>
        <Icon name="cpu" size={13} className="shrink-0" /><span className="truncate">{selection ? model?.name ?? selection.model : unset}</span>
      </button>}
      items={[
        { value: "", label: tx("Default"), hint: tx("Agent's own") },
        ...models.map((m) => ({ value: m.id, label: m.name })),
        ...(empty ? [{ value: "", label: empty, disabled: true }] : []),
        ...(device ? [{ value: REFRESH, label: tx("Refresh list"), icon: <Icon name="refresh" size={13} />, hint: catalog ? fmtTime(toDateTimeStr(new Date(catalog.checkedAt))) : undefined, disabled: checking }] : []),
      ]}
      onSelect={(id) => {
        if (id === REFRESH) refresh();
        else if (!id) { if (selection) onChange(null); }
        else onChange({ agent, model: id, effort: null, speed: null }, device?.id || null);
      }} />
    {model && model.efforts.length > 0 && <Menu
      trigger={<button type="button" className={trigger} aria-label={tx("Thinking")} disabled={disabled}>{selection?.effort ? tx("Thinking: {0}", [tx(selection.effort)]) : tx("Thinking")}</button>}
      items={[{ value: "", label: tx("Default") }, ...model.efforts.map((e) => ({ value: e, label: tx(e) }))]}
      onSelect={(effort) => update({ effort: effort || null })} />}
    {model && model.speeds.length > 0 && <Menu
      trigger={<button type="button" className={trigger} aria-label={tx("Speed")} disabled={disabled}>{selection?.speed ? tx(model.speeds.find((s) => s.id === selection.speed)?.name ?? selection.speed) : tx("Speed")}</button>}
      items={[{ value: "", label: tx("Default") }, ...model.speeds.map((s) => ({ value: s.id, label: tx(s.name) }))]}
      onSelect={(speed) => update({ speed: speed || null })} />}
  </>;
}

/** Why the chosen model settings wouldn't apply where the task runs, if they wouldn't. */
export function useModelProblem(agent: AgentId, deviceId: string | null, needs: string[] | undefined, surface: Surface | null, value: ModelSelection | null) {
  const tx = useTranslation();
  const { device } = useTaskDevice(deviceId, agent, needs);
  const problem = value ? modelSelectionProblem(value, agent, surface ?? "terminal", device?.agents[agent]?.models) : null;
  return problem ? tx.generated(problem) : null;
}
