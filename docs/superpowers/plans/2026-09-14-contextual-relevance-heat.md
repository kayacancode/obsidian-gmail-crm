# Contextual relevance and theme heat implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add explainable theme heat, current relevance, connector treatments, bounded semantic retrieval, and opt-in public enrichment to the existing People relationship graph, then ship Obsidian Gmail CRM `0.9.2`.

**Architecture:** Keep the current relationship graph and introduction-path semantics intact. Produce deterministic baseline theme signals in the Obsidian plugin and Gmail Durable Object, persist owner-scoped feedback and derived assertions in that same per-owner Durable Object, and expose them through authenticated routes. The browser normalizes the versioned relevance payload and draws a removable Balanced heat overlay behind the existing nodes; Cloudflare Workers AI is used only for explicitly confirmed, bounded email-body or public-source extraction.

**Tech Stack:** TypeScript 5/6, Obsidian API, Cloudflare Workers, SQLite-backed Durable Objects, Workers AI JSON Mode, D1, browser-native ES modules, Node test runner, esbuild, Playwright, Wrangler.

**Spec:** `docs/superpowers/specs/2026-09-14-contextual-relevance-heat-design.md`

## Global constraints

- Preserve the current relationship viewer header, source selector, graph canvas, path finder, evidence panels, session trails, directory, responsive layout, `/spatial`, and `/classic.html`.
- The `Off` lens must produce the existing graph without heat; `My mind`, `Firm`, and `Public momentum` must enforce visibility on the server and again in the browser model.
- Relationship strength, relevance heat, and connector leverage remain distinct scores with distinct visual encodings.
- Gmail body retrieval is user-confirmed, defaults to 30 days, optionally supports 90 days, and is capped at 50 messages and 1 MB of decoded text per request.
- Raw email bodies, prompts containing bodies, OAuth tokens, and unsafe cross-tenant references must never enter Durable Object storage, D1, logs, API responses, or error strings.
- Theme associations and inferred co-occurrence never enter trusted introduction-path traversal.
- Public enrichment is opt-in per HTTP(S) URL or RSS/Atom feed and must reject credentials, private/reserved hosts, unsafe redirects, unsupported content, and oversized responses.
- Granola and Obsidian signals enter `0.9.2` only through local vault processing and the authenticated graph push; no server-side Granola OAuth or vault crawl is added.
- Use the Workers AI binding `AI` with JSON Mode model `@cf/meta/llama-3.3-70b-instruct-fp8-fast`; validate the returned value independently because JSON Mode does not guarantee schema compliance.
- Every stored assertion records source type, visibility, observed and ingested times, confidence, summary, opaque evidence reference, content hash, extractor version, and model identifier.
- All mutations require the verified owner session, exact same-origin validation, bounded JSON, and an idempotency key.
- Motion must respect `prefers-reduced-motion`; static opacity and border treatments must convey the same state.
- Use test-driven development and commit after each task passes its focused tests.

---

### Task 1: Versioned theme, relevance, and connector model

**Files:**
- Create: `apps/people-graph/src/relevance-model.ts`
- Create: `apps/people-graph/tests/relevance-model.test.ts`
- Modify: `apps/people-graph/tests/run-mail.mjs`

**Interfaces:**
- Produces: `Theme`, `ThemeSignal`, `RelevanceFeedback`, `RelevanceLens`, `RelevanceSnapshot`, `canonicalThemeName(value)`, `metadataThemeSignals(rows, owner, now)`, `scoreRelevance(signals, feedback, lens, now)`, `scoreConnectors(nodes, edges)`, and `rankSerendipity(input)`.
- Consumes: graph node ids are already opaque and graph edges already distinguish `personal`, `cooccurrence`, and `interpretation`.

- [ ] **Step 1: Write failing tests for normalization, visibility, time decay, feedback, and connector evidence classes**

```ts
test('scores recent explicit activity above an old subject hint and keeps lenses separate', () => {
  const snapshot = scoreRelevance([
    signal({id:'private',sourceType:'product_activity',visibility:'private',observedAt:iso(1),confidence:1}),
    signal({id:'public',sourceType:'public_feed',visibility:'public',observedAt:iso(40),confidence:1}),
  ], [], 'my', NOW);
  assert.equal(snapshot.themes[0].themeId, 'theme-agents');
  assert.ok(snapshot.themes[0].score > 50);
  assert.deepEqual(scoreRelevance([signal({id:'private',visibility:'private'})], [], 'public', NOW).themes, []);
});

test('mutes remove heat, pins add a visible floor, and corrections are append-only inputs', () => {
  assert.deepEqual(scoreRelevance([signal()], [feedback('mute')], 'my', NOW).themes, []);
  assert.ok(scoreRelevance([signal({confidence:.1})], [feedback('pin')], 'my', NOW).themes[0].score >= 65);
});

test('connector scoring never calls co-occurrence an introduction', () => {
  const scores = scoreConnectors(nodes, [edge('personal'), edge('cooccurrence')]);
  assert.equal(scores.get('bridge')?.evidenceClass, 'documented');
  assert.equal(scores.get('inferred')?.evidenceClass, 'inferred');
});

test('serendipity favors a relevant non-obvious person with a documented bridge', () => {
  const ranked = rankSerendipity({nodes, edges, relevance, selectedNodeIds:['obvious'], mutedNodeIds:[]});
  assert.equal(ranked[0].nodeId, 'adjacent');
  assert.match(ranked[0].reason, /Agent memory|documented bridge/);
  assert.ok(ranked.length <= 5);
});
```

- [ ] **Step 2: Run the focused test and verify the module is missing**

Run: `cd apps/people-graph && npm test`

Expected: FAIL because `../src/relevance-model` cannot be resolved.

- [ ] **Step 3: Implement strict types and deterministic scoring**

