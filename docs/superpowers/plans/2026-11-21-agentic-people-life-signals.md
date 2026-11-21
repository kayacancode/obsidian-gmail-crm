# Agentic People: Life signals, job moves and the two-sided brief (sub-project 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (chosen: native). Steps use checkbox (`- [ ]`) syntax.

**Goal:** Let People remember what people mention but don't post (life signals, job moves), and give agents a catch-up brief that tells both sides' story since the last conversation. All of it stays private to the owner.

**Architecture:**
- **Where the code lives.** New pure modules in `apps/people-graph/src`:
  - `life-signals.ts`: categories, tiers, TTLs, extraction and the store.
  - `owner-timeline.ts`: the owner's self-entries.
  - `company-stints.ts`: derivation, owner edits, job-move candidates and teammates.
  - `catch-up-brief.ts`: assembles the answer envelope.
- **Wiring into `MailSync`.**
  - These stores are created lazily, following the `RelationshipMemoryStore` pattern.
  - Extraction hooks into `automaticMessageContext` (Gmail), `captureRelationshipMemory` (owner notes) and a new optional `GranolaHooks.lifeNote` (Granola).
- **Transport.** One route module, `life-routes.ts`, is registered on the session router and in the machine capability registry. Two read-only MCP tools are added. The Rust CLI gains one hosted module, `crates/peoplegraph/src/life.rs`.

**Tech Stack:** TypeScript Worker (Durable Object SQLite, Workers AI `THEME_MODEL`), node:test via `tests/run-mail.mjs`, Rust clap CLI.

**Spec:** `docs/superpowers/specs/2026-11-20-agentic-people-design.md`. The relevant sections are "Sub-project 1", "Two-sided brief", "Job moves and teammates", "Privacy partition" and "Shared contract: the answer envelope".

## Global Constraints

- **Off by default.** Life signals are owner-private (zone A) and never enter `theme_signals`, workspace graphs, peers or guests. Extraction stays off until `signals on`.
- **Categories and tiers (verbatim):**

  | Category | Tier | TTL |
  |---|---|---|
  | `travel` | open | 60 days |
  | `hobby` | open | 365 days |
  | `role_change` | open | 365 days |
  | `moved` | open | 365 days |
  | `milestone` | personal | 180 days |
  | `health` | sensitive | 120 days |
  | `family` | sensitive | 180 days |
  | `loss` | sensitive | 365 days |
  | `money` | sensitive | 120 days |
  | `legal` | sensitive | 120 days |

- **Who sets what.** The model never chooses a tier. At most 3 signals are kept per source text. Field limits: `summary` ≤ 80 chars, `quote` ≤ 600 chars.
- **Sources and attribution:**
  - Gmail: only accounts with context enabled, and only an anchor sentence that is a first-person statement by the sender.
  - Granola: only an anchor sentence naming exactly one non-owner attendee.
  - Memory: owner-written notes about that person; any anchor is accepted.
- **Expiry.** Expired signals are excluded from every read and deleted by opportunistic cleanup.
- **Brief envelope.** Shape: `{interpretation:null, answers:[{personId,name,when,why[],whether,use}], gaps[]}`. Every `why` entry carries `source`, `observedAt` and `attribution:'first_hand'`. Sensitive signals are `use:'tone_only'`.
- **`sinceLastContact`.** Two keys: `theirs` (signals and stints after `lastContact`, oldest first) and `yours` (owner self-entries after `lastContact`).
- **Owner self-entries** (`me add|list|forget`) are explicit only, never extracted, and never answered to peers.
- **Company stints:**
  - `CompanyStint{personId,company,domain,from,to|null,source}` is derived from email domains over time and from owner edits; owner edits win.
  - Job-move detection proposes and never merges.
  - `who-knows --include-former` labels `formerly`.
  - `teammates` lists people whose stints overlap.
