# People Booking implementation plan

**Goal:** Add private Booking management and public verified booking to the existing People app, backed by the Rust PeopleGraph service.

**Architecture:** The existing Worker owns routing and owner identity. D1 holds settings, visitor verification, requests and encrypted Calendar grants; a per-owner BookingCoordinator serializes scheduling. A narrow Rust adapter returns explicit freshness/identity states. Existing owner-lens fields prefill an owner-approved thesis. The frontend shares the People visual language and never receives relationship evidence on public routes.

**Spec:** ../specs/2026-10-21-smart-booking-rust-harness.md

**Execution:** User authorized implementation (“let it RIP”). Work in the managed people-booking worktree with parallel agents on disjoint modules; root integrates and reviews. Existing push/deploy authorization applies; do not merge without a new explicit request.

## Constraints

- Approval mode is the default. Public pages remain unavailable until the owner explicitly enables them and email/calendar prerequisites are ready.
- No invented Rust host, fake verification code, assumed Calendar write grant, or inferred VIP identity.
- Verification is bound to owner, browser and email, expiring after ten minutes and at most five attempts. Challenge creation has email, session and IP limits.
- Native and web data stores remain separate; configured Rust owner must match the pilot owner. No user-controlled service URL or owner identifier.
- Persist and reconcile event IDs before retrying uncertain Calendar writes. Never expose private decision evidence publicly.

## Tasks

- [x] Core policy and Rust adapter: booking-types.ts, booking-policy.ts, booking-people.ts, booking-fit.ts and focused tests. Exact normalized emails, no fuzzy privilege escalation, expired/unknown source fallback, strict bounded JSON model outputs, deterministic priority rules and timezone-aware slots.
- [x] Provider integrations: booking-providers.ts and tests. Email sending binding; separate Google Calendar OAuth with existing registered callback path, PKCE and one-use state; encrypted grants; busy reads; deterministic event IDs; conflict recovery and cancellation. No secrets in logs.
- [x] Frontend: public/booking.html, booking.mjs, booking.css, public/book.html and book.mjs, browser tests. Owner settings/request review with lens prefill and readiness; public email/code/intake/slot flow, safe text and responsive layouts.
- [x] Persistence, routing, coordinator: booking-store.ts, booking-routes.ts, booking-coordinator.ts, migrations and tests. Owner isolation, globally unique slugs, optimistic revisions, transactional verification attempts, idempotency, replay and concurrency control.
- [x] Integration: register routes and DO, add Booking navigation and Accounts link, wire existing callback safely, include tests in runner and document setup.
- [x] Local validation: final existing/new tests, typecheck, predeploy builds, deployment dry run, browser fixtures, and real workerd/D1/SQLite integration passed. Independent integration review findings were addressed; see evidence below.
- [x] Deploy additive schema and app. Live page routes return HTML, the owner API rejects unauthenticated access, and the browser displays the private sign-in gate.
- [ ] Push the branch and create the PR.
- [ ] Complete production setup: Betaworks sender-domain verification and delivery, owner Calendar write consent, and a fresh Betaworks-owned Rust source. Public intake stays paused until its prerequisites and owner settings are ready.

## Review focus

- Same email attempting another slug must not inherit visitor authority.
- Cached native source absence is distinct from outage; aliases and card unions cannot grant someone else's VIP status.
- DST changes, pending slots and retries must not double-book.
- Calendar and email provider failures must not produce success or expose codes/tokens.
- Existing People routes, mail OAuth callback and account permissions must keep working.

## Ledger

### Implemented

- Baseline: `origin/main` worktree, branch `codex/people-booking`. Source spec copied from the original checkout. Existing user scratch files untouched.
- Core policy, structured fit validation, exact-email Rust lookup, and timezone-aware scheduling are implemented. Missing, stale, mismatched-owner, ambiguous, or malformed source context requires review. Rust `/score` misses now preserve source-owner and freshness metadata without returning contact data.
- D1 persists owner-scoped settings, verification and request records, encrypted Calendar grants, and unique slugs. The additive `booking-schema.sql` and `booking-v1` SQLite Durable Object migration are prepared. The per-owner coordinator serializes mutations and retains reservations across uncertain provider responses and restarts.
- Requests retain a private `policySnapshot` of the submitted policy, excluding the full VIP list and recording only `vipMatch`, alongside the decision's policy revision. Policy edits do not silently upgrade an older request to automatic booking. Current scheduling constraints and source checks still apply.
- The Booking dashboard and public flow are implemented with People navigation, saved-lens prefill, readiness controls, explicit settings-conflict reload, safe text rendering, verified-email intake, request recovery, slot selection, and separate pending/confirmed outcomes. Confirmed bookings use cancellation controls.
- Calendar connection uses a separate owner-bound OAuth grant with PKCE and one-use state. Connected calendars offer **Reconnect Google Calendar** without first disconnecting; disconnect is blocked while booking/cancellation outcomes remain unresolved.
- `booking` and `cancelling` are recoverable states. Stable event IDs, durable reconciliation and notification retries, owner **Retry confirmation** / **Retry cancellation**, and visitor status polling prevent an uncertain provider response from appearing successful. Cancellation keeps its reservation until deletion or confirmed absence succeeds.
- Pausing intake blocks new submissions and slots while preserving existing request status. Visitors with a valid session can read their own status even without a connected calendar; email verification recovery is offered only while email delivery and pilot access are available. A paused page never falls through to new intake when history is empty.
- Integration review also covered asset-route behavior, owner/session isolation, settings compare-and-swap conflicts, duration changes, review-delay anchoring, automatic-booking source rechecks, large request histories, cancellation after restart, and reconnecting revoked Calendar grants.

