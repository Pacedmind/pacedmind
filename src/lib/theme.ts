export type Theme = "dark" | "light";

export const THEME_STORAGE_KEY = "pacedmind-theme";

declare global {
  interface Window {
    pacedMindDesktop?: {
      initialTheme: Theme;
      setTheme: (theme: Theme) => void;
      /** The system's folder dialog (desktop/preload.cjs); missing in a browser and in apps built before it. */
      pickFolder?: (near?: string | null) => Promise<string | null>;
      /** Independent, always-on-top task notes; missing in older desktop builds. */
      floatTask?: (id: number, scope: string, createdAt: string) => Promise<boolean | { ok: boolean; error?: string }>;
      closeTaskNote?: () => Promise<boolean>;
      showFloatingTask?: (href: string) => Promise<boolean>;
    };
  }
}

// Runs before the first paint, including when local storage is unavailable.
export const THEME_INIT_SCRIPT = `(() => {
  let theme = window.pacedMindDesktop?.initialTheme || 'dark';
  try { const saved = localStorage.getItem('${THEME_STORAGE_KEY}'); if (saved === 'light' || saved === 'dark') theme = saved; } catch {}
  document.documentElement.dataset.theme = theme;
})();`;
