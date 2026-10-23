# Shared Meeting Assessment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply and test the same meeting judgment before offering time through Booking, email and API/MCP.

**Architecture:** Reuse the booking fit evaluator and deterministic policy. Gate delegated offers in BookingCoordinator, read purpose from the canonical Gmail thread, and provide an explicit authenticated owner override.

**Tech Stack:** TypeScript, Workers, Durable Objects, D1, Gmail, existing helper model and Calendar providers.

**Spec:** `docs/superpowers/specs/2026-10-23-shared-meeting-assessment-design.md`

## Global Constraints

- Saved Booking thesis is policy; exact fresh sources only; evidence is untrusted data.
- No counterpart mail or Calendar writes for review/weak fit. Private rationale stays owner-only.
- Explicit override bypasses judgment only, never calendar rules or participant selection.
- Preserve durable deduplication, exact offer confirmation, and uncertain-write recovery.
- No real test messages/invites. Deploy/push; no main merge.

## Review Focus

- Legacy offers must not retain the old unassessed bypass.
- Gmail thread messages outside the sole-counterpart context or after kickoff must not influence assessment.
- Missing/stale source data must not masquerade as a verified relationship miss.
- Review mail and API reply text must not disclose private policy or scores to the counterpart.
- Owner approval must be tied to the current policy and remain safe on duplicate/restarted email delivery.

### Task 1: Shared assessment and core gate

Files: booking-fit/people/policy/coordinator, mail-sync, scheduling-types/policy/context, focused core/fit/source tests.

Interfaces: `SchedulingResult` gains optional `decision` and `requiresReview`; `SchedulingRecord` gains `assessmentVersion: 1` and optional `approval` tied to settings revision. `BookingCoordinator.approveScheduling(owner,id,expectedRevision)` records an authenticated owner override and returns current offers. Public standard submit and delegated preparation use the same evaluator. Returning shortcut remains review.

- [x] Write and run failing parity, stale source, legacy offer, review gate and explicit approval regressions.
- [x] Implement shared evaluator, authoritative My Network source fallback, and gate prepare/refresh/confirm/results.
- [x] Run focused tests and typecheck.

### Task 2: Canonical email context and private review

Files: scheduling-gmail, scheduling-email-policy/coordinator, Gmail/email tests.

Interfaces: verified kickoff gains optional `context` containing bounded canonical request evidence. Email passes it to core. `SchedulingEmailCoordinator.resumeApproved(owner,requestId)` resumes the existing conversation after owner approval. `requiresReview === true` results send an owner-only explanation and retain a resumable conversation.

- [x] Write and run failing canonical thread isolation and review/approval mail regressions.
- [x] Fetch bounded relevant canonical messages; implement private review notice and approval resume.
- [x] Run focused tests and typecheck; no production mail.

### Task 3: Owner controls and integration

Files: scheduling-routes, booking.mjs, scheduling.mjs, API/browser/runtime tests, BOOKING.md.

- [x] Write failing owner-only approval route and review UI assertions.
- [x] Add owner cookie approval endpoint and “Offer times anyway” control; API/MCP expose private assessment without new automatic override.
- [x] Exercise real workerd priority/review/weak/override plus existing Calendar recovery with synthetic providers.
- [x] Run full tests, typecheck, browser checks, build/dry run and independent review.
- [x] Update docs/PR, deploy, commit and push after verification.
