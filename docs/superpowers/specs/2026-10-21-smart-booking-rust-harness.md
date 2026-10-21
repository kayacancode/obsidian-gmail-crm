# Booking in People with the Rust harness

Feature specification · October 21, 2026

## Product and scope

Add Booking to the existing People application in `apps/people-graph`, in this repository. The owner manages their booking page alongside their network, Your lens, and connected accounts. Visitors use a public link on the same site, verify their email, describe what they are building, and explain what they want to discuss. The feature uses the owner's meeting thesis, relationship evidence from the existing Rust `peoplegraph` harness, and an explicit VIP list to decide which booking experience to offer.

Use Rust PeopleGraph as the relationship engine. It already provides JSON commands and an authenticated HTTP query server. Add booking modules to the existing web app for intake, email verification, thesis evaluation, booking policy, approvals, and Google Calendar scheduling. Reuse People sign-in, the app's visual design, connected-account setup, and the harness's identity and scoring behavior. This is one product and repository; the native Rust service remains an internal runtime dependency.

V1 enables one pilot owner with one explicitly configured PeopleGraph data source and one booking calendar. Existing People users do not automatically receive access to that owner's booking settings or data. Store all booking state with an owner key so additional owners can be enabled later with their own mappings and credentials. Start with approval required for all requests. The owner can enable automatic booking for the priority tier after reviewing decisions.

## Placement in the existing application

Add a Booking entry in People's existing navigation. Its private page contains Requests, Booking page, and Rules views. The owner can review requests, edit the public introduction, set availability and priority rules, and copy their booking link. Keep booking configuration on this dedicated page so the network graph remains focused on people and connections.

Proposed routes, to be implemented:

| Route | Audience and purpose |
| --- | --- |
| `/booking` | Existing People owner session; request inbox, settings, and share-link controls |
| `/book/:slug` | Public booking page, for example `/book/kaya` after that slug is reserved by its owner |
| `/api/booking/*` | Owner-authenticated settings, requests, approvals, and cancellations |
| `/api/public/booking/*` | Public configuration, email-code flow, and limited visitor submission/booking actions |

The public slug resolves to a server-owned configuration. It never lets a visitor select a cache, People owner, Rust service host, or calendar directly. Bind visitor verification to the email, visitor session, and booking owner. A verified visitor receives limited booking permissions and never a People owner session or access to existing graph APIs. Reuse same-origin and owner authorization checks on private mutations.

The route and page names above describe new work; they are not currently available on the live site.

## Visitor and owner experience

1. A visitor opens the owner's booking link and enters their name, email, project description, and meeting purpose. Company, project URL, and a claimed introducer are optional.
2. Verify the email using a short-lived, single-use code bound to the submitted address, booking session, and owner. Limit attempts and resends. Changing the email requires verification again. Verification establishes inbox control, not the truth of a name, employer, or project claim.
3. The booking backend queries PeopleGraph using the verified email and evaluates the request against the owner's saved policy.
4. Show the visitor the eligible slots, an approval-request flow, or a friendly asynchronous submission option. Never display their internal tier, private relationship evidence, scores, or the owner's private thesis explanation.
5. The owner dashboard shows every request or automatic booking, its concise rationale, supporting facts, uncertainty, and policy version. The owner can approve, decline, or override a decision. Automatic bookings are already confirmed and use cancellation controls rather than a misleading pending-approval button.

The owner configures the meeting thesis, examples of desired and undesired requests, VIP emails, working hours, preferred availability windows, buffers, daily and weekly limits, and whether priority bookings can be automatic. Initial editable defaults: 30-minute meetings, 24-hour minimum notice, 10-minute buffers, and a 28-day booking horizon. Review-tier slots start at least seven days out. All slots obey calendar availability and owner limits.

The thesis is an explicit owner-approved booking policy. Prefill it from the signed-in owner's confirmed Your lens fields through the existing internal owner-lens service, with manual entry when the fields are empty. The owner reviews and saves a versioned booking-policy snapshot. Later lens changes may prompt a suggested update, but do not silently change eligibility. The Rust API does not need to expose the lens for this internal integration. Unaccepted Honcho suggestions must never change booking policy. Each submitted request stores a private `policySnapshot` of the settings used, excluding the full VIP list and recording only the visitor’s `vipMatch`; the decision also retains its policy revision. This is an audit record, not an exemption from current availability and scheduling limits. A later policy revision prevents automatic upgrading of the old request, and an automatic-selection recheck preserves the initial decision.