```ts
export type RelevanceLens = 'my' | 'firm' | 'public';
export type SignalVisibility = 'private' | 'firm' | 'public';
export type SignalSourceType = 'gmail_subject' | 'gmail_body_derived' | 'calendar' | 'granola' | 'obsidian_note' | 'product_activity' | 'public_url' | 'public_feed';

export interface Theme {
  id:string; owner:string; canonicalName:string; aliases:string[]; description:string;
  status:'active'|'muted'|'merged'; mergedInto?:string; createdAt:string; updatedAt:string;
}
export interface ThemeSignal {
  id:string; owner:string; personId?:string; themeId:string; sourceType:SignalSourceType;
  visibility:SignalVisibility; observedAt:string; ingestedAt:string; confidence:number;
  summary:string; evidenceRef:string; contentHash:string; extractorVersion:string; modelId?:string;
}
export interface RelevanceFeedback {
  id:string; owner:string; themeId:string; personId?:string; action:'pin'|'mute'|'correct'|'expire';
  replacementThemeId?:string; expiresAt?:string; createdAt:string;
}
export interface RelevanceSnapshot {
  version:1; lens:RelevanceLens; calculatedAt:string; scoreVersion:'relevance-v1';
  themes:Array<{themeId:string; name:string; score:number; reason:string; nodeIds:string[]; components:Array<{signalId:string; sourceType:SignalSourceType; observedAt:string; contribution:number}>}>;
  connectors:Array<{nodeId:string; score:number; evidenceClass:'documented'|'inferred'; documentedDegree:number; inferredDegree:number; sampledPathCount:number}>;
  discoveries:Array<{nodeId:string; score:number; reason:string; themeIds:string[]; pathNodeIds:string[]; freshness:string; relationshipUncertainty:string}>;
}

const CONFIG = Object.freeze({
  product_activity: {weight: 1.20, halfLifeDays: 7},
  calendar: {weight: 1.00, halfLifeDays: 30},
  granola: {weight: .95, halfLifeDays: 45},
  obsidian_note: {weight: .95, halfLifeDays: 45},
  gmail_body_derived: {weight: .90, halfLifeDays: 30},
  gmail_subject: {weight: .45, halfLifeDays: 14},
  public_url: {weight: .60, halfLifeDays: 21},
  public_feed: {weight: .60, halfLifeDays: 21},
});

export function contribution(signal: ThemeSignal, now: number): number {
  const config = CONFIG[signal.sourceType];
  const ageDays = Math.max(0, now - Date.parse(signal.observedAt)) / 86_400_000;
  return config.weight * signal.confidence * Math.exp(-ageDays / config.halfLifeDays);
}
```

Use a stopword list, Unicode-safe token normalization, 2–4 token phrases, and a minimum of two metadata occurrences before a subject-only candidate is emitted. Cap summaries at 240 characters, aliases at 20, signals at 5,000, themes at 200, and evidence refs at 500 characters. Normalize scores to 0–100 within the permitted lens, preserve unnormalized component values for explanation, apply a pin floor of 65, and remove muted or expired results.

For connectors, count documented unique neighbors separately from inferred neighbors and run deterministic sampled Brandes-style path participation across at most 64 evenly distributed person ids. Return `{nodeId, score, evidenceClass:'documented'|'inferred', documentedDegree, inferredDegree, sampledPathCount}` and never use a theme association as an edge.

`rankSerendipity` returns at most five candidates. Its versioned score combines current permitted relevance, graph distance two or three, documented connector-path quality, freshness, and diversity from already viewed people; it rejects muted people, permission conflicts, unresolved identity, and candidates visible only through inferred theme/co-occurrence links. Every result carries a short reason, active theme ids, documented path ids when present, freshness, and relationship uncertainty.

- [ ] **Step 4: Register the new test in the Worker test bundle and run it**

```js
// apps/people-graph/tests/run-mail.mjs
contents: "import './tests/mail.test.ts'; import './tests/relevance-model.test.ts'; import './tests/sync.test.ts'; import './tests/routes.test.ts';"
```

Run: `cd apps/people-graph && npm test && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit the pure domain model**

```bash
git add apps/people-graph/src/relevance-model.ts apps/people-graph/tests/relevance-model.test.ts apps/people-graph/tests/run-mail.mjs
git commit -m "feat: add explainable relevance scoring"
```

---

### Task 2: Local Obsidian and Granola-derived theme signals in graph pushes

**Files:**
- Create: `src/theme-candidates.ts`
- Create: `tests/theme-candidates.test.ts`
- Modify: `src/graph-push.ts:14-160`
- Modify: `src/main.ts:1010-1055`
- Modify: `scripts/test-intelligence.mjs`

**Interfaces:**
- Consumes: `PersonPage`, `Interaction`, `GraphContactInput`, and the vault-local graph salt.
- Produces: `LocalThemeCandidate`, `buildLocalThemeCandidates(pages, events, now)`, optional `GraphThemeInput[]` on `buildGraphPayload`, and versioned `themes`/`themeSignals` in `GraphPayload`.

- [ ] **Step 1: Write failing candidate and privacy tests**

```ts
test('extracts Key Themes and recent meeting titles with source provenance', () => {
  const signals = buildLocalThemeCandidates([
    page('ada@example.com', '## Key Themes\n- Agent memory\n- Developer tools', 'People/Ada.md'),
  ], [meeting('ada@example.com', 'Agent interfaces workshop', '2026-09-12')], NOW);
  assert.ok(signals.some((item) => item.canonicalName === 'Agent memory' && item.sourceType === 'obsidian_note'));
  assert.ok(signals.some((item) => item.sourceType === 'calendar'));
});

test('graph payload maps emails to opaque node ids and never pushes email or note body', async () => {
  const payload = await buildGraphPayload(contacts, edges, 'salt', candidates);
  assert.ok(payload.themeSignals.every((item) => !JSON.stringify(item).includes('@')));
  assert.ok(!JSON.stringify(payload).includes('PRIVATE NOTE BODY'));
});
```

- [ ] **Step 2: Run the intelligence test bundle and verify failure**

Run: `npm run test:intelligence`

Expected: FAIL because `theme-candidates.ts` and the fourth `buildGraphPayload` argument do not exist.

- [ ] **Step 3: Implement bounded local candidate extraction**

```ts
export interface LocalThemeCandidate {
  personEmail: string;
  canonicalName: string;
  aliases: string[];
  sourceType: 'calendar' | 'granola' | 'obsidian_note';
  visibility: 'private' | 'firm';
  observedAt: string;
  confidence: number;
  summary: string;
  evidenceRef: string;
  contentHash: string;
}
```

Read only frontmatter keys `themes`, `topics`, `working_on`, Markdown sections named `Key Themes`, `Themes`, `Working On`, `Decisions`, or `Action Items`, and recent `Interaction.kind === 'meeting'` titles. Treat pages whose source/frontmatter identifies Granola as `granola`; otherwise use `obsidian_note`. Default every candidate to `private`; accept `relationship_visibility: firm` only as an explicit per-note frontmatter choice and never infer firm visibility from a folder or author. Strip Markdown, cap each phrase at 80 characters, keep at most 12 candidates per person, hash the bounded source fragment locally, and push only the compact summary plus an `obsidian:` safe reference—not the full note body or email.

- [ ] **Step 4: Extend the graph payload without breaking older callers**

```ts
export interface GraphPayload {
  pushedAt: string;
  nodes: GraphNodeOut[];
  edges: GraphEdgeOut[];
  relevanceVersion: 1;
  themes: GraphThemeOut[];
  themeSignals: GraphThemeSignalOut[];
}

