# Jev judgments — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace generate-then-verify with select-and-judge. TypeSafe's Jev model answers typed questions (yes/no probability, pick one option, rate on ordered levels) and never generates text. Use it for: (1) statements chosen from verbatim spans of each meeting note, with attendee and kind selected by Jev; (2) why-now heat from calibrated scores combined in code; (3) theme assignment over the owner's folders and topics; (4) a draft-note check before a draft is shown; (5) identity suggestions matching meeting attendees to email contacts, confirmed by the owner.

**Architecture:** One small HTTP client `src/jev.ts` (fetch to `https://api.typesafe.ai/v1/systemone`, Bearer secret, bounded JSON, batching under the token budget). A Jev-based extractor `src/granola-jev-extractor.ts` produces the same `GranolaExtraction` shape the sync already ingests, so storage, signals, hiding, and the evidence panel are unchanged. Draft checking wraps the existing `composeDraft`. Identity suggestions are a new table plus a card section and a confirm/dismiss route; confirmed matches fold an attendee address into a contact address at graph-build time. Everything is gated on the presence of the `TYPESAFE_API_KEY` secret and falls back to current behaviour without it.

**Tech Stack:** Cloudflare Workers + Durable Objects, TypeScript, TypeSafe HTTP API (no SDK), Workers AI for draft text only, browser ES modules, `node tests/run-mail.mjs`, `npm test`, Playwright suites.

**Spec:** `docs/superpowers/specs/2026-09-19-granola-sync-design.md` boundaries remain binding, plus this plan.

All paths are relative to `apps/people-graph/` in the `relationship-slice` worktree.

## TypeSafe API contract (verified against docs.typesafe.ai on 2026-09-20)

- `POST https://api.typesafe.ai/v1/systemone`, headers `Authorization: Bearer <key>`, `Content-Type: application/json`.
- Body `{state: string|object|array, model: "jev-latest", questions: {<id>: Question}}`. Question ids are chosen by us and not shown to the model; every question sees the same state and is answered independently.
- Question types: `{type:'noul', instructions, criteria?:{true,false}}` → answer `{type:'noul', noul:number}` (probability of yes). `{type:'choice', instructions, criteria:{<option>: description|null}}` (≤ 255 options) → `{type:'choice', choice, probabilities:{option:number}, confidence}`. `{type:'score', instructions, criteria:[level descriptions, 2..10]}` → `{type:'score', score:number, legend, probabilities:{'0':..}, confidence}`.
- `instructions` may be an object holding the question plus data it refers to; reference nested state with backticked paths like `` `spans[3]` ``.
- Limits: 64k tokens per request for state plus all questions; 32k for state plus the longest question; rate limits 1,200 requests/min and 250k tokens/s (429 on excess; back off and retry). Price is per input token only; output is free. Response includes `model` (versioned id) and `usage`.
- Errors: 401 invalid key; 429 rate limit; 4xx bad request; 5xx.

## Global Constraints

- Model output is never displayed as fact. Jev returns only selections among candidates we supply and probabilities; displayed statements are verbatim spans of the owner's notes; theme names are folder names or fixed topic labels; drafts remain labelled, editable, and never sent.
- The TypeSafe key is a Worker secret (`TYPESAFE_API_KEY`), read only in `src/jev.ts`, never logged, returned, or placed in prompts. The Granola key never reaches Jev. Jev `state` contains only the owner's own note text (bounded), attendee names and emails, folder names, and for drafts the evidence lines and the draft; never other owners' data.
- Without `TYPESAFE_API_KEY` every feature falls back to current behaviour (Llama extractor, unchecked drafts, no identity suggestions). A Jev failure never fails a sync: `jev_unavailable` is treated like `ai_unavailable` (attempt counted, run ends) and `jev_rate_limited` backs off.
- Every SQL read starts with `SELECT`. Mutating routes check `origin === url.origin` and return `cache-control: no-store`. New tables are created lazily in the Durable Object constructor with `CREATE TABLE IF NOT EXISTS`.
- Extractor version becomes `granola-v3-jev` when Jev is configured (so notes re-run once when the key appears); the Llama path keeps `granola-v2`.
- Commit per task with the trailers `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01CtMWAkx6YjCxX4thGthmxw`. Verification per task: `npm run typecheck`, `node tests/run-mail.mjs`; tasks touching the client also `npm test` and the relevant browser suite with `python3 -m http.server 4183 --bind 127.0.0.1 --directory public`.

