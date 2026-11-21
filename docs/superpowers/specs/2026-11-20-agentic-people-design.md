# Agentic People: intention queries, life signals and agent-to-agent over the tailnet

Status: sections up to and including sub-project 3 approved in review (artifact `agentic-people-brief`, v7). Sections marked **Proposed** come from Kaya's working note (brief v9) and are pending review. Implementation plans follow per sub-project.

## Intent

Kaya's essay *The Future of Social Networks Is Agentic* frames the goal: help people understand and activate their own networks, and meet people who change how they think. **Recency tells us when to reconnect, context tells us why, judgment tells us whether.**

Concretely:

- Any agent harness (Claude, Codex, ChatGPT, OpenClaw/Botwick, Hermes) asks People intention questions in natural language through the CLI or MCP and gets grounded, attributed answers.
- People surfaces the **catch-up-call layer**: life signals people mention but rarely post: travel, a new hobby, an injury or illness, a move, a new role.
- Members of a trusted group (the Betaworks tailnet) let their agents ask each other questions under owner-controlled policy, without a central store of other people's private lives.

Success: an agent on this machine answers "anything I should know before I catch up with Maya?" with first-hand signals and, where peers permit, attributed second-hand signals. It answers "who should I reconnect with and why now?" with evidence. It never invents a fact, and it never leaks a sensitive signal across people.

## Decisions

- **D1** Third-party information means the catch-up-call layer: life signals, not public web profiles. Public web sources are out of scope.
- **D2** Signals cross between people only peer-to-peer over the tailnet. They are answered on demand by the answering owner's agent and never stored centrally. Only `open`-tier signals are answered automatically.
- **D3** Hybrid architecture. Hosted People (Cloudflare) remains the home for each owner's graph, web app, shared networks and first-hand life signals. The tailnet is the agent-to-agent layer.

## Inputs from Kaya's working note (brief v9, proposed)

| Note item | Design consequence |
|---|---|
| Reconnecting after 10 years means the whole catch-up is spent recapping your life; it's a storytelling problem | The catch-up brief becomes two-sided: "since you last spoke" for them *and* for you (sub-project 1) |
| Everything as typed objects, with interfaces vibe-coded on top | Publish versioned JSON Schemas for every object an agent sees, so any harness can build its own interface (typed objects section) |
| Agencies need to track people across job moves and teammates | Company history per person, job-move detection that proposes identity merges, and "formerly at" in `who-knows` (sub-project 1) |
| Introductions involve 3 people, but graph edges hold 2 | Introductions become a first-class, three-party object (sub-project 6) |
| Founders keep asking "where can I search your network?" | Guest ask: an outsider's question answered by the owner's agent, with owner approval and a double opt-in before any introduction (sub-project 7) |
| Fringe: the right privacy partition when the graph is shared | Privacy partition section |
| Fringe: what's interesting to which person, at which moment | Interest model and moments (sub-project 5) |

The note's own shape (what's new in my head, why it interests me, the fringes, who I want to talk to) becomes the input object for sub-project 5: a **curiosity note**.

## Current state (verified 2026-11-20)

- The installed `/opt/homebrew/bin/peoplegraph` is 0.3.11. Its hosted login is expired, so hosted queries return `login_required`.
- The current CLI (0.3.17) lives on `codex/cli-web-parity` (unmerged): `search`, `matches`, `connection`, `helpers`, `memory`, `lens`, `sources`, `api`, and the MCP endpoint `/api/people-mcp`.
- `--local` vault discovery finds three vaults with caches. Two of them are Codex demo vaults under `~/.codex/artifacts/`. Discovery silently picks one, and responses do not report which.
- `find-person Jon` returns the owner, labelled `exact` at 0.96. `match_confidence` substring-matches a non-email query against email addresses (`main.rs`, `query_email` branch).
- `who-knows --company sequoia` and `find-person "investors in AI"` return empty results with no hint. `score` accepts only an email.
- Mail context extraction (`gmail-context.ts`) keeps only `building | need | experience` work passages. Personal-life passages are deliberately excluded today.
- Relationship memory is owner-private (`RelationshipMemoryStore`; "No memory rows enter shared signal storage").
- `skills/gmail-crm` and `skills/peoplegraph` give contradictory install guidance.

