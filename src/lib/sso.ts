/*
 * Where signing in through your organisation starts (src/server/sso.ts), for pages on either side. The server keeps
 * `next` only when sign-in may continue there (safeNext in src/server/auth-flow.ts); anything else goes to Today.
 */
export const SSO_START_PATH = "/auth/sso/start";

export const ssoStartHref = (next?: string): string => (next ? `${SSO_START_PATH}?next=${encodeURIComponent(next)}` : SSO_START_PATH);
