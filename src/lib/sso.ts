/*
 * Where signing in through your organisation starts (src/server/sso.ts), for pages on either side. The server keeps
 * `next` only when sign-in may continue there (safeNext in src/server/auth-flow.ts); anything else goes to Today.
 */
export const SSO_START_PATH = "/auth/sso/start";

/** Signing in through your organisation: the plain round-trip, which asks the issuer for no particular freshness. */
export const ssoStartHref = (next?: string): string => (next ? `${SSO_START_PATH}?next=${encodeURIComponent(next)}` : SSO_START_PATH);

/**
 * The fresh check of a session made through your organisation's sign-in, before a sensitive action: a round-trip that
 * asks the issuer for a code entered in the last five minutes (`max_age`). Every "Confirm with …" link uses this one.
 */
export const ssoConfirmHref = (next?: string): string => {
  const params = new URLSearchParams(next ? { next, fresh: "1" } : { fresh: "1" });
  return `${SSO_START_PATH}?${params}`;
};
