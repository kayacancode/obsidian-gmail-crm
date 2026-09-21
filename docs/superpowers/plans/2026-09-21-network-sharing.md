# Network sharing (multiplayer) — Spec and Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An owner can share a slice of their network with another signed-in person. The viewer sees the shared people merged into their own graph, labelled "via <owner>", with the owner's why-now evidence visible only in the Firm lens; search ranks shared people too; drafting a note about a shared-only person drafts an intro request to the owner instead. The owner controls scope and level and can revoke at any time. Every owner's data stays inside the server; the viewer's browser never receives the owner's raw emails or note text beyond what the level allows.

**Architecture:** A `shares` table in D1 (global index: who shared what with whom). The owner's Durable Object exports a bounded slice on demand (`exportSlice`). The viewer's Durable Object imports slices into cache tables plus firm-visibility signals (`importShares`), and `graph()` merges them. The Worker orchestrates a refresh on the viewer's graph load when the cache is stale, calling owners' objects by name. All person identity joins happen server-side by email; the viewer sees only their own hashed ids.

**Tech Stack:** Cloudflare Workers + Durable Objects (SQLite), D1, TypeScript, browser ES modules, `node tests/run-mail.mjs`, `npm test`, Playwright suites.

**Spec:** this document (approved by the owner on 2026-09-21: "go build it").

All paths are relative to `apps/people-graph/` in the `relationship-slice` worktree.

## Global Constraints

- Privacy: the viewer receives, per shared person, only name, company (email domain), last contact date, meeting count, and, by level, theme names and verbatim statement quotes. Never the person's email, never note text beyond quotes, never the owner's key material. Shared evidence is stored with visibility `firm` and `account='share:<owner email>'` in the viewer's object, so it appears only in the Firm lens (`permitted()` already enforces this) and never in Public.
- Consent: only the owner creates or changes a share; the viewer can hide (decline) one. Revocation deletes the viewer's cached copy on the next refresh and immediately when the owner revokes through the route (the route calls the viewer's object).
- Identity: person ids remain `opaque(viewer, email, TOKEN_SECRET)` on the viewer side, so a shared person the viewer also knows is one node. Emails travel only between Durable Objects through the Worker, never to a browser.
- Limits: a slice holds at most 500 people, 2,000 edges, 2,000 signals, 200 themes; a viewer may have at most 20 incoming shares; refresh at most every 10 minutes per viewer (`shared_meta.refreshed_at`), and a refresh run is bounded to 20 s.
- Levels: `names` (people + edges, no themes), `themes` (+ theme names and topic/heat signals without quotes), `statements` (+ verbatim statement quotes). Scope: `{kind:'all'}` or `{kind:'folders', ids:[folderId…]}` (people attending a meeting in those folders) or `{kind:'people', emails:[…]}` (chosen from the owner's own contact list in the UI; the browser sends emails of the owner's own contacts only).
- D1 DDL is created lazily with `CREATE TABLE IF NOT EXISTS` at first use (no manual migration), guarded by a per-isolate memo.
- Every SQL read in the Durable Objects starts with `SELECT`; mutating routes check `origin === url.origin`; `cache-control: no-store`; 100-bound-parameter limit respected (chunk).
- Commit per task with the trailers `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01CtMWAkx6YjCxX4thGthmxw`. Verification per task: `npm run typecheck`, `node tests/run-mail.mjs`; client tasks also `npm test` and the relevant browser suites (static server on 4183).

---

### Task 1: Owner export and viewer import in the Durable Object

**Files:** Create `src/network-share.ts` (types, slice bounding, scope filtering helpers), `tests/network-share.test.ts` (add to `tests/run-mail.mjs`); modify `src/mail-sync.ts` (RPC `exportSlice`, `importShares`, `dropShare`, `sharedMeta`; `graph()` merge; `draftNote` intro-request path), `src/granola-sync.ts` (`peopleInFolders(folderIds)` helper), `src/relevance-store.ts` (`removeAccountData` already works per account; add `signalsForShare` only if needed), `tests/sync.test.ts`.