- **New error kinds:** `signals_disabled`, `ambiguous_person`, `not_found`, `invalid_request`. Messages never contain quotes, tokens or email bodies.
- **Commands:**
  - Web: `cd apps/people-graph && node tests/run-mail.mjs && npm run typecheck`. Baseline: 1108 tests passing.
  - Rust: `cd crates/peoplegraph && cargo test --locked`. Baseline: 145 tests passing.

## Review Focus

- A Gmail message from someone quoting a third party ("my friend broke her leg") must not become a health signal about the sender. Pin it with a first-person-subject test that rejects "my friend …" anchors.
- An expired signal is in the table but must not appear in `signals list`, the brief or job-move evidence. Pin with a clock-injected test.
- Turning signals off then on must not resurrect forgotten signals. `forget` deletes rows, and re-extraction of an already-processed message is keyed by `life_processed(source_ref)`, which `forget --all` keeps.
- A merged person (`person_merges`) must see the signals of every merged id in the brief. Read through `emailsForMergedPerson` / `canonicalPersonId`.
- A Granola anchor sentence naming two attendees ("Maya and Sam both moved") must be dropped, not attributed to one of them.

---

### Task 1: Life signal model and extraction (`life-signals.ts`)

**Files:** Create `apps/people-graph/src/life-signals.ts` and `apps/people-graph/tests/life-signals.test.ts`. Add `import './tests/life-signals.test.ts';` to the import string in `tests/run-mail.mjs`.

**Interfaces (produces):**

```ts
export const LIFE_CATEGORIES = ['travel','hobby','role_change','moved','milestone','health','family','loss','money','legal'] as const;
export type LifeCategory = typeof LIFE_CATEGORIES[number];
export type LifeTier = 'open'|'personal'|'sensitive';
export const LIFE_TIER: Record<LifeCategory,LifeTier>;
export const LIFE_TTL_DAYS: Record<LifeCategory,number>;
export type LifeMode = 'sender'|'attendee'|'note';
export interface LifeCandidate {category:LifeCategory;tier:LifeTier;summary:string;quote:string;personHint?:string} // personHint = attendee email (attendee mode)
export async function extractLifeSignals(ai:Ai|undefined,text:string,mode:LifeMode,attendees?:{email:string;name:string}[],signal?:AbortSignal):Promise<LifeCandidate[]>;
```

**Extraction behaviour:**
- **Input.** Split the text with the same `sentenceParts` as `gmail-context.ts`; export it from there instead of copying. Cap at 16000 chars and 80 sentences.
- **Model call.** `ai.run(THEME_MODEL, {messages, response_format:{type:'json_schema',json_schema:SCHEMA}, max_tokens:512, temperature:0})`, with a 20 s timeout. The schema is `{signals:[{start,end,anchor,category,summary}]}`, at most 3 items.
- **Prompt.** The system prompt asks only for personal-life passages (travel, hobbies, role changes, moves, milestones, health, family, loss, money, legal) that the subject says about themselves. The summary must be a neutral paraphrase of at most 80 chars with no names other than the subject. Work-product passages are excluded.
- **Validation.** Each item must satisfy all of these:
  - indexes are in range, `end - start ≤ 3`, and `start ≤ anchor ≤ end`;
  - the quote is 20–600 chars;
  - `category` is in `LIFE_CATEGORIES`;
  - `summary` is 3–80 chars, has no `@`, and has no URL.
- **Mode check on the anchor sentence:**
  - `sender`: matches `/^\s*(i|i'm|i've|i'll|i'd|we|we're|we've)\b/i`, or contains `\b(i|i'm|i've|i'll|i'd)\b` with no third-party possessive subject. A third-party subject is `/\bmy (friend|wife|husband|partner|son|daughter|mom|mother|dad|father|brother|sister|colleague|boss|cofounder|co-founder)\b/i`, and an anchor containing it is rejected even if it also contains "I".
  - `attendee`: the anchor names exactly one non-owner attendee, by full name or first-name token (case-insensitive, whole word). `personHint` is that attendee's email.
  - `note`: no anchor check.
