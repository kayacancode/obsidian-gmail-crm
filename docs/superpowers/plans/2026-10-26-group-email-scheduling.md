# Group email scheduling implementation plan

> **For agentic workers:** Use test-driven development and independently review the combined change before deployment.

**Goal:** Schedule Kaya, Shiv and Berend together from Kaya's verified email request.

**Architecture:** Extend the current per-owner scheduling and booking coordinators. Freeze all named guests from the canonical owner SENT message. Each guest receives an individual reply capability; record agreement on an exact offer revision and slot, and book only when all guests agree. Calendar remains a single writer with its existing retry/reconciliation behavior.

**Tech stack:** TypeScript, Cloudflare Workers and SQLite Durable Objects, D1, Gmail and Google Calendar.

## Scope and decisions

- User confirmed both Shiv and Berend should attend. All non-owner, non-agent To/Cc recipients are required guests, bounded to five. No Bcc or inferred extra attendees.
- Builder choice: require every guest to select the same option before booking. A guest cannot consent for another guest.
- Individual options messages share the subject and include the owner; private reply capabilities prevent a guest from impersonating another by changing their From header. Final confirmation and Calendar invitation include every guest.
- Initially groups require owner review. A single strong primary contact cannot silently authorize unrelated additional guests. Explicit owner approval releases times, not a booking.
- Existing one-guest records and public booking stay compatible. Changing offered times invalidates prior votes. Ambiguous replies do not erase other guests' valid votes; contradictory selections never book.
- No automatic replay of the real rejected email and no additional outbound real-contact messages from the development session.

## Tasks

- [x] Core: add normalized `SchedulingInput.attendees`, restricted to owner-email authority for groups; persist through idempotency and refresh; show guests to owner; include frozen guests in Calendar; require group approval and internal email confirmation authority. Test validation, policy, idempotency and Calendar payload.
- [x] Gmail: extend canonical context to the frozen group, attribute each sender, exclude outsider and Bcc evidence. Permit exact same-address display names while continuing to reject mismatched address names.
- [x] Email coordinator: accept bounded groups; persist per-guest capabilities, acceptable parent message IDs and selections; send individual offers and waiting/conflict responses; retain votes for the same revision; reset on replacement; require consensus before core confirmation. Make final booking state and confirmation queue atomic.
- [x] Runtime: verify two guests, owner review, separate capabilities, wrong sender/capability rejection, conflicting selections, restarts, refresh invalidation, one Calendar event and one final confirmation.
- [x] Run full unit, runtime, typecheck and browser verification; independent review; deploy with existing configuration; report the exact next step for the real thread.

## Review focus

1. A participant changes From to the other guest: capability must reject it.
2. An old offered option or old acceptance arrives after refresh: cannot book.
3. Clarification/repeated approval rotates or loses another guest's valid agreement: preserve same-revision state.
4. Crash during waiting or confirmation: persist state and outgoing message together; reconcile the same Calendar intent.
5. An outsider on an incoming reply, API call, or historical email tries to add attendees: reject; only canonical frozen owner recipients reach Calendar.

## Verification

Full suite: 168 frontend and 1014 backend tests passed. Runtime: 53 passed. Booking and scheduling browser suites, typecheck, and deployment dry run passed. Independent review reproduced a stale-retry race; regression tests now prove newer guest selections withdraw old agreement before external reads and older retries cannot overwrite them. Final review found no remaining blockers.

Deployed version `1e3af207-453e-46c4-b39e-a38a81548f7e`; production booking script matches the validated source byte-for-byte. Implementation commit `dafa6b2` pushed on `codex/scheduling-context-fixes` in draft PR #14. Original Limma request received an owner-only rejection under the old one-guest limit; the user must send a fresh request with both guests, then approve offering group times in Booking. No live guest email or Calendar booking was sent from this development session.
