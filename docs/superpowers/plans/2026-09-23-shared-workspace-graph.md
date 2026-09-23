# Shared Workspace Graph Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let invited teammates use one consent-based network graph entirely in the browser, with separate member relationships.

**Architecture:** D1 owns workspace membership, targeted invitations, and contribution policies. Owner MailSync objects export bounded owned data; a new server assembler deduplicates authorized contributions into a workspace graph. Workspace queries never fall back to private graph evidence.

**Tech Stack:** Existing Workers, D1, Durable Objects, TypeScript, vanilla browser modules, Node tests, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-23-shared-workspace-graph-design.md` (approved, including browser-only onboarding).

## Global Constraints

- Obsidian, CLI, inbox connection, and personal imports are not prerequisites for accepting an invitation or viewing a workspace.
- Invitation target must equal authenticated Google identity; expires in seven days, is single-use and revocable. Joining shares nothing.
- Initial limit: 20 members; existing SHARE_CAPS apply to each contribution. Report partial and truncated coverage.
- Exact normalized email identity only; opaque workspace IDs; no raw contact emails in graph responses.
- Personal feedback and adjusted scores remain private. No automatic Botwick access.
- No transitive sharing, private email subjects/bodies, new calendar title disclosure, or workspace photos.
- All mutations require same origin; responses no-store. Check membership and policy revisions again after asynchronous export.
- No automatic invitation email or intro sending. Use copyable invitations and editable drafts.
- Preserve pairwise shares. Exclude `.superpowers/` and the unrelated reconnect draft from commits.

## Review Focus

- Two simultaneous invitation acceptances at capacity must not create member 21 (Task 1).
- Wrong-account sign-in and browser back must preserve the invite without accepting it or exposing graph data (Task 4).
- Removal during a slow export must prevent returning the revoked contribution (Task 3).
- Switching networks during a pending answer must not attach a private response to a workspace (Task 5).
- A member with zero inboxes must see shared content instead of the connect-vault screen (Tasks 4 and 5).

All paths below are relative to `apps/people-graph/`. Tests run from that directory. Add new TypeScript tests to `tests/run-mail.mjs` and browser-module tests to the npm test command as they land.

### Task 1: Membership and invitation authority

**Files:** create `src/workspace-store.ts`, `src/workspace-routes.ts`, `tests/workspace-routes.test.ts`; modify `src/index.ts`, `schema.sql`, `tests/run-mail.mjs`.

**Interfaces:** `workspaceRoute(request:Request, env:ShareEnv, me:string):Promise<Response>`; `isWorkspacePath(path:string):boolean`. Authenticated dispatch reuses `requireGoogleUser`. Store rows: workspaces(id,name,revision), members(workspace_id,email,role,joined_at), invitations(id,workspace_id,email,token_hash,expires_at,used_at,revoked_at), contributions(workspace_id,email,scope,level,enabled,revision). Composite member/contribution keys prevent duplicates.

Routes: GET/POST `/api/workspaces`; POST `/:id/invites`; DELETE `/:id/invites/:inviteId`; POST `/api/workspace-invites/accept`; GET `/:id/members`; DELETE `/:id/members/:memberId`; POST `/:id/transfer`; DELETE `/:id`; PUT `/:id/contribution`. All workspace paths begin `/api/workspaces`. Member IDs in URLs are opaque; no user-supplied role is trusted. Creation assigns admin. Deletion/transfer require admin; leave/removal enforces sole-admin protection. Name is trimmed, 1–80 characters; body limit 16KB; malformed inputs 400, wrong identity/membership 403, consumed or conflicting state 409, expired invitation 410.

- [ ] Add tests using a D1 SQLite fixture for every route and atomic transition, including origin rejection, wrong target, expiry, replay, revoked invite, two workspaces, concurrent capacity, sole-admin leave and transfer.
```ts
assert.equal((await accept(invite, 'wrong@example.com')).status, 403);
assert.equal((await accept(invite, invitedEmail)).status, 200);
assert.equal((await contribution(workspaceId, invitedEmail)).enabled, false);
assert.equal((await accept(invite, invitedEmail)).status, 409);
```
Here fixture helpers issue requests to `workspaceRoute`; `contribution` reads the fixture DB. Use token bytes from `crypto.getRandomValues(new Uint8Array(32))`, storing only SHA-256 hashes. Use conditional writes in a D1 transaction/batch with SQL predicates for target, expiry, unused state, and capacity; verify affected rows before reporting success. Duplicate acceptance cannot re-create removed membership. Invites are copied, never sent.
- [ ] Run `node tests/run-mail.mjs`, confirming the new tests fail before implementing.
- [ ] Implement store and dispatch; keep all SQL bound and initialize documented tables with retry-safe lazy DDL like share-routes. Cap outstanding invitations and workspace creation per owner to 20 each.
- [ ] Run `node tests/run-mail.mjs` and `npm run typecheck`; commit only Task 1 files.

### Task 2: Owned contribution export with separate measured relationships

**Files:** create `src/workspace-contract.ts`, `tests/workspace-export.test.ts`; modify `src/mail-sync.ts`, `tests/run-mail.mjs`.

**Interfaces:**
```ts
type WorkspaceRelationship = {score:number|null;scoreVersion:string;lastContact:string|null;observedAt:string;evidenceCategory:'email'|'meeting'|'unknown'};
type WorkspaceSlice = {slice:SharedSlice;relationships:Record<string,WorkspaceRelationship>;truncated:boolean};
// New MailSync RPC; address keys are server-only.
exportWorkspaceSlice(scope:ShareScope, level:ShareLevel):Promise<WorkspaceSlice>;
```
- [ ] Add tests where two owners know the same contact with different dates and feedback deltas; ensure exports retain independent measured values and exclude feedback, imported contacts, photos, subjects, calendar titles, and unauthorized statements.
```ts
assert.equal(exported.relationships[email].score, measuredScore);
assert.equal(JSON.stringify(exported).includes('feedbackDelta'), false);
assert.equal(exported.slice.people.some(p => p.email === importedOnlyEmail), false);
```
- [ ] Run `node tests/run-mail.mjs` and confirm failure.
- [ ] Implement using owned graph contacts and existing scope/level sanitization, computing scores before feedback application. Missing valid direct evidence yields null, never counts borrowed from another owner. Include an explicit score algorithm version and truncation before slicing. No change to the existing pairwise export contract.
- [ ] Run backend tests and typecheck; commit Task 2 files.

### Task 3: Workspace graph, search, and intro drafts

**Files:** create `src/workspace-graph.ts`, `tests/workspace-graph.test.ts`; modify `src/workspace-routes.ts`, `tests/run-mail.mjs`.

**Interfaces:** `buildWorkspaceGraph(env:ShareEnv, workspaceId:string, me:string):Promise<WorkspaceGraph>`; `WorkspaceGraph` contains nodes, edges, authorized themes/signals, members, workspace revision, coverage, and source `workspace`. Nodes carry `relationships` with memberId and WorkspaceRelationship fields; no inherited personal combined score. GET `/:id/graph`, POST `/:id/search` `{query}`, POST `/:id/draft` `{personId,memberId}`.

- [ ] Add tests for exact-identity merge, distinct aliases, edge provenance, missing scores, tie comparisons, limits, nonmembers, export timeout and concurrent revocation.
```ts
assert.equal(graph.nodes.filter(n => n.id === expectedOpaqueId).length, 1);
assert.equal(graph.nodes[0].relationships.length, 2);
assert.equal(JSON.stringify(graph).includes(contactEmail), false);
assert.equal((await removedMemberGraph()).status, 403);
```
- [ ] Run backend tests to demonstrate failure.
- [ ] Assemble only enabled member exports, limit concurrency to four and total budget to 20 seconds. Use HMAC identity namespace `workspace:<id>:person:<email>`, with a distinct member namespace. Recheck membership and revisions before sending; retry one changed snapshot, then respond 409 requiring refresh. Failed sources are reported as unavailable; no old cache fallback.
- [ ] Search uses only the newly assembled authorized candidate set and summaries, with existing Jev adapter where configured and labelled deterministic fallback. Drafts select an authorized contributing member, use only the authorized person/evidence, and return editable text; no send path. Validate candidate IDs after any model response and recheck membership after model calls. Test private-evidence exclusion and revoked membership during search/drafting.
- [ ] Run backend tests and typecheck; commit Task 3 files.

### Task 4: Browser-only joining and intuitive account controls

**Files:** create `public/workspace-panel.mjs`, `tests/workspace-browser.mjs`; modify `public/accounts.html`, `public/accounts.mjs`, `public/accounts.css`, `package.json`.

**Interfaces:** `createWorkspacePanel(root,{request,onUnauthorized})` returns `{load,clear}` as the existing sharing panel does. Invitation URL `/accounts#workspace-invite=<token>` preserves token in tab-scoped sessionStorage through sign-in; clear after success, expiry or cancellation. Do not put token into analytics, external URLs or logs.