- **Result.** `tier` comes from `LIFE_TIER`. Duplicate anchors are dropped. No binding throws `ai_unavailable`, and invalid model JSON throws `invalid_extraction`, matching the `gmail-context.ts` conventions.

- [ ] **Step 1: Failing tests** in `tests/life-signals.test.ts`. Use a fake `ai` (`{run:async()=>({response:{signals:[...]}})}`) and cover:
  - `sender`: "I just got back from two weeks in Japan." with `{category:'travel', summary:'Back from two weeks in Japan'}` yields one candidate with tier `open`.
  - `sender`: an anchor "My friend broke her leg skiing." with category `health` yields `[]` (Review Focus).
  - Tier comes from the category, even if the model output carries a `tier` field.
  - An invalid category, an over-long summary, or a summary containing an email is dropped.
  - `attendee`: notes "Maya mentioned she moved to Lisbon." with attendees `[{email:'maya@x.test',name:'Maya Rivera'}, {email:'sam@y.test',name:'Sam Lee'}]` yield `personHint:'maya@x.test'`, category `moved`.
  - `attendee`: "Maya and Sam both moved to Lisbon." yields `[]` (Review Focus).
  - `note`: "His dad has been ill since spring." is accepted as `health`, tier `sensitive`.
  - `ai` undefined rejects with `ai_unavailable`.
- [ ] **Step 2:** `TEST_NAME=life node tests/run-mail.mjs` fails with a module-not-found error.
- [ ] **Step 3:** Implement `life-signals.ts` (extraction half) and export `sentenceParts` from `gmail-context.ts`.
- [ ] **Step 4:** Same command; all pass. Then run the full web suite and typecheck.
- [ ] **Step 5:** Commit `feat(people): extract tiered life signals with subject-safe attribution`.

### Task 2: Stores and MailSync RPCs (signals, settings, owner timeline)

**Files:**
- Modify `life-signals.ts`: add `LifeSignalStore`.
- Create `owner-timeline.ts`.
- Modify `mail-sync.ts`: lazy stores and RPCs.
- Create `tests/life-store.test.ts` (uses `fixture()` from `tests/person-context.test.ts`) and add it to `run-mail.mjs`.

**Interfaces:**

```ts
export interface LifeSignal {id:string;personId:string;category:LifeCategory;tier:LifeTier;summary:string;quote:string;source:'gmail'|'granola'|'memory';sourceRef:string;observedAt:string;expiresAt:string}
export class LifeSignalStore {
 constructor(storage:DurableObjectStorage,now?:()=>number);
 enabled():boolean; setEnabled(on:boolean):void;
 processed(sourceRef:string):boolean; markProcessed(sourceRef:string):void;
 add(personId:string,c:LifeCandidate,source:LifeSignal['source'],sourceRef:string,observed:number,index:number):void; // id = `${source}:${sourceRef}:${index}`, INSERT OR REPLACE
 list(personIds?:string[]):LifeSignal[]; // unexpired, newest first
 forget(target:{id:string}|{personIds:string[]}|{all:true}):number;
 purgeExpired():void;
}
// owner-timeline.ts
export interface TimelineEntry {id:string;text:string;category:LifeCategory|null;date:string;createdAt:number}
export class OwnerTimelineStore {constructor(storage:DurableObjectStorage); add(input:{text:string;category?:LifeCategory|null;date?:string}):TimelineEntry; list():TimelineEntry[]; forget(id:string):boolean;}
```

**Storage:**
- Tables (`CREATE TABLE IF NOT EXISTS` in each constructor):
  - `life_signals(id TEXT PRIMARY KEY, person TEXT NOT NULL, category TEXT NOT NULL, tier TEXT NOT NULL, summary TEXT NOT NULL, quote TEXT NOT NULL, source TEXT NOT NULL, source_ref TEXT NOT NULL, observed INTEGER NOT NULL, expires INTEGER NOT NULL)`, with index `life_signals_person(person, expires)`;
  - `life_processed(source_ref TEXT PRIMARY KEY)`;
  - `life_settings(id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL)`;
  - `owner_timeline(id TEXT PRIMARY KEY, text TEXT NOT NULL, category TEXT, date TEXT NOT NULL, created INTEGER NOT NULL)`.
