// One scheduler for all native windows. Replacing an operation starts at the current frame.
export function createNoteMotion({ enabled = () => true } = {}) {
  const jobs = new Map();
  let timer = null;
  const stopTimer = () => { if (!jobs.size && timer) { clearInterval(timer); timer = null; } };
  const tick = () => {
    const now = Date.now();
    for (const [note, job] of jobs) {
      if (note.window.isDestroyed()) { jobs.delete(note); continue; }
      const t = Math.max(0, Math.min(1, (now - job.start) / job.duration));
      if (now < job.start) continue;
      const ease = 1 - (1 - t) ** 3;
      if (job.bounds) {
        const b = Object.fromEntries(Object.keys(job.bounds).map(k => [k, Math.round(job.from[k] + (job.bounds[k] - job.from[k]) * ease)]));
        note.window.setBounds(b);
      }
      if (job.opacity !== undefined) note.window.setOpacity?.(job.fromOpacity + (job.opacity - job.fromOpacity) * ease);
      if (t === 1) { jobs.delete(note); job.done?.(); }
    }
    stopTimer();
  };
  return {
    has: note => jobs.has(note),
    cancel(note) { jobs.delete(note); stopTimer(); },
    run(note, { bounds, opacity, delay = 0, immediate = false, done }) {
      jobs.delete(note);
      if (note.window.isDestroyed()) { stopTimer(); return; }
      if (immediate || !enabled() || note.reducedMotion || !note.ready) {
        if (bounds) note.window.setBounds(bounds);
        if (opacity !== undefined) note.window.setOpacity?.(opacity);
        done?.(); stopTimer(); return;
      }
      jobs.set(note, { from: note.window.getBounds(), fromOpacity: note.window.getOpacity?.() ?? 1, bounds, opacity, start: Date.now() + delay, duration: 240, done });
      if (!timer) { timer = setInterval(tick, 16); timer.unref?.(); }
    },
  };
}