## Sub-projects and order

| # | Sub-project | Depends on |
|---|---|---|
| 0 | Foundation: correct backend/cache, name matching, hints, one skill, banded shared scores | none |
| 1 | Life signals, job moves and the two-sided catch-up brief | 0 |
| 2 | `ask`: natural-language entry point (CLI and MCP) | 0, 1 |
| 3 | Peer layer over the tailnet | 1, 2 |
| 4 | `ask` intents for why-now, contrast/fringe and structure/bridges | 2 (separate spec) |
| 5 | Curiosity notes and moments (proposed) | 1, 2, 4 |
| 6 | Three-party introductions (proposed) | 0 |
| 7 | Guest ask: "search my network" (proposed) | 2, 6 |

Each sub-project gets its own implementation plan and ships independently. Sub-project 4 gets its own design spec once 2 exists; this spec fixes only the contract it must plug into. Typed objects and the privacy partition apply to every sub-project.

## Shared contract: the answer envelope

All new query commands, MCP tools and peer responses use the existing CLI envelope (`ok`, `command`, `data`, `stats`, `error`). `data` takes this shape:

```json
{
  "interpretation": {"intent": "catch_up", "params": {"person": "maya@acme.com"}, "confidence": 0.92},
  "answers": [{
    "personId": "p_…",
    "name": "Maya Rivera",
    "when": {"lastContact": "2026-08-02", "daysSince": 110, "label": "cooling"},
    "why": [{"kind": "life", "category": "travel", "summary": "Back from two weeks in Japan",
             "source": "gmail", "observedAt": "2026-08-02", "attribution": "first_hand"}],
    "whether": {"feedback": "boost", "relationship": "closer", "notes": 1},
    "use": "rank"
  }],
  "gaps": ["No meeting notes with Maya", "Peer kaya-test@github unreachable"]
}
```

- `interpretation` is always present for `ask`. It is `null` for direct commands.
- `why` entries always carry `source`, `observedAt` and `attribution`: `first_hand`, or `peer:<login>` for second-hand.
- `use` is `rank` or `tone_only`. Sensitive-tier signals are always `tone_only`, never affect ordering, and appear only in the owner's own brief.
- Empty `answers` with explanatory `gaps` is a successful, honest result, not an error.
- `stats` on every response (old and new commands) gains `backend` (`hosted` | `local` | `legacy_remote`), `source` (origin URL or absolute cache path) and `owner`.

## Privacy partition when the graph is shared (proposed)

Every fact involves three parties: the **subject** it is about, the **holder** who learned it, and the **viewer** who asks. A fact may go no further than the setting the subject originally said it in. A pitch in an intro email is professional and may reach the holder's professional circle. "I've been sick", told to one friend, may not.

| Zone | Contents | Who sees it | Where it lives |
|---|---|---|---|
| **A. Holder-only** | Raw content (quotes, email bodies, notes), sensitive-tier signals, the holder's judgments (swipes, relationship notes), curiosity notes | The holder and their own agent | Holder's private store; never crosses |
| **B. On request** | `open`-tier signals, `reason_to_meet`, willingness to introduce | One asker, one question at a time; attributed, expiring, logged by the holder | Peer layer (sub-project 3) or guest ask (sub-project 7) |
| **C. Shared into the graph** | That a relationship exists, an activity band, work themes, attributed work statements | Members of that shared network, at the holder's share level (`names` / `themes` / `statements`) | Hosted shared networks (existing) |
| **D. Viewer-only** | The viewer's Lens, notes, judgments and curiosity notes | The viewer only; they shape the viewer's ranking, not what others see | Hosted, owner-scoped (existing `viewerPrivateContext` pattern) |

Rules that apply in every zone:

