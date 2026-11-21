# Agentic People: intention queries, life signals and agent-to-agent over the tailnet

Status: design approved in review (artifact `agentic-people-brief`, v7). Implementation plans follow per sub-project.

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
| 0 | Foundation: correct backend/cache, name matching, hints, one skill | none |
| 1 | Life signals and catch-up brief | 0 |
| 2 | `ask`: natural-language entry point (CLI and MCP) | 0, 1 |
| 3 | Peer layer over the tailnet | 1, 2 |
| 4 | `ask` intents for why-now, contrast/fringe and structure/bridges | 2 (separate spec) |

Each sub-project gets its own implementation plan and ships independently. Sub-project 4 gets its own design spec once 2 exists; this spec fixes only the contract it must plug into.

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

## Sub-project 0: Foundation

1. **Name matching.** Email-address substring matching applies only when the query contains `@`. A name substring hit counts only at a word boundary and is labelled `partial` (new `name_match` value), not `exact`. Jaro-Winkler hits are labelled `fuzzy`. Results are ordered by confidence. The owner's own addresses (`userEmail` and its aliases) are excluded unless `--include-self` is passed.
2. **Name resolution for single-person commands.** `score`, `contact-card`, `get-neighbors` and `get-edges` accept a name or an email. One identity group resolves; several return `ambiguous_person` with candidates; none returns `not_found` with hints.
3. **Hints on empty results.** `who-knows` and `find-person` return `data.hints`: up to 3 nearest company/domain or name values, with Jaro-Winkler ≥ 0.80 over the cache.
4. **Safe discovery.** Vault auto-discovery skips vault paths with any hidden path segment (a segment starting with `.`, e.g. `~/.codex/...`), other than the `.obsidian` plugin directory itself. If more than one remaining vault has a cache, it fails with `ambiguous_cache`, listing the paths. `--cache` and `PEOPLEGRAPH_CACHE` are unaffected.
5. **Provenance in stats** as defined in the envelope section, for every command and backend.
6. **One skill.** Merge `skills/gmail-crm` into `skills/peoplegraph`. Remove the stale "copy `bin/peoplegraph`, never run the installer" guidance and list the supported harnesses. The installer keeps shipping the one skill.
7. **Rollout on this machine** (operational, not code): install the new release over 0.3.11, then run `peoplegraph login`.

## Sub-project 1: Life signals and the catch-up brief

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

## Error kinds (new)

`ambiguous_cache`, `ambiguous_person`, `unsupported_locally`, `signals_disabled`, `peer_not_allowed`, `peer_unreachable`, `peer_rate_limited`, `ticket_expired`, `pepper_missing`, `tailscale_unavailable`. Every error keeps the existing `{kind, message}` shape. Messages never contain tokens, the pepper, quotes or email bodies.

## Testing

- **Rust** (`cargo test`): name-match labels and owner exclusion, name resolution and ambiguity, hints, discovery with hidden-path vaults and multiple caches, stats provenance on every backend.
- **Worker** (`npm test`, typecheck): life extraction with a mocked model, covering tier derivation, first-person anchoring, Granola attribution, expiry, the off-by-default setting and forget. Also isolation tests proving signals never reach workspace graphs, and `ask` classification with a mocked model, covering `clarify` and param validation.
- **`ask` evaluation set.** About 40 natural-language questions with expected intents and params, checked in as a fixture. A deterministic test uses recorded classifications. `scripts/eval-ask.mjs` runs the live model on demand and reports accuracy; it does not run in CI.
- **Peer tests.** Two in-process `peer serve` instances with an injected `whois` resolver and fixture data, covering the allow-list, HMAC resolution, unknown-person indistinguishability, tier policy, tickets, expiry, the rate limit and audit entries. A manual check against two real tailnet nodes runs before release.

## Out of scope

Public-web enrichment, central storage of second-hand signals, sharing sensitive-tier signals under any policy, automatic outreach, LinkedIn import, and changes to relationship scoring. The why-now, contrast and structure ranking designs belong to the sub-project 4 spec.
