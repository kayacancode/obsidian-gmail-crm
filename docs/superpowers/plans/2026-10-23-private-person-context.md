# Private Person Context Implementation Plan

> Execution: native implementation with one isolated backend subtask and independent final review. Existing attached worktree; preserve current Booking work.

**Goal:** Save private context beside a person and use it to steer their helper suggestions.
**Architecture:** Owner-scoped MailSync note table and routes; dedicated profile editor; reuse existing explicit helper brief path.
**Tech Stack:** TypeScript, Cloudflare Worker/SQLite Durable Object, browser ES modules.
**Spec:** docs/superpowers/specs/2026-10-23-private-person-context-design.md

## Global constraints
1000 characters maximum; own synced contacts only; no shared exports or owner lens/booking changes. No real notes or messages created in verification. Reuse same-origin session authorization and account cancellation.

## Review focus
- Cross-account/shared-only/pushed identity must not gain note access.
- Concurrent edits/removal must reject stale writes and stale helper results.
- Switching people while save/load runs must not put text under the wrong name.
- Source/AI failure must preserve note and never fabricate a match.
- Private note must remain attributed to the owner and absent from shared graph exports.

### Task 1: Private storage, route, and helper default
Files: new src/person-context.ts, src/person-context-routes.ts, src/mail-sync.ts, src/index.ts, src/mail-routes.ts; focused real SQLite/route/helper tests.
Interface: GET /api/people/context?personId=<opaque>; POST /api/people/context with {personId,text,revision:string|null}. Response {personId,text,revision:string|null,updatedAt:number|null}. Empty text removes content while advancing a tombstone revision. MailSync getPersonContext(personId), savePersonContext({personId,text,revision}). Helpers return contextSource:'saved_note'|'brief'|'automatic' and brief:string (actual used context). In-flight saved-note changes yield 409 person_context_conflict.
- [x] RED tests for owner identity, bounded/same-origin input, persistence, revisions/removal, private export isolation, saved helper fallback/explicit override/stale result.
- [x] Minimal implementation and focused GREEN/typecheck.

### Task 2: Profile editor and useful context
Files: new public/relationship-graph/person-context.mjs, public/relationship-graph/graph.mjs, helper-suggestions.mjs, relationship-host.mjs, relationship-graph CSS, browser tests.
Callbacks onGetPersonContext(personId), onSavePersonContext({personId,text,revision}); enabled only for email_accounts personal context, server remains authoritative. Editor before Recent context, textContent-only display, error/conflict preserves edits, saved note refreshes helper panel. Helper renders returned brief and contextSource provenance.
- [x] RED browser regressions for save/reload/edit/remove, failed/stale saves, person switch, no shared editor, hidden boilerplate and preserved useful excerpt, actual saved brief provenance.
- [x] Minimal implementation, GREEN browser/host tests, desktop/mobile inspection.

### Task 3: Verify and deliver
- [x] Full app tests, appropriate helper/host browser checks, typecheck, dry-run, independent review.
- [x] Deploy, read-only live checks, document, commit/push existing branch and update draft PR. No merge.

## Delivery evidence

999 app tests, four workerd/SQLite/RPC integration tests, new person-context and existing helper browser suites, typecheck, builds, dry run and independent review passed. Review caught a textarea focus/caret loss on graph refresh; a browser regression now verifies the fix. Live read-only verification on Pope Cruz showed Your context / Add context and the editable form; no real note was saved.

Worker `8c6780ad-b794-4749-91d9-a5bc2100c2aa` deployed on 2026-10-23. The new route initially reached an older Durable Object during eventual deployment propagation (missing RPC method); it subsequently returned the expected empty context. Narrow diagnostics omit note text and contact identifiers. Existing draft PR #12 receives this change; main is not merged.
