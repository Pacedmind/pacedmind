"use client";

import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { createTranslator, LANGUAGE_COOKIE, type Language } from "@/lib/i18n";

const LanguageContext = createContext<Language>("en");

export function LanguageProvider({ language, children }: { language: Language; children: ReactNode }) {
  const router = useRouter();
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    let live = true;
    const sync = () => navigator.serviceWorker.controller?.postMessage({ kind: "pacedmind-language", language });
    navigator.serviceWorker.addEventListener("controllerchange", sync);
    navigator.serviceWorker.ready.then((registration) => { if (live) registration.active?.postMessage({ kind: "pacedmind-language", language }); }).catch(() => {});
    return () => { live = false; navigator.serviceWorker.removeEventListener("controllerchange", sync); };
  }, [language]);
  useEffect(() => window.pacedMindDesktop?.onLanguageChanged?.(() => router.refresh()), [router]);
  useEffect(() => {
    const changed = () => router.refresh();
    const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("pacedmind-language");
    channel?.addEventListener("message", changed);
    return () => { channel?.close(); };
  }, [router]);
  return <LanguageContext.Provider value={language}>{children}</LanguageContext.Provider>;
}

export function useTranslation() {
  const language = useContext(LanguageContext);
  return useMemo(() => createTranslator(language), [language]);
}

export function LanguageSelector() {
  const tx = useTranslation();
  const router = useRouter();
  return <select aria-label={tx("Language")} value={tx.language} onChange={(event) => {
    const language = event.target.value === "pl" ? "pl" : "en";
    document.cookie = `${LANGUAGE_COOKIE}=${language}; Path=/; Max-Age=31536000; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;
    window.pacedMindDesktop?.setLanguage?.(language);
    if (typeof BroadcastChannel !== "undefined") { const channel = new BroadcastChannel("pacedmind-language"); channel.postMessage(language); channel.close(); }
    router.refresh();
  }} className="h-7 rounded-md border border-line2 bg-input px-2 text-[12.5px] text-fg2">
    <option value="pl">Polski</option><option value="en">English</option>
  </select>;
}