- `expires = observed + LIFE_TTL_DAYS[category] * 86400000`.
- **Timeline limits.** Text is 1–280 chars and the date is `YYYY-MM-DD`, defaulting to today in UTC. At most 500 entries; beyond that, `invalid_request`.

**MailSync RPCs (public async):**
- `getLifeSettings():{enabled}`; `setLifeSignals(enabled:boolean)`.
- `listLifeSignals(personId?:string)`: canonicalizes, then reads every merged id via `emailsForMergedPerson` → `opaque`.
- `forgetLifeSignals(input:{id?:string;personId?:string;all?:boolean})` → `{removed}`.
- `addTimelineEntry(input)`; `listTimeline()`; `forgetTimelineEntry(id)`.

**Steps:**
- [ ] **Step 1: Failing tests.**
  - Disabled by default.
  - `add` then `list` round-trips, with `expiresAt` = observed + 60 d for travel.
  - An injected `now` past expiry hides the signal and `purgeExpired` deletes it (Review Focus).
  - `forget({all:true})` deletes the signals but keeps `life_processed`, so `processed(ref)` is still true (Review Focus).
  - `listLifeSignals` on a person merged with a second address returns both addresses' signals (create the merge via `setPersonMerge`, as `relationship-memory.test.ts` does).
  - The timeline rejects a 281-char text and a bad date.
- [ ] **Step 2: Watch them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Green**, then run the full web suite and typecheck.
- [ ] **Step 5: Commit** `feat(people): store private life signals and owner timeline entries`.

### Task 3: Extraction hooks (Gmail, memory capture, Granola)

**Files:**
- `mail-sync.ts`: `automaticMessageContext` and `captureRelationshipMemory`.
- `granola-sync.ts`: optional hook `lifeNote?:(input:{noteId:string;meetingAt:string;text:string;attendees:{email:string;name:string}[]})=>Promise<void>` on `GranolaHooks`, called right after `ingestExtraction` with `text = [summary, privateNotes].join('\n')`.
- Test: `tests/life-hooks.test.ts`.

**Behaviour:**
- **Gmail.** Inside `automaticMessageContext`, after the body is decoded and before `body.text = ''`, the hook runs when all of these hold:
  - `lifeStore().enabled()`;
  - `!processed('gmail:'+id)`;
  - the same revision/active guard passes.

  It then calls `extractLifeSignals(ai, body.text, 'sender')`, adds the results with person = the existing opaque `person` and `observed = parsed.date`, and calls `markProcessed`. Extraction failures are swallowed so the work-context path is unaffected, but `life_processed` is not marked, so the message is retried.
- **Memory.** After a successful capture with signals enabled, run `extractLifeSignals(ai, input.text, 'note')` for `personId`, with source `memory`, sourceRef `memory:<sourceId>` and observed now. The capture response is unchanged; failures are swallowed.
- **Granola.** `MailSync` implements `lifeNote`. When signals are enabled and the note isn't processed:
  - attendees exclude the owner's emails;
  - each candidate's `personHint` maps through `granola_identity` aliases to the contact email (reuse the alias lookup `ingestExtraction` uses);
  - person = `canonicalPersonId(opaque(owner, email))`, source `granola`, sourceRef `granola:<noteId>`, observed = `meetingAt`.
- **Every hook** calls `purgeExpired()` first.

