"use client";
import { useTranslation } from "@/components/language";
import { createTranslator, type Translator } from "@/lib/i18n";

import { useEffect, useState } from "react";
import { pushKeyAction, removePushSubscriptionAction, savePushSubscriptionAction } from "@/app/actions";
import { Button, useAction } from "./ui";

/*
 * Notifications on your phone and in the browser (web push, src/server/push.ts): turned on per browser here, in the web
 * app. The computer a session runs on sends them when the session needs you. Lists the browsers that have them on, to
 * turn them off from anywhere. The desktop app notifies by itself and can't take web push.
 */

export interface PushDevice {
  endpoint: string;
  label: string;
  createdAt: string;
}

type Here = "checking" | "unsupported" | "install" | "blocked" | "off" | "on";

/** A browser's own words for itself, short: "Chrome on Android", "Safari on iPhone". */
function labelOf(ua: string, tx: Translator = createTranslator("en")): string {
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "Mac"
    : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /(Chrome|CriOS)\//.test(ua) ? "Chrome"
    : /Safari\//.test(ua) ? "Safari" : tx("Browser");
  return os ? tx("{0} on {1}", [browser, os]) : browser;
}

/** The public key as the Push API takes it. */
function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = (base64url + "===".slice((base64url.length + 3) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

const supported = () => typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
/** An iPhone or iPad shows notifications only for a web app added to the Home Screen. */
const needsInstall = () => /iPhone|iPad/.test(navigator.userAgent) && !window.matchMedia("(display-mode: standalone)").matches;

export function PushSettings({ devices, web }: { devices: PushDevice[]; web: boolean }) {
  const tx = useTranslation();
  const { run, pending } = useAction();
  const [here, setHere] = useState<Here>("checking");
  const [endpoint, setEndpoint] = useState<string | null>(null);

  useEffect(() => {
    let gone = false;
    (async () => {
      if (!web) return setHere("unsupported");
      if (!supported()) return setHere(needsInstall() ? "install" : "unsupported");
      const reg = await navigator.serviceWorker.getRegistration("/");
      const sub = await reg?.pushManager.getSubscription();
      if (gone) return;
      setEndpoint(sub?.endpoint ?? null);
      setHere(sub && devices.some((d) => d.endpoint === sub.endpoint) ? "on" : Notification.permission === "denied" ? "blocked" : "off");
    })().catch(() => !gone && setHere("off"));
    return () => { gone = true; };
  }, [web, devices]);

  const turnOn = () => run(async () => {
    const key = await pushKeyAction();
    if (!key.ok || !key.publicKey) return key;
    if ((await Notification.requestPermission()) !== "granted") {
      setHere("blocked");
      return { ok: false, error: tx("The browser didn't allow notifications. Allow them for this site in its settings.") };
    }
    const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    // One made with another key (the account's changed) can't take this account's messages.
    if (sub && sub.options.applicationServerKey) {
      const had = new Uint8Array(sub.options.applicationServerKey);
      const want = keyBytes(key.publicKey);
      if (had.length !== want.length || had.some((b, i) => b !== want[i])) {
        await sub.unsubscribe();
        sub = null;
      }
    }
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key.publicKey) });
    const json = sub.toJSON();
    const r = await savePushSubscriptionAction({
      endpoint: sub.endpoint, p256dh: json.keys?.p256dh ?? "", auth: json.keys?.auth ?? "", label: labelOf(navigator.userAgent, tx),
    });
    if (r.ok) {
      setEndpoint(sub.endpoint);
      setHere("on");
    }
    return r;
  });

  const turnOff = (which: string) => run(async () => {
    if (which === endpoint) {
      const reg = await navigator.serviceWorker.getRegistration("/");
      await (await reg?.pushManager.getSubscription())?.unsubscribe().catch(() => false);
      setHere("off");
    }
    return removePushSubscriptionAction(which);
  });

  const status: Record<Here, string> = {
    checking: tx("Checking…"),
    unsupported: web ? tx("This browser can't show notifications from websites.") : tx("This window shows its own notifications."),
    install: tx("Add PacedMind to your Home Screen first (Share → Add to Home Screen), then open it from there and turn this on."),
    blocked: tx("This browser blocks notifications from PacedMind. Allow them for this site in its settings, then turn this on."),
    off: tx("Off in this browser."),
    on: tx("On in this browser."),
  };

  return (
    <>
      <div className="flex items-center gap-3 border-b border-line px-3.5 py-2.5 last:border-b-0">
        <span className="w-[120px] shrink-0 text-[12.5px] text-mut2">{tx("This browser")}</span>
        <span className="min-w-0 flex-1 text-[12.5px] leading-snug text-fg3">{status[here]}</span>
        {here === "off" || here === "blocked" ? (
          <Button size="sm" disabled={pending} onClick={turnOn}>{tx("Turn on")}</Button>
        ) : here === "on" && endpoint ? (
          <Button size="sm" disabled={pending} onClick={() => turnOff(endpoint)}>{tx("Turn off")}</Button>
        ) : null}
      </div>
      {devices.map((d) => (
        <div key={d.endpoint} className="flex items-center gap-3 border-b border-line px-3.5 py-2.5 last:border-b-0">
          <span className="w-[120px] shrink-0 text-[12.5px] text-mut2">{d.endpoint === endpoint ? tx("This one") : tx("Also on")}</span>
          <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg3" title={tx("Since {0}", [d.createdAt.slice(0, 10)])}>{d.label || tx("A browser")}</span>
          {d.endpoint !== endpoint && (
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => turnOff(d.endpoint)}>{tx("Turn off")}</Button>
          )}
        </div>
      ))}
    </>
  );
}