---

### Task 1: Jev HTTP client with batching

**Files:** Create `src/jev.ts`, `tests/jev.test.ts` (add to `tests/run-mail.mjs`); modify `worker-configuration.d.ts` only if `Env` needs `TYPESAFE_API_KEY?:string` and `JEV_MODEL?:string` (check how other secrets like `TOKEN_SECRET` are typed; follow that), and `src/mail-sync.ts` `MailEnv` to add `TYPESAFE_API_KEY?:string;JEV_MODEL?:string`.

**Interfaces (produced):**
```ts
export type JevQuestion=
 |{type:'noul';instructions:unknown;criteria?:{true?:unknown;false?:unknown}}
 |{type:'choice';instructions:unknown;criteria:Record<string,unknown>}
 |{type:'score';instructions:unknown;criteria:unknown[]};
export type JevAnswer=
 |{type:'noul';noul:number}
 |{type:'choice';choice:string;probabilities:Record<string,number>;confidence:number}
 |{type:'score';score:number;legend:Record<string,string>;probabilities:Record<string,number>;confidence:number};
export interface JevResult {model:string;answers:Record<string,JevAnswer>;usage:{input_tokens:number;output_tokens:number}}
export class JevError extends Error {constructor(readonly code:'jev_unconfigured'|'jev_unauthorized'|'jev_rate_limited'|'jev_unavailable'|'jev_invalid',message?:string)}
export function jevConfigured(env:{TYPESAFE_API_KEY?:string}):boolean
export async function askJev(env:{TYPESAFE_API_KEY?:string;JEV_MODEL?:string},state:unknown,questions:Record<string,JevQuestion>,signal?:AbortSignal):Promise<JevResult>
export function estimateTokens(value:unknown):number            // JSON length / 4, rounded up
export function batchQuestions<T>(items:T[],cost:(item:T)=>number,budget:number):T[][]   // greedy, order-preserving
export const noul=(instructions:unknown,criteria?)=>JevQuestion, choice=(instructions,criteria)=>JevQuestion, score=(instructions,levels)=>JevQuestion
```
Behaviour: `askJev` throws `jev_unconfigured` when the key is absent; sends `model: env.JEV_MODEL ?? 'jev-latest'`; 20 s timeout via `AbortSignal.timeout` merged with the caller's signal; reads the body with `boundedJSON` (1 MB); maps 401→`jev_unauthorized`, 429→`jev_rate_limited` (one retry after `Retry-After` seconds or 2 s, max 10 s), other non-2xx or transport→`jev_unavailable`; validates the answer shape per question type (probabilities present and numeric, choice ∈ criteria keys, noul in [0,1]) else `jev_invalid`. Never includes the key or request body in error messages.

- [ ] Tests (fake `fetch`): request shape (URL, headers, model, questions, state), missing key, 401/429 (retry once)/500/transport mapping, answer validation per type, `batchQuestions` splits by budget and preserves order, `estimateTokens`.
- [ ] Implement, typecheck, run suite, commit `feat(people-graph): Jev HTTP client with batching`.

---

### Task 2: Jev statement extraction, heat scores, theme assignment (features 1–3)

**Files:** Create `src/granola-jev-extractor.ts`, `tests/granola-jev-extractor.test.ts`; modify `src/granola-sync.ts` (`extractPhase` chooses the extractor; version constant; `ingestExtraction` uses statement probabilities for confidence and supports `topics` with probabilities and Jev-chosen folder/topic theme), `tests/granola-sync.test.ts`.

