# Signing in through your organisation

The hosted app can let the people of one organisation sign in with the organisation's own sign-in, and nothing else: no PacedMind password, no PacedMind two-factor code. The organisation runs a small identity provider (the **issuer**) that, once its own sign-in and two-factor check have passed, signs a short-lived identity token about the person for PacedMind. Everything is off until the settings below are set; the desktop app never uses it.

## How it works

1. `GET /auth/sso/start?next=…` puts a random `state` and `nonce` in a ten-minute `__Host-pacedmind-sso` cookie (HttpOnly, Secure, SameSite=None, so it survives the issuer's cross-site post back) and sends the browser to `SSO_AUTHORIZE_URL` with `client_id`, `redirect_uri` (`<ORGANIZER_PUBLIC_ORIGIN>/auth/sso/callback`), `state`, `nonce` and `response_mode=form_post`. `next` is kept only when sign-in may continue there (`safeNext`), else Today.
2. The issuer's page posts `id_token` and `state` (or `error=access_denied` and `state`) to `POST /auth/sso/callback`. The state must match the cookie, which is then used up. The token is verified offline (`src/server/sso-token.ts`): ES256 only, the key chosen by the token's `kid` from `SSO_JWKS`, `typ` `JWT`, `iss` = `SSO_ISSUER`, `aud` = `SSO_CLIENT_ID` (a single string), `exp` and `iat` with a minute of clock difference and at most two minutes apart, `nonce` = the cookie's, `sub` and `jti` UUIDs, `email` lower-case with `email_verified: true` (and in `SSO_ALLOWED_EMAIL_DOMAINS` when set), `amr` including `otp`, `acr` `aal2`, and `name` and `auth_time` present. Each `jti` signs in once (`public.issuer_claim_token`).
3. The account: the one linked to that person of the issuer (`private.issuer_identities`, issuer + `sub`; a link never moves), else the one whose confirmed email matches (which is then linked), else a new account with the email confirmed and the token's `name` as its display name. An account whose email was never confirmed is refused (`account_unconfirmed`): signing in would confirm the address and hand the account to whoever chose its password. An address two accounts answer to is refused (`account_ambiguous`). An account takes one person per issuer (`account_linked`). An account with an authenticator of its own (a verified factor) is the one signed in to, but isn't linked by its email: the address would then stand in for that authenticator. Its link waits for step 4.
4. The callback has the database keep the verified sign-in (`public.issuer_begin_handoff`, `private.issuer_handoffs`: the account, the issuer's person, the time of the issuer's check, tied to the token it used up, for one minute) and gives the browser only a random 256-bit id for it, in a 60-second `__Host-pacedmind-sso-finish` cookie (SameSite=Lax); the database keeps only the id's digest. At `GET /auth/sso/finish` the browser sends its usual cookies again. The finish opens the kept sign-in once (`public.issuer_open_handoff`) and takes everything from it, never from the browser. If the person isn't linked to the account yet (an account with its own authenticator), the browser's current session must be that account's own two-factor session (`public.issuer_confirm_link`, called with that session's token), which then links it; otherwise the sign-in ends with `account_protected` and the browser keeps the session it had. Then the finish asks Supabase's admin API for a magic link's one-time token for the account (`generateLink`, which sends no email), signs the previous session out properly, and verifies the token with the browser's own Supabase client (`verifyOtp`), which puts the new session in the usual cookies. The database marks that session as made through the issuer (`public.issuer_mark_session`: only a new live session of the kept sign-in's account, whose person is linked to it, and it uses the sign-in up), and the finish reads the mark back as every page does (`readAuthState`). A session that can't be marked, or whose mark can't be read back, is signed out at once, and the person sees a page instead of going round through the issuer again. Then the browser goes to `next`.

What the mark means (`supabase/migrations/20261126120000_issuer_sign_in.sql`): the session counts as a two-factor session for the planner, computers and everything else (`private.session_ok()`, `planner_session_ok()`, `computer_session_ok()`), and a round-trip through the issuer in the last five minutes counts as a fresh code (`private.recent_mfa()`); the app skips asking for four minutes, as for codes. When a fresh check is due, the app offers **Confirm with** `SSO_LABEL` instead of a code field; that is a new sign-in through the issuer, which makes a new, freshly marked session. Such a session never asks for PacedMind's code or password, and doesn't change the account's own authenticators or password. Only the project's secret key can write marks and links; a signed-in browser can only ask whether its own session is marked (`public.issuer_session()`), which is how `readAuthState` learns it. The mark ends with its session, and with the link.

In embed mode (`pacedmind-embed=1`), `/login` and `/login/verify` redirect straight to `/auth/sso/start`, keeping `next`. Outside embed mode the sign-in page has one more button, **Continue with** `SSO_LABEL`, and Settings → Security of a session made the usual way has **Sign in through** `SSO_LABEL`: the round-trip that links an account with its own authenticator, from a sign-in with its code. Inside a host application there is no such sign-in, so its owner does this once in a browser.

## Settings (the hosted app's environment, e.g. `/srv/pacedmind/web.env`)

| Setting | Holds | Secret |
| --- | --- | --- |
| `SSO_ISSUER` | The issuer's URL, exactly as its tokens' `iss` (https, no trailing slash) | No |
| `SSO_CLIENT_ID` | This app's client id at the issuer: the tokens' `aud` and the `client_id` sent | No |
| `SSO_AUTHORIZE_URL` | The issuer's authorize page | No |
| `SSO_JWKS` | The issuer's public JWKS as JSON (`{"keys":[…]}`): P-256 keys, each with its `kid`; private keys are refused | No |
| `SSO_ALLOWED_EMAIL_DOMAINS` | Optional, comma-separated; only addresses at these domains may sign in this way. Set it to the organisation's own domains: without it, any address the issuer vouches for signs in to (or creates) the account with that address, as long as that account has no authenticator of its own | No |
| `SSO_LABEL` | The organisation's name, for **Continue with …** (60 plain characters at most) | No |
| `SUPABASE_SECRET_KEY` | The Supabase project's secret key (Project Settings → API keys; a legacy service-role key works too) | **Yes** |
| `ORGANIZER_PUBLIC_ORIGIN` | Already set for the hosted app: its own origin (https in production, no path). The issuer posts back to its `/auth/sso/callback` | No |

With none of the `SSO_*` settings set the feature is off. Set only in part, without `SUPABASE_SECRET_KEY` or `ORGANIZER_PUBLIC_ORIGIN`, or with an unusable value, it stays off and the server logs which setting to fix (never a value). The issuer's URL, its authorize page and `ORGANIZER_PUBLIC_ORIGIN` must use https in production.

`SUPABASE_SECRET_KEY` bypasses row level security: keep it only in the server's environment file (mode 600), never in the repository, a log or an agent's environment (`agentEnv()` already drops every `SUPABASE_*`). Only `src/server/sso-admin.ts` reads it, and only for the sign-in routes.

## Deploying

1. Run `npm run typecheck`, `npm run lint`, `npm run test:auth` and `npm run test:sql`, and the production build.
2. On a disposable Supabase stack, apply the migrations and run `supabase/tests/issuer_sign_in.sql` with the other SQL suites; then sign in through a test issuer end to end (a throwaway key, `SSO_ISSUER` on that stack's address): a new person, an existing confirmed account without an authenticator, one with an authenticator (refused signed out, linked from its own sign-in with its code through Settings → Security), a refused unconfirmed one, the issuer refusing, a replayed token, a finish cookie set by hand, an embedded page, a computer request after five minutes.
3. Apply `supabase/migrations/20261126120000_issuer_sign_in.sql` to the project (additive: four private tables, new functions, and the five session checks redefined to also honour the mark). Check the security advisors: `issuer_claim_token`, `issuer_link_account`, `issuer_begin_handoff`, `issuer_open_handoff` and `issuer_mark_session` are callable only with the secret key, `issuer_session` and `issuer_confirm_link` by signed-in users only.
4. Copy the issuer's public JWKS into `SSO_JWKS` and set the other settings and `SUPABASE_SECRET_KEY` in the web app's environment file; register `<ORGANIZER_PUBLIC_ORIGIN>/auth/sso/callback` as this app's only redirect at the issuer.
5. Deploy the web app (`deploy/deploy.sh`), then sign in once through the issuer and once with a password to check both. Accounts that already have an authenticator (staff who used PacedMind before) link themselves once: sign in to the web app with the code, then Settings → Security → **Continue with** `SSO_LABEL`.

Rotating the issuer's key: add the new public key to `SSO_JWKS` (keep the old one), restart, let the issuer switch, then remove the old key. Switching the feature off (unsetting the settings) stops new sign-ins this way at once; sessions already made stay signed in until they end, and to the app they are then ordinary sessions, so an account with PacedMind's own authenticator is asked for its code.

## What a refused sign-in shows

One page, "Can't sign in here", with a short code and nothing else:

| Code | Why |
| --- | --- |
| `state` | The post didn't come from a sign-in this browser started in the last ten minutes, or the finish came without a sign-in the callback kept (none, made up, expired or already finished) |
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
| `account_protected` | The account with that email has an authenticator of its own and isn't linked yet: its owner links it from a sign-in with its code (Settings → Security) |
| `unavailable` | Supabase didn't answer as expected, or the new session's mark couldn't be read back (the session is then signed out); the server log says which step (no tokens or keys) |