- **Judgments never cross.** Swipes and relationship notes stay in zone A. The single exception is an explicit per-person vouch (sub-project 6), which the holder chooses.
- **Closeness crosses only as a band.** Other members see `strong | some | light`, never numeric scores or exact counts (foundation item 8).
- **The question is information.** Peers who know the subject learn that the asker asked. The holder's audit log shows this, and it is documented to askers. HMAC references hide it from peers who don't know the subject.
- **Answers are never combined and stored.** Answers from several holders are merged only in the asker's response and are not persisted. Each asker may ask about the same subject at most 3 times per day per holder.
- **The subject can opt out.** A tailnet member may add themselves to their own `peers.json` `doNotAnswerAbout` list. It is published to group peers (as the HMAC of each of their addresses), and every peer refuses `catch_up` and `knows` questions about them. Non-members cannot opt out, which is one more reason only `open`-tier signals cross.
- **Only statements about oneself count.** Something Maya says about Sam is not a signal about Sam.

## Typed objects (proposed)

Every object an agent sees has a versioned JSON Schema, published at `<origin>/schemas/v1/<name>.json` and bundled with the CLI (`peoplegraph schema <name>`). That way any harness can build its own interface without reverse-engineering responses. The objects are `Person`, `Relationship` (with band), `Signal`, `CompanyStint`, `Introduction`, `CuriosityNote`, `Moment`, `GuestAsk` and `Answer` (the envelope above). Schemas are additive within `v1`. A breaking change means a new `v2` path, with both served for one release.

## Sub-project 0: Foundation

1. **Name matching.** Email-address substring matching applies only when the query contains `@`. A name substring hit counts only at a word boundary and is labelled `partial` (new `name_match` value), not `exact`. Jaro-Winkler hits are labelled `fuzzy`. Results are ordered by confidence. The owner's own addresses (`userEmail` and its aliases) are excluded unless `--include-self` is passed.
2. **Name resolution for single-person commands.** `score`, `contact-card`, `get-neighbors` and `get-edges` accept a name or an email. One identity group resolves; several return `ambiguous_person` with candidates; none returns `not_found` with hints.
3. **Hints on empty results.** `who-knows` and `find-person` return `data.hints`: up to 3 nearest company/domain or name values, with Jaro-Winkler ≥ 0.80 over the cache.
4. **Safe discovery.** Vault auto-discovery skips vault paths with any hidden path segment (a segment starting with `.`, e.g. `~/.codex/...`), other than the `.obsidian` plugin directory itself. If more than one remaining vault has a cache, it fails with `ambiguous_cache`, listing the paths. `--cache` and `PEOPLEGRAPH_CACHE` are unaffected.
5. **Provenance in stats** as defined in the envelope section, for every command and backend.
6. **One skill.** Merge `skills/gmail-crm` into `skills/peoplegraph`. Remove the stale "copy `bin/peoplegraph`, never run the installer" guidance and list the supported harnesses. The installer keeps shipping the one skill.
7. **Banded shared scores.** In shared networks, introduction routes and answer cards, another member's relationship to a person is shown as `band: strong | some | light`. Numeric scores no longer cross between members (`network-answer.ts` currently passes them). The owner's own scores are unchanged.
8. **Rollout on this machine** (operational, not code): install the new release over 0.3.11, then run `peoplegraph login`.

## Sub-project 1: Life signals, job moves and the catch-up brief

### Model

A life signal is owner-private and stored in the owner's MailSync store alongside relationship memory. It never enters shared workspace `themeSignals`.

| Field | Type | Notes |
|---|---|---|
| `id` | string | Stable |
| `personId` | string | Who the signal is about |
| `category` | enum | See the tier table below |
| `tier` | `open` \| `personal` \| `sensitive` | Derived from category; never set by the model |
| `summary` | string ≤ 80 chars | Neutral paraphrase: what peers may receive |
| `quote` | string ≤ 600 chars | Verbatim source passage; never leaves the owner |
| `source` | `gmail` \| `granola` \| `memory` | |
| `sourceRef` | string | Message, note or memory entry id |
| `observedAt` | ISO date | Date of the source |
| `expiresAt` | ISO date | `observedAt` + category TTL |

| Category | Tier | TTL |
|---|---|---|
| `travel` | open | 60 days |
| `hobby` | open | 365 days |
| `role_change` | open | 365 days |
| `moved` | open | 365 days |
| `milestone` (wedding, baby, graduation) | personal | 180 days |
| `health` | sensitive | 120 days |
| `family` | sensitive | 180 days |
| `loss` | sensitive | 365 days |
| `money` | sensitive | 120 days |
| `legal` | sensitive | 120 days |

