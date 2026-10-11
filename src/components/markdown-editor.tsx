"use client";
import { useTranslation } from "@/components/language";
import { type Translator } from "@/lib/i18n";

import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { commonmarkLanguage, markdown } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { Compartment, EditorSelection, EditorState, type Range, type StateCommand } from "@codemirror/state";
import {
  Decoration, EditorView, ViewPlugin, WidgetType, keymap, placeholder as placeholderText, type DecorationSet, type ViewUpdate,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { Autolink } from "@lezer/markdown";
import { useEffect, useRef } from "react";
import { Markdown } from "./markdown";
import { cx } from "./ui";

/*
 * A Markdown text edited where it shows, as in Obsidian's live preview: the text stays Markdown, shown formatted,
 * and the marks (**, #, `, a link's address) show only on the lines the cursor is on. A click puts the cursor where
 * it lands. The same Markdown as markdown.tsx: CommonMark with bare links, no tables or strikethrough.
 */

class Bullet extends WidgetType {
  eq() { return true; }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-md-bullet";
    el.textContent = "•";
    return el;
  }
}

const hide = Decoration.replace({});
const bullet = Decoration.replace({ widget: new Bullet() });
const inlineCode = Decoration.mark({ class: "cm-md-icode" });
const link = (tx: Translator) => (Decoration.mark({ class: "cm-md-link", attributes: { title: tx("Ctrl+click to open") } }));
const quoteLine = Decoration.line({ class: "cm-md-quote" });
const fenceLine = Decoration.line({ class: "cm-md-fence" });

function decorations(view: EditorView, tx: Translator): DecorationSet {
  const { state } = view;
  const doc = state.doc;
  // The lines with the cursor or the selection show their marks, while the editor has focus.
  const active = new Set<number>();
  if (view.hasFocus) {
    for (const r of state.selection.ranges) {
      for (let n = doc.lineAt(r.from).number; n <= doc.lineAt(r.to).number; n++) active.add(n);
    }
  }
  const shown = (pos: number) => active.has(doc.lineAt(pos).number);
  // A mark and the space after it (a heading's #, a quote's >).
  const withSpace = (to: number) => doc.sliceString(to, to + 1) === " " ? to + 1 : to;
  const out: Range<Decoration>[] = [];
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from, to,
      enter: (node) => {
        const parent = node.node.parent?.name;
        switch (node.name) {
          case "HeaderMark":
            if (!shown(node.from)) out.push(hide.range(node.from, withSpace(node.to)));
            break;
          case "EmphasisMark":
            if (!shown(node.from)) out.push(hide.range(node.from, node.to));
            break;
          case "InlineCode":
            out.push(inlineCode.range(node.from, node.to));
            break;
          case "CodeMark":
            if (parent === "InlineCode" && !shown(node.from)) out.push(hide.range(node.from, node.to));
            break;
          case "FencedCode":
            for (let n = doc.lineAt(node.from).number; n <= doc.lineAt(node.to).number; n++) out.push(fenceLine.range(doc.line(n).from));
            break;
          case "Blockquote":
            for (let n = doc.lineAt(node.from).number; n <= doc.lineAt(node.to).number; n++) out.push(quoteLine.range(doc.line(n).from));
            break;
          case "QuoteMark":
            if (!shown(node.from)) out.push(hide.range(node.from, withSpace(node.to)));
            break;
          case "ListMark":
            if (parent === "ListItem" && node.node.parent?.parent?.name === "BulletList" && !shown(node.from)) out.push(bullet.range(node.from, node.to));
            break;
          case "Link":
            out.push(link(tx).range(node.from, node.to));
            break;
          case "LinkMark": case "LinkTitle":
            if (parent === "Link" && !shown(node.from)) out.push(hide.range(node.from, node.to));
            break;
          case "URL":
            if (parent === "Link") { if (!shown(node.from)) out.push(hide.range(node.from, node.to)); }
            else out.push(link(tx).range(node.from, node.to));
            break;
        }
      },
    });
  }
  return Decoration.set(out, true);
}

const livePreview = (tx: Translator) => ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = decorations(view, tx); }
  update(u: ViewUpdate) {
    if (u.docChanged || u.selectionSet || u.viewportChanged || u.focusChanged) this.decorations = decorations(u.view, tx);
  }
}, { decorations: (v) => v.decorations });

/** The address of the link at a position: a [text](address) or a bare one. Only http(s). */
function linkAt(view: EditorView, pos: number): string | null {
  for (let n: ReturnType<typeof syntaxTree>["topNode"] | null = syntaxTree(view.state).resolveInner(pos, 1); n; n = n.parent) {
    const url = n.name === "URL" ? n : n.name === "Link" ? n.getChild("URL") : null;
    if (url) {
      const href = view.state.sliceDoc(url.from, url.to);
      return /^https?:\/\//i.test(href) ? href : null;
    }
  }
  return null;
}

