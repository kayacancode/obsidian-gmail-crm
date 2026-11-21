# Agentic People: curiosity notes and moments (sub-project 5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (native). Steps use checkbox (`- [ ]`) syntax.

**Goal:**
- The owner writes a short **curiosity note** in four fixed sections:
  - what's new in my head;
  - why it interests me;
  - the fringes;
  - who I want to talk to.
- People turns notes plus network structure into a few **moments** per day. A moment is a timely, evidenced reason to act toward one to three people.
- Surprise is rationed and the overall budget is respected.
- Success is measured by connection, never by engagement.

**Architecture:**
- **`src/curiosity.ts` (pure):**
  - `parseCuriosityNote(markdown)` parses exactly four headings.
  - `noteKeywords(note)` returns the note's keywords.
- **`src/moments.ts` (pure):** `generateMoments(input) → Moment[]` takes:
  - why-now answers;
  - widen, bridges and contrast results;
  - active notes, existing moments and suppressions;
  - budget settings and `now`.

  It applies, in order: kinds, relevance to notes, per-person dedupe (7 days), suppression (30 days after dismiss), surprise rationing (one `fringe_match`/`widen` per day), and the daily budget (default 3, configurable 1–10).
- **`MailSync`:**
  - SQL tables `curiosity_notes`, `moments` and `moment_suppressions`.
  - RPCs `setCuriosityNote`, `listCuriosityNotes`, `archiveCuriosityNote`, `moments({today})`, `updateMoment(id, action)` and `momentSettings`.
  - **Generation is lazy and daily.** The first `moments` read of a UTC day generates that day's moments and stores them. Later reads return the stored set. There is no background peer call and no alarm.
- **Routes:** `src/moments-routes.ts`.
- **MCP read tools:** `list_curiosity_notes`, `list_moments`.
- **MCP write tools:** `set_curiosity_note`, `archive_curiosity_note`, `update_moment`.
- **CLI:** `crates/peoplegraph/src/moments.rs` with `mind set|show|list|archive` and `moments [--today] | act|snooze|dismiss <id>`.

**Spec:** `docs/superpowers/specs/2026-11-20-agentic-people-design.md`, sections "Sub-project 5: Curiosity notes and moments" and "Fringes, serendipity and success".

## Global Constraints

### Notes

**Headings.** A note has exactly these headings, in this order, each at most once:

1. `## What's new in my head`
2. `## Why it spikes my interest`
3. `## The fringes`
4. `## Who I want to talk to about it`

An unknown heading gives `note_invalid`, naming the heading. Text before the first heading is the note's title, at most 120 characters.

**Sections.**

| Section | Parsed into |
|---|---|
| What's new / fringes | Each `-`/`*` bullet becomes an item |
| Why | Free text |
| Want-to-talk | Each bullet is a name or email |

`(Name + Org)` in a "what's new" item becomes `unresolved` names. These are resolved by exact name or email against the owner's graph; unresolved names are reported in `gaps`.

**Limits:**
- At most 3 active notes.
- Each note is at most 4,000 characters.
- Archived notes are kept until deleted.
- Notes are zone A/D: never shared, never exported, never answered to peers or guests.

### Moments

**Shape:** `Moment {id, kind, personIds[1..3], trigger, answer: {why[], gaps[]}, createdAt, expiresAt, status: new|acted|snoozed|dismissed, day}`.

**Kinds:**

| Kind | When it applies | Expires |
|---|---|---|
| `pre_meeting` | why-now `meeting_soon` | At the event |
| `fresh_signal` | why-now `fresh_signal`, and the person's evidence or summary shares a keyword with an active note | 7 days |
| `cold_and_relevant` | why-now `going_cold`, and relevant to an active note | 14 days |
| `want_to_talk` | A resolved `wantToTalkTo` person with no contact for 30 days | 14 days |
| `fringe_match` | A `contrast` answer on a note fringe item with distance 1 | 14 days |
| `bridge` | A `bridges` pair whose shared evidence matches a note keyword | 14 days |
| `widen` | A `widen` pattern with its one person | 14 days |

**Rules:**
- **Budget:** at most N new moments per day (default 3, setting 1–10).
- **Dedupe:** at most one moment per person per 7 days, across kinds.
- **Ration:** at most one `fringe_match` or `widen` moment per day.
- **Priority** when over budget: `pre_meeting` > `want_to_talk` > `fresh_signal` > `fringe_match` > `bridge` > `cold_and_relevant` > `widen`. Ties break by the earliest trigger.
- **Dismiss** suppresses that (person, kind) for 30 days. It records only the suppression, not person feedback: dismissal is a judgment about the moment, not about the person.
- **Snooze** hides the moment for 3 days.
- **Act** marks it acted. `acted` counts are the success metric: `moments` returns `stats: {acted, dismissed, shownLast30}`. There is no engagement counter.
- **No peers:** generation never calls peers or any network beyond the owner's own hosted data plus the existing model calls in `contrast`.