Expired signals are excluded from every read and deleted by the existing opportunistic cleanup.

### Extraction

- **Separate model call.** Life extraction is a separate call from the existing work-fact extraction, whose prompt and schema stay unchanged. It uses the same sentence-index passage selection, so quotes are verbatim, and a JSON schema whose `category` enum is the table above. The model returns at most 3 signals per message and never chooses a tier.
- **Gmail:** only accounts with Gmail context enabled (existing consent), and only passages where the anchor sentence is a first-person statement by the sender about themselves. Out-of-office replies go through the same pipeline.
- **Granola:** only passages the note explicitly attributes to a named attendee. Topic co-occurrence is not attribution, consistent with existing rules.
- **Memory:** owner `memory capture` text is extracted the same way, with source `memory`.
- **Off by default.** A new owner setting gates extraction: `peoplegraph signals on|off`, also shown in Accounts. Turning it off stops extraction. `signals forget --all` deletes stored signals.

### Owner commands (CLI, MCP, registry routes)

- `peoplegraph signals list [--person <email|name>]`: the owner's signals, all tiers.
- `peoplegraph signals forget <id> | --person <email> | --all`
- `peoplegraph brief <email|name>`: the catch-up brief. Answer envelope with `when` from activity, `why` from life signals plus existing work evidence and memory, and `whether` from feedback and memory relationship. Sensitive signals appear with `use: tone_only`. With `--peers`, it also runs sub-project 3's `catch_up` fan-out and merges peer results as `peer:<login>` entries.

### Two-sided brief: "since you last spoke" (proposed)

Reconnecting after years turns the call into mutual recapping, so the brief tells both stories. `brief` adds `data.sinceLastContact`:

- `theirs`: their signals and company stints dated after `lastContact`, oldest first.
- `yours`: the owner's own timeline after `lastContact`, assembled from owner self-entries, confirmed Lens revisions and, once sub-project 5 exists, curiosity notes. It lets the agent suggest what the owner might share.

Owner self-entries are zone A and are added explicitly with `peoplegraph me add "<text>" [--category <category>] [--date <YYYY-MM-DD>]`, `me list` and `me forget <id>`. They are never extracted automatically and never answered to peers.

### Job moves and teammates (proposed)

Agencies need to follow people across employers and know who worked together.

- **`CompanyStint`** `{personId, company, domain, from, to | null, source}` is derived from email domains over time, `role_change` signals and owner edits. The owner corrects stints with `peoplegraph stints set <email|name> --company <name> --from <YYYY-MM> [--to <YYYY-MM>]` and `stints forget <id>`. Owner edits outrank derived stints.
- **Job-move detection.** When an address on a new domain matches an existing person's name (existing duplicate scoring ≥ 0.94), or a `role_change` signal names a new employer, People proposes a merge in the existing merge queue. It never merges automatically. Applying the merge closes the previous stint.
- `who-knows --company <name> --include-former` adds people with a closed stint there, labelled `formerly` with dates.
- `peoplegraph teammates <email|name>` lists people whose stints at the same company overlapped, with the overlap period.
- Stints are zone C only as company names at the holder's `themes` share level or higher. Dates never cross.

## Sub-project 2: `ask`

- **Commands.** CLI `peoplegraph ask "<question>"`; MCP tool `ask` on `/api/people-mcp`. Questions are bounded to 500 characters.
- **Hosted classification.** Classification runs server-side (Workers AI, JSON schema output) into exactly one intent with typed params, then deterministic validation. Intents and their mapping:

| Intent | Example | Runs |
|---|---|---|
| `lookup` | "who is Maya at Acme" | `search` / `find-person` |
| `company` | "who do I know at Sequoia" | `who-knows` |
| `catch_up` | "anything before I talk to Maya" | `brief` |
| `reconnect` | "who should I reconnect with" | `reconnect` (sub-project 4 adds why-now) |
| `who_can_help` | "who could help with nurse recruiting" | `matches` / `helpers` |
| `connection` | "how am I connected to Sam" | `connection` |
| `network_ask` | "does anyone in Betaworks know Maya" | Peer fan-out (CLI only) |