export async function buildGraphPayload(
  contacts: GraphContactInput[],
  edges: ContactEdge[],
  salt: string,
  themeInputs: GraphThemeInput[] = [],
): Promise<GraphPayload>;
```

Define the graph-push boundary explicitly:

```ts
export interface GraphThemeInput extends LocalThemeCandidate {}
export interface GraphThemeOut { id:string; canonicalName:string; aliases:string[]; description:string; status:'active' }
export interface GraphThemeSignalOut {
  id:string; personId:string; themeId:string; sourceType:'calendar'|'granola'|'obsidian_note';
  visibility:'private'|'firm'; observedAt:string; ingestedAt:string; confidence:number;
  summary:string; evidenceRef:string; contentHash:string; extractorVersion:'local-theme-v1';
}
```

Map `personEmail` through the same `idFor()` function used by graph nodes, discard signals for pruned people, merge canonical theme names, and include theme data in the existing byte-budget loop. Reduce per-person theme candidates before reducing the graph node cap so the graph remains useful.

- [ ] **Step 5: Wire local intelligence into the existing push command**

In `pushPeopleGraph()`, call `loadIntelligenceWorkspace(false)`, pass its events plus loaded `PersonPage` values to `buildLocalThemeCandidates`, and pass the candidates to `buildGraphPayload`. If the intelligence file is unavailable, push nodes and edges with empty theme arrays rather than failing the graph push. Update the success notice with the number of themes.

- [ ] **Step 6: Run plugin tests and build**

Change `scripts/test-intelligence.mjs` from `entryPoints` to an esbuild `stdin` bundle so both suites execute:

```js
stdin: {
  contents: "import './tests/intelligence.test.ts'; import './tests/theme-candidates.test.ts';",
  resolveDir: process.cwd(),
},
```

Run: `npm run test:intelligence && npm run build`

Expected: PASS; `main.js` builds and serialized payload tests contain no raw emails or note bodies.

- [ ] **Step 7: Commit local theme generation**

```bash
git add src/theme-candidates.ts src/graph-push.ts src/main.ts tests/theme-candidates.test.ts scripts/test-intelligence.mjs
git commit -m "feat: push private vault theme signals"
```

---

### Task 3: Durable Object theme store, feedback, and Gmail metadata baseline

**Files:**
- Create: `apps/people-graph/src/relevance-store.ts`
- Create: `apps/people-graph/tests/relevance-store.test.ts`
- Modify: `apps/people-graph/src/mail-sync.ts:3-46`
- Modify: `apps/people-graph/tests/sync.test.ts`
- Modify: `apps/people-graph/tests/run-mail.mjs`

**Interfaces:**
- Consumes: `ThemeSignal`, `RelevanceFeedback`, `metadataThemeSignals`, `scoreRelevance`, `scoreConnectors`, current `contributions`, `mail_edges`, `accounts`, and opaque owner ids.
- Produces: `RelevanceStore.ingest()`, `snapshot()`, `evidence()`, `recordFeedback()`, `removeAccountData()`, `nextAlarmAt()`, and `MailSync.relevance()` RPC methods.

- [ ] **Step 1: Write failing storage isolation and baseline tests**

```ts
test('metadata baseline derives repeated recent subject themes without bodies', async () => {
  seedContribution(db, {account:'me@example.com', email:'ada@example.com', subject:'Agent memory review'});
  seedContribution(db, {account:'me@example.com', email:'ada@example.com', subject:'Agent memory roadmap'});
  const graph = await service.graph();
  assert.ok(graph.relevance.themes.some((theme) => theme.name === 'Agent memory'));
});

