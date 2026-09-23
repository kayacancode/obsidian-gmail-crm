# Unified People CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the existing CLI query the signed-in website's network after one browser approval, while preserving local Obsidian commands.

**Architecture:** Extract the current website graph loader into a shared service. Add narrowly scoped device credentials and versioned query routes; the Rust client stores an origin-bound web profile separately from its existing generic HTTP-server settings.

**Tech Stack:** Rust/clap/ureq/serde, TypeScript, Cloudflare Workers and D1, existing MailSync Durable Object, plain browser JavaScript.

**Spec:** `docs/superpowers/specs/2026-09-22-unified-people-cli.md` (approved September 22, 2026).

## Global Constraints

- No new graph, Gmail sync engine, or per-inbox credentials.
- Expire pending challenges after ten minutes. Device credentials expire after 30 days.
- Store opaque, 256-bit device credentials hashed server-side; read-only scope only.
- No credential is placed in URLs. Use HTTPS except localhost development.
- Preserve source, score model, missing values, sharing restrictions, snapshot limits, and data freshness.
- Web failures never silently fall back to local data. Local mutations remain local-only.
- Preserve existing CLI HTTP-server mode, `--host` behavior, and local commands.
- Preserve unrelated working-tree changes. Build in an isolated `codex/` worktree.

## Review Focus

- Browser approval and concurrent polling: only one approval and one credential redemption can succeed (Task 2).
- Account switch during approval: the browser displays the approving owner and requires explicit confirmation (Task 3).
- Unavailable email identity, Obsidian IDs, or stale sharing: return only visible people without guessing identity or retaining revoked evidence (Task 1).
- A host override or HTTP redirect: never forward the persisted device credential to another origin (Task 4).
- Interrupted profile write or failed logout: retain a recoverable profile and report the actual revocation state (Task 4).

### Task 1: Shared graph loading and read-query contract

**Files:** Create `apps/people-graph/src/people-service.ts`, `apps/people-graph/src/cli-query.ts`, `apps/people-graph/tests/cli-query.test.ts`; modify `src/index.ts`, `src/mail-sync.ts`, and `tests/run-mail.mjs` within that app.

**Interfaces:**

```ts
type QueryCommand = 'find-person' | 'contact-card' | 'who-knows' |
  'score' | 'get-neighbors' | 'get-edges' | 'reconnect';
type QueryInput = {command: QueryCommand; query?: string; personId?: string;
  email?: string; company?: string; from?: string; to?: string;
  limit?: number; min_score?: number};
type QueryEnvelope = {ok: boolean; command: string; data?: unknown;
  stats?: {contractVersion: 1; source: string; scoreModel: string | null;
    updatedAt: number | null}; error?: {kind: string; message: string}};
```

Produce `loadPeopleNetwork(env, owner, source)` by extracting `getGraph`'s existing data-loading body, retaining its existing graph result type. Produce `queryPeople(env, owner, input): Promise<QueryEnvelope>`. Both receive an already authenticated owner, never an owner from the request body. Introduce a MailSync method `resolveOwnEmail(email: string): Promise<string|null>` that only resolves recorded own-network identities; verify its result belongs to the current visible snapshot before querying. Shared-only and Obsidian identities use IDs or name candidates.

- [ ] Write parity tests before extraction: signed-in `/api/graph` and `loadPeopleNetwork` return equal account, graph, and timestamp for email data, empty-email Obsidian fallback, and Granola augmentation. Use existing signed-session fixtures from `tests/routes.test.ts`.
- [ ] Add the new test import to `tests/run-mail.mjs`; run `cd apps/people-graph && npm test` and confirm the new missing-module failure.
- [ ] Extract loading without altering response/error behavior. Preserve `refreshShares`, owner binding, source selection, and pushed-graph normalization.
- [ ] Add fixtures containing overlapping inbox identities, shared-only people, missing scores/dates, ambiguous names, and revoked shares. Assert all seven commands use only snapshot members; edge endpoints must both be visible. Resolve email without returning undisclosed addresses. Use current search service for semantic evidence; never outsource shared evidence through a new path.
- [ ] Implement projections with deterministic tie-breaking by ID, default limit 20, maximum 200, and a 200-character query bound. Return `ambiguous_person` plus candidates for ambiguous singular queries, `not_found` for absent identities, and `invalid_request` for invalid limits/commands. Missing scores remain null. Reconnect omits unknown dates and sorts elapsed time descending, then known strength descending, then ID; document this distinct web ranking.
- [ ] Run `npm test` and `npm run typecheck`; commit the shared service and its tests only.