- [ ] Create browser fixtures for creator and a fresh member with no accounts/graph, target mismatch, expired token, failed network, and return from sign-in.
```js
await page.getByRole('button', {name:'Accept invitation'}).click();
await expect(page.getByRole('link', {name:'Open shared network'})).toBeVisible();
await expect(page.getByText('Obsidian required')).toHaveCount(0);
```
- [ ] Run `node tests/workspace-browser.mjs` against the existing static test server and verify failure.
- [ ] Implement two clearly separated sections: Add my inbox and Invite teammate. Workspace creation, email entry, Copy invitation, acceptance, member management, transfer/leave/delete and contribution editing use the routes from Task 1. Show disclosure preview before save. Include explicit Share nothing default and selected people/all scope. Keep existing pairwise sharing available. Never infer contribution consent from joining or connecting an inbox.
- [ ] Test retry, duplicate clicks, wrong-account switch, empty contribution, keyboard focus and narrow-screen controls. Clear member data on sign-out and page lifecycle like existing panels.
- [ ] Run accounts/share/workspace browser suites; commit Task 4 files.

### Task 5: Shared Atlas canvas and relationship sidebar

**Files:** create `public/workspace-controller.mjs`, `tests/workspace-controller.test.mjs`; modify `public/relationship-host.mjs`, `public/relationship-graph/model.mjs`, `public/relationship-graph/graph.mjs`, existing graph stylesheet identified through graph.mjs imports, `tests/workspace-browser.mjs`, `package.json`.