**Interfaces:**
```ts
export type ShareLevel='names'|'themes'|'statements';
export type ShareScope={kind:'all'}|{kind:'folders';ids:string[]}|{kind:'people';emails:string[]};
export interface SharedSlice {owner:string;exportedAt:number;people:{email:string;name:string;lastContact:string|null;meetings:number}[];edges:{a:string;b:string;weight:number;types:string[];contexts:string[]}[];themes:{id:string;name:string}[];signals:{email:string|null;themeId:string;summary:string;observedAt:string;sourceType:string;confidence:number;title?:string}[]}
// MailSync (owner side)
async exportSlice(scope:ShareScope,level:ShareLevel):Promise<SharedSlice>
// MailSync (viewer side)
async importShares(slices:SharedSlice[]):Promise<{owners:string[];people:number}>   // replaces the cache for those owners; ingests firm signals under account 'share:<owner>'
async dropShare(owner:string):Promise<void>                                          // removes cache + signals for that owner
sharedMeta():{refreshedAt:number;owners:string[]}
```
- Export: people = `graphContacts()` filtered by scope (folders → attendees of visible notes in those folders via `granola().peopleInFolders(ids)`; people → the given emails ∩ own contacts), capped; edges = own merged edges restricted to shared people; themes/signals only when level ≥ `themes`, from `this.store().signals(owner)` for those people (personId → email resolved through the contact list; topic signals with `personId` null included), quotes only when level = `statements` (otherwise `summary` is replaced by the server-owned `'<Kind> shared without quote'` → simpler: drop statement signals entirely at level `themes`, keep topic and metadata signals). Owner's own addresses are never exported.
- Import: tables `shared_people (owner TEXT, email TEXT, name TEXT, last_contact TEXT, meetings INTEGER, PRIMARY KEY(owner,email))`, `shared_edges (owner, a, b, weight, types TEXT, contexts TEXT, PRIMARY KEY(owner,a,b))`, `shared_meta (owner TEXT PRIMARY KEY, refreshed_at INTEGER, level TEXT)`; signals ingested via `ingestWithThemes` with `visibility:'firm'`, `account:'share:'+owner`, `personId=opaque(viewer,email)`, theme id `'theme-'+opaque(viewer,'share-theme:'+owner+':'+themeId)` with the owner's theme name as canonical name, `evidence_ref='share:'+owner+':'+…`.
- `graph()`: after own contacts, add shared people not already present as nodes with `via:[owner…]`, `company` from the email domain, score from `emailScore(meetings,meetings,days)`; for people already present, add `via` and take the later `lastContact`; merge shared edges with type `shared_via`; node cap unchanged.
- `draftNote(personId)`: if the person is shared-only (no own contributions, no own attendee rows), resolve the sharing owner; `to` = owner email; evidence = the shared signals; `composeDraft` gets an extra instruction "This is a note to <owner name/email> asking for an introduction to <person>; do not write to <person> directly."; response gains `introVia:owner`.
- [ ] Tests: export respects scope and level (no quotes at `themes`, no signals at `names`, owner addresses excluded, caps); import creates nodes with `via`, merges a known person onto one node, signals are firm-only (`snapshot('my')` excludes them, `snapshot('firm')` includes them); dropShare cleans everything; draftNote for a shared-only person targets the owner and sets `introVia`.
- [ ] Implement, verify, commit `feat(people-graph): share slices between owners' objects`.

---

### Task 2: Shares index in D1, routes, refresh orchestration

**Files:** Create `src/share-routes.ts`, `tests/share-routes.test.ts` (add to `tests/run-mail.mjs`); modify `src/index.ts` (dispatch `/api/shares*`, and refresh on `GET /api/graph`), `schema.sql` (document the table), `src/mail-sync.ts` only if a helper is needed.

