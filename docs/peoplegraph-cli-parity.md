# PeopleGraph CLI and web parity

PeopleGraph 0.3.18 gives an agent the same owner operations as the People website. Lens, source setup, and relationship memory have dedicated commands. Other owner operations use `peoplegraph api`, which calls a bounded registry of the existing web handlers. The server verifies the owner and permissions before dispatching; the request cannot choose a different owner.

## One-time setup

```sh
peoplegraph login --write
peoplegraph status
peoplegraph lens
```

Approve the displayed code and permissions once in your browser. The CLI saves one People integration credential automatically. That credential works for graph queries, Lens, private memory, REST, and the optional MCP endpoint according to its granted scopes. No MCP configuration or sourced environment file is necessary.

`login` without `--write` requests read-only access. Add explicit permissions only for work the owner wants the agent to perform:

```sh
peoplegraph login --write --scope sources:manage
```

| Scope | Enables |
| --- | --- |
| `people:read` | Private network, confirmed Lens, matches, context and graph queries |
| `people:write` | Lens and private context edits; broader profile edits also require `people:read` |
| `sources:manage` | Connected-source settings, synchronization and retrieval |
| `sharing:manage` | Sharing, workspaces and introduction requests |
| `booking:manage` | Booking settings, requests and scheduling approvals |
| `integrations:manage` | Credential listing/revocation and delegated keys within the caller’s grants |

Some operations require multiple scopes. `peoplegraph status` returns their exact requirements and availability. Delegated People keys cannot gain scopes or a longer lifetime than the delegating key. Permissions are capability grants, not instructions to send messages, book meetings, share data or delete anything; those actions still need the owner's authorization.

Existing integration keys also work. Feed the value through stdin locally, not a command argument or a chat message:

```sh
peoplegraph configure --url https://people-graph.kayarjones901.workers.dev --token-stdin < /secure/path/people-key
peoplegraph status
```

The config is `$XDG_CONFIG_HOME/peoplegraph/config.json`, falling back to `~/.config/peoplegraph/config.json` on macOS and Linux. It is written atomically with owner-only permissions. Its format is:

```json
{
  "version": 1,
  "active_origin": "https://people-graph.kayarjones901.workers.dev",
  "profiles": [{
    "origin": "https://people-graph.kayarjones901.workers.dev",
    "token": "<People integration credential>"
  }]
}
```

The complete `PEOPLEGRAPH_WEB_URL` / `PEOPLEGRAPH_WEB_TOKEN` environment pair overrides the saved profile. An explicit `--url` can select another saved origin, but a credential is never borrowed from an unrelated origin. Redirects are refused. Tokens and config contents must not be printed to logs or pasted into chat.

`status` authenticates against the server and reports owner, credential source, scope grants, expiry and capabilities. `status --offline` reports local metadata only and leaves authentication unverified. Old `pgd1_` device credentials remain graph-only; run the new login to replace a same-origin legacy profile. `PEOPLEGRAPH_HOST` / `PEOPLEGRAPH_TOKEN` still mean the legacy local daemon, and `--local` explicitly selects the Obsidian cache. Once a hosted profile is configured, it takes precedence over an implicit legacy daemon environment; explicit legacy flags remain supported. Failed hosted authentication never falls back to a different account or local cache.

## Keep the owner's Lens current

```sh
peoplegraph lens
peoplegraph lens set --focus "Agent interfaces and developer tools"
peoplegraph lens set --needs "Design partners" --offers "Founder introductions"
peoplegraph matches
```

Each field is at most 500 characters. Partial edits read the current Lens and preserve omitted fields. An empty string explicitly clears a field. The write includes the current revision. If another person or agent edits it first, the server returns `owner_lens_conflict`; the CLI does not retry or overwrite the newer edit.

For a reviewed full replacement, write this JSON and use `peoplegraph lens set --file lens.json` (or `--file -` for stdin):

```json
{
  "revision": "<revision returned by peoplegraph lens>",
  "fields": {
    "focus": "Agent interfaces and developer tools",
    "needs": "Design partners",
    "offers": "Founder introductions"
  }
}
```