### Verification evidence

Completed local checks on October 21, 2026:

- `npm test` in `apps/people-graph`: 148 frontend/model tests plus 705 mail, route, core-policy, and provider tests passed (853 total), with zero failures. Evidence: `/tmp/booking-full-tests.log`; root confirmed the fresh final run passed with the same totals.
- `node --test tests/booking-runtime.mjs`: the final run reports 17 passing tests, zero failures, using real workerd, D1 and SQLite Durable Objects with synthetic external services. This includes direct asset serving, authentication, verification expiry/replay, concurrency, event reconciliation, cancellation recovery, and paused status reads. Evidence: `/tmp/booking-runtime.log`.
- `node tests/booking-browser.mjs` with `PLAYWRIGHT_MODULE` set to the bundled runtime: passed after the final reconnect change and again in root’s independent final verification. Covers owner edits/error recovery, settings conflicts, readiness, lens prefill, review/cancel/retry actions, connected-calendar OAuth without disconnect, verification errors, idempotent submission retry, slot conflicts, `booking`/`cancelling` status transitions, paused recovery, async submissions, keyboard tabs, unknown pages, and mobile overflow. Desktop and mobile screenshots were inspected.
- `cargo test --manifest-path crates/peoplegraph/Cargo.toml`: 43 passed, zero failed. Evidence: `/tmp/booking-rust-tests.log`.
- `npm run typecheck`, the predeploy builds (`build:district` and `build:relevance`), and `npx wrangler deploy --dry-run`: passed in the fresh final integration run. The dry run includes the Booking namespace and `bookings@betaworks.com` sender binding with `BOOKING_EMAIL_READY=false`. Evidence: `/tmp/booking-deploy-dryrun.log`.
- JavaScript syntax checks and `git diff --check` passed for the Booking UI changes.

These local and fixture-backed checks do not establish live sender delivery, Google consent, or Rust-source freshness.

### Deployment

- Applied `booking-schema.sql` to the remote People D1 database successfully: eight additive statements.
- `npm run deploy` succeeded. Worker version: `d97eaf14-1a23-4085-961b-2f6a0273e440`. The new sender binding is present with `BOOKING_EMAIL_READY=false`.
- Verified `/booking` and `/book/kaya` serve HTML without redirects. Unauthenticated `/api/booking` returns 401, and the browser correctly shows the private sign-in gate. No owner settings or public slug have been saved yet; `/api/public/booking/kaya` returns 404. The authenticated live setup and real email/Calendar round trip remain unverified pending sign-in and external setup.
- No real verification emails or Calendar invitations were sent during testing.

### Production setup blockers

1. **Sender domain and delivery:** the selected sender is `bookings@betaworks.com`. The connected Cloudflare account does not contain the `betaworks.com` zone; domain administration is required to configure and verify Cloudflare Email Sending DNS and delivery. The previously enabled `bestmate.io` sender is not a substitute. Keep `BOOKING_EMAIL_READY=false` until Betaworks sending has been verified; do not change MX records or enable Email Routing merely to send verification codes.
2. **Calendar consent:** `kaya@betaworks.com` must grant the separate Calendar event-writing and free/busy scopes in Booking. Existing read-only Calendar access does not satisfy this requirement. The app can renew an existing grant with Reconnect, but live owner consent and provider access are not yet verified.
3. **Fresh Betaworks-owned Rust source:** configure a reachable authenticated HTTPS gateway, `PEOPLEGRAPH_HOST`, `PEOPLEGRAPH_TOKEN`, and `PEOPLEGRAPH_OWNER_EMAIL` for the pilot's intended cache, with a refresh process and owner/freshness validation. The discovered local personal-Gmail cache was last synced September 17 and was deliberately not connected to this Betaworks pilot. Native and web caches remain separate. Missing or stale evidence can fall back to review; it does not complete the intended Rust-backed pilot setup or justify automatic priority booking.
