# Agentic People: Peer layer over the tailnet (sub-project 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (native). Steps use checkbox (`- [ ]`) syntax.

**Goal:** Members of a trusted group (the Betaworks tailnet) let their agents ask each other three fixed questions about a person (`knows`, `catch_up`, `reason_to_meet`). Each answer is computed on demand by the answering owner's agent under that owner's policy. It is attributed, expiring and logged, and never stored centrally.

**Architecture:**
- **Hosted People** gains two owner-only read routes the local peer server uses with the owner's own credential:
  - `GET /api/people/peer-directory` lists the owner's own contacts as `{personId, emails}`;
  - `GET /api/people/peer-answer?personId=&type=knows|catch_up` returns a coarse band, last contact month, and **open/personal** unexpired signals (summary only).

  Sensitive signals and quotes never leave the hosted service through these routes.
- **The Rust CLI** gains `crates/peoplegraph/src/peer.rs`:
  - config (`peers.json`), HMAC references (`ring`, already in the lockfile via ureq);
  - the policy engine, approval tickets, the JSONL audit log and subject opt-outs;
  - a minimal HTTP server bound to the node's Tailscale IPv4, with caller identity from `tailscale whois`;
  - the asking side's fan-out.
- **Testability.** I/O is behind small traits (`Identity`, `Source`, `Clock`), so the handler is tested in-process.

**Spec:** `docs/superpowers/specs/2026-11-20-agentic-people-design.md` ("Sub-project 3: Peer layer over the tailnet", "Privacy partition").

## Global Constraints

- **Binding.** `peer serve` binds only to a Tailscale IPv4 address (100.64.0.0/10), port 8790 by default, over plain HTTP. Any other address is refused with `tailscale_unavailable`.
- **Caller identity** comes from `tailscale whois --json <remote ip:port>` → `UserProfile.LoginName`, never from request headers. Tagged/unknown nodes and logins not in `allow` get 403 `peer_not_allowed`.
- **Config file.** `peers.json` lives in the same directory as `config.json`, written owner-only and atomically. Shape: `{version:1, group, pepper, allow[], peers[{login,url}], doNotAnswerAbout[], policy:{open,personal,reason_to_meet}}`.
  - `policy.open` is `auto|approve|never`; `personal` is `approve|never`; `reason_to_meet` is `approve|never`.
  - Sensitive is fixed at `never` and cannot be configured.
  - The pepper is 32 random bytes (base64url) and is never printed.
- **Person references:** `HMAC-SHA256(pepper, lowercase(trim(email)))` in hex. The peer resolves them against its own directory, aliases included.
- **Requests:**
  - `POST /peer/v1/query {type:'knows'|'catch_up'|'reason_to_meet', person?, topic?, requestId}`;
  - `GET /peer/v1/tickets/<id>`;
  - `GET /peer/v1/opt-outs`.
- **Answers:**

  | Type | Response |
  |---|---|
  | `knows` | `{known:false}` or `{known:true, band:'strong'\|'some'\|'light', lastContactMonth}` |
  | `catch_up` | Always `{signals:[{category, summary, observedMonth, expiresAt}]}`; an unknown person gives `{signals:[]}` |
  | `reason_to_meet` | 202 `{ticket}`, then `{topic, reason}` after approval |

  Personal-tier signals under `approve` produce 202 `{ticket}`, answered after `peer approve`.
- **Opt-outs.** A subject in any group member's `doNotAnswerAbout` (fetched from peers' `/peer/v1/opt-outs`, plus the server's own) gets 403 `subject_opted_out` for `knows`/`catch_up`.
- **Limits:**
  - 60 requests per minute per caller → 429 `peer_rate_limited`;
  - at most 3 requests per caller per subject per day → 429 `peer_rate_limited`;
  - tickets expire after 72 h → 410 `ticket_expired`;
  - JSON bodies ≤ 4 KB; `topic` and `reason` ≤ 200 chars.
