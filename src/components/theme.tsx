"use client";

import { useEffect, useSyncExternalStore } from "react";
import { THEME_STORAGE_KEY, type Theme, type ThemePreference } from "@/lib/theme";
import { Icon } from "./icons";
import { Segmented } from "./ui";

const EVENT = "pacedmind:theme";
const getTheme = (): Theme => document.documentElement.dataset.theme === "light" ? "light" : "dark";
const getServerTheme = (): Theme => "dark";
const isNote = () => location.pathname.startsWith("/floating/task/");
function preference(): ThemePreference {
  try { const saved = localStorage.getItem(THEME_STORAGE_KEY); if (saved === "system" || saved === "light") return saved; } catch {}
  return "dark";
}
const resolve = (value: ThemePreference): Theme => value === "system" ? matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light" : value;

function subscribe(onChange: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key !== THEME_STORAGE_KEY) return;
    if (isNote() && window.pacedMindDesktop?.onTaskNoteTheme) return;
    document.documentElement.dataset.theme = resolve(preference());
    onChange();
  };
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", onStorage);
  const media = matchMedia("(prefers-color-scheme: dark)");
  const onSystem = () => { if (preference() === "system" && !isNote()) { document.documentElement.dataset.theme = resolve("system"); onChange(); } };
  media.addEventListener("change", onSystem);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", onStorage);
    media.removeEventListener("change", onSystem);
  };
}

function useTheme() {
  return useSyncExternalStore(subscribe, getTheme, getServerTheme);
}

function setTheme(theme: ThemePreference) {
  document.documentElement.dataset.theme = resolve(theme);
  try { localStorage.setItem(THEME_STORAGE_KEY, theme); } catch { /* The current session still switches. */ }
  window.dispatchEvent(new Event(EVENT));
}

export function ThemeSync() {
  const theme = useTheme();
  const selected = useSyncExternalStore(subscribe, preference, getServerTheme);
  useEffect(() => { if (!isNote()) window.pacedMindDesktop?.setTheme(getTheme(), selected); }, [theme, selected]);
  return null;
}

export function ThemeToggle() {
  const theme = useTheme();
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button type="button" aria-label={`Switch to ${next} mode`} title={`Switch to ${next} mode`}
      onClick={() => setTheme(next)} className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-md text-mut hover:bg-hover hover:text-fg2">
      <Icon name={next === "light" ? "sun" : "moon"} size={16} />
    </button>
  );
}

export function ThemeSelector() {
  const theme = useSyncExternalStore(subscribe, preference, getServerTheme);
  return <Segmented value={theme} onChange={setTheme} options={[
    { value: "dark", label: <><Icon name="moon" size={13} />Dark</> },
    { value: "light", label: <><Icon name="sun" size={13} />Light</> },
    { value: "system", label: <><Icon name="appWindow" size={13} />System</> },
  ]} />;
}
