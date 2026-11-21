# Agentic People: structure (sub-project 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (native). Steps use checkbox (`- [ ]`) syntax.

**Goal:** Owner-only answers that need the shape of the network:
- `why_now`: who to contact and why now;
- `contrast`: relevant **and** distant, with disagreement counting;
- `widen`: notice a narrowing pattern and offer one person from outside it;
- `bridges`: who should know each other, plus connectors;
- `atlas`: the landscape around one topic.

**Architecture:**
- **Pure core.** `apps/people-graph/src/network-structure.ts` takes one `StructureInput` built from `graph()` (nodes, id-mapped edges, `activity`, `themeSignals`, relevance themes) plus owner data:
  - Lens fields;
  - unexpired open/personal life signals;
  - stints and job-move proposals;
  - feedback;
  - last in/out mail dates per person.
- **Durable Object.** `MailSync` RPCs build that input and call the pure functions. The only model calls are the `contrast` stance labels and the `atlas` absent communities.
- **Routes.** `src/structure-routes.ts` serves `GET /api/people/{why-now,contrast,widen,bridges,atlas}` with `people:read`, for both session and machine callers.
- **Elsewhere.** The MCP tool `get_atlas`, the new `ask` intents, and Rust CLI `structure.rs` with commands `why-now`, `contrast`, `widen`, `bridges` and `atlas`.

**Spec:** `docs/superpowers/specs/2026-11-21-agentic-people-structure-design.md`.

## Global Constraints

- **Determinism.** Label propagation visits nodes in sorted id order, breaks ties toward the smallest label, and runs at most 20 iterations. Clusters with fewer than 3 members dissolve. A cluster's id is `sha256(sorted member ids)` truncated to 12 hex digits, computed with WebCrypto (async).
- **Cluster edges.** Only edges whose `types` include `shared_email` or `shared_meeting` count. Nodes are graph nodes with `directRelationship`, never shared-only nodes.
- **Interactions.** These come from `graph().activity`, one per (event, personId):
  - email and meeting events always count;
  - calendar events count only for `acceptedPersonIds`.

  Windows are 90 days for usual circles and 30 days for `widen`. Future events are ignored, except by `meeting_soon`.
- **Usual circles:** the fewest clusters, largest interaction share first, that together cover at least 60% of 90-day interactions. `distance` is 0, 0.5 or 1 per the spec. Shared-only people are 1, with `reach: via`.
- **Privacy:**
  - Sensitive life signals never trigger, rank or appear.
  - Judgments only exclude people: `suppress`/`delete` feedback, active `snooze`, and `notBefore` in the future. They never cross to anyone.
  - Nothing new is exported to workspaces, peers or guests.
- **Envelope.** Every answer uses `{interpretation:null, answers, result, gaps}`. Each `why` entry carries `source`, `observedAt` and `attribution:'first_hand'`.
- **Style:** no `as any`; static lookups use `Record`.

## Review Focus

- Clustering is deterministic, and `widen` is exactly correct at the 70% and 12-interaction boundaries.
- `bridges` never proposes a pair that already has any edge, including `shared_via` and `introduced` edges.
- Sensitive signals and judgments never surface.
- The model sees only short summaries and labels, never quotes or emails. `absent` entries never name a person.

### Task 1: Clusters, usual circles and distance (pure)

**File:** `src/network-structure.ts`.
- **Types:** `StructureNode`, `StructureEdge`, `StructureEvent`, `StructureInput`.
- **Functions:**
  - `clusterNetwork(nodes, edges) → Promise<Clusters>`, where `Clusters` is `{byNode: Record<id, clusterId|null>, clusters: Cluster[]}` and `Cluster` is `{id, members, label: {companies, themes}}`;
  - `interactions(events, now, days) → Record<personId, number>`;
  - `usualCircles(clusters, counts) → Set<clusterId>`;
  - `distanceOf(id, ctx) → {value, cluster, reason}`.

**Test:** `tests/network-structure.test.ts`, with a synthetic two-community fixture plus one connector.

- [ ] **Step 1: Failing tests:**
  - two planted communities become two clusters;
  - identical ids across runs;
  - a 2-member cluster dissolves;
  - the label comes from the top companies and themes;
  - the 60% usual-circle cut;
  - all three distance values;
  - shared-only people are distance 1.
- [ ] **Steps 2–5:** red, implement, green, full suite and typecheck; commit `feat(people): deterministic network clusters and distance`.

### Task 2: `why_now`

**Pure function:** `whyNow(input, {now, lens, signals, stints, jobMoves, mail: Record<personId, {lastIn, lastOut}>}) → ranked answers`.

