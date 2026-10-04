import "server-only";
import type { NoteDisplays } from "@/lib/task-notes";

// Only Electron's authenticated bridge publishes this. Keep it out of the database without an account.
const g = globalThis as unknown as { __pacedmindNoteDisplays?: { scope: string; value: NoteDisplays } };
export function localNoteDisplays(scope: string): NoteDisplays | null {
  return g.__pacedmindNoteDisplays?.scope === scope ? g.__pacedmindNoteDisplays.value : null;
}
export function publishNoteDisplays(scope: string, value: NoteDisplays) {
  g.__pacedmindNoteDisplays = { scope, value };
}