- **Low confidence.** Below 0.6, or when params don't validate, the result is `intent: clarify` with up to 3 candidate interpretations. Nothing is executed.
- **`network_ask` runs on the CLI side.** Hosted People cannot reach the tailnet, so it returns the classified intent and the CLI performs the peer fan-out. Over MCP the tool returns the interpretation with a gap: "peer questions require the CLI".
- **Local mode.** `--local ask` uses a deterministic keyword classifier supporting only `lookup`, `company`, `reconnect` and `catch_up` (activity-only, no life signals). Other intents return `unsupported_locally`.
- **Sub-project 4** registers further intents (`why_now`, `contrast`, `bridges`, `gaps_in_network`) in the same table and envelope.

## Sub-project 3: Peer layer over the tailnet

### Transport and identity

- `peoplegraph peer serve` binds to this node's Tailscale IPv4 address (100.x.y.z), port 8790 by default, plain HTTP; tailnet traffic is WireGuard-encrypted. It refuses to bind any non-Tailscale address.
- **Caller identity** comes from the Tailscale LocalAPI `whois` of the TCP remote address, never from request headers. Requests from tagged nodes, from unknown nodes, or from logins not in `allow` get `403`.
- **Data access.** The server reads the owner's data through hosted People, using the owner's saved credential (`people:read`) and a new read route for life signals and coarse activity. It keeps no cache between requests.

### Configuration (`~/.config/peoplegraph/peers.json`, owner-only, atomic writes)

```json
{
  "version": 1,
  "group": "betaworks",
  "pepper": "<32 random bytes, base64url, shared by the group out of band>",
  "allow": ["john@betaworks.com"],
  "doNotAnswerAbout": ["<HMAC of each of the owner's own addresses, when the owner opts out>"],
  "peers": [{"login": "john@betaworks.com", "url": "http://john-mbp.tailnet.ts.net:8790"}],
  "policy": {"open": "auto", "personal": "approve", "sensitive": "never", "reason_to_meet": "approve"}
}
```

`peer init --group <name>` creates a pepper; `peer join --pepper-stdin` imports one. The pepper is never printed. `sensitive` cannot be set to anything but `never`.

### Person references

A person is referenced as `HMAC-SHA256(pepper, lowercase(trim(email)))` in hex. The answering peer computes HMACs over its own contacts, including aliases, to resolve them. A peer who doesn't know the person learns nothing about who was asked about.

### Requests

`POST /peer/v1/query` with `{"type", "person"?, "topic"?, "requestId"}`:

| Type | Returns | Policy |
|---|---|---|
| `knows` | `{known, band: strong\|some\|light, lastContactMonth}`; no counts, no exact dates | auto |
| `catch_up` | Unexpired signals as `{category, summary, observedMonth, expiresAt}`; never `quote` or `sourceRef` | `open` auto; `personal` approve; `sensitive` never |
| `reason_to_meet` | `{topic (≤ 200 chars), reason (≤ 200 chars, written by the answering owner on approval)}` | approve |

- A request needing approval returns `202 {ticket}`. The asker polls `GET /peer/v1/tickets/<id>` at most once every 30 seconds. Tickets expire after 72 hours.
- Unknown person: `200 {known: false}`, the same shape and timing as a known person with no signals.
- Rate limit: 60 requests per minute per caller login.
- Every request is appended to `~/.config/peoplegraph/peer-audit.jsonl` with time, caller login, type, person HMAC, outcome and returned categories.

### Owner and asker commands

- **Answering side:** `peer pending`, `peer approve <ticket> [--reason <text>]`, `peer deny <ticket>`, `peer log [--since <date>]`. The owner's agent surfaces pending tickets. Approval is always a human decision.
- **Asking side:** `peer ask knows|catch-up <email|name>` and `peer ask reason-to-meet --topic <text>`. These fan out to all configured peers with a 10-second timeout each. Results are attributed per peer login, and unreachable peers are listed in `gaps`.

## Sub-project 5: Curiosity notes and moments (proposed)

Interest is not a property of a contact. It depends on who is looking, at what moment, and in which direction: Maya can be interesting to Kaya while Kaya is not interesting to Maya. So People models **moments**, not just rankings.

