# People Booking

Booking lives at `/booking`. The public link is `/book/<saved-slug>`. It uses the existing Google sign-in for its owner and a separate visitor session established by a single-use email code. Codes expire after ten minutes with at most five attempts; verified visitor sessions last one hour. Settings, requests, verification records and encrypted Calendar grants live in D1; a SQLite Durable Object coordinates each owner's mutations and notification/reconciliation retries.

## Pilot activation

The configured pilot is `kaya@betaworks.com`, with sender `bookings@betaworks.com`. The public page is paused by default and automatic booking is off. Opening it requires email delivery, a separate Calendar grant, a saved thesis, and the owner's explicit setting.

1. Onboard `betaworks.com` to Cloudflare Email Sending in the account that owns the Worker. The current connected Cloudflare account does **not** contain that zone; domain administration is required. Do not enable Email Routing or replace the domain's existing MX records just to send codes. Verify the sending DNS records and delivery before changing `BOOKING_EMAIL_READY` to `true`.
2. Open `/booking` as the pilot owner and connect Google Calendar. The existing registered `/api/accounts/callback` handles a separate PKCE/nonce flow. It requests Calendar event-writing and free/busy access; it does not replace the Gmail import grant. The connected Google email must exactly match the owner. If the grant expires or is revoked, use **Reconnect Google Calendar** to renew it without disconnecting first. Disconnect remains available but is blocked while a booking or cancellation is unresolved, so its recovery credentials are retained.
3. Connect a fresh Betaworks-owned Rust service as described below. Without an owner-matched configured source, the UI disables turning on automatic booking. Configuration readiness alone does not prove freshness: each lookup validates source ownership and age, and unknown or stale results require review.
4. Save the display name, link, meeting thesis, working hours, time zone and limits. A saved People lens can prefill the thesis; inferred suggestions are never adopted automatically. Enable the public page only after these settings are reviewed. Automatic priority booking is a separate opt-in.

The sender domain, live Calendar consent, and a fresh Betaworks-owned Rust source remain explicit setup blockers. The first two block public intake; missing Rust evidence falls back to review and does not establish the intended relationship-backed pilot. Keep the public page paused until the owner has reviewed the setup.

Google may require the owner to be an approved OAuth tester, or additional verification of the new scopes. The application shows connection failure without claiming a grant was established.

## Rust PeopleGraph connection

Set `PEOPLEGRAPH_HOST` to an authenticated HTTPS gateway for a running `peoplegraph serve`, and `PEOPLEGRAPH_OWNER_EMAIL` to the exact owner of its cache. Store its bearer credential with `wrangler secret put PEOPLEGRAPH_TOKEN`; never commit it. The server process must not inherit `PEOPLEGRAPH_HOST`, which would redirect its own lookups back to remote mode.

Use the Rust version from this branch: `/score` misses now include `stats.user_email`, `last_sync` and `matched:0`, so a genuinely new visitor can be distinguished from an unverified source. Older servers' incomplete misses safely require review.

The adapter reads only exact normalized emails. Aliases resolving to a different primary email require review. Cache ownership must match the pilot, and `last_sync` must be within 24 hours. There is no fuzzy identity or company-domain VIP match. Claimed introducers are shown to the owner for review; the current Rust edge API is not treated as proof of an introduction.

On October 21 the local cache found on this computer belonged to the personal Gmail account and was last synced September 17. It was deliberately not connected to the Betaworks pilot. Native caches and the People web graph are separate sources; do not silently substitute either one.

## Behavior

- Exact VIPs, strong thesis fits (including newcomers), and exact known contacts with plausible thesis fits get priority consideration when the inputs are verified and fresh. Unknown identity/source/model state requires review. Clear mismatches receive an asynchronous submission path.
- The owner sees decision reasons and quoted submission evidence. Visitors never receive private network scores, names, source records, or internal tiers.
- Each request stores a private `policySnapshot` of the settings used at submission, omitting the complete VIP list and recording only whether the verified visitor matched it (`vipMatch`). The decision retains its policy revision; automatic-selection rechecks preserve the initial decision. Current scheduling limits and availability still apply, and a changed policy revision falls back to owner approval rather than upgrading an old request.
- Review eligibility starts seven days after submission, not seven days after each approval attempt. Current minimum notice and Calendar availability are checked again when reserving.
- Slot preferences are not holds. A per-owner coordinator serializes bookings, persists a stable Calendar event ID before insert, and reconciles uncertain outcomes before retrying. Timeouts never create a second event ID.
- Working hours, DST, buffers, daily/weekly booking limits and existing bookings are respected. Google Calendar does not offer an atomic free/busy-plus-insert operation: changes made concurrently outside People remain a provider limitation.
- Transactional notices use a durable outbox with bounded retries. Calendar invitations contain only visitor-supplied meeting details. A request in `booking` remains unconfirmed until Calendar confirms it; the owner can retry confirmation from the dashboard. Unresolved reservations stay protected. Cancellation enters `cancelling` before deletion; only confirmed deletion or an already-absent event becomes `cancelled`. The owner can **Retry cancellation** and the visitor sees **Cancelling your booking** until status polling observes completion. Durable reconciliation retries uncertain cancellations after restarts.
- Pausing intake blocks new submissions and slot selection while preserving existing request status. A valid visitor session can read its own status even if the calendar is disconnected or email delivery is unavailable. **View an existing request** offers email verification recovery only when email delivery and pilot access remain available. Paused recovery never offers new intake, including when no previous requests are found.

## Validation and deployment

```sh
npm ci
npm test
npm run test:booking
npm run typecheck
npx wrangler deploy --dry-run
npx wrangler d1 execute people-graph --remote --file booking-schema.sql
npm run deploy
```

The browser test uses Playwright from `PLAYWRIGHT_MODULE` or a local installation. To use the bundled Codex runtime, set `PLAYWRIGHT_MODULE` to its absolute `playwright/index.mjs` path before running `npm run test:booking`. Runtime tests use real workerd, D1 and SQLite Durable Objects with synthetic Google/Rust responses and a test-only email transport. They send no real emails or Calendar invitations. Never deploy the fixture entrypoint from the runtime tests.

The `booking-v1` migration adds a new namespace. Existing `MailSync` storage and migration remain unchanged. Do not roll back by deleting the Booking namespace: reservations and reconciliation state must be preserved.