**Steps:**
- [ ] **Step 1: Failing tests,** using the fixture with fake `env.AI` returning `signals`:
  - Gmail with signals enabled stores a travel signal for the contact's person id. Drive `automaticMessageContext` the way `sync.test.ts` drives context extraction; copy its Gmail fetch stub.
  - Signals disabled stores nothing and makes no AI life call (count `ai.run` calls by schema name).
  - A memory capture "Her dad is ill." stores a `health`/`sensitive` signal.
  - Granola `lifeNote` with a two-attendee note attributes to the named attendee only.
  - A second run over the same message makes no extra AI call.
- [ ] **Steps 2–4:** red, implement, green, then the full suite and typecheck.
- [ ] **Step 5: Commit** `feat(people): extract life signals from opted-in mail, notes and meetings`.

### Task 4: Company stints, job moves, teammates and former colleagues

**Files:**
- Create `company-stints.ts`: pure derivation plus `CompanyStintStore` for owner edits.
- `mail-sync.ts` RPCs.
- `cli-query.ts`: `who-knows` accepts `include_former:boolean`.
- Test: `tests/company-stints.test.ts`.

**Interfaces:**

```ts
export const PERSONAL_DOMAINS: ReadonlySet<string>; // gmail.com googlemail.com yahoo.com hotmail.com outlook.com live.com icloud.com me.com mac.com aol.com proton.me protonmail.com hey.com fastmail.com msn.com gmx.com
export interface CompanyStint {id:string;personId:string;company:string;domain:string;from:string;to:string|null;source:'email_domain'|'owner'}
export function deriveStints(personId:string,addresses:{email:string;first:number;last:number}[],now:number):CompanyStint[]; // per non-personal domain: from=YYYY-MM(first); to=null if this domain holds the latest `last` among the person's work domains, else YYYY-MM(last); company = label before the first dot
export class CompanyStintStore {constructor(storage:DurableObjectStorage); set(input:{personId:string;company:string;from:string;to:string|null}):CompanyStint; forget(id:string):boolean; forPerson(personId:string):CompanyStint[];}
export function mergeStints(derived:CompanyStint[],owner:CompanyStint[]):CompanyStint[]; // owner stints replace derived ones with the same normalized company; sorted by from
export function overlaps(a:CompanyStint,b:CompanyStint):string|null; // returns "YYYY-MM..YYYY-MM|present" or null
```

**MailSync RPCs:**
- `companyStints(personId)`: addresses come from `emailsForMergedPerson`, with `first`/`last` from `SELECT email, MIN(date), MAX(date) FROM contributions WHERE email IN (...) GROUP BY email`.
- `setCompanyStint(input)`, `forgetCompanyStint(id)`.
- `jobMoveCandidates()`: graph contacts sharing a normalized full name (two or more tokens), with distinct non-personal domains, not already merged → `{name, people:[{personId,domain,lastContact}]}`, sorted by latest contact.
- `teammates(personId)`: other people with an overlapping stint at the same domain, plus the overlap period.
- `formerAt(company)`: personIds whose stint at a matching company is closed (`to != null`).

