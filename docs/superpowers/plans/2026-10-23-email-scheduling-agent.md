# Email Scheduling Agent Implementation Plan

> Execute independent scoped tasks with shared contracts, then an integrated independent review. Preserve the existing Booking behavior and reservation authority.

**Goal:** Owner-initiated email delegation proposes times and books automatically on a clear agreed choice, with reusable API/MCP access.
**Architecture:** BookingCoordinator owns offers/reservations; SchedulingEmailCoordinator owns durable inbox/outbox. Owner sessions and scoped credentials call the same core. Email kickoff is verified against the owner's Gmail SENT copy.
**Tech Stack:** Worker, D1, SQLite Durable Objects, TypeScript, postal-mime, current official MCP SDK/Agents stateless handler.
**Spec:** ../specs/2026-10-23-email-scheduling-agent.md

## Global constraints
- One counterpart, frozen owner/counterpart recipients; no fake Google visitor identities.
- Owner delegation permits automatic confirmation inside current scheduling limits. No bypass of availability/capacity or separate Calendar writers.
- Fixed offers/revisions/expiry, stable event IDs, durable inbound dedup/outbox. Never retry ambiguous email sends blindly.
- Existing apex MX unchanged. No production third-party mail or Calendar invitations in tests. Email remains off until infrastructure exists.

## Review focus
- Forged/quoted owner kickoff cannot authorize; canonical Gmail SENT verification owns that boundary.
- Token possession/expiry and fixed recipients, not a spoofable From alone, control participant confirmations.
- Draft/private lens context never enters outbound mail or Calendar descriptions.
- Same instant/cross-channel conflicts and uncertain insert recover one event.
- Machine credentials scoped/revocable/owner-bound; caller JSON cannot invent authority.

### Task 1: Scheduling core (backend agent)
Files: src/scheduling-types.ts, src/scheduling-context.ts, src/scheduling-policy.ts, src/booking-types.ts, src/booking-coordinator.ts; tests/scheduling-core.test.ts, tests/booking-coordinator.test.ts.
Interfaces: prepareScheduling, refreshScheduling, confirmScheduling, getScheduling and SchedulingResult exactly as spec. Export input validation/types for adapters.
- [x] Write failing tests for explicit owner authority, windows/timezone, offer expiry/revisions, public identity separation, fresh lens/contact context, automatic confirmation, changed settings and stable retry.
- [x] Implement additive request JSON and shared scheduling checks; reuse book/available machinery without forcing visitor review delay.
- [x] Run focused tests/typecheck, report files and test outcomes.

### Task 2: Email ingress and conversation (email agent)
Files: src/scheduling-email.ts, src/scheduling-email-coordinator.ts, src/scheduling-email-policy.ts, src/scheduling-gmail.ts, src/mail-sync.ts; tests/scheduling-email.test.ts, tests/scheduling-gmail.test.ts.
Interfaces: `schedulingEmail(message, env)` parses/routs mail to SCHEDULING_EMAIL.getByName(owner); export SchedulingEmailCoordinator. MailSync `verifySchedulingKickoff(messageId, agentAddress)` returns canonical verified message or fails. Use Task1 methods, never ordinary visitor submission.
- [x] Write failing verification/parser/state tests including forged headers, quoted kickoff, changed grant, fixed recipients, capability expiry, ambiguous selection, replay and uncertain send.
- [x] Implement verified owner ingestion and participant capability flow, durable dedup/outbox, bounded reconciliation and neutral outbound templates.
- [x] Run focused tests; do not configure DNS/send mail/deploy. Report root integration requirements.

### Task 3: Machine API/MCP (API agent)
Files: src/scheduling-auth.ts, src/scheduling-routes.ts, src/scheduling-mcp.ts; tests/scheduling-api.test.ts, tests/scheduling-mcp.test.ts; package.json/package-lock.json (single dependency owner).
Interfaces: schedulingMachineRoute(request,env,ctx?) for /api/scheduling; schedulingOwnerRoute(request,env,owner) for /api/booking/scheduling including token create/list/revoke/status. Root wires these into index/owner route. Tokens D1 schema init is additive and idempotent.
- [x] Write failing credential scope/isolation/revocation and real MCP initialization/list/call tests; provider fake only, not production.
- [x] Add revocable hashed scoped credentials, bounded APIs and official stateless MCP transport. Owner readiness includes configured email address and API/MCP URLs.
- [x] Install postal-mime plus exact compatible MCP/Agents/zod dependencies; no other agent edits lockfile. Run focused tests/typecheck and report.

### Task 4: Integration, owner controls and release (root)
Files: src/index.ts, src/booking-routes.ts, wrangler.jsonc, generated types, tests/run-mail.mjs, tests/booking-runtime.mjs or scheduling-runtime.mjs, public/booking.mjs, public/booking.css, BOOKING.md.
- [x] Wire scoped routes/email handler and new DO binding/migration; add owner view of agent setup and API token creation/revocation without altering unsaved settings.
- [x] Add Worker/D1/DO integration and owner browser checks with synthetic providers.
- [x] Independently review integrated feature; run app/runtime/browser/typecheck/build/dry-run and fix real findings.
- [x] Deploy safe disabled-unconfigured feature, configure inbox only if user selects valid domain; check production read-only boundaries; document exact remaining activation conditions.
- [x] Commit/push PR12 and give usable connection instructions; no main merge.

Release: b941c3f5-9182-44ae-aa5e-ecab24f0afca. User-selected scheduling@agent.bestmate.io configured; self-addressed plus-routing transport probe passed. 959 app + 33 runtime tests, browser suites and independent review passed. No real counterpart booking performed. See apps/people-graph/BOOKING.md for activation details and limits.
