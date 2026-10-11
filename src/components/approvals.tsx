"use client";
import { useTranslation } from "@/components/language";
import { createTranslator, type Translator } from "@/lib/i18n";

import { useEffect, useState } from "react";
import { approveLaunchAction, denyLaunchAction } from "@/app/actions";
import type { LaunchRequestKind, Surface } from "@/lib/types";
import { needList } from "@/lib/needs";
import { Button, useAction } from "./ui";

export interface ApprovalView {
  modelSettings?: import("@/lib/agent-models").ModelSelection | null;
  id: string;
  /** Start a session, resume one, or send one back with changes (src/server/requests.ts); or use a folder here. */
  kind?: LaunchRequestKind | "folder";
  key: string;
  title: string;
  /** The agent and where it runs, in words ("Claude Code · Terminal"). */
  agent: string;
  surface?: Surface;
  folder: string;
  from: string;
  /** For kind "changes": what should change, as whoever asked wrote it. */
  changes?: string | null;
  /** For a start: what the task needs that the agent doesn't have on this computer. */
  missing?: string[];
  requestedAt: number;
  expiresAt: number;
}

function ago(ms: number, now: number, tx: Translator = createTranslator("en")) {
  const min = Math.max(0, Math.round((now - ms) / 60_000));
  return min < 1 ? tx("just now") : tx("{0} min ago", [min]);
}

function question(a: ApprovalView, tx: Translator = createTranslator("en")): string {
  if (a.kind === "folder") return tx("Use a folder on this computer?");
  if (a.kind === "changes") return tx("Send a session back with changes?");
  if (a.kind === "resume") {
    if (a.surface === "cloud") return tx("Pull a cloud session into a terminal here?");
    return a.surface === "desktop" ? tx("Continue a session in the desktop app here?") : tx("Resume a session on this computer?");
  }
  return tx("Start a session on this computer?");
}

/** Who asked. The server's words also say what was asked, which the card shows on its own (and the changes in full). */
const asker = (a: ApprovalView) => a.from.replace(/, (sending the session back with changes: “[\s\S]*”|resuming its session)$/, "");

/**
 * Sessions asked for from outside this window (an agent over MCP, the web app, another computer) wait here for you:
 * nothing opens a terminal on this computer until you allow it. Shows what would run and where, and for a session sent
 * back with changes, the changes as they were written: the agent acts on them, so read them before allowing it. A folder
 * asked for a project, an area or a task waits here too, and is set only when you allow it.
 */
export function Approvals({ items }: { items: ApprovalView[] }) {
  const tx = useTranslation();
  const { run } = useAction();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(id);
  }, []);
  const open = items.filter((a) => a.expiresAt > now);
  if (!open.length) return null;
  return (
    // On a phone: the screen's width less a margin, and a list that scrolls when several wait.
    <div role="region" aria-label={tx("Sessions waiting for you")}
      className="fixed right-4 top-[52px] z-40 flex max-h-[calc(100dvh-64px)] w-[380px] flex-col gap-2 overflow-y-auto max-md:inset-x-3 max-md:w-auto">
      {open.map((a) => (
        <div key={a.id} className="flex shrink-0 flex-col gap-2.5 rounded-lg border border-line2 bg-raised p-3.5 shadow-[var(--shadow-popover)]">
          <div className="flex items-center gap-2 text-[12.5px] font-medium text-strong">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
            {question(a, tx)}
          </div>
          {a.kind === "folder" ? (
            <div className="text-[12.5px] leading-relaxed text-fg3">
              {tx("For")}{a.title}:
              <br />
              <span className="break-all font-mono text-[11.5px] text-fg2">{a.folder}</span>
              <p className="mt-1 text-mut2">{tx("Its agent sessions here would start in this folder. Allow it only if that's the right one.")}</p>
            </div>
          ) : (
            <div className="text-[12.5px] leading-relaxed text-fg3">
              <span className="font-mono text-fg2">{a.key}</span> {a.title}
              <br />
              {a.agent} {" "}{tx("in")}{" "}<span className="break-all font-mono text-[11.5px] text-fg2">{a.folder}</span>
              {a.modelSettings && <p className="mt-1 text-mut2">{a.modelSettings.model} {" "}{tx("· Thinking:")}{" "}{a.modelSettings.effort ?? tx("Default")} {" "}{tx("· Speed:")}{" "}{a.modelSettings.speed ?? tx("Default")}</p>}
            </div>
          )}
          {a.missing && a.missing.length > 0 && (
            <p className="text-[12px] leading-relaxed text-fg3">
              {tx("It needs")}{needList(a.missing)}{tx(", which the agent doesn't have on this computer. Another of your computers may: refuse this and send it there with Run on a computer.")}</p>
          )}
          {a.kind === "changes" && a.changes && (
            <div className="flex flex-col gap-1">
              <span className="text-[11.5px] text-mut2">{tx("What the agent is asked to change, as sent:")}</span>
              {/* Plain text, as it came: nothing in it is a link or formatting. */}
              <p className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md border border-line2 bg-input px-2.5 py-2 text-[12px] leading-relaxed text-fg2 wrap-break-word">
                {a.changes}
              </p>
            </div>
          )}
          <div className="text-[12px] text-mut2">{tx("Asked by")}{" "}{asker(a)} · {ago(a.requestedAt, now, tx)}</div>
          <div className="flex justify-end gap-2">
            <Button onClick={() => run(() => denyLaunchAction(a.id), tx("Refused"))}>{tx("Refuse")}</Button>
            <Button variant="primary" onClick={() => run(() => approveLaunchAction(a.id))}>{a.kind === "folder" ? tx("Use it") : tx("Allow")}</Button>
          </div>
        </div>
      ))}
    </div>
  );
}
