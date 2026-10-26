# Returning Booking Contacts Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development to implement the independent source, policy, and UI tasks, then review the integrated result.

**Goal:** Recognize strong existing contacts after Google sign-in, autofill their name and verified email, and replace the questionnaire with an optional catch-up note.

**Architecture:** A narrow owner-scoped MailSync RPC supplies the same adjusted People score as My Network. Booking verifies the exact authenticated email and threshold on both page load and submission. Returning requests use the existing owner-review path because skipping the project questionnaire does not establish thesis fit or authorize automatic booking.

**Tech Stack:** Cloudflare Workers, SQLite Durable Objects, D1, TypeScript, vanilla browser modules.

**Spec:** User-approved returning-contact flow, extending `docs/superpowers/specs/2026-10-21-smart-booking-rust-harness.md`.

## Global Constraints

- Default cutoff: People score >= 70/100; owner can change the cutoff (integer 1–100) or disable the shortcut in Rules.
- Use the adjusted My Network score, including owner feedback. Normal booking priority continues using the Rust service.
- Match exact normalized authoritative Google email anchored by raw Gmail or visible Granola attendee evidence; never qualify alias-only or shared-only contacts. Existing confirmed identity merges may contribute to the adjusted score after the exact identity match.
- Require completed contributing source syncs no older than 24 hours; Granola must have no unfinished job. Unrelated syncs must not make a contact fresh.
- Public responses expose only name and the already-verified email; never score, threshold, notes, source records, or private reasoning.
- Autofill no company or project: current company data is an email domain, not a verified employer.
- Existing requests, account isolation, recovery while paused, scheduling limits, and approval controls remain intact.
- No real invitations during testing. Deploy and push to existing PR12; do not merge.

## Review Focus

- Score changes between sign-in and submission: fall back to intake without losing the note.
- Account changes and OAuth renewal: drafts and autofill must remain bound to the same identity.
- Retry after a lost response: return the existing owned request before eligibility rechecking.
- Old saved settings: hydrate defaults without changing revisions or publishing the page.
- Refreshing another account or shared network: must not qualify stale contact evidence.

### Task 1: Direct contact source

**Files:** `apps/people-graph/src/mail-sync.ts`, a focused source test file.

**Interface:** `bookingContact(email:string)` returns `{owner,email,name,score,checkedAt,sourceUpdatedAt} | null` using the existing graph contact aggregation and feedback. Check all contributing source freshness and return no conversation content.

- [x] Write and run failing tests for exact match, score parity, feedback, missing/shared-only contacts, and relevant-source freshness.
- [x] Implement the narrow RPC and make those tests pass.

### Task 2: Eligibility and submission

**Files:** `booking-returning.ts`, `booking-types.ts`, `booking-policy.ts`, `booking-store.ts`, `booking-coordinator.ts`, `booking-routes.ts`, focused core/coordinator/runtime tests.

**Interfaces:** `getReturningBookingContact(env,settings,identity,now?)` returns `{name,email,score,lastSync} | null`. Settings gain `returningContactsEnabled:true` and `returningScoreThreshold:70`. Public metadata gains `returningContact:{name}|null`. POST requests accepts `{kind:'returning',note,idempotencyKey}`; saved requests gain `intakeKind:'returning'|'standard'`.

- [x] Write and run failing tests for threshold boundaries, non-authoritative identities, malformed or stale RPC output, owner isolation, and legacy settings.
- [x] Implement eligibility and return only the public profile projection.
- [x] Recheck eligibility after owned idempotency recovery and rate limiting; return `409 intake_required` with no record when ineligible.
- [x] Store server-resolved name, empty project/referrer/URL, optional note as purpose, and an explicit review decision with thesis fit unassessed. Test no automatic booking and existing approval behavior.

### Task 3: Visitor and owner UI

**Files:** `public/book.mjs`, `public/booking.mjs`, `tests/booking-browser.mjs`.

- [x] Write browser tests for welcome/autofill, optional note, no automatic submission, full-form opt-in, stale fallback, retries, identity-bound OAuth drafts, and paused/history precedence.
- [x] Add the returning form and a “Share more context” route to the regular form. On `intake_required`, keep name, note, and request key in regular intake.
- [x] Add Rules controls for enabling the shortcut and changing its cutoff, explaining that it skips intake and retains review.
- [x] Run browser checks at desktop and mobile widths.

### Task 4: Verify and ship

- [x] Review integrated changes and address concrete findings.
- [x] Run app tests, real Worker/D1 runtime tests, browser tests, typecheck, build, and diff checks.
- [x] Update Booking documentation, deploy, verify public static assets and anonymous boundaries, then commit/push the existing branch and update PR12.

No D1 migration or additional secrets are required. Live recognition still depends on a published Booking page and an eligible visitor signing in.

Final review found and resolved unfinished Granola retry and alias-only recognition gaps. Verification on October 22: 894 app tests (148 frontend/model + 746 TypeScript/core), 26 workerd/D1/SQLite tests, expanded desktop/mobile browser checks, typecheck, dry run and diff checks passed.

Deployment: `a39795d6-20e0-4f3f-aa53-b6802afdb4e1`. The live `kaya` page is enabled; anonymous metadata has no visitor or returning profile, and the owner API requires sign-in. An eligible real visitor has not yet completed the new shortcut in production.
