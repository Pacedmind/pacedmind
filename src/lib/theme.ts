export type Theme = "dark" | "light";
export type TaskNotesState = { count: number; visible: boolean; ok?: boolean; error?: string; message?: string };

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
      taskNotesState?: () => Promise<TaskNotesState | null>;
      toggleTaskNotes?: () => Promise<TaskNotesState | null>;
      onTaskNotesChanged?: (listener: (state: TaskNotesState) => void) => () => void;
      showFloatingTask?: (href: string) => Promise<boolean>;
      onTaskNoteVersion?: (listener: (version: string) => void) => () => void;
    };
  }
}

// Runs before the first paint, including when local storage is unavailable.
export const THEME_INIT_SCRIPT = `(() => {
  let theme = window.pacedMindDesktop?.initialTheme || 'dark';
  try { const saved = localStorage.getItem('${THEME_STORAGE_KEY}'); if (saved === 'light' || saved === 'dark') theme = saved; } catch {}
  document.documentElement.dataset.theme = theme;
})();`;
