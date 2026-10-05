export type NoteRegion = { x: number; y: number; width: number; height: number };
export type NoteLayoutSettings = {
  size: "small" | "medium" | "large";
  group: "none" | "focus" | "project" | "area" | "priority";
  order: "manual" | "relevance" | "deadline";
  emphasis: boolean;
  animation: "shuffle" | "right" | "diagonal" | "together" | "none";
  regions: Record<string, NoteRegion>;
};
export type NoteDisplay = NoteRegion & {
  id: string; label: string; primary: boolean; openCount: number; settings: NoteLayoutSettings; compact: boolean;
  groups: (NoteRegion & { key: string; name: string; count: number })[];
  notes: (NoteRegion & { ref: string; title: string })[];
};
export type NoteWorkspace = { scope: string; defaultDisplay: string | null; displays: NoteDisplay[] };
export type NoteLayoutReply = { ok: boolean; error?: string; workspace?: NoteWorkspace };
export type NoteLayoutChange = { displayId: string; settings?: Partial<NoteLayoutSettings>; move?: boolean; ref?: string; bounds?: NoteRegion };
export type NoteStyle = { size: NoteLayoutSettings["size"]; emphasis: "strong" | "normal" | "quiet" };