test('feedback is owner-local and disconnect removes account-owned derived assertions', async () => {
  await service.recordRelevanceFeedback({themeId:'agent-memory',action:'mute',createdAt:NOW});
  assert.deepEqual((await service.relevance('my')).themes, []);
  await service.remove('me@example.com');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM theme_signals WHERE account='me@example.com'").get().n, 0);
});
```

- [ ] **Step 2: Run Worker tests and verify storage APIs are missing**

Run: `cd apps/people-graph && npm test`

Expected: FAIL on `recordRelevanceFeedback` or missing `relevance` data.

- [ ] **Step 3: Add idempotent SQLite schema and transactional persistence**

Create tables `themes`, `theme_signals`, `relevance_feedback`, `retrieval_jobs`, and `public_sources` from the spec. Use primary keys `(id)`, indexes on `(theme_id, observed_at)`, `(person_id, observed_at)`, and `(visibility, observed_at)`, and unique idempotency keys scoped to the owner Durable Object. Initialize them synchronously in the existing constructor and wrap related SQL writes in `transactionSync()`.

```ts
export class RelevanceStore {
  constructor(private ctx: DurableObjectState, private owner: () => Promise<string | undefined>) {}
  ingest(signals: ThemeSignal[]): {themes:number; signals:number};
  snapshot(lens: RelevanceLens, now?:number): RelevanceSnapshot;
  evidence(themeId:string, lens:RelevanceLens): ThemeEvidence;
  recordFeedback(input:RelevanceFeedbackInput): RelevanceFeedback;
  removeAccountData(account:string): void;
}
```

- [ ] **Step 4: Derive and ingest Gmail subject candidates after metadata batches**

Query bounded contribution rows from the latest 90 days, group by contact email, map emails to owner-opaque node ids, and call `metadataThemeSignals`. Store only subject-derived compact summaries and keyed content hashes; do not add message bodies. Rebuild the returned relevance snapshot after each completed metadata sync and attach `themes`, `themeSignals`, `relevance`, and `connectors` to `MailSync.graph()`.

- [ ] **Step 5: Preserve the one-alarm invariant**

Replace the current mail-only rescheduling branch with one `scheduleNextAlarm()` method that chooses the earliest due mail sync or relevance job and calls `setAlarm()` once. Do not schedule idle per-owner wakeups. Keep generation fences so a disconnect or newer sync cannot be overwritten by stale work.

- [ ] **Step 6: Run storage, sync, and type tests**

Add `import './tests/relevance-store.test.ts';` to the esbuild stdin string in `tests/run-mail.mjs` before running the suite.

Run: `cd apps/people-graph && npm test && npm run typecheck`

Expected: PASS; existing OAuth, contact photo, sync, deduplication, and disconnect tests remain green.

- [ ] **Step 7: Commit the owner-scoped relevance store**

```bash
git add apps/people-graph/src/relevance-store.ts apps/people-graph/src/mail-sync.ts apps/people-graph/tests/relevance-store.test.ts apps/people-graph/tests/sync.test.ts apps/people-graph/tests/run-mail.mjs
git commit -m "feat: persist owner scoped relevance signals"
```

---

### Task 4: Explicit bounded Gmail-body retrieval with Workers AI

**Files:**
- Create: `apps/people-graph/src/theme-extractor.ts`
- Create: `apps/people-graph/src/gmail-body.ts`
- Create: `apps/people-graph/tests/theme-extractor.test.ts`
- Create: `apps/people-graph/tests/gmail-body.test.ts`
- Modify: `apps/people-graph/src/relevance-store.ts`
- Modify: `apps/people-graph/src/mail-sync.ts`
- Modify: `apps/people-graph/src/mail-model.ts`
- Modify: `apps/people-graph/tests/sync.test.ts`
- Modify: `apps/people-graph/tests/worker-stub.ts`
- Modify: `apps/people-graph/tests/run-mail.mjs`
- Modify: `apps/people-graph/wrangler.jsonc`
- Create: `apps/people-graph/worker-configuration.d.ts`

**Interfaces:**
- Consumes: authenticated connected Gmail accounts, refresh grants, `AI` binding, `THEME_MODEL`, selected account, person/theme scope, and 30/90-day window.
- Produces: `ThemeExtractor.extract(input)`, `decodeGmailMessage(message, remainingBytes)`, `MailSync.previewRetrieval()`, `confirmRetrieval()`, `retrievalStatus()`, and alarm-driven retrieval batches.

- [ ] **Step 1: Write failing MIME, cap, schema, and no-retention tests**

```ts
test('decodes text/plain, strips quoted history and signatures, and respects remaining bytes', () => {
  const decoded = decodeGmailMessage(mimeFixture, 1024);
  assert.match(decoded.text, /current answer/);
  assert.doesNotMatch(decoded.text, /On .* wrote:|tracking pixel|old quoted message/);
  assert.ok(decoded.bytes <= 1024);
});

test('rejects malformed or identity-changing model output', async () => {
  const extractor = new ThemeExtractor(fakeAI({response:'{"themes":[{"name":"","confidence":4}]}'}), MODEL);
  await assert.rejects(extractor.extract(input), /invalid_extraction/);
});

