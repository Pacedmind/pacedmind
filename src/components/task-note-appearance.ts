"use client";

import { useEffect } from "react";
import type { FloatingTaskData } from "@/lib/floating-task";

/** Notes receive a staggered theme from the desktop, instead of racing the storage event. */
export function useNoteAppearance(data: FloatingTaskData | null) {
  useEffect(() => {
    const desktop = window.pacedMindDesktop;
    let transitions: Animation[] = [];
    const style = desktop?.onTaskNoteStyle?.(value => {
      document.documentElement.dataset.noteSize = value.size;
      document.documentElement.dataset.noteEmphasis = value.emphasis;
    });
    const theme = desktop?.onTaskNoteTheme?.(({ theme, duration }) => {
      const elements = [...document.querySelectorAll<HTMLElement>(".task-note-surface, .task-note-surface *")];
      const colors = () => elements.map(el => { const s = getComputedStyle(el); return { color: s.color, backgroundColor: s.backgroundColor, borderColor: s.borderColor }; });
      const before = colors();
      transitions.forEach(a => a.cancel());
      transitions = [];
      document.documentElement.dataset.theme = theme;
      if (!duration || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      const after = colors();
      transitions = elements.map((el, i) => el.animate([before[i], after[i]], { duration, easing: "ease-in-out" }));
    });
    return () => { style?.(); theme?.(); transitions.forEach(a => a.cancel()); };
  }, []);
  useEffect(() => {
    if (!data) return;
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const report = () => window.pacedMindDesktop?.reportTaskNote?.({ ...data.task,
      projectId: data.projectId, projectName: data.projectName, areaId: data.areaId, areaName: data.areaName, reducedMotion: media.matches });
    report();
    media.addEventListener("change", report);
    // Refresh urgency when a planned day or deadline arrives, without relocating any notes.
    const timer = setInterval(report, 60_000);
    return () => { clearInterval(timer); media.removeEventListener("change", report); };
  }, [data]);
}
