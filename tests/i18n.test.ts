import assert from "node:assert/strict";
import { test } from "node:test";
import { createTranslator, formatDate, languageOf, plural } from "../src/lib/i18n";
import { dueInfo, toDateStr } from "../src/lib/dates";
import { normalizePolishDates } from "../src/lib/polish-dates";
import { parseQuickAdd, parseWhen } from "../src/lib/parse";
import { agentUseLine, tokensLine } from "../src/lib/usage";
import { desktopText } from "../desktop/localization.mjs";
import polish from "../src/lib/messages.pl.json";
import { areaIconLabelFor, findAreaIconsFor } from "../src/lib/area-icon-localization";

const ref = new Date(2026, 9, 6, 10, 40);
test("locale validation and indexed translations preserve values and unknown text", () => {
  const pl = createTranslator("pl"), en = createTranslator("en");
  assert.equal(languageOf("pl"), "pl");
  for (const value of ["PL", "en", null, "../pl", "<script>"]) assert.equal(languageOf(value), "en");
  assert.equal(pl("Today"), "Dzisiaj");
  assert.equal(en("Today"), "Today");
  const title = 'Żółć <b>Today</b> {1} $&';
  assert.ok(pl("Moved {0} to {1}", [title, "środa"]).includes(title));
  assert.equal(pl(title), title);
  assert.equal(pl.generated("Unknown application failure: Żółć"), "Unknown application failure: Żółć");
  assert.equal(pl.generated("Moved WRK-12 to Wednesday"), "Przeniesiono WRK-12 do Wednesday");
});
test("every translated placeholder references a source value", () => {
  for (const [key, value] of Object.entries(polish)) {
    const indices = [...key.matchAll(/\{(\d+)\}/g)].map(m => m[1]);
    for (const m of value.matchAll(/\{(\d+)\}/g)) assert.ok(indices.includes(m[1]), key + ": " + value);
  }
});
test("native menus share translations without translating protocol identifiers", () => {
  assert.equal(desktopText("Edit", "pl"), "Edycja");
  assert.equal(desktopText("Edit", "en"), "Edit");
  assert.equal(desktopText("Start {0} with {1}?", "pl", ["WRK-1", "Codex"]), createTranslator("pl")("Start {0} with {1}?", ["WRK-1", "Codex"]));

});
test("Polish dates and due labels use Polish weekdays and months", () => {
  assert.equal(formatDate(ref, "EEEE, d MMMM yyyy", "pl"), "wtorek, 6 października 2026");
  assert.equal(formatDate(ref, "EEEE, d MMMM yyyy", "en"), "Tuesday, 6 October 2026");
  assert.equal(dueInfo("2026-10-07", ref, "pl")?.text, "Jutro");
  assert.match(dueInfo("2026-10-05", ref, "pl")!.long, /1 dzień po terminie/);
  assert.equal(dueInfo("2026-10-06", ref, "pl")?.text, "Dzisiaj");
});
test("Polish count forms include special teen endings", () => {
  const forms = ["zadanie", "zadania", "zadań"] as const;
  for (const n of [1]) assert.equal(plural(n, forms), "zadanie");
  for (const n of [2, 3, 4, 22, 104]) assert.equal(plural(n, forms), "zadania");
  for (const n of [0, 5, 11, 12, 14, 21, 112]) assert.equal(plural(n, forms), "zadań");
  assert.equal(createTranslator("pl").count(2, "session"), "2 sesje");
  assert.equal(createTranslator("en").count(2, "repository"), "2 repositories");
});
test("quick add accepts Polish dates, priorities, labels and durations with original offsets", () => {
  const text = "Wyślij fakturę jutro o 10:00 !wysoki #finanse @praca przez 30 minut";
  const result = parseQuickAdd(text, ref);
  assert.deepEqual({ title: result.title, date: result.date, priority: result.priority, labels: result.labels, project: result.projectQuery, duration: result.durationMin },
    { title: "Wyślij fakturę", date: "2026-10-07T10:00", priority: 2, labels: ["finanse"], project: "praca", duration: 30 });
  for (const token of result.tokens) assert.equal(text.slice(token.index, token.index + token.text.length), token.text);
  assert.equal(result.tokens[0].text, "jutro o 10:00");
});
test("weekly repetition and comma durations handle Polish word boundaries", () => {
  const result = parseQuickAdd("Przegląd w piątek o 15:30 co tydzień przez 1,5 godziny", ref);
  assert.equal(result.weekly, true);
  assert.equal(result.durationMin, 90);
  assert.equal(result.date, "2026-10-09T15:30");
  assert.equal(result.title, "Przegląd");
  assert.equal(parseQuickAdd("Przegląd co tydzien", ref).weekly, true);
  assert.equal(parseQuickAdd("Notatka co tydzieńnik", ref).weekly, false);
});
test("date entry covers relative, inflected, accentless, month and time-only expressions", () => {
  for (const [text, date] of [["pojutrze", "2026-10-08"], ["w środę", "2026-10-07"], ["w srode", "2026-10-07"], ["za 2 tygodnie", "2026-10-20"], ["12 października 2026", "2026-10-12"], ["za 3 miesiące", "2027-01-06"], ["za 6 miesięcy", "2027-04-06"]]) {
    assert.equal(parseWhen(text, ref)?.day, date, text);
  }
  assert.deepEqual(parseWhen("o 9:00", ref), { day: "2026-10-07", time: "09:00", dayGiven: false });
  assert.equal(parseQuickAdd("Kontakt za 2 godziny", ref).date, "2026-10-06T12:40");
  assert.equal(parseWhen("nic do rozpoznania", ref), null);
  assert.equal(parseQuickAdd("Przegląd w przyszłą środę", ref).title, "Przegląd");
  const normalized = normalizePolishDates("Żółty dzień — jutro o 10");
  assert.equal(normalized.sourceRange(normalized.text.indexOf("tomorrow"), "tomorrow at 10".length).text, "jutro o 10");
});
test("English quick add remains compatible and ignores date words inside labels", () => {
  const en = parseQuickAdd("send invoice friday 10:00 !high for 30m", ref);
  assert.equal(en.title, "send invoice");
  assert.equal(en.date, "2026-10-09T10:00");
  assert.equal(en.durationMin, 30);
  assert.equal(parseQuickAdd("Plan #jutro @piątek", ref).date, null);
  assert.equal(parseWhen("tomorrow", ref)?.day, toDateStr(new Date(2026, 9, 7)));
});
test("usage labels localize without changing numeric metrics or the default protocol text", () => {
  const counts = { input: 500, output: 100, cacheRead: 200, cacheWrite: 0 };
  assert.match(tokensLine(counts, "pl"), /800 tokenów/);
  assert.match(tokensLine(counts), /800 tokens/);
  assert.match(agentUseLine({ tokens: 12000, ms: 60000, sessions: 2 }, "pl"), /2 sesje/);
});

test("Polish icon labels and searches preserve original icon identifiers", () => {
  assert.equal(areaIconLabelFor("lightbulb", "pl"), "Żarówka");
  assert.equal(areaIconLabelFor("lightbulb", "en"), "Lightbulb");
  assert.deepEqual(findAreaIconsFor("żarówka", "pl"), ["lightbulb"]);
  assert.deepEqual(findAreaIconsFor("zarowka", "pl"), ["lightbulb"]);
  assert.ok(findAreaIconsFor("cloud", "pl").includes("cloud"));
});