### Task 2: Scoped device authorization and query routes

**Files:** Create `apps/people-graph/src/cli-auth.ts`, `src/cli-routes.ts`, `migrations/20260922_cli_devices.sql`, `tests/cli-auth.test.ts`; modify `schema.sql`, `src/index.ts`, and `tests/run-mail.mjs`.

**Interfaces:**

```text
POST /api/cli/device/start   {deviceName} -> {challengeId,pollSecret,userCode,verificationUri,expiresAt,interval:5}
POST /api/cli/device/poll    {challengeId,pollSecret} -> pending | {token,owner,expiresAt}
POST /api/cli/device/approve {userCode} -> {approved:true} (browser session + Origin required)
GET  /api/cli/devices        -> {devices:[{id,name,createdAt,expiresAt}]} (browser auth)
POST /api/cli/devices/revoke {id} -> {revoked:true} (browser auth + Origin)
POST /api/cli/logout         -> {revoked:true} (device bearer)
POST /api/cli/v1/query       QueryInput -> QueryEnvelope (device bearer)
```

Produce `authenticateDevice(request, env): Promise<{owner:string;deviceId:string}|null>`; consume `queryPeople` from Task 1. Browser routes use existing Google session authentication without accepting device tokens as browser credentials.

- [ ] Write failing route tests for unauthenticated approval, foreign Origin, wrong polling secret, expiration, double approval, concurrent redemption, cross-owner revocation, revoked tokens, and scope isolation. Assert a device bearer cannot push, draft, share, sync, or mint other tokens.
- [ ] Define additive D1 tables: `cli_challenges` (ID, poll-secret hash, unique user code, device name, status, owner, created/expiry/last-poll times), `cli_devices` (ID, unique token hash, owner, name, creation/expiry/revocation times), and `cli_rate_limits` (hashed client key, window, count). Add indices for owner and expiry. Keep migration and fresh schema synchronized.
- [ ] Generate secrets with `crypto.getRandomValues(new Uint8Array(32))`, encode base64url, and hash with SHA-256. Use conditional SQL updates and atomic D1 batches for approval/redemption. A redemption race must never create two credentials; failed redemption requires a new login. Never store a recoverable bearer token.
- [ ] Enforce 5-second polling, 10 starts per client per 10 minutes, 20 approval attempts per owner per 10 minutes, and 60 query requests per device per minute. Hash client address with the existing server secret; bound names to 80 characters and request bodies to 4 KiB. Delete expired challenge/rate rows opportunistically in bounded batches. Return `429` with retry timing.
- [ ] Prefix device bearers `pgd1_` and reject them in `requireGoogleUser` before its Google token-info request, so they never reach Google URLs. All credential responses use `Cache-Control: no-store`; all errors redact request credentials and database details.
- [ ] Register exact routes before the API fallback; do not widen authentication for existing endpoints. Run web tests and typecheck. Exercise the migration twice against a temporary local D1 database to verify idempotence, then commit.

### Task 3: Browser approval and device management

**Files:** Create `apps/people-graph/public/cli.html`, `cli.mjs`, `cli-devices.mjs`, `tests/cli-browser.mjs`; modify `public/accounts.html`, `accounts.mjs`, and `package.json`.

**Interfaces:** Consume Task 2 browser APIs. Export `createCliDevices({root,request})` with `setAccount(owner)` and `clear()` methods, following the existing Accounts integration modules. Approval lives at `/cli` and accepts a human-entered user code; no secret in the URL.

- [ ] Add browser tests for signed-out approval, expired code, account switch, pending approval, success, failed revocation, and keyboard navigation. Use the existing browser-test runner conventions and mocked route responses.
- [ ] Reuse Google configuration and session creation; show device name, signed-in owner, read-only scope, expiry, and an explicit Approve button. Show a clear instruction to return to the terminal after success. Add an authenticated challenge-preview route by user code to Task 2, with the same attempt bounds; never approve during preview or page load.
- [ ] Render device names using `textContent`. Accounts lists devices and expiry, supports revocation, clears rows on sign-out, and ignores responses from an earlier account generation. A network error must not remove the visible device as though revocation succeeded.
- [ ] Run browser tests, web suite, and typecheck; inspect approval and Accounts layouts. Commit UI and tests.

