"use client";
import { useTranslation } from "@/components/language";

import { useState } from "react";

import { answerAskAction, withdrawAskAction } from "@/app/actions";
import { AGENT_LABEL, type AgentId, type AskView } from "@/lib/types";
import { pollLaunchState, useClock, useLaunchState } from "./request-status";
import { Button, cx, useAction } from "./ui";

/*
 * What a running session's agent waits for you to answer (asks.ts): a tool Claude Code wants permission for, with
 * Allow and Refuse, or a question, with a field for the answer. It comes from /api/state (LiveRefresh), so it shows
 * wherever the session does, on every device. On the session's own computer an answer goes at once; from anywhere else
 * it takes a two-factor code from the last few minutes, and only when that computer takes answers from elsewhere.
 */
export function AskCard({ sessionId, agent }: { sessionId: string; agent: AgentId }) {
  const { asks, codeFreshUntil } = useLaunchState();
  const ask = asks.find((a) => a.sessionId === sessionId);
  // A new ask gets a fresh card: what was typed for the last one doesn't carry over.
  return ask ? <AskBody key={ask.id} ask={ask} agent={agent} codeFreshUntil={codeFreshUntil} /> : null;
}

function AskBody({ ask, agent, codeFreshUntil }: { ask: AskView; agent: AgentId; codeFreshUntil: number | null }) {
  const tx = useTranslation();
  const { run, pending } = useAction();
  const now = useClock(5_000);
  const [text, setText] = useState("");
  const [code, setCode] = useState("");
  const [needCode, setNeedCode] = useState(false);
  const [sent, setSent] = useState(false);
  const who = tx(AGENT_LABEL[agent]);
  const showCode = !ask.here && (needCode || !codeFreshUntil || codeFreshUntil <= now + 5_000);
  if (sent || ask.expiresAt <= now) return null;

  const answer = (value: string) => run(async () => {
    const r = await answerAskAction(ask.id, value, showCode ? code : "");
    if (r.ok) {
      setSent(true);
      pollLaunchState();
    } else if (r.needCode) {
      setNeedCode(true);
    }
    return r;
  });

  const box = "rounded-md border border-line2 bg-input px-2.5 py-1.5 text-[12.5px] text-fg2 outline-none placeholder:text-mut2 focus:border-line-strong";
  return (
    <div className="flex flex-col gap-2.5 rounded-md border border-line-strong bg-raised p-3 max-md:wrap-break-word">
      <div className="flex items-baseline gap-2 text-[12.5px] font-medium text-fg">
        <span className="h-[7px] w-[7px] shrink-0 translate-y-[-1px] rounded-full bg-accent" />
        <span className="min-w-0 flex-1">{ask.kind === "permission" ? tx("{0} wants to use {1}", [who, ask.tool]) : tx("{0} asks you", [who])}</span>
        <span className="shrink-0 text-[11.5px] font-normal text-mut2" suppressHydrationWarning>{tx("waits until")}{" "}{tx.date(ask.expiresAt, "HH:mm")}</span>
      </div>
      {ask.kind === "permission"
        ? <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-input px-2.5 py-2 font-mono text-[11.5px] leading-[1.5] text-fg2">{ask.text}</pre>
        : <p className="whitespace-pre-wrap text-[12.5px] leading-[1.55] text-fg2">{ask.text}</p>}
      {!ask.here && !ask.remoteOk ? (
        <p className="text-[12px] leading-snug text-mut2">
          {tx("Answer it on the computer the session runs on: that computer takes answers only there (Answer from elsewhere, in its Settings).")}</p>
      ) : (
        <>
          {ask.kind === "question" && (
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} aria-label={tx("Your answer")} placeholder={tx("Your answer")}
              onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && text.trim()) { e.preventDefault(); answer(text); } }}
              className={cx(box, "field-sizing-content min-h-[52px] resize-none leading-[1.55] max-md:text-[16px]")} />
          )}
          {showCode && (
            <label className="flex items-center gap-2 text-[12px] text-mut">
              {tx("Two-factor code")}<input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code"
                aria-label={tx("Two-factor code")} placeholder="123456" className={cx(box, "w-[92px] font-mono tracking-widest max-md:text-[16px]")} />
            </label>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {ask.kind === "permission" ? (
              <>
                <Button variant="primary" disabled={pending || (showCode && code.length !== 6)} onClick={() => answer("allow")}>{tx("Allow")}</Button>
                <Button disabled={pending || (showCode && code.length !== 6)} onClick={() => answer("deny")}>{tx("Refuse")}</Button>
              </>
            ) : (
              <Button variant="primary" disabled={pending || !text.trim() || (showCode && code.length !== 6)} onClick={() => answer(text)}>{tx("Send answer")}</Button>
            )}
            {ask.here && ask.kind === "permission" && (
              <Button variant="ghost" disabled={pending} title={tx("Its terminal asks too: PacedMind stops asking")}
                onClick={() => run(async () => { const r = await withdrawAskAction(ask.id); if (r.ok) setSent(true); return r; })}>
                {tx("Answer in the terminal")}</Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