**Interfaces:**
```ts
export interface JevStatement extends GroundedStatement {probability:number;urgency:number;openLoop:number;theirAsk:number}
export interface JevExtraction extends GranolaExtraction {engine:'jev';statements:JevStatement[];topics:{topicId:TopicId;confidence:number}[];themeChoice?:{kind:'folder'|'topic'|'none';id:string;probability:number}}
export class GranolaJevExtractor {constructor(env:{TYPESAFE_API_KEY?:string;JEV_MODEL?:string}); async extract(input:GranolaExtractionInput&{folders:{id:string;name:string}[];title:string},signal?:AbortSignal):Promise<JevExtraction>}
export function candidateSpans(input:GranolaExtractionInput):{source:'summary'|'private_notes'|'transcript';offset:number;text:string}[]
```
Design:
- `candidateSpans`: split summary and private notes into sentences (on `.!?` followed by whitespace, or newlines), transcript into lines; keep spans of 20–300 characters after whitespace normalisation; record `offset` into the normalised source (same convention as `ground`); cap 400 spans per note, transcript spans after summary and notes.
- Stage 1 (gate), batched under ~20k tokens per request: state `{title, attendees:[{email,name}], spans:[text…]}`; per span a Noul `` {span:`spans[i]`, question:"Does this span express something a specific attendee asked for, promised, wants, needs to follow up on, or an introduction requested or offered?"} `` with criteria. Keep spans with `noul ≥ 0.5`, at most 60 per note ordered by probability.
- Stage 2 (judge), batched: same state shape plus `topics` (fixed list with descriptions) and `folders`; per kept span: Choice `attendee` over attendee emails plus `none` ("Which attendee is this span about, or who said it?"); Choice `kind` over `ask|commitment|intro|follow_up|interest`; Score `urgency` levels `["No time pressure","Sometime soon","This week or a stated date","Overdue or blocking"]`; Noul `openLoop` ("Does the owner still owe something here?"); Noul `theirAsk` ("Is the attendee asking the owner for something?"). Per note (once): Choice `topic` over `THEME_TOPICS` ids plus `none`; Choice `theme` over the note's folder ids plus `none` ("Which folder best describes this meeting?", using folder names in criteria).
- Output: statements where `attendee !== 'none'` and its probability ≥ 0.4, `kind` = choice, `probability` = attendee probability × kind confidence-normalised (use `probabilities[kind]`), `urgency` = `score/3`, `openLoop`, `theirAsk`; `topics` = `[{topicId:choice, confidence:probabilities[choice]}]` when choice ≠ none and probability ≥ 0.35; `themeChoice` from the folder Choice; `returned` = {topics: 1, statements: spans judged}; `calls` = requests made.
- Sync: `extractPhase` uses `GranolaJevExtractor` when `jevConfigured(this.env)`, else the Llama extractor; `GRANOLA_EXTRACTOR_VERSION` becomes a function `extractorVersion(env)` returning `'granola-v3-jev'` or `'granola-v2'` (update the version-bump comparison and stamping to call it). `ingestExtraction`: statement confidence = `clamp(0.35*probability + 0.35*urgency + 0.15*openLoop + 0.15*theirAsk, 0.05, 1)` for Jev statements (keep the fixed 0.8/0.7/0.6 for Llama); summary stays `<Kind>: “<span>”`; `evidence_ref` unchanged; the extraction JSON keeps the four dimensions. Theme precedence: Jev `themeChoice` folder when its probability ≥ 0.5, else the note's first folder (existing rule), else best topic, else Meetings. Jev errors: `jev_rate_limited`/`jev_unavailable` → treat as `ai_unavailable` (attempt counted, `aiDown` rule); `jev_unauthorized` → mark the note `failed` immediately and set connection `error='jev_unauthorized'` (surface on the card as "TypeSafe rejected the key; extraction paused").
- [ ] Tests: `candidateSpans` offsets round-trip into the normalised source (`normalised.slice(offset, offset+text.length)===text`); fake `fetch` answering stage 1 and stage 2 with fixed probabilities → expected statements, confidences, topics, theme; batching under budget; sync test with a fake Jev proving signals carry the composite confidence, the folder theme from `themeChoice`, and that without the key the Llama path and `granola-v2` are used; unauthorized path.
- [ ] Implement, typecheck, run suite, commit `feat(people-graph): Jev statement selection, heat scores and theme choice`.

---

### Task 3: Draft check (feature 4)

**Files:** Modify `src/draft-note.ts` (add `checkDraft`), `src/mail-sync.ts` (`draftNote` runs the check when Jev is configured), `src/mail-routes.ts` (response gains `warnings:string[]` and `checked:boolean`), `public/relationship-host.mjs` (dialog shows warnings), tests `tests/draft-note.test.ts`, `tests/sync.test.ts`, `tests/relationship-browser.mjs`.

