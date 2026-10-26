export type NoteRegion = { x: number; y: number; width: number; height: number };
export type NoteFill = { corner: "auto" | "top-left" | "top-right" | "bottom-left" | "bottom-right"; axis: "horizontal" | "vertical" };
export type NoteLayoutSettings = {
  size: "xs" | "small" | "medium" | "large";
  group: "none" | "focus" | "project" | "area" | "priority" | "status" | "deadline";
  arrangement: "grid" | "columns" | "rows";
  order: "manual" | "relevance" | "deadline";
  color: "none" | "project" | "area" | "blue" | "teal" | "green" | "sand" | "rose" | "violet";
  emphasis: boolean;
  animation: "shuffle" | "right" | "diagonal" | "together" | "cascade" | "center" | "none";
  regions: Record<string, NoteRegion>;
  fills: Record<string, NoteFill>;
};
export type NoteDisplay = NoteRegion & {
  id: string; label: string; primary: boolean; openCount: number; settings: NoteLayoutSettings; compact: boolean;
  groups: (NoteRegion & { key: string; name: string; count: number })[];
  notes: (NoteRegion & { ref: string; groupKey: string; title: string })[];
  presets: { name: string; settings: NoteLayoutSettings }[];
};
export type NoteWorkspace = { scope: string; defaultDisplay: string | null; displays: NoteDisplay[] };
export type NoteLayoutReply = { ok: boolean; error?: string; workspace?: NoteWorkspace };
export type NoteLayoutChange = { displayId: string; settings?: Partial<NoteLayoutSettings>; move?: boolean; rearrange?: boolean; preset?: { action: "save" | "load" | "delete"; name: string }; ref?: string; bounds?: NoteRegion };
export type NoteStyle = { size: NoteLayoutSettings["size"]; emphasis: "strong" | "normal" | "quiet"; color: string | null };
