# People Booking

Booking lives at `/booking`. The public link is `/book/<saved-slug>`. Both owner and visitor authentication use Google, with separate permissions and sessions. Visitors request only the `openid email` identity scopes; they do not grant Calendar or Gmail access. Settings, requests, visitor sessions and encrypted owner Calendar grants live in D1. A SQLite Durable Object coordinates each owner's mutations and Calendar reconciliation retries.

## Pilot activation

The configured pilot is `kaya@betaworks.com`. The public page is paused by default and automatic booking is off. Opening it requires configured Google sign-in, a separate owner Calendar grant, a saved thesis, and the owner's explicit setting. Booking does not require a sender domain, custom email service, or DNS changes.

1. Configure `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `MAIL_TOKEN_KEY`, and `TOKEN_SECRET`. Visitor sign-in uses the existing registered `/api/accounts/callback` URI with its own state prefix; no additional callback path is required. Check that the deployed app origin and callback URI remain authorized for that Google OAuth client. Readiness confirms configuration presence; a live sign-in still needs verification after deployment.
2. Open `/booking` as the pilot owner and connect Google Calendar. The existing registered `/api/accounts/callback` handles a separate PKCE/nonce flow. It requests Calendar event-writing and free/busy access; it does not replace the Gmail import grant. The connected Google email must exactly match the owner. If the grant expires or is revoked, use **Reconnect Google Calendar** to renew it without disconnecting first. Disconnect remains available but is blocked while a booking or cancellation is unresolved, so its recovery credentials are retained.
3. Keep the owner’s My Network sources synced, or configure the Betaworks-owned Rust service below. With no Rust configuration, Booking uses exact My Network evidence. Readiness checks completed source syncs; every decision also checks ownership and freshness. Unknown, stale, incomplete or ambiguous evidence requires review. A configured or partially configured Rust source never silently falls back to another source.
4. Save the display name, link, meeting thesis, working hours, time zone and limits. A saved People lens can prefill the thesis; inferred suggestions are never adopted automatically. Enable the public page only after these settings are reviewed. Automatic priority booking is a separate opt-in.

**Use my saved lens** reads the latest saved focus, needs and offers when clicked. If the lens is empty, open **Network → Your lens**, save those fields or accept a suggested update, then return and click the button again. An empty lens or a failed read leaves the current meeting thesis and other edits intact. Importing a lens only fills the draft; **Save changes** applies it to Booking.

The Google-only update is deployed. On October 22 the live dashboard showed Calendar connected, the saved `kaya` page accepting requests, and an existing Google visitor request awaiting review. A real Calendar booking and the new returning-contact flow with an eligible live visitor have not been verified. The Rust service remains optional when fresh owner-local My Network evidence is available. A live real counterpart booking remains unverified.

Google may require the owner to be an approved OAuth tester, or additional verification of the new scopes. The application shows connection failure without claiming a grant was established.

## Visitor identity and request access

Visitor OAuth starts from a same-origin POST and binds a ten-minute, single-use state record to the browser, owner and public slug. PKCE and a validated OpenID nonce protect the callback. Google token signatures, issuer, audience, expiration and verified-email claims are checked before a one-hour visitor session is created. The session uses Secure, HttpOnly cookies and is separate from People owner authentication. Visitor access and refresh tokens are discarded.

Sessions and requests bind both the normalized email and an opaque hash of the Google account subject (`opaque('booking-google-sub', sub, TOKEN_SECRET)`). Knowing the email or a request ID is insufficient to recover another Google account's request. Returning to a request requires the same subject and email; an old email-code session or legacy request without a Google subject does not automatically gain access.

A signed Gmail address, or a verified email with Google's signed Workspace `hd` claim, establishes Google email authority for booking rules. A Google account using a third-party address without `hd` may sign in and submit a review request, but the app does not query PeopleGraph for that address or grant VIP/network priority. Its `vipMatch` is false. Current and originally recorded email authority must both be present for automatic booking; later sign-in cannot silently upgrade a request that began with uncertainty. Google sign-in does not establish an employer, project claim, or referral.

## Returning contacts

In **Booking → Rules**, **Offer a shorter form to returning contacts** is on by default with a **Returning contact score cutoff of 70/100**. The owner can change the cutoff (1–100) or turn the shortcut off. Reading older saved settings supplies these defaults without changing their revision or enabling a paused booking page.

After Google sign-in, an exact authoritative email match to the owner’s direct My Network contact qualifies when its adjusted People score reaches the cutoff. This is the same activity/recency/feedback score shown in My Network, including Granola meetings. All sources contributing to that contact must have a completed sync within 24 hours. Shared-only contacts, alias-only identity matches, unknown or non-authoritative emails, stale or incomplete syncs and source errors use the regular questionnaire. An exact raw email contribution or visible meeting attendee record anchors identity; previously confirmed identity merges may contribute to the displayed score after that exact match. The normal thesis/priority decision now also uses exact My Network evidence when no Rust source is configured; the returning shortcut retains its separate score cutoff.

Eligible visitors see their name and verified email, an optional catch-up note, and **Choose a time**. They may choose **Share more context** to fill the full questionnaire. The shortcut does not infer a company, project, or meeting purpose from private notes. No score, cutoff, contact evidence or other profile information is sent to the visitor. Existing requests and resume links take precedence over starting a new one.

Submission rechecks eligibility and resolves the name on the server. If eligibility changes, the UI opens the normal questionnaire with the name and note preserved. Account switching clears recognition; OAuth draft recovery requires the same email and Google identity and expires after one hour. An owned retry returns its existing request before reevaluating the score.

Returning catch-up requests require owner approval and use the existing review slots (at least seven days out). Their optional note is not scored as a thesis submission. Neither a high People score nor the shortcut grants automatic booking, even when the visitor is a VIP. Normal full submissions retain their existing priority rules. The owner can see why intake was skipped and approve the selected time through the usual Calendar flow. These changes add JSON fields only; no migration, secret or Rust deployment is required.

## Rust PeopleGraph connection

Set `PEOPLEGRAPH_HOST` to an authenticated HTTPS gateway for a running `peoplegraph serve`, and `PEOPLEGRAPH_OWNER_EMAIL` to the exact owner of its cache. Store its bearer credential with `wrangler secret put PEOPLEGRAPH_TOKEN`; never commit it. The server process must not inherit `PEOPLEGRAPH_HOST`, which would redirect its own lookups back to remote mode.

Use the Rust version from this branch: `/score` misses now include `stats.user_email`, `last_sync` and `matched:0`, so a genuinely new visitor can be distinguished from an unverified source. Older servers' incomplete misses safely require review.

The adapter reads only exact normalized emails. Aliases resolving to a different primary email require review. Cache ownership must match the pilot, and `last_sync` must be within 24 hours. There is no fuzzy identity or company-domain VIP match. Claimed introducers are shown to the owner for review; the current Rust edge API is not treated as proof of an introduction.

On October 21 the local cache found on this computer belonged to the personal Gmail account and was last synced September 17. It was deliberately not connected to the Betaworks pilot. Native caches and the People web graph are separate sources; do not silently substitute either one.

## Behavior

- Exact VIPs, strong thesis fits (including newcomers), and exact known contacts with plausible thesis fits get priority consideration when Google email authority and the other inputs are verified and fresh. Unknown identity, email authority, source or model state requires review. Clear mismatches with otherwise validated inputs receive an asynchronous submission path.
- The owner sees decision reasons and quoted submission evidence. Visitors never receive private network scores, other contacts’ names, source records, or internal tiers. A recognized returning visitor receives only their own contact name and already-verified email.
- Each request stores a private `policySnapshot` of the settings used at submission, omitting the complete VIP list and recording only whether the verified visitor matched it (`vipMatch`). The decision retains its policy revision; automatic-selection rechecks preserve the initial decision. Current scheduling limits and availability still apply, and a changed policy revision falls back to owner approval rather than upgrading an old request.
- Review eligibility starts seven days after submission, not seven days after each approval attempt. Current minimum notice and Calendar availability are checked again when reserving.
- Slot preferences are not holds. A per-owner coordinator serializes bookings, persists a stable Calendar event ID before insert, and reconciles uncertain outcomes before retrying. Timeouts never create a second event ID.
- Working hours, DST, buffers, daily/weekly booking limits and existing bookings are respected. Google Calendar does not offer an atomic free/busy-plus-insert operation: changes made concurrently outside People remain a provider limitation.
- Google Calendar sends meeting confirmation/invitation and cancellation updates through the owner's Calendar grant. Event descriptions contain only visitor-supplied meeting details. Request, review, decline and new-slot updates appear in the owner's Booking dashboard and the visitor's status page; Public Booking sends no custom email notifications; the separately configured scheduling assistant replies within its delegated email threads.
- A request in `booking` remains unconfirmed until Calendar confirms it; the owner can retry confirmation from the dashboard. Unresolved reservations stay protected. Cancellation enters `cancelling` before deletion; only confirmed deletion or an already-absent event becomes `cancelled`. The owner can **Retry cancellation** and the visitor sees **Cancelling your booking** until status polling observes completion. Durable reconciliation retries uncertain confirmations and cancellations after restarts.
- Pausing intake blocks new submissions and slot selection while preserving existing request status. A valid Google visitor session can read its own status even if the calendar is disconnected. **View an existing request** offers Google sign-in recovery when sign-in configuration and pilot access remain available. Recovery requires the same Google subject and email and never offers new intake while paused, including when no previous requests are found.

## Choosing a time

Visitors choose from a month calendar. Available days are highlighted; selecting a date shows only its time choices. The calendar opens on the first available date, supports previous/next month navigation within the available range, and disables dates without times. Changing the display timezone regroups dates from the original timestamps, including month boundaries and daylight-saving changes. Repeated local times show their UTC offsets. Refresh preserves the selected date while its availability remains present.

Choosing a date or browsing months sends no booking request. Choosing a time uses the exact offered timestamp and the existing approval/confirmation flow. Conflicts retain the calendar so the visitor can refresh availability. Mobile layouts use the same calendar and compact time buttons.

The availability endpoint returns the configured horizon, bounded to 8,640 slots (90 days × 96 quarter-hour starts), so the calendar does not hide later dates behind the former 100-slot listing limit. Targeted selection, approval and reservation checks retain the small 100-slot cap; notice, buffers, working hours, capacity and review delays are unchanged.

## Suggested times

When the listed openings do not fit, visitors can use **None of these times work? Suggest a time**. The same fallback is available when there are no openings. They submit one to three local dates/times with a prefilled timezone on their existing verified request. Suggestions remain preferences until the host explicitly approves a particular time; priority and VIP settings cannot automatically book them.

The request displays saved suggestions to its visitor and to the owner. The owner can approve one or ask for different times. Explicit approval can accept a start outside the owner's normal weekdays or hours. It still checks current minimum notice, the request's review delay, horizon, meeting duration, Calendar availability, buffers and daily/weekly booking limits. Nonexistent or ambiguous daylight-saving times, invalid dates, duplicates and excessive suggestions are rejected rather than silently converted.

Proposal sets carry revisions so an old owner screen cannot approve a replaced suggestion. Identical submission retries reuse the saved set. Choosing an offered calendar time clears suggestions; pending proposals do not consume capacity. In-flight/confirmed bookings cannot have their choices replaced. The existing owner coordinator and persisted Calendar event ID handle concurrent approvals and uncertain writes. No additional schema migration, custom email sender or Google permission is needed.

## Scheduling assistant, REST API and MCP

In **Booking → Scheduling assistant**, the owner can create and revoke app credentials and see whether the agent inbox is connected. Standard public intake, email scheduling and API/MCP preparation use one assessment: the saved Booking thesis, exact fresh relationship evidence and the existing VIP policy. Delegation alone is not meeting approval. Priority results can offer times and delegated meetings book automatically after the counterpart chooses a current offer. Review and weak-fit results offer no times and create no event. The saved page must be enabled and Calendar connected. Working hours, duration, minimum notice, horizon, buffers and capacity still apply.

The scheduler prepares up to three options, each with a slot ID and an offer revision. Offers expire within 48 hours and before their earliest start. A changed settings revision, changed offer or conflict requires fresh options. Confirmation rechecks the live Calendar and uses the existing persisted event ID and reconciliation path. There is no second Calendar writer. Owner-delegated records have no fabricated Google visitor identity and are inaccessible through public visitor endpoints.

The saved Booking thesis is authoritative; a changed or unconfirmed People lens never silently rewrites it. The model must cite exact request evidence, while the deterministic policy applies relationship/VIP rules. The recommendation and decision are private to the owner or their authorized API client. Only `replyText` is intended for a counterpart; never send the whole API result. Calendar descriptions are neutral and exclude private thread text, People scores and lens information.

### Connect another app

Create a token in the Scheduling assistant tab. It is shown once in that browser page, expires after 90 days, and is stored as a SHA-256 hash. `scheduling:read` reads existing requests; `scheduling:write` prepares options, refreshes them and books a selected option. These credentials work only on `/api/scheduling/*`; owner browser cookies work only on the owner routes. Keep tokens in server-side secrets, never URLs or browser bundles.

REST base: `https://people-graph.kayarjones901.workers.dev/api/scheduling`

MCP endpoint: `https://people-graph.kayarjones901.workers.dev/api/scheduling/mcp`

Both use `Authorization: Bearer <scheduling token>`. The MCP server uses the official stateless Streamable HTTP handler. Configure a client that supports a custom bearer header. Tools:

- `prepare_scheduling_reply`: assess the request and persist eligible options; does not send email.
- `refresh_scheduling_options`: reassess against current rules, replace eligible options and invalidate the old revision.
- `confirm_scheduling_time`: create the Calendar invitation for the selected option.
- `get_scheduling_request`: read current status, options and private context.

REST example bodies (placeholders, not live credentials):

```http
POST /api/scheduling/prepare
Authorization: Bearer <scheduling token>
Content-Type: application/json

{
  "email": "counterpart@example.com",
  "name": "Counterpart",
  "context": "Catch up about their new project",
  "timezone": "America/New_York",
  "idempotencyKey": "one-stable-key-for-this-request"
}
```

Optional `windowStart` and `windowEnd` are UTC ISO timestamps. A caller must translate requested date ranges into these fields before asking for options. Nonempty free-text `instructions` are rejected with `invalid_instructions`; `context` is background, not enforced scheduling constraints. If a request such as “afternoons only” cannot fit the saved rules and one continuous window, ask the owner to clarify rather than silently ignoring it.

Use the returned `requestId`, `offer.revision` and selected `offer.slots[].id`:

```http
POST /api/scheduling/requests/<requestId>/confirm
Authorization: Bearer <scheduling token>
Content-Type: application/json

{"revision":"<current offer revision>","slotId":"<selected offered slot>"}
```

Results include private `decision` and `requiresReview`. When `requiresReview` is true, `offer` is null and `replyText` is a neutral waiting-for-review message. API/MCP tokens cannot override judgment. The owner can use **Booking → Requests → Offer times anyway**; the override is tied to the reviewed settings revision. **Reassess request** applies current rules. Legacy unassessed offers cannot be confirmed until reassessed. Already-booked/in-flight exact confirmation recovery is retained.

`GET /api/scheduling/requests/<requestId>` reads the result; `POST /api/scheduling/requests/<requestId>/refresh` with `{}` obtains new options. Repeating an identical preparation key returns its existing request. Reusing that key with changed input or authority fails. Repeating the same confirmation recovers the existing meeting. A `booking` result means confirmation is still unresolved; do not tell a counterpart it is booked until status is `booked`.

### CC email flow and inbox setup

Email is disabled until `SCHEDULING_EMAIL_ADDRESS`, `SCHEDULING_EMAIL_REPLY_DOMAIN`, the sending binding and incoming routing are configured. Deploying the code alone does not activate an address. The owner's connected Gmail account needs its existing read grant; the separate Calendar grant writes the meeting.

The pilot supports one owner and one counterpart. The owner CCs the configured agent and sends a direct request such as “Please find us times to meet next week.” The agent checks the exact Message-ID against the owner's canonical Gmail SENT copy and uses its recipients and authored text. Spoofed From headers, quoted requests, ambiguous authorization, extra recipients and unsupported timing constraints cannot initiate automatic booking. “This week” and “next week” use the owner's saved timezone. Arbitrary date language and recurring negotiations are not supported yet.

The verified kickoff also supplies bounded, authored text from relevant owner/counterpart messages in the exact canonical Gmail thread, at or before the kickoff. Other participants, later messages, attachments and quoted inbound SMTP history do not become meeting evidence or authority. Missing purpose is uncertainty, not proof of fit.

For a review or weak-fit result, only the owner receives an explanation and a link to the request; the counterpart receives no rejection, scores, profile text or time offer. **Offer times anyway** resumes the email conversation once, without booking until the counterpart chooses. API/MCP preparation never sends an email on its own.

An eligible reply offers numbered options. The counterpart can reply “Option 1 works” or “Other options please.” Each offer has a random plus-address reply capability, bound to its counterpart, current offer and expiry; replies must reference the current outbound message. This proves possession of that thread capability, not a separately verified Google identity. Ambiguous or stale choices require clarification or fresh options. Participant rescheduling/cancellation and group meetings are not included in this version. The owner can cancel confirmed meetings in Booking.

Configure a dedicated subdomain when the main domain already uses Google Workspace mail. Do not replace its apex MX. Enable Email Routing and subaddress support for the dedicated subdomain, route the literal agent address to this Worker, and separately configure Email Sending for that sender. The reply domain must accept `scheduling+<capability>@<reply-domain>` through the literal `scheduling@<reply-domain>` rule. Subdomain catchall routing is not used. A `scheduling-email-v1` migration adds the per-owner email coordinator; preserve its namespace on rollback.

Durable email state deduplicates inbound messages and records send intent before delivery. An ambiguous send outcome is not blindly resent; owner attention may be required. Calendar uncertainty follows the stable event reconciliation path. No real email or Calendar invitation is created by the automated tests.

## Additive storage update

The Google-only update adds `booking_google_sessions` and `booking_visitor_oauth` in D1. Existing settings, requests, Calendar grants and coordinator reconciliation records are preserved. It does not convert legacy email identities into Google identities or drop existing tables. Old OTP challenges and email-code sessions are inert and cannot authenticate a visitor; normal expiry cleanup can remove expired rows. Legacy durable email outbox/history tables remain untouched and are ignored. An old email alarm can wake once, but only outstanding Calendar reconciliation can schedule another alarm.

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

The browser test uses Playwright from `PLAYWRIGHT_MODULE` or a local installation. To use the bundled Codex runtime, set `PLAYWRIGHT_MODULE` to its absolute `playwright/index.mjs` path before running `npm run test:booking`. Runtime tests use real workerd, D1 and SQLite Durable Objects with synthetic Google/Rust responses. They send no real Calendar invitations. Never deploy the fixture entrypoint from the runtime tests.

Local validation of the Google-only update passed on October 21, 2026: `npm test` passed 868 tests (148 frontend and 720 TypeScript/core), and all 22 workerd/D1/SQLite runtime tests passed. The browser suite independently passed owner readiness/settings/actions and visitor Google OAuth, draft restoration, request/slot, paused-page and mobile flows; the mobile screenshot was visually inspected. Typecheck, generated Wrangler types, asset builds, deployment dry run and `git diff --check` also passed. Rust is unchanged by this authentication update; its earlier 43 passing tests remain evidence only for that unchanged Rust code.

Deployment completed on October 21, 2026. All ten additive SQL queries succeeded, and `npm run deploy` passed both asset builds and deployed Worker version `7107c5cb-1837-415c-83d2-576500c59f7a` without email bindings. Live smoke checks returned 200 for `/`, `/booking`, `/book/kaya`, `book.mjs` and `booking.mjs`; the bundles contain the Google sign-in flow/readiness and no OTP flow. The unauthenticated owner API returned 401. The public `kaya` API returned 404 because no slug has been saved; serving the HTML page does not mean intake is enabled.

Those October 21 checks did not verify live visitor OAuth or configured intake. The later October 22 dashboard check found a saved, enabled page and a visitor request; a fresh Betaworks-owned Rust source remains missing.

The saved-lens follow-up is deployed as `96c0055f-1bc3-4466-b010-e100fad91e3b`. The 868 app tests, Booking browser suite, typecheck and asset builds passed. The live empty-lens action was verified with all 24 draft controls preserved. The owner dashboard now reports the Calendar connection as ready; a real Calendar booking has not been tested.

The returning-contact update is deployed as `a39795d6-20e0-4f3f-aa53-b6802afdb4e1` (October 22). All 894 app tests (148 frontend/model + 746 TypeScript/core), 26 workerd/D1/SQLite tests, expanded desktop/mobile browser checks, typecheck, asset builds, dry run and diff checks passed. Source regressions cover unfinished Granola retries and alias-only recognition. Live HTML/assets and the enabled `kaya` metadata endpoint passed smoke checks; anonymous metadata contains no visitor/profile and the owner API remains protected. No new migration was needed. An eligible real visitor has not yet exercised the returning shortcut in production.

The month-calendar update is deployed as `458dc43d-5098-4785-a25e-452a6486120d` (October 22). All 904 app tests (156 frontend/model + 748 TypeScript/core), 26 workerd/D1/SQLite tests, typecheck, asset builds, dry run and diff checks passed. Browser regressions cover month navigation, keyboard selection, empty months, exact timestamp submission, timezone round trips, daylight-saving repeats, preserving a day after its first time is taken, and disabled controls after a slot conflict. Desktop and mobile screenshots were inspected; the calendar also fits a 320-pixel viewport. Live pages/assets and anonymous access checks passed, and the public page renders Google sign-in. No live booking was submitted during verification; the authenticated calendar interactions were tested against synthetic availability.

The suggested-times update is deployed as `228a5056-555f-4a01-a43a-b4d1c08ad8dd` (October 23). All 912 app tests (156 frontend/model + 756 TypeScript/core), 30 workerd/D1/SQLite tests, expanded desktop/mobile browser checks, typecheck, asset builds, deployment dry run and diff checks passed. Tests cover timezone/DST validation, visitor identity and origin, revision changes, manual outside-hours approval, conflicts and capacity, uncertain Calendar recovery, preserved drafts and owner settings, and requests changed or confirmed while a visitor is editing. Independent review found no remaining actionable issues. Live pages/assets and enabled public metadata passed smoke checks; owner and proposal APIs reject anonymous access. No real booking or invitation was created during verification. Authenticated proposal and approval flows were verified against synthetic providers. No migration was needed.

The `booking-v1` migration adds a new namespace. Existing `MailSync` storage and migration remain unchanged. Do not roll back by deleting the Booking namespace: reservations and reconciliation state must be preserved.

The scheduling assistant update is deployed as `b941c3f5-9182-44ae-aa5e-ecab24f0afca` (October 23). **959 app tests (156 frontend/model + 803 TypeScript/core), 33 workerd/D1/SQLite integration tests, both desktop/mobile Booking browser suites, typecheck, asset builds, dry run and diff checks pass.** Independent review findings were repaired with regressions for negated kickoff, preserved timing constraints, SMTP reply local-part length, different selections booked by another channel, and successive recovered offers.

The pilot agent address is **scheduling@agent.bestmate.io**. Email Sending is enabled for `agent.bestmate.io`; its SPF, DKIM, DMARC and bounce MX resolve. The dedicated subdomain's routing is ready and literal rule `77242c28bbfd4f189bbbd78324fe3f60` points to `people-graph`, with subaddressing enabled. The Worker restricts sending to this address. Existing apex Google MX/SPF and the disabled catch-all are unchanged. Cloudflare's apex Routing status reports “misconfigured” because those Google MX intentionally remain; the subdomain independently reports ready. Do not fix that apex warning by replacing its MX.

A single automated self-addressed probe to a fresh `scheduling+<token>@agent.bestmate.io` recipient reached the deployed email handler with `outcome: ok` and no exceptions. Its auto-generated header prevented any scheduling action. This probe verified live sending, DNS and plus routing. The owner subsequently supplied a successful live Gmail kickoff-to-offer test on October 23. Neither test confirms a real Calendar booking. The full kickoff-to-booking path passed synthetic integration tests. A real counterpart booking remains untested. Live anonymous route/assets and authorization checks pass. The live browser required sign-in, so the owner controls were verified in the browser fixture; no production API credential was minted. Read-only D1 checks confirmed the `kaya` page remains enabled with 30-minute meetings in America/New_York and a saved Calendar grant.

## Shared assessment validation (October 23)

The shared assessment update is deployed as `dbed43c0-7cf1-4166-8799-270a10885874`. It closes the delegated judgment bypass. All 991 app tests (156 frontend/model + 835 TypeScript/core), 39 real workerd/D1/SQLite integration tests, both desktop/mobile browser suites, typecheck, asset builds, dry run and diff checks pass. Independent review findings were fixed with regressions for stale offers after owner reassessment, current assessment checks during email clarification, API-only approval without email configuration, recovery after temporarily unavailable slots, clear legacy reassessment guidance, and refreshed request policy without overwriting unsaved settings. Scoped re-review found no remaining actionable issues.

Regression coverage includes public/API decision parity, canonical Gmail thread isolation, owner-only review notices, explicit owner overrides, source freshness failures, legacy offers, stale policy, restart/idempotency recovery, and owner UI actions. A live Workers AI evaluation using four synthetic purposes returned strong for concrete AI-agent collaboration, weak for unrelated sales, and uncertain for a vague meeting request and an instruction-injection attempt. These were synthetic inputs; the real saved Booking thesis remains authoritative in production.

Read-only production checks show Google sign-in, Calendar, People source and owner access ready. The earlier live email request correctly requires reassessment because it predates the shared assessment. No existing request was approved, reassessed or booked during deployment verification. Anonymous owner and scheduling APIs return 401; public pages and updated assets return 200. Automated tests use synthetic email and Calendar providers and send no real messages or invitations. A real counterpart Calendar booking remains untested.