### Privacy

- Sensitive signals never create or appear in moments. why-now already excludes them.
- Moments are owner-only.

## Review Focus

- Budget, dedupe, ration and suppression hold together, including across days.
- Lazy generation is idempotent within a day and can't double-generate when reads race. Use one SQL transaction keyed by day.
- No peer or outbound network call during generation.
- The note parser rejects unknown headings and keeps text exactly. Fixtures are synthetic and use no real names.

### Task 1: Curiosity notes

**Pure:** `src/curiosity.ts` with `parseCuriosityNote`, `CuriosityNote`, and `noteKeywords` (reusing `keywords` from `network-structure.ts`).

**Store:** `CuriosityNoteStore`. The table is `curiosity_notes(id, title, text, parsed, status, created, updated)`.

**RPCs:**
- `setCuriosityNote({text, id?})`: create, or replace an active note.
- `listCuriosityNotes({includeArchived?})`.
- `archiveCuriosityNote(id)`.

Names are resolved with an exact name or email match over `graph()` nodes. Ambiguous or missing names are listed in `gaps`.

**Routes:** `GET/POST /api/people/mind` and `POST /api/people/mind/archive`. Writes are same-origin JSON and need `people:write`.

**MCP:** read tool `list_curiosity_notes`, write tools `set_curiosity_note` and `archive_curiosity_note`.

- [ ] **Step 1: Failing tests:**
  - A synthetic note in the shape of the working note parses into the four fields.
  - An unknown heading gives `note_invalid` naming it.
  - More than 4,000 characters is rejected.
  - A fourth active note gives `note_limit`.
  - `(Ada + example)` resolves Ada and keeps "example" unresolved in `gaps`.
  - Archive works.
  - The routes and MCP tools work, and the MCP counts become read 11 and read+write 15.
- [ ] **Steps 2–5:** red, implement, green, full suite and typecheck. Commit `feat(people): curiosity notes`.

### Task 2: Moment generation (pure)

**Code:** `src/moments.ts` with `generateMoments`, `PRIORITY` (a Record) and `EXPIRY` (a Record).

- [ ] **Step 1: Failing tests:**
  - Each kind is produced from its trigger.
  - Budget 3, with priority ordering.
  - Per-person 7-day dedupe, both against earlier days and within the same day.
  - A dismissed (person, kind) is suppressed for 30 days.
  - At most one fringe/widen moment per day.
  - A sensitive signal never produces a moment.
  - `fresh_signal` and `cold_and_relevant` need note relevance.
  - With no active notes, only `pre_meeting` moments appear: every other kind needs a note, which keeps moments intentional.
- [ ] **Steps 2–5:** commit `feat(people): moments with budget, dedupe and rationed surprise`.

### Task 3: Storage, lazy daily generation, routes, MCP

**Tables:** `moments` and `moment_suppressions`. Settings `{budget}` live in DO storage.

**RPCs:**
- `moments({today})`: the first read of a UTC day runs `generateMoments` inside a transaction keyed by day. It returns new, snoozed-but-due and acted moments, plus `stats`.
- `updateMoment(id, action)`.
- `setMomentBudget(n)`.

**Routes:**
- `GET /api/people/moments?today=1`;
- `POST /api/people/moments/update` with `{id, action}`;
- `POST /api/people/moments/settings` with `{budget}`.

**MCP:** read tool `list_moments`, write tool `update_moment`.

- [ ] **Step 1: Failing tests:**
  - Generation runs once per day: a second read doesn't regenerate.
  - Act, snooze and dismiss behave as specified.
  - Stats count acted and dismissed only.
  - No outbound fetch happens during generation: spy on `globalThis.fetch`.
  - The MCP tools are listed.
- [ ] **Steps 2–5:** commit `feat(people): daily moments store, routes and MCP tools`.

### Task 4: CLI, skill and docs

**Rust `moments.rs`:**
- `mind set --file <path|->`, `mind show <id>`, `mind list [--archived]`, `mind archive <id>`;
- `moments [--today]`, `moments act|snooze|dismiss <id>`, `moments budget <1-10>`.

**Skill:** a "Curiosity notes and moments" section. Agents surface at most the day's moments, never invent extra ones, and present the success metric as connections made.

- [ ] **Step 1:** Rust fixture tests for each command's request.
- [ ] **Step 2:** Commit `feat(cli): mind and moments commands; document them`.