## Decision rules

Evaluate thesis fit, relationship evidence, and VIP status separately. The existing People score measures relationship activity; it is not a booking priority, proof of closeness, or permission to book.

Apply the following policy in order:

| Condition | Outcome |
| --- | --- |
| Required verification is incomplete | Do not offer or confirm a booking |
| Identity is ambiguous, the configured People source is unavailable or stale, or model output cannot be validated | Review |
| Exact verified VIP email, or an owner-confirmed alias of that VIP | Priority |
| Strong thesis fit supported by specific submission details, with no unresolved material ambiguity | Priority, including people new to the network |
| Exact verified primary email matches an existing contact in the fresh configured source, and the meeting purpose has possible thesis fit | Priority; relationship score alone is not sufficient |
| Clear mismatch with the owner's stated meeting interests | Async |
| Otherwise, possible fit for a new visitor, uncertain fit, or incomplete context | Review |

| Outcome | Experience |
| --- | --- |
| Priority | Earliest eligible slots, ordered by the owner's preferred windows. Book directly only if automatic booking is enabled; otherwise submit for approval. |
| Review | Eligible slots at least seven days away. The selected slot is a preference, not a confirmed reservation. Owner approval is required. |
| Async | A courteous response and a short update or deck-link submission form. No calendar event. |

A lookup returning `not_found` against a verified fresh cache represents a new visitor and does not lower thesis fit. A failed lookup is an unknown result and routes to review. A documented introduction can support review; it does not override a clear mismatch or the owner's calendar limits.

Use the model to return structured fit (`strong`, `possible`, `weak`, or `uncertain`), concise reasons, cited submission or authorized context fields, and uncertainties. Validate the result. Application code applies the policy and executes calendar actions. Treat visitor text, links, and stored excerpts as data, never as instructions to modify policy, reveal contacts, or invoke tools.

Store a private decision record with the verification reference, People source and freshness, evidence used, fit result, outcome, policy version, model version, and any owner override. Feedback can inform later suggestions, but must not silently rewrite the policy.

## Existing Rust integration

Repository: https://github.com/kayacancode/obsidian-gmail-crm

Implementation: `crates/peoplegraph/src/main.rs`. The contract below was checked against commit `237b77cd10b69b901fbc1301a705d14c8b0b9cbe`, merged into `main` by PR #11.

The Rust harness reads a configured `contact-index.json` and related local source files. `peoplegraph serve` exposes queries over HTTP. Its default bind address is `127.0.0.1:8787`. The operator supplies `PEOPLEGRAPH_TOKEN`; HTTP requests use `Authorization: Bearer <token>`. This is an existing shared read credential for that server's configured cache, not a Google login, per-visitor token, or multi-tenant authorization system.

The production Rust-service URL is deployment configuration, not an already verified public endpoint. The existing People site at `https://people-graph.kayarjones901.workers.dev/` will host the booking pages and routes, but its current Worker API does not implement the Rust query contract. Do not substitute that URL as `PEOPLEGRAPH_HOST` without an explicit adapter.

Supported examples, with the token injected through the environment or secret manager:

```sh
# Run on the host that owns the configured cache.
env -u PEOPLEGRAPH_HOST peoplegraph --cache /srv/people/contact-index.json serve --bind 127.0.0.1:8787

# Query through the CLI. PEOPLEGRAPH_HOST and PEOPLEGRAPH_TOKEN are configured.
peoplegraph --remote score sam@example.com
peoplegraph --remote contact-card sam@example.com
peoplegraph --remote get-neighbors sam@example.com
peoplegraph --remote get-edges --from sam@example.com --to alex@example.com
```

`--remote` prevents accidental fallback to a different local cache. Keep `PEOPLEGRAPH_HOST` unset in the server process: it can cause its own query dispatch to enter remote mode. An application running beside the Rust binary may instead invoke local commands with a fixed `--cache` path, no remote-host environment setting, and argument arrays; never interpolate visitor input into a shell command. Check the deployed binary with `version`; the inspected crate version is 0.3.10.