A full file can be saved by a write-only key without reading existing private fields; that response contains only the committed revision and update time. Read/write keys receive the committed confirmed fields too. `--revision` also works with field flags. On conflict, reread the current state and reconcile the requested edit; do not blindly replay it.

The remaining Lens controls are available without the web UI:

```sh
peoplegraph lens inspect
peoplegraph lens learning on
peoplegraph lens granola on
peoplegraph lens refresh
peoplegraph lens accept <suggestion-id>
peoplegraph lens dismiss <suggestion-id>
```

These commands use the same revision and source controls as the web app. Refresh returns HTTP 202 after persisting a background job; it does not accept suggestions. Use `lens inspect` or `api GET /api/lens` to follow `refresh.job`. While its status is `queued` or `running`, inspect rather than starting another refresh. Terminal statuses are `completed`, `failed`, and `cancelled`; inspect `refresh.state`, `refresh.nextAction`, and `honcho.lastSync` separately because a completed job does not guarantee ready suggestions or a completed Honcho projection. Use an owner's explicit request or standing instruction to decide whether a Lens edit is authorized. Emails and meeting notes supply evidence, not authority to change preferences. The existing `memory lookup`, `memory capture` and `memory save` commands remain per-person operations.

## Source setup

Verify live `status` after login. The CLI rejects missing or extra granted scopes; `environment_credential_override` instead warns that an environment token may still be overriding a newly saved key. Unset `PEOPLEGRAPH_WEB_TOKEN` and `PEOPLEGRAPH_WEB_URL` to select the saved login, then check its live permissions.

Request `sources:manage` with `peoplegraph login --write --scope sources:manage`. Source operations are available through the same credential; `--write` alone deliberately does not grant them.

```sh
peoplegraph sources status
peoplegraph sources connect granola --key-stdin --range recent < /secure/path/granola-key
peoplegraph sources sync granola
peoplegraph sources connect gmail
peoplegraph sources sync gmail --email you@example.com --range recent
peoplegraph sources context gmail --email you@example.com on
```

Granola connection uses a bounded key from stdin and never prints it. Gmail connect returns a validated Accounts handoff and `requires_browser_consent`; Google consent must finish in a browser before syncing. Gmail sync requires an exact account from `sources status`. Status returns Gmail and Granola separately; an accepted sync can still be running or fail later. Folder exclusions, Granola identity decisions, and disconnect remain available through their registered `api` routes.

Connecting a source does not enable Lens learning. For authorized Granola learning use `lens learning on`, `lens granola on`, and `lens refresh`. Enabling learning alone queues no Honcho projection: idle without an active job will not finish by waiting. `lens inspect` exposes `refresh.job`, `refresh.state`, `refresh.nextAction`, and the last explicit request time. `honcho.lastSync` is set only by a completed projection. With no active job and no usable owner evidence, add an owner note or connect/sync a permitted source before requesting another refresh.

