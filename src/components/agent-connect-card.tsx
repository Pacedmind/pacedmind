"use client";
import { useTranslation } from "@/components/language";
import { createTranslator, type Translator } from "@/lib/i18n";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { dismissConnectCardAction } from "@/app/actions";
import { MCP_NAME } from "@/lib/types";
import { Button, cx, toast } from "./ui";

type Way = {
  id: string;
  name: string;
  how: string;
  /** Commands for a terminal, copied together. */
  commands?: string[];
  /** A link that opens the agent's app, which asks to add the server. */
  install?: { label: string; href: string };
  open?: { label: string; href: string };
  then: string;
};

/**
 * How each agent connects to PacedMind Cloud's MCP server, as pacedmind.com/connect has it (site/lib/content.ts) and
 * Settings → MCP server for Claude Code and Codex. The browser this runs in is signed in already, so the agent's sign-in
 * only asks for Allow.
 */
function waysFor(url: string, tx: Translator = createTranslator("en")): Way[] {
  const allow = tx("PacedMind opens in your browser: select Allow.");
  return [
    {
      id: "claude-code", name: "Claude Code", how: tx("Run these in a terminal:"),
      commands: [`claude mcp add --transport http --scope user ${MCP_NAME} ${url}`, `claude mcp login ${MCP_NAME}`],
      then: tx("After the second one, {0} The Claude app's Code sessions use it too.", [allow]),
    },
    {
      id: "codex", name: "Codex", how: tx("Run these in a terminal:"),
      commands: [`codex mcp add ${MCP_NAME} --url ${url}`, `codex mcp login ${MCP_NAME}`],
      then: tx("After the second one, {0} The Codex app uses it too.", [allow]),
    },
    {
      id: "cursor", name: "Cursor", how: tx("Add PacedMind to Cursor with one click:"),
      install: { label: tx("Add to Cursor"), href: `cursor://anysphere.cursor-deeplink/mcp/install?name=${MCP_NAME}&config=${encodeURIComponent(btoa(JSON.stringify({ url })))}` },
      then: tx("Select Install in Cursor. When it asks you to sign in, {0}", [allow]),
    },
    {
      id: "vscode", name: "VS Code", how: tx("Add PacedMind to VS Code with one click:"),
      install: { label: tx("Add to VS Code"), href: `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: MCP_NAME, type: "http", url }))}` },
      then: tx("Select Install in VS Code. When it asks you to sign in, {0}", [allow]),
    },
    {
      id: "claude", name: "Claude", how: tx("In Claude, open Customize → Connectors, select + and then Add custom connector, and paste this address:"),
      open: { label: tx("Open Claude connectors"), href: "https://claude.ai/settings/connectors" },
      then: tx("Name it PacedMind, select Add, then Connect. {0} On a team, an owner may need to add the connector first.", [allow]),
    },
    {
      id: "chatgpt", name: "ChatGPT", how: tx("In ChatGPT, turn on Developer mode in Settings → Security and login. Open Plugins, select +, name it PacedMind and add this address with OAuth:"),
      open: { label: tx("Open ChatGPT plugins"), href: "https://chatgpt.com/plugins" },
      then: tx("{0} Add PacedMind from the tools menu in a new chat. Developer mode depends on your account and workspace settings.", [allow]),
    },
    {
      id: "other", name: tx("Other"), how: tx("In any MCP client that signs in with OAuth, add this address as a streamable HTTP server:"),
      then: tx("It finds PacedMind's sign-in and registers by itself. {0}", [allow]),
    },
  ];
}

/** Copies text: with the Clipboard API, else the older copy command, which some browsers allow when that's refused. */
async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    const copied = document.execCommand("copy");
    area.remove();
    return copied;
  }
}

/**
 * The web app's way to an agent, until the account has one connected (connected_agents) or you say Not now, which this
 * browser keeps (CONNECT_CARD_COOKIE): a tab per agent with its commands, its install link or the server's address.
 * Settings → MCP server has the same, so the card stays out of it.
 */
export function AgentConnectCard({ url }: { url: string }) {
  const tx = useTranslation();
  const [open, setOpen] = useState(true);
  const [pick, setPick] = useState("claude-code");
  const path = usePathname();
  if (!open || path.startsWith("/settings/mcp")) return null;
  const ways = waysFor(url, tx);
  const way = ways.find((w) => w.id === pick) ?? ways[0];
  const text = way.commands?.join("\n") ?? url;
  const copy = async () => {
    const copied = await copyText(text);
    toast(copied ? tx("{0} copied", [way.commands ? tx("Commands") : tx("Address")]) : tx("Couldn't copy: select the text instead"), copied ? "info" : "error");
  };
  const notNow = () => {
    setOpen(false);
    void dismissConnectCardAction();
  };
  return (
    <div role="dialog" aria-labelledby="agent-connect-title"
      className="fixed bottom-4 right-4 z-40 flex w-[470px] flex-col gap-3 rounded-xl border border-line bg-panel p-4 shadow-lg max-md:inset-x-3 max-md:w-auto">
      <div>
        <p id="agent-connect-title" className="text-[13px] font-semibold text-strong">{tx("Connect your agent")}</p>
        <p className="mt-1 text-[12.5px] leading-relaxed text-fg3">
          {tx("Claude Code, Codex, Cursor, ChatGPT and other agents can then plan your tasks and report on their work here. Pick yours:")}</p>
      </div>
      <div role="tablist" aria-label={tx("Agents")} className="flex flex-wrap gap-1">
        {ways.map((w) => (
          <button key={w.id} type="button" role="tab" aria-selected={w.id === way.id} onClick={() => setPick(w.id)}
            className={cx("h-6 rounded-md border px-1.5 text-[12px]",
              w.id === way.id ? "border-line-strong bg-sel text-strong" : "border-line text-mut hover:bg-hover hover:text-fg2")}>
            {w.name}
          </button>
        ))}
      </div>
      <div role="tabpanel" aria-label={way.name} className="flex flex-col gap-2">
        <p className="text-[12.5px] leading-relaxed text-fg3">{way.how}</p>
        {way.open && <a href={way.open.href} target="_blank" rel="noreferrer"
          className="self-start text-[12.5px] text-fg2 underline underline-offset-4">{way.open.label}</a>}
        {way.install ? (
          <a href={way.install.href}
            className="inline-flex h-7 items-center self-start rounded-md border border-ctl px-2.5 text-[12.5px] text-fg2 hover:bg-hover">
            {way.install.label}
          </a>
        ) : (
          <div className="flex items-start gap-2 rounded-md border border-line bg-input py-2 pl-2.5 pr-2">
            <pre className="min-w-0 flex-1 whitespace-pre-wrap break-all py-0.5 font-mono text-[11.5px] leading-relaxed text-fg2">{text}</pre>
            <Button size="sm" onClick={copy}>{tx("Copy")}</Button>
          </div>
        )}
        <p className="text-[12px] leading-relaxed text-mut2">{way.then}</p>
        <p className="text-[12px] leading-relaxed text-mut2">{tx("Try: “What should I work on today?” Planning works before you set up two-factor sign-in; controlling computers requires it.")}</p>
      </div>
      <div className="flex items-center justify-between gap-2">
        <Link href="/settings/mcp" className="text-[12px] text-mut hover:text-fg2">{tx("Settings → MCP server")}</Link>
        <Button size="sm" variant="ghost" onClick={notNow}>{tx("Not now")}</Button>
      </div>
    </div>
  );
}
