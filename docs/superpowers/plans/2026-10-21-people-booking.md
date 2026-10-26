# People Booking implementation plan

**Goal:** Add private Booking management and public Google-authenticated booking to the existing People app, backed by the Rust PeopleGraph service.

**Architecture:** The existing Worker owns routing and owner identity. Separate Google visitor OAuth requests only `openid email` through the existing registered callback. D1 holds settings, browser-bound visitor sessions, requests and encrypted owner Calendar grants; a per-owner BookingCoordinator serializes scheduling. A narrow Rust adapter returns explicit freshness/identity states. Existing owner-lens fields prefill an owner-approved thesis. The frontend shares the People visual language and never receives relationship evidence on public routes. Calendar sends meeting invitations and cancellation updates; request/review/decline updates live in the dashboard and visitor status page.

**Spec:** ../specs/2026-10-21-smart-booking-rust-harness.md

**Execution:** User authorized implementation (“let it RIP”) and subsequently approved replacing email-code verification with Google-only visitor sign-in, removing custom email and sender-domain dependencies. Continue in the managed people-booking worktree on `codex/people-booking`, updating draft PR #12. Root integrates and reviews. Existing push/deploy authorization applies; do not merge without a new explicit request.

## Constraints

- Approval mode is the default. Public intake remains unavailable until the owner enables the page and Google sign-in, pilot access and owner Calendar prerequisites are ready.
- No custom email sender, notification service or domain/DNS setup is required. Do not assume a Calendar write grant, invent a Rust host, or infer VIP identity.
- Google visitor OAuth uses only `openid email`, browser-bound PKCE, a validated OpenID nonce and a single-use ten-minute state record. Visitor sessions last one hour and bind the owner, slug, browser, normalized email and opaque Google-subject hash. Sign-in initiation has browser/IP limits.
- Visitor request access and idempotency require the same Google subject and email. Legacy OTP sessions and requests without a Google subject do not automatically inherit access. Submission text cannot select an identity.
- Gmail or signed Workspace `hd` authority is required for email-based PeopleGraph/VIP priority. Other Google-account addresses can submit for review but skip network lookup, retain `vipMatch:false`, and cannot silently gain automatic eligibility on a later login.
- Native and web data stores remain separate; configured Rust owner must match the pilot owner. No user-controlled service URL or owner identifier.
- Persist and reconcile event IDs before retrying uncertain Calendar writes. Never expose private decision evidence publicly.
- Add Google OAuth/session D1 tables without dropping real records. Leave old OTP/session/outbox state inert; preserve Calendar booking/cancellation reconciliation and the existing Durable Object namespace.

## Tasks

