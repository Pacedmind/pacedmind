"use client";
import { useTranslation } from "@/components/language";

import { useState } from "react";
import { cloudConnectOfferAction } from "@/app/actions";
import { AGENT_LABEL, type AgentId } from "@/lib/types";
import { Button, useAction } from "./ui";

/**
 * Once after signing in to PacedMind Cloud (desktop): offers to connect Claude Code and Codex on this computer to its
 * MCP server, so the sessions you start yourself and those in their apps reach your account. Connect sets them up and
 * opens a terminal each where they sign in; Settings → Connect does the same any time.
 */
export function CloudConnectOffer({ agents }: { agents: AgentId[] }) {
  const tx = useTranslation();
  const { run, pending } = useAction();
  const [open, setOpen] = useState(true);
  if (!open) return null;
  const names = agents.map((a) => tx(AGENT_LABEL[a])).join(tx(" and "));
  const answer = (connect: boolean) => {
    setOpen(false);
    run(() => cloudConnectOfferAction(connect));
  };
  return (
    <div role="dialog" aria-labelledby="cloud-connect-title"
      className="fixed bottom-4 right-4 z-40 flex w-[360px] flex-col gap-2 rounded-xl border border-line bg-panel p-4 shadow-lg max-md:inset-x-3 max-md:w-auto">
      <p id="cloud-connect-title" className="text-[13px] font-semibold text-strong">{tx("Connect your agents to PacedMind Cloud")}</p>
      <p className="text-[12.5px] leading-relaxed text-fg3">
        {names} {tx("on this computer can then plan your tasks and report on their work from any folder, in their terminals and apps. Each signs in with your account in the browser; no token goes into their settings.")}</p>
      <div className="mt-1 flex justify-end gap-2">
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => answer(false)}>{tx("Not now")}</Button>
        <Button size="sm" variant="primary" disabled={pending} onClick={() => answer(true)}>{tx("Connect")}</Button>
      </div>
    </div>
  );
}