- **Audit.** Every request is appended to `peer-audit.jsonl` as `{at, caller, type, person, outcome, categories}`, with no summaries and no topics.
- **Asker fan-out.** `peer ask knows|catch-up <email> | reason-to-meet --topic <t>` sends to every configured peer with a 10 s timeout and attributes results per login. Unreachable peers go in `gaps`. `peer ask status --peer <login> <ticket>` fetches a ticket.
- **Background work.** Peers are never asked in the background.

## Review Focus

- A caller spoofing `X-Forwarded-For` or `Tailscale-User-Login` headers gets no identity from them.
- An unknown person and a known person with no open signals return byte-identical `catch_up` bodies (`{"signals":[]}`).
- A `personal` signal is never returned under `approve` before the owner approves the exact ticket. A sensitive signal is never returned in any configuration: a hosted filter plus a client filter (belt and braces).
- `peers.json` with group/world-readable permissions or owned by someone else is refused, as for `config.json`.
- The pepper or a token never appears in output, the audit log or errors.

### Task 1: Hosted peer read routes

**Files:** `apps/people-graph/src/mail-sync.ts` (RPCs `peerDirectory()`, `peerAnswer(personId,type)`), `src/life-routes.ts` (routes), `src/index.ts` and `src/people-machine.ts` (capabilities, `people:read`). Test: `tests/peer-routes.test.ts`.

- **`peerDirectory()`:** from `mergeIdentities()` grouped by canonical id → `{people:[{personId,emails}]}`. The owner's own addresses are already excluded by `mergeIdentities`.
- **`peerAnswer`:**
  - `knows`: the graph node gives `combined`. The band is strong ≥ 60, some ≥ 30, otherwise light. `lastContactMonth` is `lastContact` sliced to `YYYY-MM`, or null.
  - `catch_up`: `listLifeSignals(personId)` filtered to `tier !== 'sensitive'`, mapped to `{category,tier,summary,observedMonth,expiresAt}`. No quote and no `sourceRef`.

- [ ] **Step 1: Failing tests:**
  - The directory lists Ada with her email.
  - `peer-answer` `knows` for Ada gives `known:true` and a band.
  - `catch_up` with an open, a personal and a sensitive signal returns only open and personal, without quotes.
  - An unknown personId gives `{known:false}` / `{signals:[]}`.
  - A machine read principal may call both.
- [ ] **Steps 2–5:** red, implement, green, full suite and typecheck; commit `feat(people): owner-only peer directory and coarse peer answers`.

### Task 2: Peer core in Rust (config, HMAC, policy, tickets, audit, limits)

**Files:** Add `ring = "0.17.14"` to `crates/peoplegraph/Cargo.toml` (run `cargo build` once to update the lockfile). Create `src/peer.rs` with pure logic and file stores, and unit tests in it.

**Interfaces:**

```rust
pub(crate) struct PeerConfig { version:u8, group:String, pepper:String, allow:Vec<String>, peers:Vec<PeerRef>, do_not_answer_about:Vec<String>, policy:Policy }
pub(crate) fn person_ref(pepper:&str, email:&str) -> String; // hex HMAC
pub(crate) enum Decision { Answer(Value), Ticket(String), Deny(u16, &'static str) }
pub(crate) trait Source { fn directory(&self) -> Result<Vec<(String, Vec<String>)>, String>; fn answer(&self, person_id:&str, kind:&str) -> Result<Value, String>; }
pub(crate) trait Identity { fn login(&self, remote:&std::net::SocketAddr) -> Option<String>; }
pub(crate) struct PeerState { tickets:Vec<Ticket>, recent:Vec<(String,String,u64)> } // persisted in peer-state.json
pub(crate) fn handle(config:&PeerConfig, state:&mut PeerState, source:&dyn Source, caller:&str, method:&str, path:&str, body:&[u8], now:u64, opted_out:&HashSet<String>) -> (u16, Value, AuditEntry);
```