| Existing HTTP route | Use |
| --- | --- |
| `GET /score?email=<encoded-email>` | Lookup by normalized email or stored alias; returns score, direct activity fields, and freshness metadata |
| `GET /contact-card?query=<encoded-email>` | Source-aware profile enrichment after exact identity resolution |
| `GET /get-neighbors?email=<encoded-email>` | Existing graph neighbors and edge context |
| `GET /get-edges?from=<encoded-email>&to=<encoded-email>` | Existing edges between two addresses |
| `GET /find-person?query=<encoded-query>` | Fuzzy discovery for owner review; never an identity verification step |
| `GET /version`, `GET /describe`, `GET /health` | Version and capability checks; health alone does not establish cache validity or freshness |

Every route requires bearer authentication. Responses use the existing envelope: `ok`, `command`, optional `data`, `stats`, and optional `error` with `kind` and `message`. Success is HTTP 200. The current server uses HTTP 400 for query failures including a missing contact and HTTP 401 for failed authentication. Parse `ok` and `error.kind`; do not classify every HTTP 400 as a new visitor.

The following is an abridged example of the existing `/score` response, using fictional values. Other signal and statistics fields are omitted for readability.

```json
{
  "ok": true,
  "command": "score",
  "data": {
    "email": "sam@example.com",
    "name": "Sam Rivera",
    "canonical_id": "person_example",
    "score": {
      "depth": 3,
      "recency": 8,
      "combined": 64,
      "quadrant": "nurture"
    },
    "effective_score": 64,
    "manual_adjustment": 0,
    "score_source": "cached",
    "signals": {
      "total_exchanges": 12,
      "sent": 5,
      "received": 7,
      "last_contact": "2026-10-03T14:00:00Z",
      "domain": "example.com"
    }
  },
  "stats": {
    "matched": 1,
    "contact_count": 240,
    "last_sync": "2026-10-21T09:00:00Z",
    "user_email": "owner@example.com",
    "ms": 2
  }
}
```

Preserve score units: depth is 1–5, recency 1–10, and combined 0–100. `effective_score` can include a manual adjustment. `score_source` indicates whether cached score information exists; partially cached records can still contain estimated fields. A company inferred from an email domain is not verified employment.

## Booking adapter and evidence rules

Create a small adapter inside `apps/people-graph` around the existing Rust commands. This adapter is new feature code; its normalized results are not existing Rust API fields.

1. Resolve using `/score` with the verified email. An exact primary email match is eligible for relationship lookup. If it resolves through an alias, use that association for automatic priority only when the alias is owner-confirmed or its provenance is otherwise verified. Existing lookup chooses the first matching alias and does not report alias collisions; ambiguous or unverified alias resolution requires review.
2. After resolution, query `/contact-card` using the returned primary email if additional profile information is needed. Use `source_of_truth.contact` for the primary record. The card can fall back to a fuzzy match, and `core.emails` combines candidate external sources, including some company-only matches. Neither a returned card nor its combined email list independently verifies identity. Keep external candidates separate for owner review.
3. Retrieve neighbors or a specific edge only when relevant, such as investigating a claimed introducer. Do not download the entire network for every visitor. Empty edge lists establish only that no matching edge was returned.
4. Map results to explicit `matched`, `not_found`, `ambiguous`, `stale`, or `unavailable` outcomes. A transport, parsing, authorization, owner-source mismatch, or missing-cache error is not `not_found`.
5. Bind the service endpoint, credential, and expected cache owner in trusted server configuration. Check returned owner metadata. If source ownership cannot be established, disable automatic eligibility until configured correctly. Visitors cannot supply the service host, cache path, owner, or arbitrary graph-query parameters.
6. Use `stats.last_sync` to assess freshness, with an initial maximum age of 24 hours. Missing or future-dated freshness is unknown. An old `signals.last_contact` describes the relationship, not the age of the cache. This implementation adds `matched: 0`, `user_email`, and `last_sync` to the Rust `/score` `not_found` statistics, retaining `ok: false`, the existing error, and no contact data. Missing cache metadata remains null. The inspected older binary omits this metadata; its lookup misses route to review unless source ownership and freshness can be verified separately for the same configured service. A fresh miss with matching owner metadata establishes a new visitor, rather than a source failure.

