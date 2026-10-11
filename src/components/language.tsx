"use client";

import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { createTranslator, LANGUAGE_COOKIE, type Language } from "@/lib/i18n";
import { createLanguageState } from "@/lib/language-state";

const LanguageContext = createContext<Language>("en");
const languageState = createLanguageState();

function applyLanguage(value: unknown) {
  if (!languageState.set(value)) return false;
  document.documentElement.lang = languageState.get("en");
  return true;
}

export function LanguageProvider({ language, children }: { language: Language; children: ReactNode }) {
  const router = useRouter();
  const selected = useSyncExternalStore(languageState.subscribe, () => languageState.get(language), () => language);
  useEffect(() => { document.documentElement.lang = selected; }, [selected, language]);
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    let live = true;
    const sync = () => navigator.serviceWorker.controller?.postMessage({ kind: "pacedmind-language", language: selected });
    navigator.serviceWorker.addEventListener("controllerchange", sync);
    navigator.serviceWorker.ready.then((registration) => { if (live) registration.active?.postMessage({ kind: "pacedmind-language", language: selected }); }).catch(() => {});
    return () => { live = false; navigator.serviceWorker.removeEventListener("controllerchange", sync); };
  }, [selected]);
  useEffect(() => window.pacedMindDesktop?.onLanguageChanged?.((value) => { if (applyLanguage(value)) router.refresh(); }), [router]);
  useEffect(() => {
    const changed = (event: MessageEvent) => { if (applyLanguage(event.data)) router.refresh(); };
    const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("pacedmind-language");
    channel?.addEventListener("message", changed);
    return () => { channel?.close(); };
  }, [router]);
  return <LanguageContext.Provider value={selected}>{children}</LanguageContext.Provider>;
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
    applyLanguage(language);
    window.pacedMindDesktop?.setLanguage?.(language);
    if (typeof BroadcastChannel !== "undefined") { const channel = new BroadcastChannel("pacedmind-language"); channel.postMessage(language); channel.close(); }
    router.refresh();
  }} className="h-7 rounded-md border border-line2 bg-input px-2 text-[12.5px] text-fg2">
    <option value="pl">Polski</option><option value="en">English</option>
  </select>;
}
