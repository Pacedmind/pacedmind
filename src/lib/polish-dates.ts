/** Normalize Polish date phrases for Chrono while keeping offsets in the user's original text. */
const words: Record<string, string> = {
  "pojutrze": "in 2 days", "dzisiaj": "today", "dziś": "today", "dzis": "today", "jutro": "tomorrow", "wczoraj": "yesterday",
  "poniedziałek": "monday", "poniedzialek": "monday", "poniedziałku": "monday", "pon": "mon", "pn": "mon",
  "wtorek": "tuesday", "wtorku": "tuesday", "wt": "tue", "środa": "wednesday", "środę": "wednesday", "środy": "wednesday", "sroda": "wednesday", "srode": "wednesday", "śr": "wed",
  "czwartek": "thursday", "czwartku": "thursday", "czw": "thu", "cz": "thu", "piątek": "friday", "piatek": "friday", "piątku": "friday", "pt": "fri",
  "sobota": "saturday", "sobotę": "saturday", "sobote": "saturday", "soboty": "saturday", "sob": "sat", "niedziela": "sunday", "niedzielę": "sunday", "niedziele": "sunday", "niedzieli": "sunday", "nd": "sun",
  "stycznia": "january", "styczeń": "january", "lutego": "february", "luty": "february", "marca": "march", "marzec": "march",
  "kwietnia": "april", "kwiecień": "april", "maja": "may", "maj": "may", "czerwca": "june", "czerwiec": "june",
  "lipca": "july", "lipiec": "july", "sierpnia": "august", "sierpień": "august", "września": "september", "wrzesnia": "september", "wrzesień": "september",
  "października": "october", "pazdziernika": "october", "październik": "october", "listopada": "november", "listopad": "november", "grudnia": "december", "grudzień": "december",
};
const alternatives = Object.keys(words).sort((a, b) => b.length - a.length).join("|");
const expressions = new RegExp(`(?<![\\p{L}\\p{N}])(?:za \\d+ (?:minut(?:y|ę)?|godzin(?:y|ę)?|dni|dzień|dzien|tygodni(?:e|a)?|tydzień|tydzien|miesiąc(?:e|y)?|miesięcy|miesiac(?:e|y)?|miesiecy)|(?:w|we) (?:${alternatives})|(?:(?:w|we) )?(?:następn(?:y|a|ą|ym)|nastepn(?:y|a|ym)|przyszł(?:y|a|ą|ym)|przyszl(?:y|a|ym)) (?:tydzień|tydzien|${alternatives})|o (?:godzinie )?\\d{1,2}(?:[:.]\\d{2})?|${alternatives})(?![\\p{L}\\p{N}])`, "giu");

export function normalizePolishDates(text: string): { text: string; sourceRange: (start: number, length: number) => { index: number; text: string } } {
  let normalized = "", previous = 0;
  const starts: number[] = [], ends: number[] = [];
  const append = (value: string, start: number, end: number, replaced: boolean) => {
    for (let i = 0; i < value.length; i++) { starts.push(replaced ? start : start + i); ends.push(replaced ? end : start + i + 1); }
    normalized += value;
  };
  for (const match of text.matchAll(expressions)) {
    const start = match.index!, end = start + match[0].length;
    append(text.slice(previous, start), previous, start, false);
    const value = match[0].toLowerCase().replace(/^(w|we) /, "");
    let replacement: string;
    if (value.startsWith("za ")) {
      const [, amount, unit] = value.split(" ");
      const english = unit.startsWith("minut") ? "minutes" : unit.startsWith("godzin") ? "hours" : /^(dni|dzie)/.test(unit) ? "days" : /^(tygod|tydz)/.test(unit) ? "weeks" : "months";
      replacement = `in ${amount} ${english}`;
    } else if (/^o /.test(value)) replacement = "at " + value.replace(/^o (?:godzinie )?/, "").replace(".", ":");
    else if (/^(nast|przysz)/.test(value)) { const rest = value.slice(value.indexOf(" ") + 1); replacement = "next " + (words[rest] ?? "week"); }
    else { const rest = value.replace(/^(w|we) /, ""); replacement = words[rest] ?? rest; }
    append(replacement, start, end, true); previous = end;
  }
  append(text.slice(previous), previous, text.length, false);
  return { text: normalized, sourceRange: (start, length) => {
    const index = starts[start] ?? start, end = ends[start + length - 1] ?? index + length;
    return { index, text: text.slice(index, end) };
  } };
}
