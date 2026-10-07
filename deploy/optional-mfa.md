# Optional two-factor setup rollout

Planning and approved MCP access are available before MFA enrollment. Enrolled accounts still verify their factor at sign-in. Computer operations require a verified factor that predates the current sign-in; after first enrollment, sign out and in again. Basic OAuth connections must be reconnected to gain computer permissions.

## Deployment order

1. Run `npm run test:auth`, `npm run test:sql`, `npm run test:connectors`, typecheck, lint and the production build.
2. On a disposable Supabase stack, run both `supabase/tests/security.sql` and `supabase/tests/optional_mfa.sql`. Test actual Auth sign-up, confirmation, MFA, password reset and OAuth exchange/refresh. The isolated PostgreSQL WASM runner does not implement Auth HTTP endpoints or replace this check.
3. Apply `supabase/migrations/20260930180934_optional_mfa_planner.sql` before deploying the app. The new server fails closed for computer control if `can_control_computers()` is missing. Check Supabase security advisors after applying the migration.
4. Deploy the app, site and docs from the landed checkout using the repository's normal release procedure. Existing desktop installations keep their older onboarding until upgraded.
5. Run the live connector test cases in [directory/review.md](directory/review.md#3-test-cases). Publish the OpenAI challenge token from the submission portal only when domain verification is requested ([directory/openai.md](directory/openai.md)).

## Acceptance matrix

| Sign-in | Planner and ordinary MCP | Computer control |
| --- | --- | --- |
| No account, desktop | This computer's data | Local behavior unchanged |
| Account without verified MFA | Available after ordinary sign-in | Denied |
| Enrolled account, MFA not verified | Denied until verification | Denied |
| MFA just enrolled in this sign-in | Available | Sign out and sign in again |
| Established MFA sign-in | Available | Available under existing approvals and fresh-code rules |
| MCP approved before MFA | Available | Denied even after the account enrolls MFA |
| MCP reconnected with established MFA | Available | Only allowed request kinds and eligible computers |
| Revoked/expired session | Denied | Denied |

Test the no-fresh-code computer setting explicitly: it must never bypass the established-MFA requirement. Verify account isolation, a second device enrolling MFA while an aal1 session remains open, and Auth network failures without fallback into local mode.

For accounts without MFA, test password change and deletion with current password, deletion via a new recovery email, stale confirmations, and refusal to delete while a subscription can renew. For enrolled accounts, retain code checks and the existing-factor provenance rule.

## Mobile sign-in

The native marker only selects presentation and the authorization-code handoff. It grants no authorization. The system browser hands a short-lived PKCE code to the native app; the WebView redeems it with its own HttpOnly verifier cookie. Access/refresh tokens never go into deep links. Validate the redirect allowlist, Google, confirmation, reset, deletion email, cancellation, app restart and expired-code behavior on signed iOS and Android builds. See [store readiness](../stores/README.md).

## Verification status

The local SQL and application checks are reproducible from this checkout. No production migration, deployment, OAuth directory submission or store submission is performed by these checks. Live Auth/OAuth and signed-device review are required before release.
