import polish from "./messages.pl.json";
import { format as dateFormat, type FormatOptions } from "date-fns";
import { pl, enUS } from "date-fns/locale";

export type Language = "en" | "pl";
export const LANGUAGE_COOKIE = "pm_language";
export const languageOf = (value: unknown): Language => value === "pl" ? "pl" : "en";
export type Translator = ((message: string, values?: readonly unknown[]) => string) & {
  language: Language;
  date: (date: Parameters<typeof dateFormat>[0], pattern: string, options?: FormatOptions) => string;
  generated: (message: string) => string;
  count: (count: number, noun: CountNoun) => string;
};
const countForms = {
  activity: ["aktywność", "aktywności", "aktywności"],
  task: ["zadanie", "zadania", "zadań"],
  project: ["projekt", "projekty", "projektów"],
  area: ["obszar", "obszary", "obszarów"],
  session: ["sesja", "sesje", "sesji"],
  skill: ["umiejętność", "umiejętności", "umiejętności"],
  plugin: ["wtyczka", "wtyczki", "wtyczek"],
  hook: ["hook", "hooki", "hooków"],
  workspace: ["obszar roboczy", "obszary robocze", "obszarów roboczych"],
  repository: ["repozytorium", "repozytoria", "repozytoriów"],
} as const;
export type CountNoun = keyof typeof countForms;
const messages: Record<string, string> = polish;
const fill = (message: string, values: readonly unknown[]) => message.replace(/\{(\d+)\}/g, (placeholder, index) => Number(index) < values.length ? String(values[Number(index)] ?? "") : placeholder);
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const generatedTemplates = Object.keys(messages).filter((key) => /\{\d+\}/.test(key)).sort((a, b) => b.length - a.length).map((key) => {
  const indices: number[] = [];
  const parts = key.split(/(\{\d+\})/g).map((part) => {
    if (!/^\{\d+\}$/.test(part)) return escape(part);
    indices.push(Number(part.slice(1, -1))); return "([\\s\\S]*?)";
  });
  return { key, indices, expression: new RegExp("^" + parts.join("") + "$") };
});

/** For application-generated API/desktop messages only; never pass user task titles or agent prose here. */
export function translateGenerated(message: string, language: Language): string {
  if (language === "en") return message;
  if (messages[message]) return messages[message];
  for (const template of generatedTemplates) {
    const match = template.expression.exec(message);
    if (!match) continue;
    const values: string[] = [];
    template.indices.forEach((index, i) => { values[index] = match[i + 1]; });
    return translate(template.key, language, values);
  }
  return message;
}

export function translate(message: string, language: Language = "en", values: readonly unknown[] = []): string {
  return fill(language === "pl" ? messages[message] ?? message : message, values);
}

export function createTranslator(language: Language): Translator {
  return Object.assign((message: string, values?: readonly unknown[]) => translate(message, language, values), {
    language, date: (date: Parameters<typeof dateFormat>[0], pattern: string, options?: FormatOptions) => formatDate(date, pattern, language, options),
    generated: (message: string) => translateGenerated(message, language),
    count: (count: number, noun: CountNoun) => language === "pl"
      ? `${count} ${plural(count, countForms[noun])}`
      : `${count} ${count === 1 ? noun : noun === "repository" ? "repositories" : noun === "activity" ? "activities" : noun + "s"}`,
  });
}

/** Polish distinguishes 1, 2–4 and 5+, including the special 12–14 endings. */
export function plural(count: number, forms: readonly [string, string, string], language: Language = "pl"): string {
  if (language === "en") return count === 1 ? forms[0] : forms[2];
  const category = new Intl.PluralRules("pl").select(count);
  return forms[category === "one" ? 0 : category === "few" ? 1 : 2];
}

export function formatDate(date: Parameters<typeof dateFormat>[0], pattern: string, language: Language, options?: FormatOptions): string {
  return dateFormat(date, language === "pl" ? pattern.replace(/'at'/g, "'o'") : pattern, { ...options, locale: language === "pl" ? pl : enUS });
}