### Curiosity note

A curiosity note is the owner's current thinking, in the shape of Kaya's working note. It is the "intent now" input for `ask`, moments and sub-project 4.

| Field | From heading | Notes |
|---|---|---|
| `newInMyHead[]` | `## What's new in my head` | Each item `{text, fromPersonIds[], unresolved[]}`. Names in parentheses, such as "(Sam + betaworks)", are resolved with `find-person` |
| `why` | `## Why it spikes my interest` | Free text |
| `fringes[]` | `## The fringes` | Open questions; they drive contrast searches |
| `wantToTalkTo[]` | `## Who I want to talk to about it` | Person ids; unresolved names are kept and reported in `gaps` |

- `peoplegraph mind set --file <note.md|->` parses exactly these four headings. Unknown headings are rejected with `note_invalid`, naming the heading.
- `mind show`, `mind list` and `mind archive <id>` manage notes; the same operations are MCP tools.
- At most 3 notes are active, each at most 4,000 characters.
- Notes are zone A/D: they are never shared and never answered to peers or guests.

### Interest model

$$\text{interest}(v,s,t)=\text{relevance}(\text{intent}_v(t),\text{context}_s(t))\times\text{timeliness}(t)\times\text{novelty}(s\mid v)\times\text{reachability}(v\to s)$$

A candidate surfaces only if it also passes the viewer's **judgment** (`suppress` and `delete` mean never), the **privacy partition**, and the **attention budget**.

| Term | Source |
|---|---|
| `intent_v(t)` | Active curiosity notes, then confirmed Lens, then recent `ask` questions |
| `context_s(t)` | Work evidence and unexpired `open`/`personal` signals the viewer holds |
| timeliness | Meeting within 48 hours, a signal from the last 7 days, crossing into dormancy, a topic appearing on both sides within 7 days |
| novelty | Community/discipline distance from the viewer's dense clusters (sub-project 4). Until sub-project 4 ships, novelty is 1 |
| reachability | Direct relationship band, a shared-network path, or a willing introducer |

### Moments

`Moment` `{id, kind, personIds[1..3], trigger, answer, createdAt, expiresAt, status: new|acted|snoozed|dismissed}`. `answer` uses the answer envelope.

| Kind | Trigger | Expires |
|---|---|---|
| `pre_meeting` | Calendar event with the person in the next 48 hours | At the event |
| `fresh_signal` | An `open`/`personal` signal from the last 7 days, relevant to an active note | 7 days |
| `cold_and_relevant` | The relationship crossed into dormancy and is relevant to an active note | 14 days |
| `want_to_talk` | A `wantToTalkTo` person with no contact in 30 days; includes a two-sided brief and a suggested reason | 14 days |
| `fringe_match` | A person whose evidence addresses a `fringes[]` question from a different community (needs sub-project 4) | 14 days |
| `bridge` | Two contacts with matching evidence and no recorded connection; proposes an `Introduction` (sub-project 6) | 14 days |

- **Budget.** At most 3 moments per day by default (configurable 1–10). There is at most one moment per person per 7 days. Dismissing one suppresses that person and kind for 30 days and is recorded as judgment.
- **Generation.** Moments are generated daily by hosted cron and on demand. They are read with `peoplegraph moments [--today]` and the MCP tool `moments`, and act/snooze/dismiss uses `moments act|snooze|dismiss <id>`.
- **Peers are never asked in the background.** Peer data enters only through an explicit `brief --peers`.

## Sub-project 6: Three-party introductions (proposed)

Introductions involve three people, but graph edges hold two. `Introduction` becomes a first-class object:

```json
{"id": "…", "introducer": "p_john", "parties": ["p_kaya", "p_maya"], "reason": "…",
 "evidence": [{"personId": "p_maya", "source": "granola", "date": "2026-10-12", "summary": "…"}],
 "status": "proposed", "vouch": null, "outcome": null, "createdAt": "…", "updatedAt": "…"}
```

