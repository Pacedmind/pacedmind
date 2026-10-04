import { z } from "zod";

export const displayIdSchema = z.string().regex(/^-?\d{1,20}$/);
export const noteDisplaysSchema = z.object({
  displays: z.array(z.object({
    id: displayIdSchema, label: z.string().min(1).max(100).regex(/^[^\x00-\x1f\x7f]+$/),
    x: z.number().int().min(-100_000).max(100_000), y: z.number().int().min(-100_000).max(100_000),
    width: z.number().int().positive().max(32768), height: z.number().int().positive().max(32768),
    primary: z.boolean(), capacity: z.number().int().min(0).max(20_000), openCount: z.number().int().min(0).max(200),
  })).min(1).max(16),
  defaultDisplay: displayIdSchema.nullable(), updatedAt: z.string().datetime({ offset: true }),
});
export type NoteDisplays = z.infer<typeof noteDisplaysSchema>;
export const noteDisplaysOf = (value: unknown): NoteDisplays | null => noteDisplaysSchema.safeParse(value).data ?? null;
export const noteDisplaysFresh = (value: NoteDisplays | null) => !!value && Math.abs(Date.now() - Date.parse(value.updatedAt)) < 90_000;

export interface TaskNoteInput {
  deviceId: string; taskId: number; taskCreatedAt: string; displayId: string; remember: boolean;
}
export interface TaskNoteRequest extends TaskNoteInput {
  id: string; status: "pending" | "dispatched" | "opened" | "failed" | "expired";
  requestedAt: string; expiresAt: string; note: string | null;
}

/** An explicit selection always includes the user's answer about remembering it. */
export function chooseNoteDisplay(snapshot: NoteDisplays, display?: string, remember?: boolean): string {
  if (display !== undefined) {
    if (!snapshot.displays.some((d) => d.id === display)) throw new Error("That display is no longer connected. List displays and ask the user again.");
    if (remember === undefined) throw new Error("Ask the user whether to remember this display, then pass remember: true or false.");
    return display;
  }
  if (remember !== undefined) throw new Error("Name the display the user chose before saving a preference.");
  if (snapshot.defaultDisplay) {
    if (snapshot.displays.some((d) => d.id === snapshot.defaultDisplay)) return snapshot.defaultDisplay;
    throw new Error("The remembered display is disconnected. Ask which display to use and whether to remember it.");
  }
  if (snapshot.displays.length === 1) return snapshot.displays[0].id;
  throw new Error("Ask the user which display to use and whether to always use it for task notes on this computer. Then call show_task_note with display and remember. No note has been opened.");
}