**Steps:**
- [ ] **Step 1: Failing unit tests (in `peer.rs`):**
  - `person_ref` is stable and lowercases its input, and matches a known HMAC-SHA256 vector (RFC 4231 test case 2, adapted: key "Jefe", data "what do ya want for nothing?" → `5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843`).
  - A caller not in `allow` gets 403.
  - `knows` for a known person returns the band; an unknown person returns `{known:false}`.
  - `catch_up` under `policy.open=auto` returns open summaries only. A personal signal under `approve` returns 202 with a ticket and no signal; after approve, the ticket fetch returns the personal signal; an expired ticket gives 410.
  - A sensitive signal from a misbehaving source is still dropped.
  - Unknown versus known-but-empty `catch_up` bodies are identical.
  - Opted-out subjects get 403.
  - The fourth request for the same subject in a day gives 429, and the 61st in a minute gives 429.
  - Audit entries have no summary text.
- [ ] **Steps 2–4:** red, implement, green.
- [ ] **Step 5: Commit** `feat(cli): peer policy, references, tickets and audit`.

### Task 3: Peer commands and server

**Files:** `src/peer.rs` (CLI glue, server loop and asker) and `main.rs` (the `Peer(peer::PeerArgs)` variant, local-only, rejected with `--remote`/`--host`). Test: `tests/peer_cli.rs`.

**Commands:**
- `peer init --group <name>`, `peer join --group <name> --pepper-stdin`
- `peer allow <login>`, `peer disallow <login>`, `peer add <login> --url <url>`, `peer remove <login>`
- `peer opt-out on|off --email <addr>...`
- `peer policy --open auto|approve|never --personal approve|never --reason-to-meet approve|never`
- `peer status` (config without the pepper)
- `peer serve [--port 8790]`, which uses `tailscale ip -4`
- `peer pending`, `peer approve <ticket> [--reason <text>]`, `peer deny <ticket>`, `peer log [--since <YYYY-MM-DD>]`
- `peer ask knows|catch-up <email>`, `peer ask reason-to-meet --topic <text>`, `peer ask status --peer <login> <ticket>`

**Server details:**
- The real `Identity` shells out to `tailscale whois --json <addr>`; tests inject a fake through `PEOPLEGRAPH_PEER_TEST_IDENTITY=<login>`, which is honoured only when the bind is loopback in debug builds (`cfg(debug_assertions)`).
- The real `Source` calls hosted People with the owner's credential via `people_client`.
- Opt-out lists are fetched from configured peers at startup and every 10 minutes.

**Steps:**
- [ ] **Step 1: Failing tests:**
  - `peer init` creates `peers.json` with mode 0600 and the pepper absent from stdout.
  - `peer status` hides the pepper.
  - `peer serve --port 0 --test-bind 127.0.0.1` (debug only) serves `knows`, using a fake hosted origin fixture for the directory and answers.
  - `peer ask knows` against two peers, one of which is unreachable, attributes one answer and puts the other in `gaps`.
  - `peer approve` resolves a pending ticket.
  - `peer serve` without Tailscale returns `tailscale_unavailable`. Simulate with `PATH` emptied.
- [ ] **Steps 2–4:** red, implement, green, `cargo fmt --check` and the full suite.
- [ ] **Step 5: Commit** `feat(cli): serve and ask peers over the tailnet with owner policy`.

### Task 4: Brief integration, skill and docs

- [ ] `peoplegraph brief <email> --peers` runs `peer ask catch-up <email>` and merges peer results into `why` as `attribution:'peer:<login>'`, `use:'rank'`, listing peer gaps. Test it with a fixture.
- [ ] `ask`: when the hosted interpretation is `network_ask` and the CLI has `peers.json`, the CLI runs `peer ask knows` and `peer ask catch-up` for the person and adds `peerResults`. Test it.
- [ ] Skill and parity docs get a "Peers" section covering setup, approvals, privacy rules, and never asking in the background.
- [ ] Run the full verification and commit `docs(skill): peer questions over the tailnet`.