**Interfaces:** `export async function checkDraft(env,{evidence,subject,body},signal?):Promise<{unsupported:number;toneOk:number;asksForMoneyOrSecrets:number}>` using one Jev request with state `{evidence:[…], draft:{subject,body}}` and three Nouls: unsupported ("Does the draft state a specific fact, event, or commitment that is not present in `evidence`?"), toneOk ("Is the draft friendly, brief and appropriate to send to a professional contact?"), asksForMoneyOrSecrets ("Does the draft ask the recipient for money, payment details, passwords or credentials?"). In `draftNote`: when configured, run the check; if `unsupported ≥ 0.5` or `asksForMoneyOrSecrets ≥ 0.5`, regenerate once with an added instruction ("Only mention items present in the evidence. Do not ask for money or credentials.") and check again; return `warnings` built from server-owned strings: "This draft may mention something not in your notes." when unsupported ≥ 0.5, "This draft may read as too blunt or off-tone." when toneOk < 0.5, "This draft asks for money or credentials; do not send it as is." when asksForMoneyOrSecrets ≥ 0.5; `checked:true`. Without Jev: `checked:false, warnings:[]`. Jev failure: `checked:false`, no error to the user.
- [ ] Tests: check request shape and mapping; regenerate-once path; warnings mapping; route passes them through; dialog renders warnings via `textContent` above the body and shows "Checked against your notes." when `checked` and no warnings.
- [ ] Implement, verify (incl. `npm run test:relationship-browser`), commit `feat(people-graph): Jev draft check with warnings`.

---

### Task 4: Identity suggestions (feature 5)

**Files:** Modify `src/granola-sync.ts` (table `granola_identity`, candidate generation and Jev judging at the end of a run, `identitySuggestions()`, `resolveIdentity(attendeeEmail,decision)`, `aliases()`), `src/mail-sync.ts` (`graphContacts()` and `graph()` fold confirmed aliases: attendee email → contact email for nodes, meetings, edges; RPC `granolaIdentities()`, `granolaIdentity(attendeeEmail,decision)`), `src/granola-routes.ts` (`GET /api/granola/identities`, `POST /api/granola/identities` `{attendeeEmail,decision:'confirm'|'dismiss'}`), `public/granola-connect.mjs` (card section "Possible matches" with Confirm/Dismiss), tests in `tests/granola-sync.test.ts`, `tests/sync.test.ts`, `tests/granola.test.ts`, `tests/granola-browser.mjs`.

**Design:**
- Table `granola_identity (attendee_email TEXT PRIMARY KEY, contact_email TEXT NOT NULL, attendee_name TEXT NOT NULL, contact_name TEXT NOT NULL, probability REAL NOT NULL, status TEXT NOT NULL, updated_at INTEGER NOT NULL)`; status `pending|confirmed|dismissed`.
- Candidates (code, no model): attendee emails that have no `contributions` row, paired with Gmail contacts whose normalised name (lowercase, diacritics stripped, punctuation removed) equals the attendee's, or whose first name equals and last initial matches; at most 3 contacts per attendee; skip pairs already decided. Computed in `finishRun` when Jev is configured (hook: `MailSync` passes a `contacts()` function returning `{email,name}` for Gmail contacts into `GranolaHooks`).
- Jev: batched requests, state `{attendee:{name,email,domain,meetings:[titles ≤5]}, contact:{name,email,domain,recentSubjects:[≤5 subject theme names]}}` per pair (one pair per request, batched by running several requests per tick under a 20 s budget, at most 50 pairs per run), one Noul "Are `attendee` and `contact` the same person?" with criteria. Store probability; status `pending` when ≥ 0.6, else `dismissed` automatically (kept so it is not re-asked).
- Aliases: confirmed rows map `attendee_email → contact_email`. `GranolaSync.contacts()`/`edges()`/`ownEmails()` apply the alias map, so the merge in `graphContacts()` lands on the contact node; statement signals for an aliased attendee use the contact's opaque id (apply the alias in `ingestExtraction`, and on confirm re-ingest that attendee's notes from stored extraction JSON like `applyHiddenSignals` does).
- Card: "Possible matches" list under Folders: "<attendee name> <attendee email> looks like <contact name> <contact email> · 82%" with Confirm and Dismiss buttons; hidden when empty; polls with status.
- [ ] Tests: candidate generation rules; Jev request shape and thresholds; confirm folds the node and re-points signals; dismiss hides; routes (auth, origin, body); browser: section renders and Confirm posts.
- [ ] Implement, verify (incl. `npm run test:granola-browser`), commit `feat(people-graph): Jev identity suggestions with owner confirmation`.

