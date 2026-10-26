# Relationship Memory Implementation Plan

> **For agentic workers:** Use the existing isolated worktree; independent modules run in parallel with one integration review. Track completed work and test evidence here.

**Goal:** Make owner-authored relationship context reusable across capture, recommendations and intro explanations.

**Architecture:** Private owner SQLite memory and explicit manual entities. Bounded recommendation snapshots with source attribution; a separate API/MCP credential boundary; Rust as a client of the same hosted records.

**Tech Stack:** TypeScript, Cloudflare Worker/Durable Object SQLite, browser ES modules, Rust/Clap.

**Spec:** `docs/superpowers/specs/2026-10-24-relationship-memory-design.md`

## Global constraints

- Keep legacy context APIs compatible and private. No automatic sharing or sending.
- Reject unknown fields/identities, stale revisions, oversized input and credential cross-use.
- Manual records cannot impersonate synced mail evidence or automatic booking recognition.
- Use existing infrastructure and dependencies; no production test records.

## Review focus

- Capture retry after deletion must not restore the deleted source.
- A removed source/contact or changed note while inference runs must invalidate the recommendation.
- Point-person and weaker-relationship controls must remain separate from hiding/sending.
- Old clients editing the legacy note must not erase structured fields.
- Shared intro explanations cannot include private memory.

## Tasks

### 1. Memory and capture (root)
- [x] Add meaningful failing tests for persistence/CAS, legacy preservation, capture dedupe/tombstones, owner and manual-identity boundaries, snapshot changes and score adjustment.
- [x] Implement `relationship-memory.ts`, root `MailSync` methods, session routes, preview extraction. Export `RelationshipMemory`, `RecommendationMemory`, `validSaveRelationshipMemory`.
- [x] Verify node tests and actual Worker SQLite/RPC; wire imports into test runner.

### 2. Matching and intro reasons (person_context_review)
- [x] Test owner context as both selected brief and candidate evidence; defer/suppression; snapshot races; shared isolation.
- [x] Extend helper pipeline and owner-lens routes. Reuse audited explanations for shared intros; add point-person guidance.
- [x] Run affected core tests and typecheck.

### 3. External capture (person_context_recon)
- [x] Test separate token scope/expiry/revocation, owner isolation and REST/MCP parity.
- [x] Implement People auth/adapter and explicit Rust memory lookup/capture/save commands with text-file support.
- [x] Document exact bot/voice-transcript usage; verify Rust suite and adapter tests.

### 4. UI (relationship_capture_ui)
- [x] Test editing/reload/conflict/focus preservation, voice failure fallback, graph navigation/copy and credential controls.
- [x] Expand existing context editor with structured fields and optional dictation, relationship/timing/point-person controls, source entry deletion. Add reason copy/explore and integrations UI.
- [x] Verify browser tests desktop/mobile, without real-data writes.

### 5. Integration (root)
- [x] Full app + Rust suites, builds/typecheck, independent final review, fix verified regressions.
- [x] Deploy authorized app changes after checks, attempt read-only live verification, and prepare the verified changes for the existing draft PR. Do not merge without a current merge request.

## Interface ledger

`MailSync.getRelationshipMemory(personId)`, `saveRelationshipMemory(input)`, `relationshipMemoryForEmail(email)`, `captureRelationshipMemory(input)`, `recommendationMemory()` share the exported types. Recommendation revision fingerprints eligible memory, feedback and identity state, including legacy writes. API adapters derive owner from credentials. Frontend GET/POST `/api/people/memory` uses the full editable record excluding entries/updatedAt; DELETE `/entry` uses personId/entryId/revision. Integrations revoke is POST `/api/people/integrations/:id/revoke`.

Engineering defaults: reuse existing branch; native browser dictation where supported and external bot transcripts elsewhere; no implicit Botwick installation; point person is private guidance rather than permission to contact them; imported sharing remains explicit. These choices follow the approved outcomes and existing project boundaries.

## Verification evidence — October 24, 2026

- Full app suite: 1,033 passing tests (161 frontend/model and 872 TypeScript/core).
- Rust: 50 passing tests (43 existing and 7 memory CLI HTTP integration checks).
- Five real workerd/SQLite/RPC checks pass, including code reload and legacy edit preservation.
- Relationship memory, legacy person context, and helper browser suites pass on desktop/mobile. The helper suite used an isolated static server on port 4179.
- Typecheck, district/relevance asset builds and diff checks pass.
- Independent review findings fixed with regression coverage: write-only credentials no longer return existing private notes; source withdrawal invalidates in-flight inference; manual company is editable and clearable; saved voice/text context retains owner-report attribution.
- Deployed Worker version: `ffabe642-d3d1-4802-894a-284cb57fe729`.
- External bots still require an explicitly created integration key and client configuration. No real notes, credentials, messages or bookings were created during verification.

Live verification reached the deployed sign-in page. The existing browser session expired on reload and Google sign-in did not complete in the in-app browser, so the new authenticated production editor remains unverified. Automated authenticated editor and integration browser coverage passed; no production test data was written.
