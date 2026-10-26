import type { CalendarDetails } from "./calendar-sync";

const COLORS = ["#5585d9", "#aa74ca", "#d07845", "#3b9a87", "#c36984", "#7f8c42"];

/** Public event provenance only; never reads the OAuth connection or its tokens. */
export function calendarSource(details?: CalendarDetails) {
  const source = details?.source;
  if (!source) return { key: "pacedmind", account: "PacedMind", name: "PacedMind", label: "PacedMind", short: "PacedMind", color: "var(--color-mut2)", google: false };
  const account = source.accountName || source.calendarId;
  const name = source.calendarName || source.calendarId;
  let hash = 0;
  for (const char of account) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
  return { key: source.calendarId, account, name, label: account === name ? account : `${account} / ${name}`,
    short: account.includes("@") ? account.slice(account.lastIndexOf("@") + 1) : account,
    color: COLORS[hash % COLORS.length], google: true };
}

export function matchesCalendarSource(details: CalendarDetails | undefined, account?: string, calendar?: string) {
  const source = calendarSource(details);
  const eq = (value: string, query: string) => value.toLocaleLowerCase() === query.trim().toLocaleLowerCase();
  return (!account || eq(source.account, account))
    && (!calendar || eq(source.name, calendar) || eq(source.key, calendar));
}