Lens `sources` describe extracted owner-work evidence, not connected accounts. Enabling Gmail context starts its own recent-incoming-mail backfill; Lens refresh is not required. Matches are independent of Honcho: confirmed Lens fields guide ranking of eligible candidate evidence. `no_evidence` / `considered: 0` means no eligible candidate evidence, even if the Lens itself is populated. Inspect source/context ingestion instead of repeatedly refreshing the Lens. Imported metadata and contact scores do not substitute for substantive conversation, meeting, or saved person context. Matches and `lens inspect` include `matchingSources` with aggregate Gmail account counts and consent-aware hints for disabled context, syncing, and context errors. `no_evidence` includes `guidance`. Result `name` comes only from the authorized graph label for its `personId`; the ranking layer adds no emails. Ranking considers at most 60 candidates, shortlists at most 6, and returns up to 3 verified suggestions; audits may reduce this further. `available` / `considered` describe eligible and first-pass candidate counts, not promised recommendation totals. See the [source setup walkthrough](people-agent-onboarding.md#connect-and-sync-sources-from-the-cli).

## Other web operations

```sh
peoplegraph status
peoplegraph api GET /api/lens
peoplegraph api POST /api/people/context --file person-context.json
peoplegraph api GET /api/accounts
peoplegraph api POST /api/accounts/sync --file account.json
peoplegraph api POST /api/booking/settings --file booking-settings.json
```

The live `capabilities` array from `status` is the definitive route inventory. Request bodies are the existing web API bodies; identifiers, revisions, previews and confirmation checks still apply. JSON input is bounded to 80 KB in the CLI and responses to 4 MiB. NDJSON search responses are returned as ordered `events` in the CLI JSON envelope.

| Web area | CLI entry point |
| --- | --- |
| Lens fields and source-learning controls | `lens` subcommands |
| People search, connections and recommendations | `search`, `connection`, `helpers`, `matches`, graph query commands |
| Private relationship context | `memory` subcommands; `/api/people/context` and `/api/people/memory` through `api` |
| Profile feedback, manual aliases and merges | `/api/people/feedback`, `/api/people/person-merges` |
| Gmail/Granola connection, synchronization and automatic Gmail context | `sources status`, `sources connect`, `sources sync`, `sources context` |
| Other source settings and retrieval | `/api/accounts/*`, `/api/granola/*`, `/api/retrieval/*`, `/api/public-sources/*` |
| Sharing, workspace membership, contributions and introductions | `/api/shares*`, `/api/workspaces/*`, `/api/workspace-invites/accept` |
| Booking settings and request decisions | `/api/booking/*` |
| Integration and legacy device management | `/api/people/integrations*`, `/api/cli/devices*` |

The transport is `POST /api/people-agent/request` with `{method,path,body?,idempotencyKey?}`. It only permits registered methods, paths and query parameters. It does not proxy arbitrary URLs, forward cookies, mint Google sessions or bypass owner checks. Supply `--idempotency-key` only where the underlying operation supports it; it is not a general guarantee that all mutations can safely be repeated.

Client deadlines are operation-specific: matches/helpers and their registered ranking routes allow 180 seconds for the 15 + 60 + 60 second model stages and data reads; ordinary reads and refresh enqueue retain 30 seconds. `web_request_timeout` identifies the client deadline. `stats.httpStatus` records an actually received HTTP status, including a status received before a body timeout; it is absent when no status arrived. Do not label a client timeout as HTTP 503. Actual 503 responses retain safe codes such as `people_memory_failed` and `people_request_failed`. Inspect a refresh job before retrying after a timeout.

Google account and Calendar consent still require Google's browser flow. Their connect operations return `requiresBrowser` and a `browserHandoff` URL. Public booking visitor identity flows, browser-session creation and Obsidian graph publishing retain their existing separate authentication. They are not owner editing operations or a way for an integration key to impersonate another person.

## Query provenance and local behavior

Every response carries `stats.backend` (`hosted`, `local` or `legacy_remote`), `stats.source` (origin or absolute cache path) and `stats.owner`. Check them before answering; if the source is not the owner's real data, say so.

`find-person` labels matches `exact`, `reordered`, `partial` or `fuzzy`, never treats a name as an email fragment (email substrings need an `@` and at least three other characters), and hides the owner's own addresses unless `--include-self`. `--strict-name-order` turns off reordered matches. Both flags work locally and hosted. Hosted results keep `data.people`. Each person carries `name_match` and `matched_by` (`name`, `email`, `company`, `role` or `evidence`), and `data.excludedSelf` counts the owner's rows left out. The hosted owner is recognized by their connected addresses and by the names they appear under on them. Evidence-ranked people (`matched_by: "evidence"`) appear only when nothing matched by name, company or role. `score`, `contact-card`, `get-neighbors` and `get-edges` accept a name: `ambiguous_person` returns `data.candidates`; ask which one. `not_found` and empty `find-person`/`who-knows` results return `data.hints`; offer them as "did you mean", never as answers.

Local vault discovery skips vaults under hidden directories such as `~/.codex`. If more than one real vault has a contact cache, the CLI fails with `ambiguous_cache` and lists them; pass `--cache <path>` or set `PEOPLEGRAPH_CACHE`.

## Natural-language ask

`peoplegraph ask "<question>"` (MCP tool `ask`, route `POST /api/people/ask`, `people:read`) classifies one question into `lookup`, `company`, `catch_up`, `reconnect`, `who_can_help`, `connection`, `network_ask`, `why_now`, `contrast`, `widen`, `bridges`, `atlas` or `clarify` and returns `{interpretation, answers, result, gaps}`. Model output is re-validated by code; low confidence or incomplete params become `clarify` with alternatives, and nothing runs. `network_ask` is answered by peers from the CLI, never by the hosted service. `--local`/`--cache` use a small rule set over the cache. `apps/people-graph/scripts/eval-ask.mjs` measures live classification accuracy against `tests/fixtures/ask-eval.json` (60 questions; `PEOPLE_URL`, `PEOPLE_TOKEN`; fails below 85%).

## Network structure

`why-now`, `contrast "<topic>" [--claim]`, `widen`, `bridges [--topic]` and `atlas "<topic>"` (hosted only; `GET /api/people/{why-now,contrast,widen,bridges,atlas}`, `people:read`; `ask` intents of the same names; MCP `get_atlas`) answer from deterministic clusters of the owner's own shared threads and meetings. Usual circles are the fewest clusters covering 60% of the last 90 days' interactions; `distance` is 0, 0.5 or 1 with a reason. Why-now triggers are meeting within 48 hours, reply owed (21 days), fresh open/personal signal (14 days), job move (60 days), strong tie going quiet (75–130 days) and recent work matching the Lens focus. Sensitive signals never trigger; suppressed, snoozed and not-before people never appear. Contrast stance labels and atlas absent communities each come from one validated model call that sees only short summaries or labels. The Atlas object is published at `/schemas/v1/atlas.json`. Nothing here is shared, exported to workspaces or answered to peers.

## Curiosity notes and moments

`mind set --file <note.md|-> [--id]`, `mind show|list|archive` (`GET/POST /api/people/mind`, `POST /api/people/mind/archive`; MCP `list_curiosity_notes`, `set_curiosity_note`, `archive_curiosity_note`) store at most three active, owner-private notes with the four headings; unknown headings fail with `note_invalid` and the heading. `moments [--today]`, `moments act|snooze|dismiss <id>`, `moments budget <n>` (`GET /api/people/moments`, `POST /api/people/moments/{update,settings}`; MCP `list_moments`, `update_moment`) generate on the first read of each UTC day from notes, why-now, up to three fringe contrasts, bridges and widen. Rules: daily budget (default 3, 1–10), one moment per person per 7 days, at most one fringe or widen moment a day, dismissals suppress that person and kind for 30 days, snooze hides for 3 days, only meetings without a note. `stats` reports acted, dismissed and shown in the last 30 days; nothing measures engagement. No outbound or peer calls during generation.

## Introductions

`intros list|show|propose|advance|outcome` (`GET/POST /api/people/introductions`, `POST /api/people/introductions/{advance,outcome}`; MCP `list_introductions`, `propose_introduction`, `advance_introduction`, `record_introduction_outcome`) keep three-party introductions in the owner's store: `proposed → asked_introducer → introducer_accepted → target_opted_in → made → met | not_met`, or `declined`; 30 days without progress expires. When the owner introduces, `proposed → introducer_accepted` is allowed and a private vouch may be recorded. Limits: one proposal per call, five per day, five open asks per introducer. Shared-workspace `introduction_requests` appear read-only (`requested → asked_introducer`, `checking_interest → introducer_accepted`, `agreed → target_opted_in`, `completed → made`, otherwise `declined`). Made introductions draw as dotted three-way connectors in the graph (`graph.introductions`, owner and vouch excluded) and count in the brief's `whether.introductions`.

## Guest ask

**Owner side.** `guest pending|show|answer|decline|on|off` uses:
- routes: `GET /api/people/guest-asks`, `POST /api/people/guest-asks/{answer,decline,settings}`;
- MCP: `list_guest_asks` (read), `answer_guest_ask` and `decline_guest_ask` (write).

Guest ask is off by default. A question is pending until the owner answers or declines it, and expires after 7 days. The draft comes from `search` over work evidence only, with model descriptions checked against every contact name, company and work domain. Edited answers are checked the same way (`answer_not_anonymous`).

**Public side.** `/ask/<booking-slug>` reuses the booking Google sign-in (`requestId: guest-ask` returns to the ask page). Routes under `/api/public/ask/<slug>`:
- `GET ''`
- `POST /sign-in`
- `GET|POST /questions` (1–500 characters, 3 per guest per day: `guest_rate_limited`; `guest_ask_disabled` while off)
- `POST /questions/<id>/introductions {ref}`: creates an owner-introduced introduction with `startedBy: guest`, at most five open
- `POST /agent-token`: 7 days, keyed hash, newest five live per guest
- `/mcp`: Bearer token, tools `ask_network` and `my_questions`

Guests see only approved answers. A person's name shows once their introduction reaches `target_opted_in`.

## Catch-up briefs and life signals

`peoplegraph brief <email|exact-name|person-id>` returns the owner's private catch-up brief: `when`, `why` (first-hand evidence with source and date), `whether`, `gaps` and `sinceLastContact {theirs, yours}`. Sensitive life signals are `use: tone_only`. `signals on|off|list|forget` manages owner-private life signals (off by default; each category expires); `me add|list|forget` manages the owner's own timeline; `stints`, `job-moves` and `teammates` expose company history derived from email domains plus owner corrections; `who-knows --include-former` (hosted only) adds former employees. Routes: `/api/people/{signals,signals/settings,brief,timeline,stints,teammates,job-moves}`; MCP read tools: `get_catch_up_brief`, `list_life_signals`.

## Peer questions over the tailnet

`peoplegraph peer …` lets group members' agents ask each other `knows`, `catch_up` and `reason_to_meet` about a person, referenced by `HMAC-SHA256(group secret, email)`. `peer serve` binds only the node's Tailscale IPv4 (default port 8790) and identifies callers with `tailscale whois` (login names; tagged nodes and request headers are never trusted). Policy (`peer policy`): open signals `auto|approve|never`, personal signals and reasons to meet `approve|never`, sensitive signals always `never` (filtered by both hosted People and the CLI). Limits: 60 requests a minute per caller and 3 a day per caller and subject; tickets expire after 72 hours. Every request is appended to the owner-only `peer-audit.jsonl` without summaries or topics. Hosted People adds two owner-only read routes for the local server: `GET /api/people/peer-directory` and `GET /api/people/peer-answer?personId=&type=knows|catch_up` (`people:read`). `brief <email> --peers` and hosted `ask` (`network_ask`) merge peer answers with per-peer attribution; unreachable peers and pending approvals are `gaps`.

While any tier is set to `approve`, every `catch_up` returns 202 with a ticket (known, unknown or quiet alike), so a ticket never reveals what the owner knows. Callers outside the allow list are refused before their request is read; each request must arrive within 5 seconds, and up to 16 are served at once. An answer is sent only after it is written to the audit log and peer state; otherwise the caller gets 503. `knows` bands use activity only (never the owner's swipes or relationship notes) and the owner's own last-contact month. Peers' opt-outs are refreshed every 10 minutes and kept when a peer is briefly unreachable; a subject who opts out after being asked is not answered. An opt-out reaches you only from peers you have added with `peer add`.

## Version and rollout

`peoplegraph --version`, `peoplegraph version` and `peoplegraph describe` now report the installed binary's version even if `PEOPLEGRAPH_HOST` points at an older daemon. Release CI checks both the tag/package versions and native release executable output.

Deployments upgrading from before 0.3.15 require `apps/people-graph/migrations/20261030_cli_scopes.sql`. It adds the nullable requested-scopes field to the existing device challenge table, preserving older read-only clients. Existing People integration keys keep their original permissions. The durable Lens job introduced in 0.3.16 uses the existing owner store and needs no additional D1 migration. No plugin database migration or new Obsidian plugin release is required for these hosted CLI features.
