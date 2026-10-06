"use client";
import { useTranslation } from "@/components/language";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { Icon } from "@/components/icons";
import { Button, cx } from "@/components/ui";
import { agentConnectionAction, approveAgentAction, denyAgentAction } from "./actions";

type Note = { text: string; error: boolean } | null;
type Connection = { login: string; state: "waiting" | "connected" | "unconfirmed" | "ended" };

/** Local agents return in a temporary window; this page stays open until their connection is confirmed. */
export function ConsentForm({ id, held, name, local, children }: {
  id: string; held: string | null; name: string | null; local: boolean; children: ReactNode;
}) {
  const tx = useTranslation();
  const [note, setNote] = useState<Note>(null);
  const [done, setDone] = useState(false);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [pending, start] = useTransition();
  const popup = useRef<Window | null>(null);

  useEffect(() => {
    if (connection?.state !== "waiting") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const deadline = Date.now() + 60_000;
    const timeout = setTimeout(() => {
      cancelled = true;
      clearTimeout(timer);
      setConnection({ login: connection.login, state: "unconfirmed" });
    }, 60_000);
    const check = async () => {
      try {
        const state = await agentConnectionAction(connection.login);
        if (cancelled) return;
        if (state !== "waiting") {
          try { popup.current?.close(); } catch { /* A callback may isolate its window; its sign-in still counts. */ }
          popup.current = null;
          setConnection({ login: connection.login, state });
          return;
        }
        if (Date.now() < deadline) {
          timer = setTimeout(check, 1500);
          return;
        }
      } catch {
        if (cancelled) return;
      }
      setConnection({ login: connection.login, state: "unconfirmed" });
    };
    void check();
    return () => { cancelled = true; clearTimeout(timer); clearTimeout(timeout); };
  }, [connection]);

  const allow = () => {
    // Open during the click, before awaiting approval, so browsers allow it. Hosted callbacks and custom app
    // schemes keep their normal navigation. A blocked popup falls back to the same working sign-in in this tab.
    const target = local ? window.open("about:blank", "_blank", "popup,width=480,height=360") : null;
    popup.current = target;
    if (target) {
      target.document.title = tx("Connecting · PacedMind");
      target.document.body.textContent = tx("Finishing your connection to PacedMind…");
      const theme = getComputedStyle(document.documentElement);
      Object.assign(target.document.body.style, {
        margin: "0", padding: "40px", font: "14px system-ui, sans-serif", lineHeight: "1.6",
        backgroundColor: theme.getPropertyValue("--color-bg"), color: theme.getPropertyValue("--color-fg3"),
      });
    }
    setNote(null);
    start(async () => {
      try {
        const result = await approveAgentAction(id, held);
        if (!result.ok) {
          target?.close();
          popup.current = null;
          setNote({ text: result.error, error: true });
          return;
        }
        if (!result.local || !target || target.closed) {
          target?.close();
          popup.current = null;
          window.location.assign(result.url);
          return;
        }
        target.location.replace(result.url);
        setConnection({ login: result.login, state: "waiting" });
      } catch {
        target?.close();
        popup.current = null;
        setNote({ text: tx("PacedMind couldn't finish the request. Start connecting the agent again."), error: true });
      }
    });
  };

  const run = (fn: () => Promise<{ ok: boolean; error?: string; message?: string } | undefined>) =>
    start(async () => {
      const r = await fn();
      if (!r) return;
      setNote({ text: (r.ok ? r.message : r.error) ?? tx("Something went wrong."), error: !r.ok });
      if (r.ok) setDone(true);
    });

  if (connection) {
    const connected = connection.state === "connected";
    const waiting = connection.state === "waiting";
    return (
      <div className="flex flex-col items-center gap-5 rounded-xl border border-line bg-panel p-7 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full border border-line2 bg-raised text-fg2" aria-hidden="true">
          {waiting
            ? <span className="h-5 w-5 animate-spin rounded-full border-2 border-line-strong border-t-fg2 motion-reduce:animate-none" />
            : <Icon name={connected ? "check" : "terminal"} size={23} />}
        </div>
        <div role="status" aria-live="polite" className="flex flex-col gap-2">
          <h1 className="text-[18px] font-semibold tracking-tight text-strong">
            {connected ? tx("Connected to PacedMind") : waiting ? tx("Finishing connection…") : tx("Connection not confirmed")}
          </h1>
          <p className="text-[13px] leading-relaxed text-fg3">
            {connected
              ? tx("{0} can now use your PacedMind Cloud planner.", [name || tx("Your agent")])
              : waiting
                ? tx("Your agent is completing its sign-in. Its temporary window will close when it’s ready.")
                : connection.state === "ended"
                  ? tx("This sign-in has ended. Start connecting the agent again.")
                  : tx("Check your agent’s sign-in window. If it finished, check the connection again.")}
          </p>
        </div>
        {connected ? (
          <>
            <p className="text-[13px] leading-relaxed text-mut">{tx("Return to")}{" "}{name || tx("your agent")} {" "}{tx("to continue. You can close this tab.")}</p>
            <Link href="/today" className="flex h-9 w-full items-center justify-center rounded-md bg-accent-strong px-3 text-[13px] font-medium text-white hover:brightness-110">
              {tx("Open PacedMind")}</Link>
            <Link href="/settings/mcp" className="text-[12px] text-mut underline-offset-4 hover:text-fg2 hover:underline">
              {tx("Manage connected agents")}</Link>
          </>
        ) : connection.state === "unconfirmed" && (
          <Button type="button" className="h-9 justify-center text-[13px]" onClick={() => setConnection({ ...connection, state: "waiting" })}>
            {tx("Check connection")}</Button>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-line bg-panel p-6">
      {children}
      {note && (
        <p role={note.error ? "alert" : "status"}
          className={cx("rounded-md border px-3 py-2 text-[12.5px] leading-relaxed", note.error ? "border-line-strong text-fg" : "border-line2 text-fg3")}>
          {note.text}
        </p>
      )}
      {!done && (
        <div className="flex gap-2">
          <Button type="button" disabled={pending} onClick={() => run(() => denyAgentAction(id, held !== null))} className="h-9 flex-1 justify-center text-[13px]">
            {tx("Deny")}</Button>
          <Button type="button" variant="primary" disabled={pending} onClick={allow} className="h-9 flex-1 justify-center text-[13px]">
            {tx("Allow")}</Button>
        </div>
      )}
    </div>
  );
}