---

### Task 5: Docs and verification

- README: a "TypeSafe (Jev)" section: what it judges, the secret (`npx wrangler secret put TYPESAFE_API_KEY`), fallback behaviour, cost note (input tokens only), and the identity-confirmation flow. Update the Granola section's theme sentence.
- Run `npm run typecheck`, `node tests/run-mail.mjs`, `npm test`, and all four browser suites. Commit `docs(people-graph): describe Jev judgments`.
- Deploy is owner-run; post-deploy checks: `/api/granola/identities` returns 401 unauthenticated; the card asset contains "Possible matches"; after the owner sets the secret and presses Sync now, the status counts show extraction progressing and the extraction JSON version is `granola-v3-jev` (visible only indirectly: theme chips change).

---

### Task 6: Search my network with Jev (feature 6, added 2026-09-20)

**Files:** Create `src/network-search.ts`, `tests/network-search.test.ts` (add to `tests/run-mail.mjs`); modify `src/mail-sync.ts` (`searchPeople(query)`), `src/mail-routes.ts` + `src/index.ts` (`POST /api/people/search`), `public/relationship-host.mjs` and `public/relationship-graph/graph.mjs` (search box and results), `tests/sync.test.ts`, `tests/routes.test.ts`, `tests/relationship-browser.mjs`.

**Interfaces:**
- Route `POST /api/people/search` body `{query:string}` (1–200 chars, JSON ≤ 2 KB, same-origin, session, `bindOwner`) → `200 {query, results:[{personId,name,company,lastContact,score:number,reasons:[{summary,observedAt,title?}]}], checked:boolean}`; 400 `invalid_request`; 503 `jev_unavailable` only when Jev is configured but fails after the fallback below is impossible (never; see fallback).
- `MailSync.searchPeople(query)`:
  1. `graph()` once; candidates are its nodes with their attached signals (`themeSignals` where `personId` matches), plus edge contexts and theme names for each node.
  2. Fast pass in code (`src/network-search.ts` `keywordRank(query, people)`): tokenise the query (lowercase, strip punctuation, drop stopwords), score each person by term hits across name, company, evidence summaries, meeting titles, edge contexts and theme names (name/company hits weigh 3, others 1), tie-break by `lastContact` descending; keep the top 40 with a non-zero score, or, when fewer than 10 have hits, the top 40 by recency so the model still has candidates.
  3. Jev pass when configured: batched requests (`batchQuestions`, ~20k tokens) with state `{query, people:[{i, name, company, lastContact, evidence:[≤5 {summary,observedAt,title?} newest first]}]}` and per person a Score `` r<i> `` ("How well does `people[i]` match what the query is looking for, judged only from their listed evidence?", levels `["Unrelated","Loosely related","Relevant","Exactly who they are looking for"]`) and a Noul `` h<i> `` ("Could `people[i]` plausibly help with the query, judging from the evidence?"). Final score = `0.7*(score/3) + 0.3*noul`; without Jev, score = keyword score normalised to [0,1] and `checked:false`. On any `JevError` fall back to the keyword ranking with `checked:false` (never a user-facing error).
  4. Return the top 10 with `reasons` = up to 3 evidence items whose summary or title shares a query term, else the 2 newest.
- Client: a search field above the graph, placeholder "Ask your network: who can help with…", submit on Enter; results render as a list: name, company, a score bar or percentage, and the reason lines (via `textContent`); clicking a result selects that node in the graph (reuse the existing node-selection path) and closes the list; an empty result shows "No one in your network matches yet."; while pending show "Searching…"; results carry a small "Ranked by Jev" or "Keyword match only" label from `checked`. Escape or a clear button dismisses.
- [ ] Tests: `keywordRank` weights and stopwords; Jev request shape and score combination; fallback on `JevError`; `searchPeople` returns ≤ 10 with reasons; route auth/origin/body; browser: type a query, see ranked results from a stubbed route, click one selects the node.
- [ ] Implement, verify (`npm run typecheck`, `node tests/run-mail.mjs`, `npm test`, `npm run test:relationship-browser`), commit `feat(people-graph): search my network with Jev reranking`.