**Interfaces:**
- D1 `shares (owner_email TEXT NOT NULL, viewer_email TEXT NOT NULL, scope TEXT NOT NULL, level TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, hidden INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(owner_email, viewer_email))`, created lazily.
- Routes (session; non-GET same-origin; JSON ≤ 8 KB; `bindOwner`):
  - `GET /api/shares` → `{outgoing:[{viewerEmail,scope,level,updatedAt}], incoming:[{ownerEmail,level,updatedAt,hidden}]}`
  - `POST /api/shares` `{viewerEmail,scope,level}` → upsert (validate email shape, scope shape, level; viewer ≠ owner; ≤ 50 outgoing) → then push: call `env.MAIL.getByName(owner).exportSlice(scope,level)` and `env.MAIL.getByName(viewer).importShares([slice])` so the viewer sees it immediately; respond `{ok:true, people:n}`.
  - `DELETE /api/shares` `{viewerEmail}` (owner revokes) → delete row, call viewer's `dropShare(owner)`; `{ok:true}`.
  - `POST /api/shares/hide` `{ownerEmail,hidden:boolean}` (viewer) → set hidden; when hidden call own `dropShare(owner)`; when unhidden trigger a refresh.
- Refresh in `GET /api/graph` (index.ts `getGraph`): before returning the mail graph, if `sharedMeta().refreshedAt` is older than 10 min, read incoming non-hidden shares from D1 (≤ 20), export each from its owner's object with a 20 s overall budget, `importShares`, and `dropShare` for owners no longer sharing. Failures never fail the graph.
- [ ] Tests: DDL lazy creation with a fake D1; each route's validation, auth, origin, limits; push-on-create calls export then import with the stub; revoke calls `dropShare`; refresh skips when fresh, runs when stale, drops removed owners, and swallows a failing owner export.
- [ ] Implement, verify, commit `feat(people-graph): share routes and refresh`.

---

### Task 3: Accounts "Sharing" tab, graph labels, browser tests

**Files:** Modify `public/accounts.html`, `public/accounts.mjs`, `public/accounts.css`, create `public/share-panel.mjs`; modify `public/relationship-graph/graph.mjs` (node subtitle "via <owner>" for nodes with `via`, the Firm lens hint), `public/relationship-graph/model.mjs` (accept optional `via:string[]` on nodes), `public/relationship-host.mjs` (draft dialog shows "Intro request to <owner>" when `introVia`); tests `tests/accounts-browser.mjs` (or a new `tests/share-browser.mjs` wired to `package.json` scripts), `tests/relationship-browser.mjs`, `tests/relevance-browser-model.test.mjs`.

- Sharing tab: "Share my network" form: viewer email input, scope radio (All meetings / Choose folders → checkboxes from `/api/granola/status` folders / Choose people → a searchable list from the owner's graph names, sending emails resolved server-side is not possible from names, so for `people` scope the UI lets the owner pick from `/api/graph` nodes and the route accepts person ids; Task 2's route must then accept `{kind:'people', personIds:[…]}` and the owner's object resolves ids to emails in `exportSlice`; Task 1 adds that resolution), level select with plain-language descriptions, Share button; "Shared by me" list with Revoke; "Shared with me" list with Hide/Show and the level.
- Graph: nodes with `via` show a small "via <owner>" line under the name and are drawn with a dashed ring; the Firm lens description mentions shared evidence.
- Draft dialog: when `introVia` is present, title "Intro request to <owner>" and the "Open in email" link addresses the owner.
- [ ] Tests: browser flow for creating, listing, revoking and hiding shares against stubbed routes; graph renders "via" label; draft dialog shows the intro-request title. All existing suites pass.
- [ ] Implement, verify, commit `feat(people-graph): sharing tab and via labels`.

---

### Task 4: Docs and verification

- README section "Sharing your network": consent model, levels, what the viewer sees and never sees, revoke, Firm lens, intro requests; how to test with two accounts.
- Full verification: typecheck, both Node suites, all browser suites. Commit `docs(people-graph): describe network sharing`. Deploy is owner-run; no D1 migration needed (lazy DDL).
