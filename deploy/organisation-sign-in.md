# Signing in through your organisation

The hosted app can let the people of one organisation sign in with the organisation's own sign-in, and nothing else: no PacedMind password, no PacedMind two-factor code. The organisation runs a small identity provider (the **issuer**) that, once its own sign-in and two-factor check have passed, signs a short-lived identity token about the person for PacedMind. Everything is off until the settings below are set; the desktop app never uses it.

## How it works

1. `GET /auth/sso/start?next=…` puts a random `state` and `nonce` in a ten-minute `__Host-pacedmind-sso` cookie (HttpOnly, Secure, SameSite=None, so it survives the issuer's cross-site post back) and sends the browser to `SSO_AUTHORIZE_URL` with `client_id`, `redirect_uri` (`<ORGANIZER_PUBLIC_ORIGIN>/auth/sso/callback`), `state`, `nonce` and `response_mode=form_post`. `next` is kept only when sign-in may continue there (`safeNext`), else Today.
2. The issuer's page posts `id_token` and `state` (or `error=access_denied` and `state`) to `POST /auth/sso/callback`. The state must match the cookie, which is then used up. The token is verified offline (`src/server/sso-token.ts`): ES256 only, the key chosen by the token's `kid` from `SSO_JWKS`, `typ` `JWT`, `iss` = `SSO_ISSUER`, `aud` = `SSO_CLIENT_ID` (a single string), `exp` and `iat` with a minute of clock difference and at most two minutes apart, `nonce` = the cookie's, `sub` and `jti` UUIDs, `email` lower-case with `email_verified: true` (and in `SSO_ALLOWED_EMAIL_DOMAINS` when set), `amr` including `otp`, `acr` `aal2`, and `name` and `auth_time` present. Each `jti` signs in once (`public.issuer_claim_token`).
3. The account: the one linked to that person of the issuer (`private.issuer_identities`, issuer + `sub`; a link never moves), else the one whose confirmed email matches (which is then linked), else a new account with the email confirmed and the token's `name` as its display name. An account whose email was never confirmed is refused (`account_unconfirmed`): signing in would confirm the address and hand the account to whoever chose its password. An account takes one person per issuer (`account_linked`).
4. The callback asks Supabase's admin API for a magic link's one-time token for that account (`generateLink`, which sends no email) and hands it, in a 60-second `__Host-pacedmind-sso-finish` cookie (SameSite=Lax), to `GET /auth/sso/finish`. There the browser sends its usual cookies again, so the previous session, if any, is signed out properly, and the browser's own Supabase client verifies the token (`verifyOtp`), which puts the new session in the usual cookies. The database then marks that session as made through the issuer (`public.issuer_mark_session`, keyed by the session id, `private.issuer_sessions`) and the browser goes to `next`. A session that can't be marked is signed out at once.

What the mark means (`supabase/migrations/20261126120000_issuer_sign_in.sql`): the session counts as a two-factor session for the planner, computers and everything else (`private.session_ok()`, `planner_session_ok()`, `computer_session_ok()`), and a round-trip through the issuer in the last five minutes counts as a fresh code (`private.recent_mfa()`); the app skips asking for four minutes, as for codes. When a fresh check is due, the app offers **Confirm with** `SSO_LABEL` instead of a code field; that is a new sign-in through the issuer, which makes a new, freshly marked session. Such a session never asks for PacedMind's code or password, and doesn't change the account's own authenticators or password. Only the project's secret key can write marks and links; a signed-in browser can only ask whether its own session is marked (`public.issuer_session()`), which is how `readAuthState` learns it. The mark ends with its session, and with the link.

In embed mode (`pacedmind-embed=1`), `/login` and `/login/verify` redirect straight to `/auth/sso/start`, keeping `next`. Outside embed mode the sign-in page has one more button, **Continue with** `SSO_LABEL`.

## Settings (the hosted app's environment, e.g. `/srv/pacedmind/web.env`)

| Setting | Holds | Secret |
| --- | --- | --- |
| `SSO_ISSUER` | The issuer's URL, exactly as its tokens' `iss` (https, no trailing slash) | No |
| `SSO_CLIENT_ID` | This app's client id at the issuer: the tokens' `aud` and the `client_id` sent | No |
| `SSO_AUTHORIZE_URL` | The issuer's authorize page | No |
| `SSO_JWKS` | The issuer's public JWKS as JSON (`{"keys":[…]}`): P-256 keys, each with its `kid`; private keys are refused | No |
| `SSO_ALLOWED_EMAIL_DOMAINS` | Optional, comma-separated; only addresses at these domains may sign in this way | No |
| `SSO_LABEL` | The organisation's name, for **Continue with …** (60 plain characters at most) | No |
| `SUPABASE_SECRET_KEY` | The Supabase project's secret key (Project Settings → API keys; a legacy service-role key works too) | **Yes** |

With none of the `SSO_*` settings set the feature is off. Set only in part, or with an unusable value, it stays off and the server logs which setting to fix (never a value). The issuer's URL must use https in production.

`SUPABASE_SECRET_KEY` bypasses row level security: keep it only in the server's environment file (mode 600), never in the repository, a log or an agent's environment (`agentEnv()` already drops every `SUPABASE_*`). Only `src/server/sso-admin.ts` reads it, and only for the sign-in routes.

## Deploying

1. Run `npm run typecheck`, `npm run lint`, `npm run test:auth` and `npm run test:sql`, and the production build.
2. On a disposable Supabase stack, apply the migrations and run `supabase/tests/issuer_sign_in.sql` with the other SQL suites; then sign in through a test issuer end to end (a throwaway key, `SSO_ISSUER` on that stack's address): a new person, an existing confirmed account, a refused unconfirmed one, the issuer refusing, a replayed token, an embedded page, a computer request after five minutes.
3. Apply `supabase/migrations/20261126120000_issuer_sign_in.sql` to the project (additive: three private tables, new functions, and the four session checks redefined to also honour the mark). Check the security advisors: `issuer_claim_token`, `issuer_link_account` and `issuer_mark_session` are callable only with the secret key, `issuer_session` by signed-in users.
4. Copy the issuer's public JWKS into `SSO_JWKS` and set the other settings and `SUPABASE_SECRET_KEY` in the web app's environment file; register `<ORGANIZER_PUBLIC_ORIGIN>/auth/sso/callback` as this app's only redirect at the issuer.
5. Deploy the web app (`deploy/deploy.sh`), then sign in once through the issuer and once with a password to check both.

Rotating the issuer's key: add the new public key to `SSO_JWKS` (keep the old one), restart, let the issuer switch, then remove the old key. Switching the feature off (unsetting the settings) stops new sign-ins this way at once; sessions already made stay signed in until they end, and to the app they are then ordinary sessions, so an account with PacedMind's own authenticator is asked for its code.

## What a refused sign-in shows

One page, "Can't sign in here", with a short code and nothing else:

| Code | Why |
| --- | --- |
| `state` | The post didn't come from a sign-in this browser started in the last ten minutes, or the finish came without a verified sign-in |
| `access_denied` | The issuer refused the person |
| `token` | The token didn't verify (signature, key, issuer, audience, lifetime, shape) |
| `expired` | The token was too old |
| `nonce` | The token was made for another sign-in |
| `email` | No verified, lower-case email |
| `domain` | The email isn't at an allowed domain |
| `two_factor` | The issuer didn't ask for its two-factor code |
| `replayed` | The token was used before |
| `account_linked` | The account with that email is linked to another person of the issuer |
| `account_unconfirmed` | An account with that email exists but was never confirmed |
| `account_ambiguous` | More than one account has that email |
| `unavailable` | Supabase didn't answer as expected; the server log says which step (no tokens or keys) |