| Trigger | Condition | Weight |
|---|---|---|
| `meeting_soon` | A calendar event with the person in the next 48 h | 3 |
| `owes_reply` | `lastIn > lastOut`, with `lastIn` within 21 days | 2 |
| `fresh_signal` | An open/personal signal observed within 14 days | 2 |
| `job_move` | A stint starting within 60 days, or a job-move proposal | 2 |
| `going_cold` | Strength ≥ 50 and 75–130 days since contact | 1.5 |
| `topic_overlap` | A theme signal from the person within 30 days whose summary shares at least one 4+ letter keyword with Lens `focus` or `needs` | 1.5 |

**Score:** `sum(weights) × (0.5 + strength/200)`. Return the top 10.

**DO RPC:** `whyNow(limit)`. It builds the mail map with `SELECT email, MAX(CASE WHEN received>0 THEN date END) AS lastIn, MAX(CASE WHEN sent>0 THEN date END) AS lastOut FROM contributions GROUP BY email`, mapped to person ids with the same `opaque` id as `graph()`.

**Route:** `GET /api/people/why-now?limit=`.

- [ ] **Step 1: Failing tests:**
  - each trigger alone;
  - a sensitive signal never triggers;
  - suppressed and snoozed people are excluded;
  - no triggers gives empty answers plus a gap;
  - the route answers for a machine read principal.
- [ ] **Steps 2–5:** commit `feat(people): why-now triggers with evidence`.

### Task 3: `contrast`, `widen`, `bridges` and connectors

**Pure functions:**
- `contrast(candidates with relevance, distanceCtx, stances?)`;
- `widen(input, now, lens)`;
- `bridges(input, clusters, topic?)`;
- `connectors(clusters, edges)`.

**DO RPCs:**
- `contrast(topic, claim?)`: candidates from `searchPeople(topic)` results, with `relevance = score`. With a claim, it runs one Workers AI JSON-schema call (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`). The call sees `{claim, people: [{i, summaries ≤ 3 × 200 chars}]}` and returns `{labels: [{i, stance}]}`, which is validated.
- `widen()`.
- `bridges(topic?)`.

**Routes:** `contrast?topic=&claim=`, `widen`, `bridges?topic=`.

- [ ] **Step 1: Failing tests:**
  - the contrast distance filter, and fewer than 3 distant candidates gives a gap;
  - a `challenges` stance outranks `supports` (mocked AI);
  - an invalid model output is ignored, so there is no stance;
  - `widen` at 69% vs 70%, and fewer than 12 interactions;
  - the one-person pick is distance 1 with strength ≥ 30 and no contact for 30 days;
  - `bridges` excludes connected pairs (including `shared_via` and `introduced`) and same-cluster pairs, and requires evidence;
  - connectors touch at least 2 clusters.
- [ ] **Steps 2–5:** commit `feat(people): contrast, widen, bridges and connectors`.

### Task 4: `atlas`, MCP `get_atlas` and schema

- **Pure:** `assembleAtlas(topic, known, fringe, communities, absent)`.
- **DO RPC `atlas(topic)`:**
  1. `searchPeople(topic)` gives `known`, at relevance ≥ 0.3.
  2. The `contrast` selection without a claim gives `fringe`.
  3. Communities with at least one relevant member, plus the usual circles.
  4. One AI call for `absent`, which sees `{topic, present labels}` and returns up to 5 short labels. Each is validated as a string of at most 60 characters and marked `inferred:true`.
- **Route and schema:** `GET /api/people/atlas?topic=`, plus `public/schemas/v1/atlas.json` (JSON Schema draft 2020-12).
- **MCP:** a read tool `get_atlas {topic}`. Tool-count tests go to 10 read and 13 read+write.

- [ ] **Step 1: Failing tests:**
  - the atlas validates against the schema's required keys;
  - `absent` entries have only `label` and `inferred`;
  - the MCP lists `get_atlas` and returns an atlas;
  - the tool counts are updated.
- [ ] **Steps 2–5:** commit `feat(people): fringe atlas object, route and MCP tool`.

### Task 5: `ask` intents, CLI, eval and docs

- **`ask`:**
  - New intents `why_now {}`, `contrast {topic, claim?}`, `widen {}`, `bridges {topic?}` and `atlas {topic}`, added to `ASK_INTENTS`, `REQUIRED`, the prompt and the dispatch.
  - The eval set grows to 60 questions.
  - The recorded-classification test covers them.
- **Rust `structure.rs`:** hosted-only commands `why-now [--limit]`, `contrast <topic> [--claim]`, `widen`, `bridges [--topic]` and `atlas <topic>`, each calling the machine route. `--local`/`--cache` give `incompatible_backend`, as other private commands do. Add `describe` entries.
- **Docs:** the skill and parity doc get a "Network structure" section.
- **Tests:** a Rust fixture test per command (the request path is sent), plus web tests for the ask dispatch of each new intent.
- [ ] Commit `feat: ask and CLI for why-now, contrast, widen, bridges and atlas`.
