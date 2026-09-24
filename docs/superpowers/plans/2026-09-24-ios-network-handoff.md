# iOS-style network handoff implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the approved contact-sheet and human introduction flow in the existing shared network web app.

**Architecture:** Keep the graph mounted behind a focused sheet. Add a deterministic answer/route adapter and a participant-only D1 request store, then connect the existing authenticated workspace host to those APIs. Jev continues ranking evidence-supported candidates; it never sends requests or invents routes.

**Tech Stack:** Existing vanilla JavaScript modules and CSS, Cloudflare Worker TypeScript, D1, Node tests, and Playwright browser harness. No UI framework migration or new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-09-24-contextual-network-walks-design.md`, including the approved visual direction and human handoff addendum.

## Global constraints

- “No score mutation merely because someone is recommended, viewed, or skipped.”
- “Drafting never sends a message.”
- “No invented connections fill the gap.”
- No prototype stock portraits, fictional candidates, or fabricated evidence in live results.
- Requests are explicit in-app sends between current workspace members; no external email transport in this release.
- Never ship the prototype's account-switching impersonation control.
- Native execution recommended: implement in this session, review the complete branch before deployment.

## Review focus

1. Member removal while a request is open: subsequent reads and writes must fail and clear the screen.
2. Retried sends and concurrent replies: one request per idempotency key, no silently overwritten reply.
3. Missing photos, unmatched identity, or unsupported route: usable fallback and no fabricated introduction claim.
4. Long messages, malicious markup, touch keyboards, and reduced motion: readable, safe, accessible sheet.
5. Account/workspace switching during search or send: late responses never enter another account's UI.

## Delivery boundary

This plan implements the first delivery named in the spec addendum. It uses an explicit query or existing shared-context discovery. The later private-context Wander ingestion is not needed to ship this working loop and requires its own implementation plan. No production messages are sent as part of testing or deployment.

### Task 1: Typed, evidence-backed answer cards and routes

**Files:** create `apps/people-graph/src/network-answer.ts`, `apps/people-graph/tests/network-answer.test.ts`; modify `src/workspace-graph.ts`, `tests/run-mail.mjs` under the same app.

**Interface:** export `buildAnswerCards(graph: WorkspaceGraph, results: SearchResult[]): AnswerCard[]`. Export `AnswerCard` with `personId`, `evidence`, `routes`, and `novelty: 'no_recorded_direct_contact' | 'recorded_contact'`. Evidence entries retain source, date, and stable reference. Route steps distinguish `workspace_member`, `recorded_contact`, and `cooccurrence`; no co-occurrence-only route offers an intro action. Include graph revision and workspace ID in the search response.

- [ ] Add unit fixtures with self member, another contributor, two contacts, and dated source records. Pin viewer-specific novelty and the absence of invented routes:

```ts
assert.equal(buildAnswerCards(graph, [match])[0].personId, match.personId);
assert.equal(buildAnswerCards(graph, [match])[0].novelty, 'no_recorded_direct_contact');
assert.deepEqual(buildAnswerCards({...graph, members: [], edges: [], nodes: graph.nodes.map(n => ({...n, relationships: []}))}, [match])[0].routes, []);
```

- [ ] Register tests in `tests/run-mail.mjs`; run `TEST_NAME='answer' node tests/run-mail.mjs` and observe the missing-module failure.
- [ ] Build member routes from the selected person's actual `relationships`, resolve self through `members.isMe`, preserve evidence type/date, and reject absent/ambiguous identities. Similarity is a reason, never an edge. Use existing bounded path traversal for non-member hops; no all-pairs scan.
- [ ] Test direct viewer contact, another-member-only contact, same-name different IDs, missing person, co-occurrence, and names-only sharing with no theme evidence. Return empty evidence rather than a fabricated explanation.
- [ ] Run targeted tests and `npm run typecheck`; commit only task files.

### Task 2: Durable, participant-only introduction requests

**Files:** create `src/introduction-store.ts`, `tests/introduction-store.test.ts`; modify `tests/run-mail.mjs` and `schema.sql` under `apps/people-graph`.

**Interface:** export `ensureIntroductionRequests(db)`, `createIntroductionRequest(db, input)`, `readIntroductionRequest(db, workspaceId, requestId)`, `listIntroductionRequests(db, workspaceId, memberId)`, and `replyToIntroductionRequest(db, input)`. Route layer supplies authenticated member IDs after authorization. Request record contains request ID, workspace ID, requester/recipient IDs, target person ID, message, selected evidence references, state, revision, timestamps, and optional alternative person ID/reply text. Never persist a graph snapshot or private source body.

- [ ] Define D1 schema with participant indexes and uniqueness on `(workspace_id, requester_id, client_request_id)`:

```sql
CREATE TABLE IF NOT EXISTS introduction_requests (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
 requester_id TEXT NOT NULL, recipient_id TEXT NOT NULL,
 client_request_id TEXT NOT NULL, person_id TEXT NOT NULL,
 message TEXT NOT NULL, evidence_refs TEXT NOT NULL,
 state TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
 reply TEXT, alternative_person_id TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(workspace_id, requester_id, client_request_id)
);
CREATE INDEX IF NOT EXISTS intro_requester ON introduction_requests(workspace_id, requester_id, updated_at);
CREATE INDEX IF NOT EXISTS intro_recipient ON introduction_requests(workspace_id, recipient_id, updated_at);
```

- [ ] Write failing D1-backed tests using the repository's existing test DB pattern: retrying the same payload/key returns the same record; reusing that key with a different payload conflicts; a stale expected revision conflicts; lists are scoped and paginated at 30 records.
- [ ] Implement parameterized SQL and compare-and-swap replies. Allowed states: `requested`, `checking_interest`, `agreed`, `alternative_suggested`, `declined`, `completed`, `cancelled`. Recipient responds to pending requests; requester can cancel a nonterminal request. Only recipient explicitly marks agreed/checking requests completed. A declined/cancelled/completed request cannot be reopened through a reply.
- [ ] Verify stable pagination, duplicate send, simultaneous reply, and no score writes. Run targeted tests; commit task files.

### Task 3: Authorized request APIs

**Files:** create `src/introduction-routes.ts`, `tests/introduction-routes.test.ts`; modify `src/workspace-routes.ts`, `tests/run-mail.mjs`.

**Interface:** authenticated workspace paths: `GET/POST /api/workspaces/:id/intro-requests`, `GET /api/workspaces/:id/intro-requests/:requestId`, and `POST /api/workspaces/:id/intro-requests/:requestId/reply`. Export `introductionRoute(request, env, me)` with the same `ShareEnv`/authenticated-email convention as `workspaceRoute`. Responses are `no-store`.

- [ ] Add failing route tests for nonparticipant access, including a workspace administrator; cross-workspace request IDs; removed participants; nonexistent recipient; self-intro; invalid shared person/evidence; and stale workspace/request revisions.
- [ ] Reuse bounded body parsing and same-origin mutation checks. Enforce message/reply length 1–2000 trimmed characters, at most 5 unique evidence refs, existing current member recipient, and an actual recipient-to-person relationship from the freshly authorized graph. Derive sender from the session, never body fields.
- [ ] Validate both participants' current membership on every read/write. Re-resolve attachments from the fresh shared graph; remove withdrawn evidence/profile fields. Do not echo stored source contents because none are stored. Revalidate workspace revision before returning a result; bind insertion to the expected workspace revision in SQL so a consent change cannot race insertion.
- [ ] For alternate suggestions, require a current shared person and recipient-authored reason; preserve that attribution. Send no external notifications. Add explicit completion and cancellation validation from Task 2.
- [ ] Run route/store tests and typecheck, then commit task files.

### Task 4: iOS-style contact sheet and visible walk

**Files:** create `public/relationship-graph/contact-sheet.mjs`, `public/relationship-graph/contact-sheet.css`, `tests/contact-sheet.test.mjs`; modify `public/relationship-graph/graph.mjs`, `public/atlas.css`, `public/relationship-host.mjs`.

**Interface:** `mountContactSheet(container, {onClose, onSelectStep, onRequestIntro})` returns `{setCard(card), setStep(step), destroy()}`. Host provides validated answer cards. Steps are `person`, `route`, `evidence`. Sheet receives data, not authenticated fetch logic.

- [ ] Add model tests for step navigation and missing-card handling; add browser assertions for selection → sheet → route → evidence → close with restoration of the selected graph position.
- [ ] Build accessible DOM with `textContent`, native buttons, a labeled sheet, available authorized photo and clean fallback. Use system typography, rounded opaque surfaces with restrained translucency at chrome only, contributor outline colors, and evidence disclosure. Never hardcode John as the recipient.
- [ ] Desktop: selected-person side sheet; mobile: bottom sheet with page-safe sizing and a visible close button. Trap focus only while modal; Escape closes, focus returns to the selected person. Keyboard users can follow every route step.
- [ ] Animate the selected card's translation/scale and fade unrelated graph marks without replacing graph nodes or triggering full layout. Disable transition motion under `prefers-reduced-motion`. Preserve zoom and graph filters on dismissal.
- [ ] Test missing photo, 200-character name, long evidence, 320px viewport, keyboard-only navigation, and reduced motion. Commit after focused tests pass.

### Task 5: Real request composer, inbox, and replies

**Files:** create `public/introduction-client.mjs`, `public/relationship-graph/introduction-thread.mjs`, `tests/introduction-client.test.mjs`; modify `public/relationship-host.mjs`, `public/workspace-panel.mjs`, contact sheet styles from Task 4.

**Interface:** `createIntroductionClient({workspaceId, fetcher})` returns `{list, read, create, reply, destroy}`. Client holds an AbortController and an account/workspace generation token; each response must match the initiating generation. Thread renderer consumes request state and action callbacks; it cannot switch users.

- [ ] Write client tests with injected delayed fetcher: switching scope invalidates late replies; repeated click reuses an idempotency key; server errors preserve the user's draft.
- [ ] Open an editable composer from a real member route. Show recipient name, exact message, target card, and explicit optional evidence attachment selector. Submission requires the user's Send request click. Show “Sent in People” only after successful persistence, never imply email delivery.
- [ ] Add a compact Requests entry with received/sent lists scoped to the signed-in participant. Fetch on open and focus; no unrequested continuous polling. John sees actual incoming requests only while signed in as John.
- [ ] Render checking-interest, agreement, alternative, decline, and explicit completion separately. Alternative person cards are tappable and return to the graph sheet. Do not automatically forward a request to the alternative; require a fresh review/send.
- [ ] Clear local request views/drafts on sign-out or account change. Preserve a draft across a transient network error within the same account. Render plain text safely. Do not mutate scores or send outside-app messages.
- [ ] Run client tests and commit task files.

### Task 6: End-to-end validation and live preview

**Files:** create `tests/introduction-browser.mjs`; modify `package.json` to add `test:introduction-browser`; update the design doc with actual delivered scope.

- [ ] Use two isolated fixture sessions with different current-member IDs. Assert this complete flow:

```js
await kaya.getByRole('button', {name: 'Ask for an introduction'}).click();
await kaya.getByRole('textbox', {name: 'Message'}).fill('Would you introduce us for the event?');
await kaya.getByRole('button', {name: 'Send request', exact: true}).click();
await john.getByRole('button', {name: 'Requests', exact: true}).click();
await john.getByRole('button', {name: 'Someone else comes to mind'}).click();
// Select a fixture person, enter an attributed reason, submit, and verify
// Kaya receives a tappable alternative while a third member gets HTTP 403.
```

- [ ] Add concrete assertions for attachment revocation after request creation, membership removal while a thread is open, send retry, alternate suggestion validation, and completion not occurring on agreement. Verify no email/Gmail send request is made.
- [ ] Run `npm run typecheck`, `npm test`, `npm run test:workspace-browser`, `npm run test:relationship-browser`, and the new `npm run test:introduction-browser` in the app with the established Playwright runtime and local server. Inspect screenshots at 390px and 1024px in light/dark mode. Verify 5,000-node graph node identity survives sheet navigation.
- [ ] Review the complete diff for authorization, source provenance, and regressions. Fix findings and rerun affected checks. Keep unrelated `.superpowers/` and untracked reconnect spec untouched.
- [ ] Open a local working preview for the user. Deployment remains a separate explicit action after the tested implementation is reviewable; do not send a real intro request as a smoke test.