**Interfaces:** workspace controller maintains `{workspaceId,phase,graph,revision,error}`; `select(workspaceId|null)`, `refresh()`, `search(query)`, `draft(personId,memberId)`, `destroy()`. Requests use AbortController plus a generation guard; changing workspace cancels requests and clears graph/profile/answer state before loading.

- [ ] Add unit tests for switching while a personal answer is pending, revocation, disconnected stale state and empty personal network.
```js
controller.select(workspaceId);
resolveOldPrivateAnswer(privateAnswer);
assert.equal(controller.getState().graph.source, 'workspace');
assert.equal(JSON.stringify(controller.getState()).includes(privateAnswer.text), false);
```
- [ ] Run the new test with `node --test tests/workspace-controller.test.mjs` and verify failure.
- [ ] Add My network/workspace selector to compact header; workspace selection bypasses personal empty-source onboarding. Preserve Atlas layout and scope Wander/Answer to workspace data. Show contribution coverage and unavailable sources. Never send workspace IDs to personal search, evidence, feedback or drafting endpoints.
- [ ] Sidebar renders one relationship row per member, labelled measured scores and dates; compare only equal score versions, keep unknowns/ties explicit. Show private current-user adjustment only through an authenticated private mapping, never on shared responses. Request intro opens editable draft for chosen member. Keep private Needs attention and feedback in My network only.
- [ ] Refresh membership on focus and every 30 seconds while visible; immediately clear on 401/403 or removal and mark offline views stale. Destroy listeners/timers on navigation. Verify fresh-member graph, overlap, ties, no routes, draft edits, revoked access, and personal regression with browser tests.
- [ ] Run unit and relevant browser tests; commit Task 5 files.

### Task 6: Integrated verification and delivery

**Files:** modify `README.md`; extend workspace tests where integration reveals gaps.

- [ ] Run `npm test`, `npm run typecheck`, accounts/share/workspace/relationship/intelligence browser suites and `git diff --check`. Use existing Playwright runtime; do not add product dependencies for test convenience.
- [ ] Review API responses for two simulated members and a nonmember: separate scores, no private source leakage, no transitive grants, no send action and correct permission invalidation. Inspect a browser screenshot of onboarding and the shared sidebar.
- [ ] Document Add my inbox vs Invite teammate, no-Obsidian onboarding, contribution controls, caps, score semantics and current limitations in README. Record exact verification results and commit only feature files.
- [ ] Present the local working flow and changed-file summary. Do not invite real colleagues or change their sharing policies for verification. Do not claim production availability unless an authorized deployment is completed and checked.

## Implementation and verification record — 2026-09-23

Implemented in commits `01eb965`, `7e92d76`, `97344ce`, and `2df47ca` on `betaworks-score-push`.

Implementation rulings: workspace membership/invites/policies use one bounded revisioned D1 JSON row with compare-and-swap updates rather than multiple tables; concurrent capacity acceptance is verified against actual SQLite. The existing relationship controller handles workspace requests with its abort/generation protections instead of introducing a second controller. Workspace relevance is computed only from allowed shared signals. Per-contributor edge observations survive graph normalization. A private viewer score overlay is resolved only inside the signed-in owner's object; teammates receive the measured score alone.

Verification: full npm test passed (379 backend tests plus frontend suites), TypeScript passed, existing Accounts/Sharing/Relationship/Intelligence browser regressions passed, workspace browser tests passed (no-inbox acceptance, default sharing off, folder-policy preservation, mobile, shared canvas, member score, editable intro, no private API requests). Fresh review found deep-link sign-in state, populated theme and edge provenance issues; each is covered by a regression and corrected. Build scripts and Wrangler dry run passed. `git diff --check` passed.

Deployed Worker version: `172824da-7729-4606-9c63-e41eff3d6078` at `https://people-graph.kayarjones901.workers.dev`. Live authenticated Shared networks UI verified for the existing account; anonymous workspace API returns 401. No real teammate invited and no live contribution consent changed during verification.

Usage: Accounts → Shared networks → Create workspace → Members, invitations & what I share → Invite teammate → enter Google sign-in email → Create invitation link → Copy invitation. Recipient signs in with that email and accepts. Each member then chooses What I share and saves. Open shared network, or select it from Atlas's Network selector. Obsidian is optional.