### Task 4: Rust login, profile, and backend selection

**Files:** Create `crates/peoplegraph/src/web_profile.rs`, `web_client.rs`; modify `src/main.rs`, `Cargo.toml`, and workspace lockfile only if needed.

**Interfaces:**

```rust
#[derive(serde::Serialize, serde::Deserialize)]
pub struct WebProfile {
    pub version: u8,
    pub backend: String, // exactly "people-web"
    pub origin: String,
    pub owner: String,
    pub token: String,
    pub expires_at: u64,
}
```

Implement `load_profile`, `save_profile`, and `remove_profile` in `web_profile.rs`; each takes an explicit path for testing. Implement `login`, `logout`, and `query` in `web_client.rs` returning the existing CLI response envelope. Add `Login`, `Logout` commands and global `--local`. Use the existing ureq stack; disable redirects for credential-bearing requests.

- [ ] Write Rust tests for legacy `--host`/`--remote`/environment behavior, explicit local selection, expired profiles, invalid origins, redirects, malformed responses, unsupported web mutations, and profile-write failure.
- [ ] Add platform configuration directory resolution: macOS Application Support, Windows APPDATA, Linux XDG_CONFIG_HOME or `.config`; keep profile path injectable in tests. Create private directory and exclusive temporary file, apply owner-only Unix permissions before writing, flush, then atomically rename. On Windows use current-user-restricted storage permissions rather than assuming Unix modes apply. Do not overwrite the prior valid profile on failure.
- [ ] Login validates HTTPS origin (HTTP only loopback), starts the challenge, prints URL and human code, and opens the browser using a subprocess argument array without a shell. Poll until approval/expiry with bounded timeouts; honor server retry timing. An unavailable browser leaves copyable manual instructions. Save only after success.
- [ ] Select backend in this order: explicit `--local`; explicit legacy host/remote settings; stored People web profile; existing local default. Reject conflicting flags. Never attach a stored People token to legacy host overrides. Surface web authentication/network errors without falling back.
- [ ] Map the seven read commands to `/api/cli/v1/query`, preserve `json`/`jsonl` envelope output, and reject web writes before HTTP dispatch. Logout revokes remotely before removing the profile; on offline failure retain it and report that revocation is incomplete.
- [ ] Run `cargo test --manifest-path crates/peoplegraph/Cargo.toml --locked`, then compile and exercise the actual executable against a mock HTTP server. Commit client and tests.

### Task 5: End-to-end verification and release

**Files:** Create `apps/people-graph/tests/cli-integration.mjs`, `docs/peoplegraph-web-login.md`; modify app test scripts, `crates/peoplegraph/Cargo.toml`/lockfile, CLI README, and release artifacts according to existing packaging conventions.

**Interfaces:** Real compiled CLI against a local Worker and temporary D1; use browser sessions for approval. Release CLI as 0.3.11 only after integration passes.

- [ ] Add an integration scenario: login start → browser approval → token redemption → website/CLI graph parity → revocation → rejected query. Repeat with two different owners and prove no cross-owner access. Include legacy local and generic-server regression commands.
- [ ] Run the web test suite, typecheck, CLI tests, approval browser tests, and the integration scenario. Review all security and shared-data changes before deployment; resolve findings and rerun affected checks.
- [ ] Document installation, login, source/score output, expiry, logout failure, device revocation, local mode, and legacy-host precedence. Avoid editing the user's uncommitted documentation copies from the main working directory.
- [ ] Apply the additive migration before deploying the Worker; verify existing Accounts and graph routes still operate. Publish/build/install CLI 0.3.11 with rollback to the preserved 0.3.10 binary.
- [ ] Start a production CLI login for the user to approve, then compare one CLI result with that owner's website. Report deployment/install versions and verification evidence. Do not call the integration complete while production login or parity verification remains outstanding.

## Execution recommendation

Native execution in this task, with one independent review before release. The auth and client steps depend closely on the same small contract, so a single implementer avoids unnecessary handoffs. Native execution completed. The Worker is deployed and CLI 0.3.11 is installed and released. User-approved production login and a live query/browser record comparison passed. Independent review findings were fixed and rechecked. Windows web credential storage was explicitly deferred because supported release targets are macOS and Linux; it fails closed. PR #8 contains the source changes and is not merged.