Introduction status must remain separate from network membership. Shared-thread edges, mutual neighbors, generic edge context, and a visitor's named referral are not verified introductions. The current cache producer derives edge scores from the owner's scores with the two endpoints; edge and aggregate scores are not measurements of how well those endpoints know one another. The Rust edge schema has no dedicated verified-introduction record with source provenance. V1 shows named referrals as unverified claims for owner review. Approving a meeting is not recorded as proof of an introduction. Verified referral records are a future extension.

The existing web Gmail introduction service can later provide additional evidence internally once the Rust contact is mapped to the same owner's web identity and source consent is verified. Preserve that evidence's provenance and distinct unavailable/not-found states; use cached evidence for booking rather than triggering a long Gmail search on every visit. Neither this mapping nor introduction retrieval is supplied by the Rust token. The owner lens is reused separately through People's existing internal service.

## Deployment and data freshness

The architecture is:

```text
Visitor → People public booking routes → private Rust PeopleGraph service → configured cache
                                      → owner-approved booking policy and reservation coordinator
                                      → Google Calendar
Owner   → People sign-in → Booking settings and requests → existing owner-lens service
```

Extend the existing People Cloudflare Worker and static assets for the public and private booking pages. Add owner-scoped booking tables to the existing D1 database and a separate booking reservation Durable Object; keep booking state out of the mail-sync object. Run the native Rust service on a persistent host or container with access to the intended cache, behind an authenticated private connection or HTTPS gateway. A deployed Worker cannot reach the developer laptop's loopback address, and the current native binary uses filesystem and TCP APIs rather than running unchanged inside a standard Worker.

Reuse the existing cache producer and establish a scheduled, atomic refresh or delivery process to the service host. Running `serve` does not perform Gmail sync. The native cache and the web mail-sync Durable Object are currently separate stores; putting Booking in this repository does not unify them. Show the selected relationship source and freshness in owner settings, establish the explicit People-owner-to-cache-owner mapping, and verify the intended source before enabling automatic bookings. Claims that Booking uses the exact network visible in the graph require a tested data bridge or shared source. Keep source-specific private context separated; Booking receives only the fields needed for its decision.

The current HTTP server is a small synchronous TCP server. Before production, provide bounded connections, request and response limits, timeouts, rate limiting, and redacted access logs through the gateway or a focused server improvement. Prevent a slow client from blocking queries. Keep the service private and restrict the booking credential's reachable routes to the required reads. Never expose the Rust token, filesystem paths, raw response envelopes, or other contacts' details to visitors.

A proposed lookup budget is three seconds for the booking request. On timeout, let the visitor submit a review request. Host credentials are configured out of band; this document contains no live token or production Rust-service URL.

## Calendar and approvals

Add a Calendar booking authorization step to the Booking dashboard, linked from Accounts and the network menu. Reuse the owner identity, verify the granted scopes, and obtain explicit availability and event-creation permission for the chosen calendar. The existing People Calendar grant is read-only and does not authorize booking writes. Keep booking capability and revocation status explicit so changing booking permissions does not disrupt Gmail import. A connected calendar offers **Reconnect Google Calendar** to renew expired or revoked grants without disconnecting first. Disconnect remains available but is blocked while `booking` or `cancelling` requests require reconciliation.

Use the configured calendar's free/busy data, owner timezone, and local working hours. Store instants in UTC and render them in the selected timezone. V1 has no automatic deck fetching or attachment ingestion; accept a link and short text.

Persist requests in D1. Coordinate competing bookings for one owner in a Durable Object or equivalent serialized reservation mechanism. Recheck Google availability just before event creation. Use an idempotency key per booking and a stable event identifier so retries after a lost response reconcile the same event instead of creating another one. Application reservations protect against competing app requests; Google Calendar can still be edited externally, so detect conflicts and offer alternatives rather than promising an atomic cross-system transaction.