test('confirmed retrieval persists assertions but never decoded bodies', async () => {
  await service.confirmRetrieval(confirmInput);
  await service.alarm();
  assert.equal(allStorageText(db, kv).includes('SECRET BODY SENTENCE'), false);
  assert.equal(allStorageText(db, kv).includes('Agent memory collaboration'), true);
});
```

- [ ] **Step 2: Run Worker tests and verify failure**

Run: `cd apps/people-graph && npm test`

Expected: FAIL because the extractor, decoder, and retrieval methods do not exist.

- [ ] **Step 3: Implement the strict extractor adapter**

```ts
const THEME_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['themes'],
  properties: {
    themes: {type:'array', maxItems:12, items:{
      type:'object', additionalProperties:false,
      required:['name','summary','confidence'],
      properties:{
        name:{type:'string',minLength:2,maxLength:80},
        summary:{type:'string',minLength:2,maxLength:240},
        confidence:{type:'number',minimum:0,maximum:1},
      },
    }},
  },
} as const;
```

Call `env.AI.run(env.THEME_MODEL, {messages, response_format:{type:'json_schema',json_schema:THEME_SCHEMA}})`, normalize both object and string response shapes, and validate every field without trusting the model. The prompt must request themes/current work only from supplied text, forbid identity/employment inference, and forbid returning quotes or raw message text. Return `invalid_extraction` for any schema failure; never include model output in the error.

- [ ] **Step 4: Implement bounded MIME decoding**

Support nested `multipart/*`, prefer `text/plain`, sanitize `text/html` to text, decode base64url incrementally, omit attachments, remove quote blocks, common signature tails, script/style content, and tracking markup. Stop before the caller's remaining byte budget. Return only `{text, bytes, internalDate, messageId}` in memory.

- [ ] **Step 5: Implement preview, confirm, and alarm batches**

`previewRetrieval` validates the selected account, maps an opaque person id to its contact email inside the owner object, and returns scope/window/caps without listing or fetching Gmail messages. `confirmRetrieval` requires the preview fingerprint plus idempotency key, stores a queued job containing only scope identifiers and counters, and schedules the shared alarm.

Each alarm batch refreshes one account token, lists matching Gmail ids only when the job has no pending ids, processes at most 10 messages in parallel, stops at 50 messages or 1 MB total decoded text, calls the extractor once for that in-memory batch, persists only validated assertions and counters transactionally, releases all decoded strings before returning, and reschedules unfinished work. Job errors use the safe allowlist `reconnect_required`, `gmail_access_denied`, `ai_unavailable`, `invalid_extraction`, or `retrieval_failed`.

- [ ] **Step 6: Configure the binding and model**

```jsonc
"ai": { "binding": "AI" },
"vars": {
  "APP_ORIGIN": "https://people-graph.kayarjones901.workers.dev",
  "GOOGLE_CLIENT_ID": "726397126192-d5esd42caksfb95hcoh12vpuji8kv008.apps.googleusercontent.com",
  "THEME_MODEL": "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
}
```

Generate `worker-configuration.d.ts` with `npx wrangler types`, consume the generated `Env` binding shape rather than adding a second hand-written AI interface, and extend the Node Worker stub with a fake AI binding used only by tests.

- [ ] **Step 7: Run focused security and type tests**

Add `import './tests/theme-extractor.test.ts'; import './tests/gmail-body.test.ts';` to the esbuild stdin string in `tests/run-mail.mjs` before running the suite.

Run: `cd apps/people-graph && npm test && npm run typecheck`

Expected: PASS; a recursive storage scan confirms raw fixture text is absent.

- [ ] **Step 8: Commit bounded semantic retrieval**

```bash
git add apps/people-graph/src/theme-extractor.ts apps/people-graph/src/gmail-body.ts apps/people-graph/src/relevance-store.ts apps/people-graph/src/mail-sync.ts apps/people-graph/src/mail-model.ts apps/people-graph/tests/theme-extractor.test.ts apps/people-graph/tests/gmail-body.test.ts apps/people-graph/tests/sync.test.ts apps/people-graph/tests/worker-stub.ts apps/people-graph/tests/run-mail.mjs apps/people-graph/wrangler.jsonc apps/people-graph/worker-configuration.d.ts
git commit -m "feat: add bounded semantic mail retrieval"
```

---

### Task 5: Guarded public URL and feed enrichment

**Files:**
- Create: `apps/people-graph/src/public-sources.ts`
- Create: `apps/people-graph/tests/public-sources.test.ts`
- Modify: `apps/people-graph/src/relevance-store.ts`
- Modify: `apps/people-graph/src/mail-sync.ts`
- Modify: `apps/people-graph/tests/run-mail.mjs`

**Interfaces:**
- Consumes: explicit URL, optional opaque person id, owner Durable Object, `ThemeExtractor`, and the shared alarm scheduler.
- Produces: `previewPublicSource(url)`, `confirmPublicSource(input)`, conditional fetch checkpoints, and public-only `ThemeSignal`s.

- [ ] **Step 1: Write failing URL, redirect, size, and visibility tests**

```ts
for (const url of ['http://127.0.0.1/x','http://[::1]/x','http://169.254.169.254/x','https://user:pass@example.com/x','file:///tmp/x']) {
  test(`rejects unsafe source ${url}`, async () => assert.rejects(previewPublicSource(url), /unsafe_public_source/));
}

test('follows at most three safe redirects and stores public-only assertions', async () => {
  const result = await fetchPublicSource('https://example.com/feed.xml', fixtureFetch);
  assert.ok(result.textBytes <= 1_000_000);
  assert.equal(result.visibility, 'public');
  assert.equal(result.canonicalUrl, 'https://example.com/feed.xml');
});
```

- [ ] **Step 2: Run Worker tests and verify failure**

Run: `cd apps/people-graph && npm test`

Expected: FAIL because `public-sources.ts` does not exist.

- [ ] **Step 3: Implement strict preview and bounded retrieval**

Accept only credential-free `http:` and `https:` URLs with public DNS hostnames. Reject localhost, `.local`, IP literals in private, loopback, link-local, multicast, documentation, benchmark, and reserved ranges. Use `redirect:'manual'`, revalidate each of at most three redirect targets, allow HTML, plain text, RSS, and Atom content types, stream at most 1 MB, and use a 20-second timeout. Parse feed item title/summary/date/link or strip HTML to bounded visible text.

Persist canonical URL, publisher host, trustworthy publication time or observed time, retrieved time, ETag, Last-Modified, content hash, status, and last safe error. Use `If-None-Match`/`If-Modified-Since` on refresh. A failed refresh keeps the previous successful signals and marks their age.

- [ ] **Step 4: Extract and persist public-only assertions**

Send bounded text through `ThemeExtractor`, force `visibility:'public'` regardless of request input, associate the optional person id only after verifying it exists in the owner graph, and key idempotency by owner/source/content hash/extractor version. Never copy a public assertion into a private or firm signal.

- [ ] **Step 5: Run tests and commit**

Add `import './tests/public-sources.test.ts';` to the esbuild stdin string in `tests/run-mail.mjs` before running the suite.

Run: `cd apps/people-graph && npm test && npm run typecheck`

```bash
git add apps/people-graph/src/public-sources.ts apps/people-graph/src/relevance-store.ts apps/people-graph/src/mail-sync.ts apps/people-graph/tests/public-sources.test.ts apps/people-graph/tests/run-mail.mjs
git commit -m "feat: add opt in public theme sources"
```

---

### Task 6: Authenticated relevance routes and backward-compatible graph payloads

**Files:**
- Create: `apps/people-graph/src/relevance-routes.ts`
- Create: `apps/people-graph/tests/relevance-routes.test.ts`
- Modify: `apps/people-graph/src/index.ts:1-96`
- Modify: `apps/people-graph/tests/routes.test.ts`
- Modify: `apps/people-graph/tests/run-mail.mjs`

**Interfaces:**
- Consumes: verified owner email from `requireGoogleUser`, the owner `MAIL` stub, same-origin request, and idempotency header.
- Produces: the eight routes in the spec plus additive relevance fields on `/api/graph`.

- [ ] **Step 1: Write failing authorization, origin, preview, and tenant tests**

```ts
test('preview is read-only and confirm requires same origin plus idempotency', async () => {
  assert.equal((await relevanceRoute(post('/api/retrieval/preview', preview), env, OWNER)).status, 200);
  assert.equal(stub.calls.confirm.length, 0);
  assert.equal((await relevanceRoute(post('/api/retrieval/confirm', confirm, 'https://evil.test'), env, OWNER)).status, 403);
  assert.equal((await relevanceRoute(post('/api/retrieval/confirm', confirm, ORIGIN), env, OWNER)).status, 400);
});

test('another authenticated owner is routed to a different Durable Object', async () => {
  await relevanceRoute(get('/api/relevance?lens=my'), env, 'alice@example.test');
  await relevanceRoute(get('/api/relevance?lens=my'), env, 'bob@example.test');
  assert.deepEqual(env.names, ['alice@example.test','bob@example.test']);
});
```

- [ ] **Step 2: Run route tests and verify 404/missing module failures**

Run: `cd apps/people-graph && npm test`

Expected: FAIL because the relevance router is missing.

- [ ] **Step 3: Implement bounded route parsing**

Add:

```text
GET  /api/relevance?lens=my|firm|public
GET  /api/themes/:id/evidence?lens=my|firm|public
POST /api/retrieval/preview
POST /api/retrieval/confirm
GET  /api/retrieval/:id
POST /api/themes/:id/feedback
POST /api/public-sources/preview
POST /api/public-sources/confirm
```

Read at most 16 KB JSON; reject unknown fields, invalid ids, invalid lenses, non-30/90 windows, summaries over limits, and invalid actions. Require `Origin === request URL origin` and `Idempotency-Key` of 16–128 visible ASCII characters for every mutation. Return no-store JSON and safe error codes only.

- [ ] **Step 4: Route through the existing authenticated Worker entrypoint**

Move `requireGoogleUser` to an exported `auth.ts` helper or export it from `index.ts` without weakening current session behavior. Resolve the user before calling `relevanceRoute`; pass only `user.email`. Keep `/api/push`, `/api/graph`, account OAuth, and static assets unchanged.

When a pushed Obsidian graph is selected, normalize additive `themes` and `themeSignals` from its JSON, apply owner feedback through the owner Durable Object, and attach the filtered relevance snapshot. Older graph blobs without those arrays receive empty arrays. Gmail-generated graphs continue to source baseline and derived signals from the owner object.

- [ ] **Step 5: Run all Worker tests and typecheck**

Run: `cd apps/people-graph && npm test && npm run typecheck`

Expected: PASS; cross-owner, origin, body-size, idempotency, method, and old-payload compatibility cases are green.

- [ ] **Step 6: Commit the API surface**

```bash
git add apps/people-graph/src/relevance-routes.ts apps/people-graph/src/index.ts apps/people-graph/tests/relevance-routes.test.ts apps/people-graph/tests/routes.test.ts apps/people-graph/tests/run-mail.mjs
git commit -m "feat: expose authenticated relevance workflows"
```

---

### Task 7: Browser normalization, theme-aware search, and trusted connector data

**Files:**
- Modify: `apps/people-graph/public/relationship-graph/model.mjs`
- Create: `apps/people-graph/public/relationship-graph/relevance.mjs`
- Create: `apps/people-graph/tests/relevance-browser-model.test.mjs`
- Modify: `apps/people-graph/package.json`

**Interfaces:**
- Consumes: additive graph `themes`, `themeSignals`, `relevance`, and `connectors` fields.
- Produces: normalized safe records, `filterRelevance(graph, lens)`, `themeFields(graph, visibleNodes, lens)`, and theme-aware `searchGraph` results.

- [ ] **Step 1: Write failing normalization and search tests**

```js
test('normalizes themes without allowing them to become relationship edges', () => {
  const graph = normalizeGraph(rawGraphWithThemes);
  assert.equal(graph.themes[0].name, 'Agent memory');
  assert.equal(graph.edges.length, 1);
  assert.equal(findPaths(graph, 'ada', 'bo').paths.length, 0);
});

test('search finds a person through a visible theme but not a hidden signal', () => {
  const graph = normalizeGraph(rawGraphWithPrivateAndPublicThemes);
  assert.deepEqual(searchGraph(filterRelevance(graph, 'public'), 'private thesis'), []);
  assert.equal(searchGraph(filterRelevance(graph, 'my'), 'agent memory')[0].id, 'ada');
});
```

- [ ] **Step 2: Run browser model tests and verify failure**

Run: `cd apps/people-graph && node --test tests/relevance-browser-model.test.mjs`

Expected: FAIL because `relevance.mjs` and normalized theme fields do not exist.

- [ ] **Step 3: Add strict additive normalization**

Validate ids, enum values, safe source URLs, timestamps, confidence/score range 0–100 or 0–1 as appropriate, and maximum lengths. Preserve existing graph normalization for old payloads by defaulting relevance collections to empty arrays. Preserve `weight` and recognized `types` on normalized relationship edges so connector evidence remains inspectable.

`filterRelevance` is a defense-in-depth filter: `my` accepts all records already returned for the owner; `firm` accepts only firm; `public` accepts only public. `themeFields` returns stable positions derived from theme ids and member node positions without mutating node positions.

- [ ] **Step 4: Add the test to the default browser-model test command**

```json
"test": "node --test tests/model.test.mjs tests/lab.test.mjs tests/relationship-host.test.mjs tests/relevance-browser-model.test.mjs && node tests/run-mail.mjs"
```

- [ ] **Step 5: Run tests and commit**

Run: `cd apps/people-graph && npm test`

```bash
git add apps/people-graph/public/relationship-graph/model.mjs apps/people-graph/public/relationship-graph/relevance.mjs apps/people-graph/tests/relevance-browser-model.test.mjs apps/people-graph/package.json
git commit -m "feat: normalize relevance graph data"
```

---

### Task 8: Balanced heat overlay and why-now interaction on the existing layout

**Files:**
- Modify: `apps/people-graph/public/relationship-graph/graph.mjs:39-773`
- Modify: `apps/people-graph/public/relationship-graph/graph.css:1-797`
- Modify: `apps/people-graph/tests/relationship-browser.mjs`

**Interfaces:**
- Consumes: `themeFields`, normalized relevance snapshot, connector scores, and callbacks supplied by the host.
- Produces: My/Firm/Public/Off lens controls, non-interactive background fields, node pulses, solid/dashed connector rings, why-now panel, correction controls, and `setRelevance()`.

- [ ] **Step 1: Extend the browser fixture and write failing UI assertions**

Add two overlapping themes, private/public evidence, one documented connector, one inferred connector, one non-obvious adjacent discovery, and assertions that:

```js
await page.getByLabel('Relevance now').selectOption('my');
assert.equal(await page.locator('.rg-theme-field').count(), 2);
assert.equal(await page.locator('.rg-node[data-hot="true"]').count(), 3);
assert.equal(await page.locator('.rg-node[data-connector="documented"]').count(), 1);
await page.getByRole('button', {name:/Why Agent memory is hot now/}).click();
assert.match(await page.getByLabel('Why this is hot now').innerText(), /PRIVATE EVIDENCE/);
assert.match(await page.getByLabel('Adjacent discoveries').innerText(), /why now|documented bridge/i);
await page.getByLabel('Relevance now').selectOption('off');
assert.equal(await page.locator('.rg-theme-field').count(), 0);
```

- [ ] **Step 2: Run the relationship browser test against the local Worker and verify failure**

Run one terminal with `cd apps/people-graph && npx wrangler dev --port 4183`; in another run `cd apps/people-graph && npm run test:relationship-browser`.

Expected: FAIL because the lens and heat elements are absent.

- [ ] **Step 3: Render the removable overlay without moving nodes**

Add `let lens = options.lens ?? 'my'` and render a compact `Relevance now` select in the current header. In `renderCanvas()`, calculate existing node positions first, then insert `rg-theme-fields` before the SVG relationship layer. Each field receives a stable center/radius derived from its visible member positions and an accessible button label; it never captures drag events outside its label.

Set node datasets `data-hot`, `data-heat-level`, and `data-connector`. Relevance uses a soft pulse/halo; documented connectors use a solid outer ring; inferred connectors use a dashed ring. Preserve active, related, context, path, and photo states. The `Off` branch must skip every relevance class and produce the pre-feature DOM structure except for the lens control.

- [ ] **Step 4: Add why-now and correction UI**

The panel groups evidence under Private, Firm, and Public headings, shows source type, observed date, confidence, summary, and safe reference/link, and includes Pin, Mute, Correct, Expire, and Retrieve more context actions. A compact `Adjacent discoveries` section shows at most five ranked people, the active theme, unexpected documented bridge when available, evidence freshness, and relationship uncertainty; selecting one uses the existing node/trail behavior. Disable mutation actions while their promise is pending, announce success/failure through an `aria-live` status, and leave the prior snapshot visible on failure.

Extend callbacks:

```js
onLensChange(lens)
onThemeFeedback({themeId, personId, action, replacementThemeId, expiresAt})
onRetrievePreview({themeId, personId})
onOpenPublicSource({themeId, personId})
```

Add `setRelevance(snapshot, lens)` to update heat without resetting selection, camera, trail, or path state. Guard asynchronous callbacks with a request generation so a stale response cannot replace a newer lens or selection.

- [ ] **Step 5: Add restrained visual tokens and accessibility fallbacks**

Use the existing palette and typography. Add low-opacity radial fields, a maximum of three visual heat levels, and no new card grid. Under `prefers-reduced-motion: reduce`, remove pulse animation and retain border/opacity. Under print styles, render static field outlines and labels. At 320 px, keep the lens in the header flow and the panel within viewport width.

- [ ] **Step 6: Run browser and unit tests**

Run: `cd apps/people-graph && npm test && npm run test:relationship-browser`

Expected: PASS; screenshots confirm the existing layout remains recognizable and `Off` removes all heat.

- [ ] **Step 7: Commit the heat overlay**

```bash
git add apps/people-graph/public/relationship-graph/graph.mjs apps/people-graph/public/relationship-graph/graph.css apps/people-graph/tests/relationship-browser.mjs
git commit -m "feat: layer balanced relevance heat on graph"
```

---

### Task 9: Host workflows for lenses, retrieval, feedback, and public sources

**Files:**
- Modify: `apps/people-graph/public/relationship-host.mjs:1-357`
- Modify: `apps/people-graph/public/index.html:1-5`
- Modify: `apps/people-graph/public/relationship-host.css`
- Modify: `apps/people-graph/tests/relationship-host.test.mjs`
- Modify: `apps/people-graph/tests/relationship-browser.mjs`

**Interfaces:**
- Consumes: authenticated relevance endpoints and graph callbacks from Task 8.
- Produces: abortable `loadRelevance(lens)`, `previewRetrieval(scope)`, `confirmRetrieval(preview, windowDays)`, `pollRetrieval(jobId)`, `submitFeedback(input)`, `previewPublicSource(input)`, and `confirmPublicSource(preview)` controller methods.

- [ ] **Step 1: Write failing controller tests for cancellation, account changes, and preview/confirm separation**

```js
test('changing lens aborts stale relevance and cannot replace the current lens', async () => {
  const my = deferredResponse();
  const controller = signedInController((path) => path.includes('lens=my') ? my.promise : json(publicSnapshot));
  const stale = controller.loadRelevance('my');
  await controller.loadRelevance('public');
  my.resolve(json(privateSnapshot));
  await stale;
  assert.equal(controller.getState().lens, 'public');
  assert.deepEqual(controller.getState().relevance, publicSnapshot);
});

test('retrieval preview performs no confirm and confirm sends idempotency once', async () => {
  const preview = await controller.previewRetrieval({personId:'ada'});
  assert.deepEqual(calls.map((call) => call.path), ['/api/retrieval/preview']);
  await controller.confirmRetrieval(preview, 30);
  assert.equal(calls[1].headers['Idempotency-Key'].length >= 16, true);
});
```

- [ ] **Step 2: Run host tests and verify missing methods**

Run: `cd apps/people-graph && node --test tests/relationship-host.test.mjs`

Expected: FAIL because the relevance workflow methods do not exist.

- [ ] **Step 3: Implement account-bound abortable workflows**

Add a separate `relevanceGeneration` and `AbortController`. Clear relevance, pending previews, job ids, and evidence on sign-out or account change. Preserve relationship graph data when a relevance request fails. Generate idempotency keys with `crypto.randomUUID()` and reuse the same key only when retrying that logical confirm.

Poll active retrieval jobs at 1, 2, 4, 8, then 15-second intervals, stopping on completion, failure, abort, account switch, or five minutes. Refresh relevance once on completion. Do not persist private relevance or jobs to localStorage.

- [ ] **Step 4: Wire confirmation dialogs into the graph without changing the page shell**

The retrieval dialog must show account, selected person/theme, 30-day default, 90-day option, 50-message cap, 1 MB cap, and the statement that bodies are analyzed ephemerally and not retained. The public source dialog must show canonical URL, content type when known, visibility `Public`, and require confirm before source creation. Native `<dialog>` is acceptable with an accessible fallback section when unavailable.

- [ ] **Step 5: Exercise the full browser workflow**

Mock the relevance, preview, confirm, status, evidence, feedback, and public-source routes in `relationship-browser.mjs`. Assert lens switching, why-now, pin/mute/correct/expire, retrieve preview before confirm, progress completion, public-source provenance, account switch cleanup, session expiry cleanup, mobile width, keyboard escape, reduced motion, and absence of browser console errors.

- [ ] **Step 6: Run host and browser suites and commit**

Run: `cd apps/people-graph && npm test && npm run test:relationship-browser`

```bash
git add apps/people-graph/public/relationship-host.mjs apps/people-graph/public/index.html apps/people-graph/public/relationship-host.css apps/people-graph/tests/relationship-host.test.mjs apps/people-graph/tests/relationship-browser.mjs
git commit -m "feat: connect relevance interactions"
```

---

### Task 10: Regression, privacy, scale, and live acceptance

**Files:**
- Create: `apps/people-graph/tests/relevance-security.test.ts`
- Modify: `apps/people-graph/tests/all-people-browser.mjs`
- Modify: `apps/people-graph/tests/run-mail.mjs`
- Modify: `apps/people-graph/scripts/smoke.sh`
- Modify: `apps/people-graph/README.md`
- Modify: `PRIVACY.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: the complete plugin, Worker, API, and browser implementation.
- Produces: repeatable release gates and documented data-handling behavior.

- [ ] **Step 1: Add adversarial privacy tests**

Cover cross-tenant ids, hidden visibility, stale generation writes, duplicated idempotency, prompt injection inside email/public text, malformed model JSON, body text in thrown errors, source refs containing another owner, HTML/script URLs, oversized gzip/stream responses, unsafe redirects, MIME bombs, and account disconnect during an active job. Scan SQL rows, KV values, JSON responses, and captured logs for raw fixture bodies and OAuth tokens.

Add `import './tests/relevance-security.test.ts';` to the esbuild stdin string in `tests/run-mail.mjs` so the default Worker test command runs the adversarial suite.

- [ ] **Step 2: Extend the 1,500-person browser fixture**

Generate 120 themes and 5,000 signals, confirm the canvas still bounds visible nodes to 80, search/directory still reaches all 1,500 people, heat renders only for visible nodes, selection remains responsive, and `Off` avoids theme-field work. Record elapsed render time as diagnostic output without making a brittle timing assertion.

- [ ] **Step 3: Update smoke checks**

Assert `/`, `/spatial.html`, `/classic.html`, `/accounts.html`, static modules, and unauthenticated API gates. Verify `GET /api/relevance` returns 401 without a session and confirm endpoints reject missing Origin/Idempotency-Key before touching a Durable Object mutation.

- [ ] **Step 4: Document the exact privacy and product behavior**

State that metadata heat is advisory; deeper body retrieval is explicit and capped; raw bodies are not retained; Granola/Obsidian stay local until push; public/private/firm evidence remains separated; connector rings do not prove willingness; and the system never sends outreach or introduction requests.

- [ ] **Step 5: Run every automated gate**

```bash
npm run test:intelligence
npm run build
cd apps/people-graph
npm test
npm run typecheck
npm run build:district
```

Start `npx wrangler dev --port 4183`, then run:

```bash
npm run test:relationship-browser
npm run test:accounts-browser
npm run test:lab-browser
npm run test:studio-browser
npm run test:district-browser
npm run test:building-browser
npm run test:figures-browser
npm run test:world-browser
npm run test:all-people-browser
```

Expected: every command passes with no browser console errors.

- [ ] **Step 6: Review Worker platform conformance**

Run `npx wrangler types`, inspect the generated binding types, validate `wrangler.jsonc` against the installed schema, confirm every promise is awaited/returned/voided, confirm all fetches have timeouts and bounded reads, confirm no request state is module-global, and confirm only one owner-specific alarm is scheduled at a time.

- [ ] **Step 7: Commit tests and documentation**

```bash
git add apps/people-graph/tests/relevance-security.test.ts apps/people-graph/tests/all-people-browser.mjs apps/people-graph/tests/run-mail.mjs apps/people-graph/scripts/smoke.sh apps/people-graph/README.md PRIVACY.md README.md
git commit -m "test: verify relevance privacy and scale"
```

---

### Task 11: Version, deploy, push, tag, and publish `0.9.2`

**Release sequencing update (2026-09-14, explicit user request):** Publish the plugin update first. The remaining production body-retrieval, public-feed provenance, and second-tenant checks are deferred follow-up work, not prerequisites for this plugin publication and not represented as passed. Do not start email-body analysis without the separate requested consent. Keep the completed automated gates and completed production checks in the release notes.

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `manifest.json`
- Modify: `versions.json`
- Create: `docs/releases/0.9.2.md`
- Generated and verified: `main.js`

**Interfaces:**
- Consumes: all passing release gates, configured Cloudflare bindings/secrets, and the verified release commit.
- Produces: deployed People Graph Worker, pushed feature branch, integrated `main`, annotated `0.9.2` tag, and GitHub release assets.

- [ ] **Step 1: Write release notes and update all version metadata to `0.9.2`**

Set `package.json`, lockfile root package version, and `manifest.json` to `0.9.2`; add `"0.9.2": "1.0.0"` to `versions.json`. Release notes must explicitly describe Balanced theme heat, why-now evidence, connector rings, local Granola/Obsidian signals, bounded email retrieval, public-source opt-in, privacy boundaries, and the fact that no action is sent automatically.

- [ ] **Step 2: Build and checksum release assets**

Run:

```bash
npm ci
npm run test:intelligence
npm run build
shasum -a 256 main.js manifest.json styles.css
```

Record the three checksums in `docs/releases/0.9.2.md` after the final build.

- [ ] **Step 3: Deploy the Worker and retain rollback information**

From `apps/people-graph`, run `npm ci`, all Worker tests, `npm run typecheck`, `npx wrangler deploy --dry-run`, then `npx wrangler deploy`. Record the deployment id and previous deployment id in the local release notes. Do not print secret values.

- [ ] **Step 4: Perform live authenticated acceptance**

Sign in with one real account, confirm metadata heat, contact photo rendering, Off-lens parity, one 30-day explicit retrieval, absence of raw body persistence through the available diagnostics, one safe public feed, source provenance, `/spatial`, and `/classic.html`. Sign in as or use a second test tenant and confirm it cannot see the first tenant's themes, signals, jobs, or evidence. Roll back instead of tagging if any live gate fails.

- [ ] **Step 5: Commit the verified release build**

```bash
git add package.json package-lock.json manifest.json versions.json main.js styles.css docs/releases/0.9.2.md
git commit -m "release: prepare 0.9.2"
```

- [ ] **Step 6: Push and integrate without overwriting unrelated work**

Fetch `origin`, inspect divergence, push `feat/betaworksos-relationship-view`, and integrate the verified release commit into `main` using a fast-forward when possible or a reviewed merge when `origin/main` has advanced. Re-run the plugin build/test and Worker unit/type suites on the integrated commit before pushing `main`.

- [ ] **Step 7: Tag and publish only the verified integrated commit**

```bash
git tag -a 0.9.2 -m "Obsidian Gmail CRM 0.9.2"
git push origin 0.9.2
gh release create 0.9.2 main.js manifest.json styles.css --title "Obsidian Gmail CRM 0.9.2" --notes-file docs/releases/0.9.2.md
```

- [ ] **Step 8: Verify the public release**

Confirm the remote tag resolves to the integrated release commit, the GitHub release is published with exactly `main.js`, `manifest.json`, and `styles.css`, downloaded asset checksums match the recorded values, the hosted graph serves the deployed version, authentication remains gated, and the previous Worker deployment remains available for rollback.
