import * as chrono from "chrono-node";
import { normalizePolishDates } from "./polish-dates";
import { toDateStr, toDateTimeStr } from "./dates";
import type { Priority } from "./types";

export type TokenKind = "date" | "priority" | "label" | "project" | "duration" | "repeat";

export interface ParsedToken {
  kind: TokenKind;
  text: string;
  index: number;
}

export interface ParsedInput {
  title: string;
  /** "YYYY-MM-DD" or "YYYY-MM-DDTHH:mm" */
  date: string | null;
  hasTime: boolean;
  /** Only a time was typed, with no day: "15:00", "at 5pm". Its day is the next one that has that time still ahead. */
  timeOnly: boolean;
  priority: Priority | null;
  labels: string[];
  projectQuery: string | null;
  durationMin: number | null;
  weekly: boolean;
  tokens: ParsedToken[];
}

const PRIORITY_WORDS: Record<string, Priority> = {
  urgent: 1, "1": 1, high: 2, "2": 2, medium: 3, med: 3, "3": 3, low: 4, "4": 4,
  pilny: 1, pilne: 1, wysoki: 2, średni: 3, sredni: 3, niski: 4,
};

/**
 * Parses quick-add text like "Send invoice to Acme friday 10:00 !high #finance @q4 for 30m".
 * The recognized fragments are removed from the title and returned as tokens for highlighting.
 */
export function parseQuickAdd(text: string, ref = new Date()): ParsedInput {
  const tokens: ParsedToken[] = [];
  let priority: Priority | null = null;
  const labels: string[] = [];
  let projectQuery: string | null = null;
  let durationMin: number | null = null;
  let weekly = false;

  const take = (re: RegExp, kind: TokenKind, onMatch: (m: RegExpExecArray) => boolean | void) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      if (onMatch(m) !== false) tokens.push({ kind, text: m[0].trim(), index: m.index + (m[0].length - m[0].trimStart().length) });
    }
  };

  take(/(?:^|\s)!(urgent|high|medium|med|low|pilny|pilne|wysoki|średni|sredni|niski|[1-4])\b/gi, "priority", (m) => {
    priority = PRIORITY_WORDS[m[1].toLowerCase()] ?? null;
  });
  take(/(?:^|\s)#([\p{L}\p{N}_-]+)/giu, "label", (m) => {
    labels.push(m[1].toLowerCase());
  });
  take(/(?:^|\s)@([\p{L}\p{N}_-]+)/giu, "project", (m) => {
    projectQuery = m[1].toLowerCase();
  });
  take(/(?:^|\s)(?:for|przez|na) (\d+(?:[.,]\d+)?)\s*(h|hr|hrs|hours?|godz(?:iny|in|ina|\.)?|g|m|min|mins|minutes?|minut(?:y|a)?)\b/gi, "duration", (m) => {
    const v = parseFloat(m[1].replace(",", "."));
    durationMin = Math.round(/^(h|g)/i.test(m[2]) ? v * 60 : v);
  });
  take(/(?:^|\s)(every week|weekly|each week|co tydzień|co tydzien)(?![\p{L}\p{N}])/giu, "repeat", () => {
    weekly = true;
  });

  // Dates: only the first chrono match counts, and only outside other tokens.
  let date: string | null = null;
  let hasTime = false;
  let timeOnly = false;
  const normalized = normalizePolishDates(text);
  const results = chrono.parse(normalized.text, ref, { forwardDate: true });
  for (const r of results) {
    const original = normalized.sourceRange(r.index, r.text.length);
    const overlaps = tokens.some((t) => original.index < t.index + t.text.length && t.index < original.index + original.text.length);
    if (overlaps) continue;
    const d = r.start.date();
    hasTime = r.start.isCertain("hour");
    timeOnly = hasTime && !(["day", "weekday", "month", "year"] as const).some((c) => r.start.isCertain(c));
    date = hasTime ? toDateTimeStr(d) : toDateStr(d);
    tokens.push({ kind: "date", ...original });
    break;
  }

  tokens.sort((a, b) => a.index - b.index);
  let title = text;
  for (const t of [...tokens].sort((a, b) => b.index - a.index)) {
    title = title.slice(0, t.index) + title.slice(t.index + t.text.length);
  }
  title = title.replace(/\s{2,}/g, " ").replace(/\s+([,.])/g, "$1").trim();

  return { title, date, hasTime, timeOnly, priority, labels, projectQuery, durationMin, weekly, tokens };
}

/** A date typed on its own, like "fri", "tomorrow 15:00", "in 2 weeks" or "2pm": its day, its time if one was typed,
 *  and whether a day was typed at all (for "2pm" it's today or tomorrow, whichever still has that time ahead). */
export function parseWhen(text: string, ref = new Date()): { day: string; time: string | null; dayGiven: boolean } | null {
  const r = chrono.parse(normalizePolishDates(text).text, ref, { forwardDate: true })[0];
  if (!r) return null;
  const d = r.start.date();
  return {
    day: toDateStr(d),
    time: r.start.isCertain("hour") ? toDateTimeStr(d).slice(11) : null,
    dayGiven: (["day", "weekday", "month", "year"] as const).some((c) => r.start.isCertain(c)),
  };
}