Request states are `pending_approval`, `booking`, `booked`, `needs_new_slot`, `declined`, `async_submitted`, `cancelling`, `cancelled`, and `expired`. A booking error retains a recoverable state and must not display confirmation until event creation is verified. Pending review requests do not reserve a slot indefinitely. On approval, recheck availability; if the requested time is gone, move to `needs_new_slot` and offer new eligible times.

Persist `cancelling` before requesting Calendar deletion and keep its reservation protected until the provider confirms deletion or the event is already absent. An uncertain deletion must not become `cancelled` or return to `booking`. Durable reconciliation retries the same event ID after restarts; the owner can use **Retry cancellation**. Visitors see **Cancelling your booking** and poll their own status until cancellation completes. The equivalent **Retry confirmation** and status polling apply to `booking`.

Pausing public intake blocks new requests and slot selection without removing access to existing request status. A valid visitor session can read its own status even when the booking calendar is disconnected or email delivery is unavailable. The public page offers **View an existing request** for email verification recovery only while email delivery and pilot access remain available (`recoveryAvailable`). Paused recovery shows existing statuses or an empty-history message and never exposes new intake or time selection.

Owner approval and decline require authenticated, idempotent POST actions. Opening a link or an email preview must not approve a meeting. Send the calendar invitation only after successful creation. Keep private scores, referral analysis, and policy reasoning out of the event description and visitor notifications.

## Delivery and acceptance

Build in this order:

1. Add the Booking navigation entry, owner page, and public slug route in `apps/people-graph`, using existing People owner authentication and isolated visitor sessions.
2. Implement the Rust adapter and fixtures against the documented envelope, including not-found, stale, ambiguous alias, and service-error cases. Establish the owner/source mapping.
3. Build verified visitor intake, owner-approved thesis prefill from Your lens, VIP settings, structured fit evaluation, and the approval dashboard. Initially require approval for all bookings.
4. Add availability, conflict handling, event creation, cancellation, and retry recovery.
5. Connect the actual Rust host and cache refresh process. Verify the intended owner and freshness, then enable the owner's optional automatic-booking setting.

Acceptance tests must demonstrate:

- People owner sessions and public visitor sessions remain distinct; changing a slug or request ID cannot access another owner's requests or network.
- Confirmed Your lens fields can prefill the thesis, while later lens changes and pending suggestions cannot silently alter the saved booking policy.
- A fresh lookup miss with strong fit can qualify for priority; a lookup failure routes to review.
- A fuzzy card or unconfirmed alias cannot give someone another person's relationship or VIP privileges.
- A claimed referral or shared-email edge never becomes a documented introduction automatically.
- VIP status is an explicit booking rule; a high People score alone cannot bypass approval.
- Stale, missing, mismatched-owner, and malformed source results produce reviewable requests.
- Submission text cannot override policy or trigger arbitrary commands, URLs, or contact queries.
- Expired or replayed email codes fail, and changing the address requires reverification.
- Review requests offer dates at least seven days out and remain unconfirmed until approved.
- Repeated approval, duplicate submission, and uncertain Calendar responses create at most one app booking event.
- Concurrent requests, external calendar conflicts, daylight-saving changes, and owner limits are handled without false confirmations.
- An uncertain cancellation survives restart, retries the same Calendar event deletion, remains visibly pending, and never resurrects the meeting or releases its reservation prematurely.
- Existing Calendar grants can be reauthorized without disconnecting first.
- Paused pages recover existing visitor status without offering new requests or slots, including when the calendar is disconnected.
- Each request retains its private policy snapshot and original decision through later policy or source rechecks.
- The owner sees reasons and evidence; visitors receive only their own booking outcome and permitted public information.

## Implementation references

- [Rust commands, HTTP server, and response schemas](https://github.com/kayacancode/obsidian-gmail-crm/blob/237b77cd10b69b901fbc1301a705d14c8b0b9cbe/crates/peoplegraph/src/main.rs)
- [Existing remote-query guide](https://github.com/kayacancode/obsidian-gmail-crm/blob/237b77cd10b69b901fbc1301a705d14c8b0b9cbe/docs/peoplegraph-remote-query.html) — use secret injection rather than copying token-in-command examples.
- [Google Calendar availability](https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query)
- [Google Calendar event creation](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert)