- [x] Core policy and Rust adapter: booking-types.ts, booking-policy.ts, booking-people.ts, booking-fit.ts and focused tests. Exact normalized emails, no fuzzy privilege escalation, expired/unknown source fallback, strict bounded JSON model outputs, deterministic priority rules and timezone-aware slots.
- [x] Owner Calendar integration: separate OAuth through the existing registered callback, PKCE and one-use state, encrypted grants, busy reads, deterministic event IDs, conflict recovery and cancellation. Visitor sign-in does not reuse this grant.
- [x] Base Booking UI and persistence: owner request review, lens prefill, globally unique slugs, revision checks, isolated requests, serialized reservations and recoverable booking/cancelling states.
- [x] Coordinator/config update: replace email readiness with Google sign-in readiness, remove custom sender bindings and notification paths, retain inert legacy outbox data, and bind new requests to Google subject plus email authority.
- [x] Complete and review the Google-only provider, callback/session, public route and UI integration, including identity-only scopes, account recovery and third-party-email fallback.
- [x] Fresh local validation of the Google-only update: full existing/new tests, typecheck, generated bindings, predeploy builds, deployment dry run, browser fixtures, and real workerd/D1/SQLite integration. Confirmed results are recorded below.
- [x] Apply the additive Google session/OAuth schema and deploy the Google-only app. Record its version and verify live page/API routes and assets after deployment. Live Google authentication and recovery remain part of production setup below.
- [x] Push `codex/people-booking` and create draft [PR #12](https://github.com/kayacancode/obsidian-gmail-crm/pull/12). Main has not been merged.
- [x] Update PR #12's description with the Google-only implementation and confirmed fresh validation/deployment results.
- [ ] Complete production setup: verify the configured Google client and live visitor callback, obtain owner Calendar write consent, and connect a fresh Betaworks-owned Rust source. Public intake stays paused until its prerequisites and owner settings are ready; automatic booking still requires verified fresh source context.

## Review focus

- Same email on another Google subject, another slug, or a legacy OTP session must not inherit visitor authority.
- Signed Google identities without Gmail/Workspace email authority must never trigger network lookup or VIP priority; body-supplied identity fields must be ignored.
- PKCE, browser binding, one-use OAuth state, nonce validation and one-hour session expiry must survive replay and account-switch tests.
- Cached native source absence is distinct from outage; aliases and card unions cannot grant someone else's VIP status.
- DST changes, pending slots and retries must not double-book.
- Google sign-in and Calendar provider failures must not produce success or expose tokens. Legacy email outbox tasks must not send or keep rescheduling alarms.
- Existing People routes, mail OAuth callback and account permissions must keep working.

## Ledger

### Implemented

- Baseline: `origin/main` worktree, branch `codex/people-booking`. Source spec copied from the original checkout. Existing user scratch files untouched.
- Core policy, structured fit validation, exact-email Rust lookup, and timezone-aware scheduling are implemented. Missing, stale, mismatched-owner, ambiguous, or malformed source context requires review. Rust `/score` misses now preserve source-owner and freshness metadata without returning contact data.
- D1 persists owner-scoped settings and request records, encrypted Calendar grants, and unique slugs. The Google-only update adds `booking_google_sessions` and `booking_visitor_oauth`; it does not drop tables or convert old email identities into Google subjects. Old OTP/session data is inert, with normal expiry cleanup. The `booking-v1` SQLite Durable Object namespace remains in place. Its coordinator preserves reservations across uncertain provider responses and restarts, while legacy email outbox/history records are ignored.
- Requests retain a private `policySnapshot` of the submitted policy, excluding the full VIP list and recording only `vipMatch`, alongside the decision's policy revision. Policy edits do not silently upgrade an older request to automatic booking. Current scheduling constraints and source checks still apply.
- The base Booking dashboard and public flow include People navigation, saved-lens prefill, settings-conflict reload, safe text, request recovery, slot selection and separate pending/confirmed outcomes. The current update replaces code entry and email readiness with Google sign-in, account identity and subject-bound recovery. Fresh local browser and runtime integration validation passed.
- Calendar connection uses a separate owner-bound OAuth grant with PKCE and one-use state. Connected calendars offer **Reconnect Google Calendar** without first disconnecting; disconnect is blocked while booking/cancellation outcomes remain unresolved.
- `booking` and `cancelling` are recoverable states. Stable event IDs, durable Calendar reconciliation, owner **Retry confirmation** / **Retry cancellation**, and visitor status polling prevent an uncertain provider response from appearing successful. Cancellation keeps its reservation until deletion or confirmed absence succeeds. Calendar sends invitations and cancellation updates; custom request/review/decline emails are removed, and those updates appear in Booking and the visitor status page.
- Pausing intake blocks new submissions and slots while preserving existing request status. Visitors with a valid Google session can read their own status even without a connected calendar. Google sign-in recovery is available while sign-in configuration and pilot access are ready and requires the same subject and email. A paused page never falls through to new intake when history is empty.
- Integration review also covered asset-route behavior, owner/session isolation, settings compare-and-swap conflicts, duration changes, review-delay anchoring, automatic-booking source rechecks, large request histories, cancellation after restart, and reconnecting revoked Calendar grants.

### Verification evidence — current Google-only update

Fresh final local validation was confirmed on October 21, 2026:

- [x] Full `npm test`: 868 passed — 148 frontend and 720 TypeScript/core tests.
- [x] Real workerd/D1/SQLite runtime tests: 22 passed, covering Google OAuth/browser and subject isolation, non-authoritative email fallback, legacy identity rejection and booking/cancellation recovery.
- [x] Browser suite independently rerun successfully: owner readiness/settings/actions and visitor Google OAuth, draft restoration, request/slot, paused access and mobile flows. The mobile screenshot was visually inspected.
- [x] Final typecheck exited 0; generated Wrangler types and `git diff --check` passed.
- [x] Asset builds and deployment dry run passed, with custom email bindings and sender variables removed.
- [x] Rust scope checked: unchanged by the Google authentication update. The earlier 43 passing Rust tests remain evidence for that unchanged code; no fresh Rust run is claimed.

Earlier OTP-based app and runtime totals are superseded by the fresh Google-only results above. Local synthetic tests cannot establish live Google consent, callback configuration or Rust-source freshness. Deployment and route/asset smoke checks are confirmed below; live provider consent is still unverified.

### Deployment — current Google-only update

- [x] Additive Google D1 schema applied: all ten SQL queries succeeded, without dropping existing records.
- [x] Google-only Worker deployed on October 21, 2026: `7107c5cb-1837-415c-83d2-576500c59f7a`. `npm run deploy` passed both asset builds; no custom email bindings remain.
- [x] Live HTML/API/asset smoke checks: `/`, `/booking`, `/book/kaya`, `book.mjs` and `booking.mjs` returned 200. Deployed bundles contain Google sign-in/readiness and no OTP flow. Unauthenticated owner API returned 401; public `kaya` API returned 404 because the slug has not been saved. Public intake is not configured.
- [ ] Live Google visitor sign-in/callback, same-account recovery and owner setup verified.
- [ ] Live owner Calendar consent and an explicitly authorized booking/cancellation round trip verified.

Historical baseline: the earlier eight-statement Booking schema and OTP-based Worker version `d97eaf14-1a23-4085-961b-2f6a0273e440` preceded the Google-only deployment above. No real verification emails or Calendar invitations were sent during those earlier tests. The Google-only update is tracked in PR #12; it has not been merged into main.

### Production setup blockers

1. **Live Google sign-in and public intake:** the Google-only Worker is deployed, but a live visitor sign-in/callback and same-account recovery are unverified. Verify the existing Google client ID/secret plus `MAIL_TOKEN_KEY` and `TOKEN_SECRET`, authorized app origin and existing `/api/accounts/callback`, then complete owner setup and save the public slug. Visitor scopes are only `openid email`, with no Calendar/Gmail grant. Public intake is not configured; sender-domain verification and custom email delivery are no longer prerequisites.
2. **Calendar consent:** `kaya@betaworks.com` must grant the separate Calendar event-writing and free/busy scopes in Booking. Existing read-only Calendar access does not satisfy this requirement. The app can renew an existing grant with Reconnect, but live owner consent and provider access are not yet verified.
3. **Fresh Betaworks-owned Rust source:** configure a reachable authenticated HTTPS gateway, `PEOPLEGRAPH_HOST`, `PEOPLEGRAPH_TOKEN`, and `PEOPLEGRAPH_OWNER_EMAIL` for the pilot's intended cache, with a refresh process and owner/freshness validation. The discovered local personal-Gmail cache was last synced September 17 and was deliberately not connected to this Betaworks pilot. Native and web caches remain separate. Missing or stale evidence can fall back to review; it does not complete the intended Rust-backed pilot setup or justify automatic priority booking.
