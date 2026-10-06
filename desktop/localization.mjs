import fs from "node:fs";
import path from "node:path";

const bundled = path.join(import.meta.dirname, "messages.pl.json");
const messages = JSON.parse(fs.readFileSync(fs.existsSync(bundled) ? bundled : path.join(import.meta.dirname, "../src/lib/messages.pl.json"), "utf8"));
export function desktopText(message, language, values = []) {
  const text = language === "pl" ? (message === "Edit" ? "Edycja" : messages[message] ?? message) : message;
  return text.replace(/\{(\d+)\}/g, (placeholder, index) => Number(index) < values.length ? String(values[Number(index)] ?? "") : placeholder);
}
