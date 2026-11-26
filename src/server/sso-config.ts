import "server-only";

/*
 * Signing in through your organisation: one trusted issuer, configured by environment (hosted app only). The issuer
 * signs a short-lived identity token about the person (ES256), the browser posts it to /auth/sso/callback, and this
 * server verifies it offline with the issuer's public keys from SSO_JWKS: it never calls the issuer. With every
 * setting unset the feature is off and nothing changes. See deploy/organisation-sign-in.md.
 */

/** One of the issuer's public signing keys (a P-256 JWK), picked by its `kid`. */
export interface SigningKey {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
  kid: string;
}

export interface SsoConfig {
  /** The token's expected `iss`. */
  issuer: string;
  /** The token's expected `aud`, and the `client_id` this app names itself by. */
  clientId: string;
  /** Where /auth/sso/start sends the browser. */
  authorizeUrl: string;
  keys: SigningKey[];
  /** Lower-case email domains a person's address must be in; empty accepts any. */
  allowedDomains: string[];
  /** The organisation's name, for the one line of the sign-in page that needs it. */
  label: string;
  /** This app's own address (ORGANIZER_PUBLIC_ORIGIN), whose /auth/sso/callback the issuer posts back to. */
  publicOrigin: string;
  /** The Supabase project's secret key, which only the callback uses (sso-admin.ts). */
  secretKey: string;
}

const SETTINGS = ["SSO_ISSUER", "SSO_CLIENT_ID", "SSO_AUTHORIZE_URL", "SSO_JWKS", "SSO_LABEL"] as const;
const OPTIONAL = ["SSO_ALLOWED_EMAIL_DOMAINS"] as const;
const DOMAIN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

type Env = Record<string, string | undefined>;

/** A URL setting: https, or plain http to this computer while developing. Errors name the setting, never a value. */
function httpsUrl(name: string, value: string, { local }: { local: boolean }): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is not a URL.`);
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:" && loopback)) throw new Error(`${name} must use https.`);
  if (url.username || url.password || url.hash) throw new Error(`${name} must not carry credentials or a fragment.`);
  return value;
}

function signingKeys(text: string): SigningKey[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("SSO_JWKS is not JSON.");
  }
  const list = (parsed as { keys?: unknown })?.keys;
  if (!Array.isArray(list) || !list.length || list.length > 10) throw new Error("SSO_JWKS needs a \"keys\" list of one to ten keys.");
  const kids = new Set<string>();
  return list.map((key: Record<string, unknown>) => {
    // A private key here would mean the issuer's secret left the issuer: refuse to run with it.
    if (!key || typeof key !== "object" || "d" in key) throw new Error("SSO_JWKS must hold public keys only.");
    if (key.kty !== "EC" || key.crv !== "P-256") throw new Error("SSO_JWKS keys must be P-256 (ES256) keys.");
    if (key.alg !== undefined && key.alg !== "ES256") throw new Error("SSO_JWKS keys must be for ES256.");
    if (key.use !== undefined && key.use !== "sig") throw new Error("SSO_JWKS keys must be signing keys.");
    if (typeof key.kid !== "string" || !key.kid || key.kid.length > 200) throw new Error("Every SSO_JWKS key needs a kid.");
    if (kids.has(key.kid)) throw new Error("SSO_JWKS has two keys with the same kid.");
    if (typeof key.x !== "string" || typeof key.y !== "string") throw new Error("SSO_JWKS keys need x and y.");
    kids.add(key.kid);
    return { kty: "EC", crv: "P-256", x: key.x, y: key.y, kid: key.kid };
  });
}

/**
 * The configuration, or null when the feature is off (every setting unset). Throws, naming the setting, when it is set
 * only in part or a value is unusable: the caller treats that as off and says so in the server's log.
 */
export function readSsoConfig(env: Env = process.env): SsoConfig | null {
  const given = [...SETTINGS, ...OPTIONAL].filter((name) => env[name]?.trim());
  if (!given.length) return null;
  const missing = SETTINGS.filter((name) => !env[name]?.trim());
  if (missing.length) throw new Error(`Sign-in through your organisation is set up only in part: set ${missing.join(", ")}.`);
  if (!env.SUPABASE_SECRET_KEY?.trim()) throw new Error("Sign-in through your organisation needs SUPABASE_SECRET_KEY.");
  // Without it there is no callback address to send: the sign-in page would offer a button that leads nowhere.
  if (!env.ORGANIZER_PUBLIC_ORIGIN?.trim()) throw new Error("Sign-in through your organisation needs ORGANIZER_PUBLIC_ORIGIN.");
  const local = env.NODE_ENV !== "production";
  const publicOrigin = new URL(httpsUrl("ORGANIZER_PUBLIC_ORIGIN", env.ORGANIZER_PUBLIC_ORIGIN.trim(), { local }));
  if (publicOrigin.pathname !== "/" || publicOrigin.search) throw new Error("ORGANIZER_PUBLIC_ORIGIN must be an origin, without a path.");
  const issuer = httpsUrl("SSO_ISSUER", env.SSO_ISSUER!.trim(), { local });
  if (issuer.endsWith("/")) throw new Error("SSO_ISSUER must not end with a slash.");
  const clientId = env.SSO_CLIENT_ID!.trim();
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(clientId)) throw new Error("SSO_CLIENT_ID may hold only letters, digits, dots, dashes and underscores.");
  const label = env.SSO_LABEL!.trim();
  if (label.length > 60 || /[\p{Cc}<>]/u.test(label)) throw new Error("SSO_LABEL must be a short plain name.");
  const allowedDomains = (env.SSO_ALLOWED_EMAIL_DOMAINS ?? "").split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);
  for (const domain of allowedDomains) if (!DOMAIN.test(domain)) throw new Error("SSO_ALLOWED_EMAIL_DOMAINS has a value that isn't a domain.");
  return {
    issuer, clientId, label, allowedDomains, publicOrigin: publicOrigin.origin,
    authorizeUrl: httpsUrl("SSO_AUTHORIZE_URL", env.SSO_AUTHORIZE_URL!.trim(), { local }),
    keys: signingKeys(env.SSO_JWKS!),
    secretKey: env.SUPABASE_SECRET_KEY!.trim(),
  };
}

const g = globalThis as unknown as { __pacedmindSso?: { config: SsoConfig | null } };

/**
 * The hosted app's configuration, read once. A broken one switches the feature off rather than half on, and the log
 * says which setting to fix.
 */
export function ssoConfig(): SsoConfig | null {
  if (process.env.ORGANIZER_MODE !== "web") return null;
  if (!g.__pacedmindSso) {
    try {
      g.__pacedmindSso = { config: readSsoConfig() };
    } catch (e) {
      console.error(`Sign-in through your organisation is off: ${e instanceof Error ? e.message : String(e)}`);
      g.__pacedmindSso = { config: null };
    }
  }
  return g.__pacedmindSso.config;
}

/** The organisation's name for the sign-in page, or null while the feature is off. */
export const ssoLabel = (): string | null => ssoConfig()?.label ?? null;