- **Statuses:** `proposed → asked_introducer → introducer_accepted → target_opted_in → made → (met | not_met)`; any step can end in `declined` or `expired` (30 days without progress).
- **Double opt-in.** The target is asked before the introduction is made. People never sends email itself; the introducer's agent drafts the messages.
- **Vouch.** Optional text written by the introducer, visible only to the two parties of that introduction. It is the single judgment that may cross (privacy partition).
- **Outcome.** `met` / `not_met` plus an optional note. It feeds `whether` and the existing completed-introduction counts.
- **Migration.** Existing `introduction_requests` map to `parties [requester, target]`, with `introducer = recipient`. Workspace introduction suggestions become `proposed` introductions.
- **Graph.** An introduction renders as a three-way connector between the three people. Pairwise relationship edges are unchanged.
- `peoplegraph intros list|show|propose|advance|outcome` and MCP equivalents.

## Sub-project 7: Guest ask, "search my network" (proposed)

Founders ask "where can I search your network?" Guest ask lets an outsider ask without seeing the graph.

- **Entry.** The guest asks at `<origin>/ask/<owner-handle>`, or through their own agent via the public MCP tool `ask_network`. Guest identity reuses booking's Google visitor verification. Questions are at most 500 characters, each guest may ask 3 per day, and the owner can turn guest ask off.
- **Draft.** The owner's agent drafts an answer from the owner's graph and zone C evidence, **work evidence only**. Life signals, curiosity notes and peer answers are never used.
- **Approval.** Every answer requires owner approval (`GuestAsk` status `pending → answered | declined`, expiring after 7 days). An approved answer describes people without naming them, e.g. "a design lead at a health startup working on nurse scheduling".
- **Names only through introductions.** A name is revealed only when the guest requests an introduction, the owner accepts as introducer, and the described person opts in (sub-project 6).
- `peoplegraph guest pending|answer <id> [--file <draft.json>]|decline <id>`.

## Error kinds (new)

`ambiguous_cache`, `ambiguous_person`, `unsupported_locally`, `signals_disabled`, `peer_not_allowed`, `peer_unreachable`, `peer_rate_limited`, `subject_opted_out`, `ticket_expired`, `pepper_missing`, `tailscale_unavailable`, `note_invalid`, `introduction_state_invalid`, `guest_rate_limited`, `guest_ask_disabled`. Every error keeps the existing `{kind, message}` shape. Messages never contain tokens, the pepper, quotes or email bodies.

## Testing

- **Rust** (`cargo test`): name-match labels and owner exclusion, name resolution and ambiguity, hints, discovery with hidden-path vaults and multiple caches, stats provenance on every backend.
- **Worker** (`npm test`, typecheck): life extraction with a mocked model, covering tier derivation, first-person anchoring, Granola attribution, expiry, the off-by-default setting and forget. Also isolation tests proving signals never reach workspace graphs, and `ask` classification with a mocked model, covering `clarify` and param validation.
- **`ask` evaluation set.** About 40 natural-language questions with expected intents and params, checked in as a fixture. A deterministic test uses recorded classifications. `scripts/eval-ask.mjs` runs the live model on demand and reports accuracy; it does not run in CI.
- **Peer tests.** Two in-process `peer serve` instances with an injected `whois` resolver and fixture data, covering the allow-list, HMAC resolution, unknown-person indistinguishability, tier policy, subject opt-out, the per-subject question limit, tickets, expiry, the rate limit and audit entries. A manual check against two real tailnet nodes runs before release.
- **Partition tests.** For each zone, a fixture fact of that zone is asserted absent from every response type it must not reach: shared graph, peer, guest, MCP. Includes banded scores replacing numeric scores in shared networks.
- **Curiosity notes and moments.** Parsing of the four-heading format, using a synthetic fixture with the same shape as Kaya's working note and no real names; name resolution; budget, dedupe and suppression; no peer calls during generation.
- **Introductions.** The state machine, including illegal transitions, migration of existing requests, and vouch visibility limited to the two parties.
- **Guest ask.** Rate limits, owner approval, no life signals in drafts, and no names before opt-in.

## Out of scope

Public-web enrichment, central storage of second-hand signals, sharing sensitive-tier signals under any policy, automatic outreach or email sending, background peer queries, LinkedIn import, and changes to relationship scoring. The why-now, contrast and structure ranking designs belong to the sub-project 4 spec.
