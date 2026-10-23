# Suggested Booking Times Implementation Plan

> **For agentic workers:** Use the normal execution workflow with independently scoped backend and UI tasks, then a fresh integrated review. Steps use checkbox syntax for tracking.

**Goal:** Let authenticated visitors propose up to three times and let the host approve a specific suggestion safely.

**Architecture:** Extend existing request JSON with a revisioned proposal set, validate local times on the server, and reuse serialized Calendar booking/reconciliation. Keep the public month picker primary and offer a collapsed fallback; add owner proposal actions.

**Tech Stack:** Existing Cloudflare Worker, D1, SQLite Durable Object, TypeScript and vanilla browser modules.

**Spec:** ../specs/2026-10-23-booking-suggested-times-design.md

## Global constraints

- One to three local starts plus an IANA timezone; exact Google visitor ownership and same-origin writes.
- Owner approval always required; suggested starts may be outside working hours but all other scheduling limits remain.
- Stale proposal revision cannot book; overlapping approval cannot create conflicting events; uncertain writes retain existing event identity.
- No production test bookings, new migrations, or main merge.

## Review focus

- DST gaps/repeats and date rollover must never silently move a requested time (backend policy tests).
- Pending preferences must not hold capacity or become automatic priority bookings (coordinator/runtime tests).
- Replaced suggestions and uncertain writes must not book a different instant on retry (coordinator/runtime tests).
- Expired/wrong visitor sessions must not expose or mutate another request; unsaved failed form remains available (runtime/browser tests).
- Empty availability, mobile layouts and the return-to-calendar path remain usable (browser tests).

### Task 1: Proposal persistence and approval

Files: src/booking-types.ts, src/booking-policy.ts or focused helper, src/booking-coordinator.ts, src/booking-routes.ts; tests/booking-core.test.ts, tests/booking-coordinator.test.ts.

Interfaces: visitor POST requests/:id/proposals accepts {timezone, times: string[]} where each time is YYYY-MM-DDTHH:mm. Public request adds proposedTimes?: {timezone, slots: {start,end}[], revision} and slotSource?: 'suggested'|'offered'. Owner POST requests/:id/approve-proposal accepts {start,revision}; owner POST requests/:id/request-times requests a fresh choice.

- [x] Write/run failing policy and coordinator tests for validation, outside-hours manual approval, limits, conflicts, stale revision, state/identity and retries.
- [x] Implement additive JSON state, narrow public projection and safe serialized transitions; retain provider reconciliation.
- [x] Run scoped tests and typecheck.

### Task 2: Visitor and owner UI

Files: public/book.mjs, public/booking.mjs, public/booking.css, optional focused public module; tests/booking-browser.mjs.

- [x] Add browser expectations for proposal entry, validation, save/failure, resume, owner action and mobile.
- [x] Add compact 1–3 date/time form with selected timezone; submission goes to proposals endpoint. Show saved proposals on request status and allow editing or choosing calendar times while permitted.
- [x] Render owner alternatives in host timezone with visitor timezone context, approve-proposal with current revision, and request-times fallback. Keep draft settings intact.
- [x] Run browser suite and inspect desktop/mobile screenshots.

### Task 3: Integration, review and release

Files: tests/booking-runtime.mjs, BOOKING.md, this plan.

- [x] Add real Worker/D1/DO tests for identity/origin, public projection, alternative approval and uncertain retry.
- [x] Review integrated diff; run npm test, Booking runtime/browser, typecheck, diff check and deployment dry run.
- [x] Deploy, verify assets/public boundaries, update docs, commit and push PR12.
