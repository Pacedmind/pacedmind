import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import ts from "typescript";
import polish from "../src/lib/messages.pl.json";

const root = path.resolve(import.meta.dirname, "..");
const dictionary: Record<string, string> = polish;
const literalExceptions = new Set(["PacedMind", "PacedMind Cloud", "Claude Code", "Codex", "English", "Polski", "CLI", "min", "Enter", "Ctrl ↵", "Ctrl K", "/mcp", "codex mcp login pacedmind", "npm run skills"]);

function sourceFiles(folder: string): string[] {
  return fs.readdirSync(folder, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(folder, entry.name);
    return entry.isDirectory() ? sourceFiles(file) : /\.(tsx?|mjs)$/.test(entry.name) ? [file] : [];
  });
}

test("UI messages, accessible labels and native note errors have Polish translations", () => {
  const missing: string[] = [];
  const files = [...sourceFiles(path.join(root, "src")), ...["task-windows", "task-note-layout", "task-note-workspace", "task-note-controls"].map(name => path.join(root, "desktop", name + ".mjs"))];
  for (const file of files) {
    const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const report = (node: ts.Node, message: string) => missing.push(`${path.relative(root, file)}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: ${message}`);
    function visit(node: ts.Node) {
      if (ts.isCallExpression(node) && node.expression.getText(source) === "tx" && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && !(node.arguments[0].text in dictionary)) report(node, node.arguments[0].text);
      if (ts.isJsxText(node)) {
        const text = node.text.trim();
        if (/[A-Za-z]{3}/.test(text) && !literalExceptions.has(text)) report(node, "Untranslated text: " + text);
      }
      if (ts.isJsxAttribute(node) && /^(label|title|note|placeholder|aria-label|description|confirmLabel)$/.test(node.name.getText(source)) && node.initializer && ts.isStringLiteral(node.initializer) && /[A-Za-z]{3}/.test(node.initializer.text) && !literalExceptions.has(node.initializer.text)) report(node, "Untranslated label: " + node.initializer.text);
      if (file.endsWith(".mjs") && ts.isPropertyAssignment(node) && node.name.getText(source) === "error" && ts.isStringLiteral(node.initializer) && !(node.initializer.text in dictionary)) report(node, node.initializer.text);
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  assert.deepEqual(missing, []);
});
