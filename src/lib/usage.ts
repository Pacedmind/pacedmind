import type { Session, SessionUsage, TokenCounts } from "./types";
import { createTranslator, type Language } from "./i18n";

/*
 * What agents used, as their usage metrics report it (the usage route): tokens per session and how long it worked,
 * summed per task and project with the time their sessions ran. Claude Code also prices the tokens at API rates
 * (SessionUsage.costUsd); that stays with the session but isn't shown.
 */

export const NO_TOKENS: TokenCounts = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };

export const addTokens = (a: TokenCounts, b: TokenCounts): TokenCounts => ({
  input: a.input + b.input, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite, output: a.output + b.output,
});

/** All the tokens a session's conversations used. */
export const sessionTokens = (u: SessionUsage | null | undefined): TokenCounts =>
  Object.values(u?.conversations ?? {}).reduce(addTokens, NO_TOKENS);

/** Every token, read, cached or written, in one number. */
export const tokenTotal = (t: TokenCounts) => t.input + t.cacheRead + t.cacheWrite + t.output;

/** "950", "12k", "1.2M". */
export function fmtTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1e6) return `${n < 1e4 ? (n / 1e3).toFixed(1).replace(/\.0$/, "") : Math.round(n / 1e3)}k`;
  return `${n < 1e7 ? (n / 1e6).toFixed(1).replace(/\.0$/, "") : Math.round(n / 1e6)}M`;
}

/** "1.2M tokens, 1.1M of them from cache, 12k output" for a session's usage. */
export function tokensLine(t: TokenCounts, language: Language = "en"): string {
  const tx = createTranslator(language);
  const total = tokenTotal(t);
  if (!total) return tx("no tokens yet");
  const parts = [tx("{0} tokens", [fmtTokens(total)])];
  if (t.cacheRead) parts.push(tx("{0} of them from cache", [fmtTokens(t.cacheRead)]));
  parts.push(tx("{0} output", [fmtTokens(t.output)]));
  return parts.join(", ");
}

/** "40 s", "42 min", "3 h 5 min". */
export function fmtSpan(ms: number): string {
  if (ms < 59_500) return `${Math.max(1, Math.round(ms / 1000))} s`;
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
}

/** What a task's or a project's sessions used: tokens, and how long the agents worked (TaskContext.agentUse). */
export interface AgentUse {
  sessions: number;
  tokens: number;
  /** The agents' working time, as they reported it. */
  ms: number;
}

export const NO_USE: AgentUse = { sessions: 0, tokens: 0, ms: 0 };

/** What one session used, as its agent reported it. */
export const sessionUse = (s: Session): AgentUse => ({
  sessions: 1, tokens: tokenTotal(sessionTokens(s.usage)), ms: (s.usage?.activeSeconds ?? 0) * 1000,
});

/** Whether an agent reported anything: sessions it couldn't report from (the apps, the cloud) have nothing to show. */
export const hasUse = (u: AgentUse | undefined): u is AgentUse => !!u && (u.tokens > 0 || u.ms > 0);

/** "1.2M tokens · 42 min working"; empty when nothing was reported. */
export const usageText = (u: AgentUse, language: Language = "en") => {
  const tx = createTranslator(language);
  return [u.tokens ? tx("{0} tokens", [fmtTokens(u.tokens)]) : null, u.ms ? tx("{0} working", [fmtSpan(u.ms)]) : null].filter(Boolean).join(" · ");
};

/** "1.2M tokens · 42 min working · 2 sessions". */
export const agentUseLine = (u: AgentUse, language: Language = "en") => [usageText(u, language), createTranslator(language).count(u.sessions, "session")].filter(Boolean).join(" · ");

/** "agents: 1.2M tokens" (or their working time, without tokens), for a header. */
export const agentUseShort = (u: AgentUse, language: Language = "en") => {
  const tx = createTranslator(language);
  return tx("agents: {0}", [u.tokens ? tx("{0} tokens", [fmtTokens(u.tokens)]) : fmtSpan(u.ms)]);
};

export const addUse = (a: AgentUse, b: AgentUse): AgentUse => ({
  sessions: a.sessions + b.sessions, tokens: a.tokens + b.tokens, ms: a.ms + b.ms,
});
