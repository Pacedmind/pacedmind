import type { Language } from "./i18n";

/** A user's latest choice wins over older server renders still arriving in the background. */
export function createLanguageState() {
  let selected: Language | null = null;
  const listeners = new Set<() => void>();
  return {
    get: (fallback: Language) => selected ?? fallback,
    set(value: unknown): boolean {
      if ((value !== "en" && value !== "pl") || value === selected) return false;
      selected = value;
      listeners.forEach(listener => listener());
      return true;
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
