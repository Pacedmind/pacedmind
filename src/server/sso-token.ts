import "server-only";
import { timingSafeEqual } from "node:crypto";
import { decodeProtectedHeader, errors, importJWK, jwtVerify, type JWTPayload } from "jose";
import type { SsoConfig } from "./sso-config";

/*
 * Verifying the issuer's identity token, offline: the signature with the issuer's public key named by the token's
 * `kid` (ES256 only, nothing else is even tried), then every claim the issuer promises. Anything missing or
 * different refuses the token with a short code, which is all the person sees.
 */

/** A token lives two minutes; clocks may differ by a minute. */
export const TOKEN_LIFETIME = 120;
export const CLOCK_SKEW = 60;

/** Why a sign-in through the issuer failed, as the one short code the error page shows. */
export type SsoRefusal =
  | "access_denied" | "state" | "token" | "expired" | "nonce" | "email" | "domain" | "two_factor"
  | "replayed" | "account_linked" | "account_unconfirmed" | "account_ambiguous" | "account_protected" | "unavailable";

/** The person the issuer vouches for. */
export interface Identity {
  issuer: string;
  /** The issuer's id for the person, stable for them. */
  subject: string;
  email: string;
  name: string;
  tokenId: string;
  /** When the issuer issued the token (seconds): the time of this round-trip through it. */
  issuedAt: number;
  expiresAt: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@\p{Cc}]{1,64}@[^\s@\p{Cc}]{1,253}$/u;

/** Equal strings, compared in constant time. */
export function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Checks `token` against the configuration and the `nonce` this browser's sign-in started with. `now` is in seconds.
 */
export async function verifyIdentityToken(
  token: string, config: SsoConfig, nonce: string, now = Math.floor(Date.now() / 1000),
): Promise<{ ok: true; identity: Identity } | { ok: false; code: SsoRefusal }> {
  if (!token || token.length > 8192) return { ok: false, code: "token" };
  let payload: JWTPayload;
  try {
    const header = decodeProtectedHeader(token);
    // Before any key is used: the algorithm is fixed, and the key is the one the token names, never a guess.
    if (header.alg !== "ES256" || typeof header.kid !== "string") return { ok: false, code: "token" };
    const jwk = config.keys.find((k) => k.kid === header.kid);
    if (!jwk) return { ok: false, code: "token" };
    const key = await importJWK({ ...jwk, alg: "ES256" }, "ES256");
    ({ payload } = await jwtVerify(token, key, {
      algorithms: ["ES256"],
      typ: "JWT",
      issuer: config.issuer,
      audience: config.clientId,
      clockTolerance: CLOCK_SKEW,
      maxTokenAge: TOKEN_LIFETIME,
      currentDate: new Date(now * 1000),
      requiredClaims: ["iss", "aud", "sub", "exp", "iat", "jti", "nonce", "email", "email_verified", "amr", "acr", "auth_time", "name"],
    }));
  } catch (e) {
    return { ok: false, code: e instanceof errors.JWTExpired ? "expired" : "token" };
  }
  const { sub, email, email_verified, name, amr, acr, nonce: sent, jti, iat, exp, auth_time, aud } = payload as JWTPayload & Record<string, unknown>;
  // One audience, this app, exactly as the issuer promises: a token for several apps isn't one for us alone.
  if (aud !== config.clientId) return { ok: false, code: "token" };
  if (typeof sub !== "string" || !UUID.test(sub) || typeof jti !== "string" || !UUID.test(jti)) return { ok: false, code: "token" };
  if (typeof iat !== "number" || typeof exp !== "number" || exp <= iat || exp - iat > TOKEN_LIFETIME) return { ok: false, code: "token" };
  if (typeof auth_time !== "number" || !Number.isFinite(auth_time) || auth_time > now + CLOCK_SKEW) return { ok: false, code: "token" };
  if (typeof name !== "string" || name.length > 200) return { ok: false, code: "token" };
  if (typeof sent !== "string" || !sameSecret(sent, nonce)) return { ok: false, code: "nonce" };
  if (typeof email !== "string" || email !== email.toLowerCase() || !EMAIL.test(email) || email.length > 254) return { ok: false, code: "email" };
  if (email_verified !== true) return { ok: false, code: "email" };
  const domain = email.slice(email.lastIndexOf("@") + 1);
  if (config.allowedDomains.length && !config.allowedDomains.includes(domain)) return { ok: false, code: "domain" };
  // The issuer asked for its two-factor code: that is what lets this session skip PacedMind's.
  if (!Array.isArray(amr) || !amr.every((m) => typeof m === "string") || !amr.includes("otp") || acr !== "aal2") {
    return { ok: false, code: "two_factor" };
  }
  return {
    ok: true,
    identity: { issuer: config.issuer, subject: sub.toLowerCase(), email, name, tokenId: jti.toLowerCase(), issuedAt: iat, expiresAt: exp },
  };
}