// Ctrl+B and Ctrl+I (⌘ on a Mac): the selection bold or italic, or the marks to type into.
const wrap = (mark: string): StateCommand => ({ state, dispatch }) => {
  dispatch(state.update(state.changeByRange((r) => ({
    changes: [{ from: r.from, insert: mark }, { from: r.to, insert: mark }],
    range: r.empty ? EditorSelection.cursor(r.from + mark.length) : EditorSelection.range(r.from + mark.length, r.to + mark.length),
  })), { userEvent: "input" }));
  return true;
};

const style = HighlightStyle.define([
  { tag: tags.heading, fontWeight: "500", color: "var(--color-fg2)" },
  { tag: tags.strong, fontWeight: "600", color: "var(--color-fg2)" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.processingInstruction, color: "var(--color-dim)" },
]);

const theme = EditorView.theme({
  "&": { color: "inherit", backgroundColor: "transparent", fontSize: "inherit" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "inherit", lineHeight: "inherit", overflow: "visible" },
  ".cm-content": { padding: "0", caretColor: "var(--color-strong)" },
  ".cm-line": { padding: "0" },
  ".cm-placeholder": { color: "var(--color-dim)" },
  ".cm-md-icode": {
    fontFamily: "var(--font-mono)", fontSize: "11.5px", backgroundColor: "var(--color-hover)", borderRadius: "4px", padding: "1px 4px",
  },
  ".cm-md-link": {
    color: "var(--color-fg2)", textDecoration: "underline", textDecorationColor: "var(--color-line-strong)", textUnderlineOffset: "2px",
  },
  ".cm-md-quote": { borderLeft: "2px solid var(--color-line-strong)", paddingLeft: "12px", color: "var(--color-mut2)" },
  ".cm-md-fence": { fontFamily: "var(--font-mono)", fontSize: "11.5px", backgroundColor: "var(--color-raised)", paddingLeft: "12px" },
  ".cm-md-bullet": { color: "var(--color-dim)", display: "inline-block", width: "0.6em" },
});

// Ctrl+Enter is left to the page (quick add creates the task with it).
const keys = defaultKeymap.filter((k) => k.key !== "Mod-Enter");

export function MarkdownEditor({ value, onChange, onBlur, placeholder, label, autoFocus, className }: {
  value: string;
  onChange: (text: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  label: string;
  autoFocus?: boolean;
  /** The text's size and color, and its height limits. */
  className?: string;
}) {
  const tx = useTranslation();
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const languageConfig = useRef(new Compartment());
  // The latest callbacks, so the editor made once always calls them.
  const handlers = useRef({ onChange, onBlur });
  useEffect(() => { handlers.current = { onChange, onBlur }; });

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          keymap.of([{ key: "Mod-b", run: wrap("**") }, { key: "Mod-i", run: wrap("*") }, ...historyKeymap, ...keys]),
          markdown({ base: commonmarkLanguage, extensions: [Autolink] }),
          syntaxHighlighting(style),
          languageConfig.current.of([livePreview(tx), EditorView.contentAttributes.of({ "aria-label": label, "aria-multiline": "true" }), placeholder ? placeholderText(placeholder) : []]),
          theme,
          EditorView.lineWrapping,
          EditorView.domEventHandlers({
            mousedown(e, v) {
              if (!(e.ctrlKey || e.metaKey)) return false;
              const pos = v.posAtCoords({ x: e.clientX, y: e.clientY });
              const href = pos === null ? null : linkAt(v, pos);
              if (!href) return false;
              e.preventDefault();
              window.open(href, "_blank", "noopener,noreferrer");
              return true;
            },
          }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) handlers.current.onChange(u.state.doc.toString());
            if (u.focusChanged && !u.view.hasFocus) handlers.current.onBlur?.();
          }),
        ],
      }),
    });
    view.current = v;
    if (autoFocus) v.focus();
    return () => { v.destroy(); view.current = null; };
    // Made once; later values come in through the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    view.current?.dispatch({ effects: languageConfig.current.reconfigure([livePreview(tx), EditorView.contentAttributes.of({ "aria-label": label, "aria-multiline": "true" }), placeholder ? placeholderText(placeholder) : []]) });
  }, [tx, label, placeholder]);

  // A value changed from outside (quick add cleared for the next task, say).
  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
  }, [value]);

  // Until the editor is made in the browser, the text shows formatted (it replaces this once it's there).
  return (
    <div className={cx("min-w-0 cursor-text leading-relaxed [&:has(.cm-editor)>[data-fallback]]:hidden", className)}
      // A click on the room around the text (below a short one) puts the cursor at its end.
      onMouseDown={(e) => {
        const v = view.current;
        if (!v || v.contentDOM.contains(e.target as Node)) return;
        e.preventDefault();
        v.focus();
        v.dispatch({ selection: { anchor: v.state.doc.length } });
      }}>
      <div data-fallback>{value.trim() ? <Markdown text={value} breaks className="" /> : <span className="text-dim">{placeholder}</span>}</div>
      <div ref={host} />
    </div>
  );
}