**Steps:**
- [ ] **Step 1: Failing tests:**
  - `deriveStints` for addresses at acme.com (2023-01..2024-06) and zeta.io (2024-07..now) gives acme closed and zeta open.
  - gmail.com addresses are ignored.
  - An owner stint for "Acme" replaces the derived acme stint.
  - `overlaps` returns the right range.
  - `jobMoveCandidates` pairs "Maya Rivera"@acme with "Maya Rivera"@zeta, and skips them once merged.
  - `cli-query` `who-knows` with `include_former:true` returns the former employee labelled `formerly:{from,to}` (fake the MAIL stub's `formerAt`).
- [ ] **Steps 2–4:** red, implement, green, then the full suite and typecheck.
- [ ] **Step 5: Commit** `feat(people): derive company stints, job-move candidates and teammates`.

### Task 5: Catch-up brief (`catch-up-brief.ts`)

**Files:** Create `catch-up-brief.ts` (pure assembly) and add a `catchUpBrief` RPC to `mail-sync.ts`. Test: `tests/catch-up-brief.test.ts`.

**Interfaces:**

```ts
export interface BriefInput {person:{id:string;name:string;company:string;lastContact:string|null;combined:number|null};signals:LifeSignal[];work:{summary:string;observedAt:string;source:string}[];memory:{text:string;createdAt:number}[];feedback:{action:string}|null;relationship:'neutral'|'closer'|'weaker';stints:CompanyStint[];timeline:TimelineEntry[];now:number}
export function assembleBrief(input:BriefInput):{interpretation:null;answers:Answer[];gaps:string[];sinceLastContact:{theirs:Array<{kind:'signal'|'stint';summary:string;date:string}>;yours:TimelineEntry[]}};
```

**Envelope contents:**
- **`when`:** `{lastContact, daysSince, label}`. The labels are those of `staleness`: active < 30 d, warm < 90 d, cooling < 180 d, stale < 365 d, otherwise dormant.
- **`why`:**
  - signals as `{kind:'life',category,summary,source,observedAt,attribution:'first_hand',use}`;
  - work items as `{kind:'work',…}`;
  - memory notes as `{kind:'note',summary:text≤160,source:'memory',…}`.
- **Use.** `use` is `tone_only` for sensitive signals and `rank` otherwise. The answer-level `use` is `rank`.
- **`whether`:** `{feedback:action|null, relationship, notes:memory.length}`.
- **Gaps (exact text):**
  - "No life signals: signals are off" when disabled;
  - "No first-hand notes";
  - "No contact date recorded".
- **Resolution.** `catchUpBrief({personId?,email?,query?})` resolves the person like `cli-query`: id, then email via `resolveOwnEmail`, then an exact case-insensitive name. Several matches give `ambiguous_person` with `candidates:[{id,name,company}]`; none gives `not_found`. It then gathers:
  - `listLifeSignals`;
  - `automaticContextSignals` for the person (max 3);
  - `memoryForPerson` entries (latest 3);
  - the `person_feedback` row and memory relationship;
  - `companyStints`;
  - `listTimeline`.

  Then it calls `assembleBrief`.

**Steps:**
- [ ] **Step 1: Failing tests:**
  - A sensitive signal is `tone_only`; travel is `rank`.
  - `sinceLastContact.theirs` holds only items after `lastContact`, oldest first.
  - `yours` holds only timeline entries after `lastContact`.
  - Disabled signals produce the gap text.
  - A merged person shows both addresses' signals (Review Focus).
  - An ambiguous name returns candidates.
  - An expired signal is absent.
- [ ] **Steps 2–4:** red, implement, green, then the full suite and typecheck.
- [ ] **Step 5: Commit** `feat(people): assemble two-sided catch-up briefs`.

### Task 6: Routes, machine registry, MCP tools

**Files:**
- Create `life-routes.ts`.
- Modify `index.ts` (session prefixes `/api/people/signals`, `/api/people/brief`, `/api/people/timeline`, `/api/people/stints`, `/api/people/job-moves`, `/api/people/teammates`).
- Modify `people-machine.ts` (Handler `'life'` and capabilities).
- Modify `people-diagnostics.ts` (phase name).
- Modify `people-memory-agent.ts` (MCP).
- Test: `tests/life-routes.test.ts`.

**Routes** (JSON; non-GET requires `origin === url.origin`, as in `relationship-memory-routes.ts`):

| Method and path | Scope | Body or query |
|---|---|---|
| `GET /api/people/signals` | read | `?personId` |
| `POST /api/people/signals/settings` | edit | `{enabled}` |
| `DELETE /api/people/signals` | edit | `{id}`, `{personId}` or `{all:true}` |
| `GET /api/people/brief` | read | `?personId`, `?email` or `?query` |
| `GET /api/people/timeline` | read | |
| `POST /api/people/timeline` | edit | |
| `DELETE /api/people/timeline` | edit | `{id}` |
| `GET /api/people/stints` | read | `?personId` |
| `POST /api/people/stints` | edit | |
| `DELETE /api/people/stints` | edit | `{id}` |
| `GET /api/people/job-moves` | read | |
| `GET /api/people/teammates` | read | `?personId` |

- **Errors:** `invalid_request` → 400, `not_found` → 404, `ambiguous_person` → 409 with candidates.
- **MCP (people:read):**
  - `get_catch_up_brief` (`{email?, personId?}`, exactly one) runs `catchUpBrief`.
  - `list_life_signals` (`{personId?}`) runs `listLifeSignals`.
  - Descriptions state that the results are private and first-hand, that sensitive items are tone-only, and that nothing is shared.

**Steps:**
- [ ] **Step 1: Failing tests:**
  - A signed session can toggle settings and list.
  - A cross-origin POST is 403.
  - A machine credential with only `people:read` gets `insufficient_scope` on a POST.
  - `GET /api/people/brief?query=Ada` returns the envelope.
  - The MCP tool list for a read principal includes both new tools; copy the `people-memory-agent.test.ts` pattern.
- [ ] **Steps 2–4:** red, implement, green, then the full suite and typecheck.
- [ ] **Step 5: Commit** `feat(people): expose life signals, briefs, timeline and stints over routes and MCP`.

### Task 7: Rust CLI (`life.rs`)

**Files:**
- Create `crates/peoplegraph/src/life.rs` and `crates/peoplegraph/tests/life_cli.rs` (fixture server pattern from `tests/memory_cli.rs`).
- Modify `main.rs` in the places `memory` touches: enum variants, the hosted `matches!` dispatch list, the `unreachable!` list, the `remote_path` `None` list, `command_name` and `describe_payload`.
- Add `who-knows --include-former` to `WhoKnowsArgs`: hosted sends `include_former`; local and legacy return `unsupported_locally`.

**Commands** (all hosted via `people_client`):

| Command | Request |
|---|---|
| `signals list [--person <id-or-email>]` | `GET /api/people/signals` |
| `signals on` / `signals off` | `POST /api/people/signals/settings` |
| `signals forget (<id> \| --person <id> \| --all)` | `DELETE /api/people/signals` |
| `brief <email-or-name-or-id>` | `GET /api/people/brief?email=` when the value contains `@`, `personId=` when it matches `^[A-Za-z0-9:_-]{20,}$`, otherwise `query=` |
| `me add "<text>" [--category <c>] [--date <YYYY-MM-DD>]` / `me list` / `me forget <id>` | `/api/people/timeline` |
| `stints <person>` / `stints set <person> --company <c> --from <YYYY-MM> [--to <YYYY-MM>]` / `stints forget <id>` | `/api/people/stints` |
| `job-moves` | `GET /api/people/job-moves` |
| `teammates <person>` | `GET /api/people/teammates` |

DELETE uses `request_http(…,"DELETE",…)`.

**Steps:**
- [ ] **Step 1: Failing tests:** each command sends the exact method, path and body to the fixture server and prints the envelope. `who-knows --include-former --local` gives `unsupported_locally`.
- [ ] **Steps 2–4:** red, implement, green, then `cargo fmt --check`.
- [ ] **Step 5: Commit** `feat(cli): signals, brief, me, stints, job-moves and teammates commands`.

### Task 8: Skill, docs, final verification

- [ ] **Skill.** Add a "Catch-up and life signals" section to `skills/peoplegraph/SKILL.md`:
  - when to use `brief`;
  - signals are off until the owner says `signals on`;
  - sensitive items are tone-only and never repeated to third parties;
  - `me add` only on explicit owner request;
  - job moves are proposals the owner confirms with `api POST /api/people/person-merges`.
- [ ] **Docs.** Add a short "Life signals and briefs" section to `docs/peoplegraph-cli-parity.md`.
- [ ] **Full verification.** Run the web suite, typecheck, the Rust suite and the installer tests; commit `docs(skill): document catch-up briefs and life signals`.
