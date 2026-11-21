# Agentic People: three-party introductions (sub-project 6) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (native). Steps use checkbox (`- [ ]`) syntax.

**Goal:** An introduction involves three people, so it becomes a first-class object with:
- a double opt-in;
- an introducer budget;
- an optional vouch, visible only to the two parties;
- a recorded outcome that feeds `whether`.

People never sends email. The owner's agent drafts messages, and the owner records each step.

**Architecture:**
- **`src/introductions.ts`, pure part:** the `Introduction` type, `TRANSITIONS` (a Record), `advance()`, `expire()`, `budgetCheck()`, and `fromWorkspaceRequest()` (a read-only mapping of the existing workspace `introduction_requests`).
- **`src/introductions.ts`, store:** `IntroductionStore` (DO SQL `introductions`).
- **`MailSync` RPCs:**
  - `listIntroductions` merges the owner's own introductions with read-only workspace requests where the owner is the requester or the recipient.
  - `proposeIntroduction` proposes exactly one introduction per call; there are no bulk proposals.
  - `advanceIntroduction` and `recordIntroductionOutcome`.
- **Routes:** `src/introductions-routes.ts`.
- **MCP:**
  - read: `list_introductions`;
  - write: `propose_introduction`, `advance_introduction`, `record_introduction_outcome`.
- **CLI:** `crates/peoplegraph/src/intros.rs` with `intros list|show|propose|advance|outcome`.
- **Graph:** `graph().introductions` lists made, met and not-met introductions as `{id, personIds}`. `public/model.mjs` turns each into connector links of type `introduction` between the people present. Pairwise relationship edges are unchanged.
- **Brief:** `whether.introductions = {made, met}` counts introductions involving the person.

**Spec:** `docs/superpowers/specs/2026-11-20-agentic-people-design.md`, section "Sub-project 6".

## Global Constraints

### Shape

```
Introduction {
  id, source: 'owner'|'workspace',
  introducer: 'owner' | personId,
  parties: [personId|'owner', personId],
  reason, evidence[{personId, source, date, summary}],
  status, vouch: string|null, outcome: {result: 'met'|'not_met', note: string|null}|null,
  startedBy: 'owner'|'introducer', createdAt, updatedAt
}
```

### Statuses

`proposed → asked_introducer → introducer_accepted → target_opted_in → made → met | not_met`

- Any non-terminal status can go to `declined`.
- `expired` is applied on read after 30 days without progress.
- When the owner is the introducer, `proposed → introducer_accepted` is allowed.

**Illegal transitions** give `introduction_state_invalid`. That includes skipping steps, going backwards, or acting on `made`/`declined`/`expired` except to record an outcome on `made`.

### Who may do what

All of these are the owner, recording facts:
- When the owner is the introducer: `vouch` (≤ 500 characters) can be set at `introducer_accepted` or later.
- When the owner is a party: the owner records the introducer's and target's answers.
- `outcome` only on `made`.

### Budget

- **Introducer budget:** an introducer may have at most 5 open introductions that they did not start themselves (`startedBy !== 'introducer'`). For the owner, that means at most 5 open introductions where the owner is the introducer but the request came from someone else (workspace mapping). Asks to one contact are capped at 5 open introductions where that contact is the introducer.
- **Proposal limit:** at most 5 proposals per day across the store. That blocks bulk proposing by agents.

### Vouch

The vouch is stored only in the owner store. It is returned only to the owner, and only when the owner is the introducer or a party, which is always true in the owner store. It never appears in workspace data, exports, peers, guests or the graph payload.

### Migration

Workspace `introduction_requests` stay authoritative for workspace flows; their UI is unchanged. In the owner's list they appear mapped as:

| Field | Value |
|---|---|
| `introducer` | the recipient member |
| `parties` | [requester member, `personId`] |
| `source` | `'workspace'` |
| `readOnly` | `true` |

**Status map:**

| Workspace state | Status |
|---|---|
| `requested` | `asked_introducer` |
| `checking_interest` | `introducer_accepted` |
| `agreed` | `target_opted_in` |
| `completed` | `made` |
| `declined`, `cancelled` | `declined` |
| `alternative_suggested` | `declined`, with `alternativePersonId` |

Workspace suggestions are not migrated: `proposed` is only for the owner's own proposals.

### Privacy

- Introductions are owner-private (zone A/D), except what the workspace flow already shares.
- Messages to other people are drafted by agents and never sent by People.

## Review Focus

- The state machine rejects every illegal transition, and expiry happens on read.
- The budget and the 5/day proposal limit hold, and they can't be bypassed through `advance`.
- The vouch can't leave the owner store.
- The workspace mapping is read-only, and its status mapping is exact.

### Task 1: Pure model and store

- [ ] **Step 1: Failing tests:**
  - Every legal transition, and a table of illegal ones.
  - The owner-as-introducer shortcut.
  - 30-day expiry on read.
  - Budget: a 6th open introduction for one introducer is refused with `introduction_budget`.
  - The 6th proposal in a day is refused with `introduction_rate_limited`.
  - The vouch is only for an owner introducer, at `introducer_accepted` or later, ≤ 500 characters.
  - Outcome only on `made`.
  - The workspace status mapping, including `alternative_suggested`.
- [ ] **Steps 2–5:** red, implement, green; commit `feat(people): three-party introduction model and store`.

### Task 2: RPCs, routes and MCP

**Routes:**
- `GET /api/people/introductions` (read);
- `POST /api/people/introductions` (propose, write);
- `POST /api/people/introductions/advance` with `{id, to, vouch?}` (write);
- `POST /api/people/introductions/outcome` with `{id, result, note?}` (write).

Parties are validated as the owner's own person IDs, or `'owner'`.

**MCP:** read count 13; read+write count 21.

- [ ] **Step 1: Failing tests:**
  - Propose, then advance through `made`, then the outcome.
  - A workspace request shows as read-only and can't be advanced through these routes.
  - Scopes.
  - MCP counts.
  - The brief's `whether.introductions` counts.
- [ ] **Steps 2–5:** commit `feat(people): introduction routes, MCP tools and brief counts`.

### Task 3: Graph connector

- `graph()` adds `introductions:[{id,personIds,status}]` for `made`, `met` and `not_met` owner introductions. `'owner'` is excluded from `personIds`.
- `public/model.mjs` keeps `introductions` and adds connector edges of type `introduction` among those people (a pair gets one link; three people get a triangle).
- `public/scene.mjs` styles links of type `introduction` as dashed.

- [ ] **Step 1: Failing tests:**
  - The graph payload includes made introductions without vouch text.
  - Model parsing adds connector edges and leaves pairwise edges untouched (a node test of `public/model.mjs`).
- [ ] **Step 2:** Verify in a browser with the static UI fixture, if one exists; otherwise report the limit.
- [ ] **Steps 3–5:** commit `feat(web): introductions as three-way connectors`.

### Task 4: CLI and docs

**Rust `intros.rs`:**
- `intros list`, `intros show <id>`;
- `intros propose --parties <a>,<b> [--introducer <id|owner>] --reason <text>`;
- `intros advance <id> <status> [--vouch <text>]`;
- `intros outcome <id> met|not_met [--note]`.

**Skill:** a section on introductions covering double opt-in, the budget, and the rule to never send anything.

- [ ] Rust request-shape tests; commit `feat(cli): intros commands; document introductions`.
