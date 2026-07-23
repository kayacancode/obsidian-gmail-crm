# Reconnect Stable IDs + Diff Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Push the full re-engage pool to the swipe app daily with stable contact ids so swipes permanently exclude contacts, boost/suppress apply globally to people scores, deletes stay deleted, and sync sends only diffs.

**Architecture:** Three cooperating pieces: a Rust CLI (`peoplegraph`) that owns the contact index and feedback overlay on the source-of-truth machine; a dependency-free Node bridge script that computes stable HMAC ids and syncs diffs to a Cloudflare Worker; the Worker (+ static swipe UI) backed by D1. Identity fix: `id = HMAC-SHA256(salt, lowercase(email))[0..32]`, salt local-only, so a decision made any day excludes the contact forever via the Worker's decisions join.

**Tech Stack:** Rust (clap + serde), Node ≥18 ESM (no deps, `node --test`), Cloudflare Workers + D1, vanilla-JS static UI, wrangler v4.

**Spec:** `docs/superpowers/specs/2026-07-23-reconnect-stable-ids-design.md` (committed on `peoplegraph-cli`, copied onto the work branch in Task 1).

## Global Constraints

- Base branch is `origin/main` (John's line — it has the current bridge/CLI). The local `peoplegraph-cli` branch supplies the deployed, auth-gated Worker/UI files; everything else on `peoplegraph-cli` is out of scope.
- Privacy invariant: emails and the HMAC salt never leave the source-of-truth machine. D1 only ever stores opaque ids + display fields.
- The bridge script stays dependency-free (node builtins only).
- `reconnect-feedback.json` is written camelCase (`schemaVersion`, `updatedAtUnix`, `updatedUnix`); the CLI must ALSO accept legacy snake_case via serde aliases, and must fail loudly (not silently return an empty store) on a malformed file — a silently empty store is the bug that re-surfaced 1,341 boosted contacts on 2026-07-22.
- Feedback entry keys are lowercased emails. Delta default is 10, clamped so scores stay in 0–100.
- Swipe semantics (spec §Product decisions): boost = +delta to the people score globally; suppress = −delta globally; delete = removed from `contact-index.json` + blocklisted. Any feedback entry (incl. `shown` within its 30-day cooldown) excludes a contact from the reconnect pool.
- Worker sync API becomes `{ upserts, remove_ids, reset? }`; `batch_date` is removed everywhere. `/api/candidates` stays auth-gated (Google allowlist) and returns at most 500 rows.
- Every commit message ends with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Work branch + restore deployed Worker/UI

The deployed Worker (verified live: unauthenticated `/api/candidates` → 401) is built from `peoplegraph-cli`, but `origin/main`'s copy is the older public-read variant. Start from `origin/main` and overwrite the Worker/UI files with the deployed versions so a future deploy can't remove the auth gate.

**Files:**
- Create branch: `reconnect-stable-ids` from `origin/main`
- Overwrite from `peoplegraph-cli`: `apps/reconnect-web/src/index.ts`, `apps/reconnect-web/public/index.html`
- Copy from `peoplegraph-cli`: `docs/superpowers/specs/2026-07-23-reconnect-stable-ids-design.md`

**Interfaces:**
- Produces: branch `reconnect-stable-ids`; Worker source with `requireGoogleUser` gating `GET /api/candidates` and UI with `waitForGoogle()`/`renderGate()` (later tasks modify these exact files).

- [ ] **Step 1: Create the branch**

```bash
cd /Users/kayajones/betaworks/obsidian-gmail-crm
git fetch origin
git checkout -b reconnect-stable-ids origin/main
```

- [ ] **Step 2: Restore the deployed Worker/UI + spec**

```bash
git checkout peoplegraph-cli -- \
  apps/reconnect-web/src/index.ts \
  apps/reconnect-web/public/index.html \
  docs/superpowers/specs/2026-07-23-reconnect-stable-ids-design.md
```

- [ ] **Step 3: Verify the auth gate is present and the Worker typechecks**

```bash
grep -n "requireGoogleUser(request, env)" apps/reconnect-web/src/index.ts   # expect a hit inside listCandidates
cd apps/reconnect-web && npm run typecheck && cd ../..
```
Expected: grep shows `listCandidates` calling `requireGoogleUser`; `tsc --noEmit` exits 0.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "reconnect: restore deployed auth-gated worker/UI onto main line

origin/main still had the public-read variant; the deployed Worker is the
peoplegraph-cli build with the Google allowlist gate and GIS race fix.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: CLI — feedback store: serde aliases, lowercased keys, loud failure

`read_feedback` currently swallows parse errors and returns an empty store (`crates/peoplegraph/src/main.rs`, `fn read_feedback`), which makes every swiped contact reappear. Make malformed files a hard error, accept legacy snake_case, and normalize entry keys to lowercase.

**Files:**
- Modify: `crates/peoplegraph/src/main.rs` — `FeedbackStore`/`FeedbackEntry` structs (~line 363), `fn read_feedback` (~line 2774), every `read_feedback(` call site (`reconnect`, `feedback`)
- Test: `#[cfg(test)] mod tests` at the bottom of `main.rs` (~line 4525)

**Interfaces:**
- Produces: `fn read_feedback(path: &Path) -> Result<FeedbackStore, String>` — `Ok(default)` when the file is missing, `Err(msg)` when present but unparseable; entry keys lowercased. Tasks 3–5 call this exact signature.

- [ ] **Step 1: Write the failing tests** (append inside `mod tests`)

```rust
    fn tmp_file(name: &str, content: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("pg-test-{}-{}", std::process::id(), name));
        std::fs::write(&path, content).unwrap();
        path
    }

    #[test]
    fn read_feedback_accepts_legacy_snake_case() {
        let path = tmp_file(
            "legacy.json",
            r#"{"schema_version":1,"updated_at_unix":1750000000,
                "entries":{"Alice@Example.com":{"action":"boost","delta":10,"updated_unix":1750000000}}}"#,
        );
        let store = read_feedback(&path).expect("legacy file must parse");
        let entry = store.entries.get("alice@example.com").expect("key must be lowercased");
        assert_eq!(entry.action, "boost");
        assert_eq!(entry.updated_unix, 1750000000);
    }

    #[test]
    fn read_feedback_accepts_camel_case() {
        let path = tmp_file(
            "camel.json",
            r#"{"schemaVersion":1,"updatedAtUnix":1750000000,
                "entries":{"bob@example.com":{"action":"suppress","delta":10,"updatedUnix":1750000000}}}"#,
        );
        let store = read_feedback(&path).expect("camelCase file must parse");
        assert_eq!(store.entries.get("bob@example.com").unwrap().action, "suppress");
    }

    #[test]
    fn read_feedback_missing_file_is_empty_store() {
        let path = std::env::temp_dir().join("pg-test-definitely-missing.json");
        let store = read_feedback(&path).expect("missing file is not an error");
        assert!(store.entries.is_empty());
    }

    #[test]
    fn read_feedback_malformed_file_is_a_hard_error() {
        let path = tmp_file("broken.json", "{ not json ");
        assert!(read_feedback(&path).is_err(), "malformed feedback must not become an empty store");
    }
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd crates/peoplegraph && cargo test read_feedback 2>&1 | tail -20
```
Expected: compile error (`read_feedback` returns `FeedbackStore`, not `Result`) — that counts as the failing state.

- [ ] **Step 3: Implement**

Add snake_case aliases to the structs:

```rust
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct FeedbackStore {
    #[serde(default = "one", alias = "schema_version")]
    schema_version: u32,
    #[serde(default, alias = "updated_at_unix")]
    updated_at_unix: u64,
    #[serde(default)]
    entries: HashMap<String, FeedbackEntry>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct FeedbackEntry {
    action: String, // "boost" | "suppress" | "delete" | "shown"
    #[serde(default)]
    delta: u8,
    #[serde(default, alias = "updated_unix")]
    updated_unix: u64,
}
```

Replace `read_feedback`:

```rust
// Missing file -> empty store (normal on first run). Present-but-unparseable
// file -> hard error: a silently empty store un-excludes every swiped contact,
// which is exactly the 2026-07-22 "everyone reappeared" incident.
fn read_feedback(path: &Path) -> Result<FeedbackStore, String> {
    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Ok(FeedbackStore {
                schema_version: 1,
                updated_at_unix: unix_seconds(),
                entries: HashMap::new(),
            })
        }
        Err(err) => return Err(format!("cannot read {}: {err}", path.display())),
    };
    let mut store: FeedbackStore = serde_json::from_str(&content)
        .map_err(|err| format!("malformed feedback file {}: {err}", path.display()))?;
    store.entries = store
        .entries
        .into_iter()
        .map(|(key, value)| (key.trim().to_ascii_lowercase(), value))
        .collect();
    Ok(store)
}
```

Update the two call sites to propagate the error as a fail response, e.g. in `reconnect()`:

```rust
    let feedback = match read_feedback(&feedback_path(&cache_path)) {
        Ok(store) => store,
        Err(message) => return fail(command, "feedback_unreadable", message, start),
    };
```

and the same pattern in `feedback()` (error code `feedback_unreadable`).

- [ ] **Step 4: Run tests to verify they pass**

```bash
cargo test read_feedback
```
Expected: 4 passed. Then `cargo test` — all existing tests still pass; `cargo build --release` succeeds.

- [ ] **Step 5: Commit**

```bash
git add crates/peoplegraph/src/main.rs
git commit -m "peoplegraph: harden feedback store parsing

Accept legacy snake_case via serde aliases, lowercase entry keys, and turn
malformed-file into a hard error instead of a silent empty store (the failure
mode that resurfaced every swiped contact on 2026-07-22).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: CLI — day-count-free nudges

Diff sync (Task 6) hashes candidate content; `reconnect_nudge` currently leads with "Last contact N days ago", which changes daily and would defeat the diff. The UI renders recency from `last_contact` (Task 8), so nudges must carry only stable facts.

**Files:**
- Modify: `crates/peoplegraph/src/main.rs` — `fn reconnect_nudge` (~line 1556)
- Test: `mod tests` in `main.rs`

**Interfaces:**
- Consumes: nothing new.
- Produces: `reconnect_nudge(contact, days)` output containing no digits derived from `days` (signature unchanged so call sites stay untouched).

- [ ] **Step 1: Write the failing test**

```rust
    #[test]
    fn nudge_has_no_day_counts() {
        let contact = Contact {
            name: "Test Person".to_string(),
            total_exchanges: 25,
            ..Default::default()
        };
        let nudge = reconnect_nudge(&contact, Some(120));
        assert!(!nudge.contains("120"), "nudge must not embed day counts: {nudge}");
        assert!(!nudge.to_lowercase().contains("month"), "no month counts either: {nudge}");
        assert!(nudge.contains("previously active"), "stable facts stay: {nudge}");
        let no_signal = Contact { name: "Quiet Person".to_string(), ..Default::default() };
        assert!(!reconnect_nudge(&no_signal, None).is_empty(), "nudge never empty");
    }
```

If `Contact` does not derive `Default`, construct it the same way the nearest existing test in `mod tests` constructs contacts (mirror that fixture code exactly).

- [ ] **Step 2: Run to verify it fails**

```bash
cargo test nudge_has_no_day_counts
```
Expected: FAIL — current nudge starts with "No contact in 4 months".

- [ ] **Step 3: Implement**

```rust
// Short, human-facing re-engagement reason built from STABLE signals only.
// Recency ("last contact N days ago") is rendered by the UI from last_contact;
// keeping day counts out of the nudge keeps its content hash stable across
// days, which is what makes the bridge's diff sync cheap.
fn reconnect_nudge(contact: &Contact, _days: Option<i64>) -> String {
    let mut parts: Vec<String> = Vec::new();
    if contact.total_exchanges >= 20 {
        parts.push(format!(
            "previously active ({} emails)",
            contact.total_exchanges
        ));
    }
    if let Some(role) = contact.role.as_deref().filter(|r| !r.trim().is_empty()) {
        parts.push(format!("role: {role}"));
    } else if let Some(company) = display_company(contact) {
        parts.push(format!("at {company}"));
    }
    if parts.is_empty() {
        return "Dormant relationship — worth a reconnect".to_string();
    }
    parts.join(" — ")
}
```

- [ ] **Step 4: Run tests**

```bash
cargo test
```
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add crates/peoplegraph/src/main.rs
git commit -m "peoplegraph: keep day counts out of reconnect nudges

Recency is rendered client-side from last_contact; stable nudge text keeps
the bridge's content hashes (and therefore daily diffs) small.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: CLI — boost/suppress apply to people scores globally

Today the feedback overlay only affects reconnect. Add an effective-score helper and wire it into the score-reporting surfaces (`score`, `who-knows`). The reconnect pool contains no feedback entries (they're excluded), so `reconnect` needs no score change.

**Files:**
- Modify: `crates/peoplegraph/src/main.rs` — new helper next to `feedback_entry_for` (~line 1438); `fn score_person` (~line 1248); `fn who_knows` (~line 1281); their call sites in the `Commands::` match (~line 554)
- Test: `mod tests` in `main.rs`

**Interfaces:**
- Consumes: `read_feedback(path) -> Result<FeedbackStore, String>` (Task 2).
- Produces:
  - `fn apply_feedback_delta(combined: u8, entry: Option<&FeedbackEntry>) -> u8`
  - `score_person(index: &ContactIndex, feedback: &FeedbackStore, email: &str, start: Instant) -> Response` — JSON gains `"effective_score"` and `"manual_adjustment"` fields
  - `who_knows(index: &ContactIndex, feedback: &FeedbackStore, company: &str, limit: usize, start: Instant) -> Response` — ranks by effective score

- [ ] **Step 1: Write the failing tests**

```rust
    #[test]
    fn apply_feedback_delta_boost_suppress_clamp() {
        let boost = FeedbackEntry { action: "boost".into(), delta: 10, updated_unix: 0 };
        let suppress = FeedbackEntry { action: "suppress".into(), delta: 10, updated_unix: 0 };
        let delete = FeedbackEntry { action: "delete".into(), delta: 0, updated_unix: 0 };
        assert_eq!(apply_feedback_delta(50, Some(&boost)), 60);
        assert_eq!(apply_feedback_delta(95, Some(&boost)), 100, "clamped at 100");
        assert_eq!(apply_feedback_delta(50, Some(&suppress)), 40);
        assert_eq!(apply_feedback_delta(5, Some(&suppress)), 0, "clamped at 0");
        assert_eq!(apply_feedback_delta(50, Some(&delete)), 50, "delete is not a score signal");
        assert_eq!(apply_feedback_delta(50, None), 50);
    }
```

- [ ] **Step 2: Run to verify failure**

```bash
cargo test apply_feedback_delta
```
Expected: compile error — `apply_feedback_delta` not defined.

- [ ] **Step 3: Implement the helper**

```rust
// A human swipe shifts the people score everywhere, not just the deck:
// boost adds its delta, suppress subtracts it, clamped to 0..=100.
fn apply_feedback_delta(combined: u8, entry: Option<&FeedbackEntry>) -> u8 {
    match entry.map(|e| (e.action.as_str(), e.delta)) {
        Some(("boost", delta)) => combined.saturating_add(delta).min(100),
        Some(("suppress", delta)) => combined.saturating_sub(delta),
        _ => combined,
    }
}
```

- [ ] **Step 4: Wire into `score_person` and `who_knows`**

Change both signatures to take `feedback: &FeedbackStore`. In `score_person`, after `let score = infer_score(&row.contact);`:

```rust
    let entry = feedback_entry_for(feedback, &row);
    let effective = apply_feedback_delta(score.combined, entry);
```

and extend the JSON payload:

```rust
        json!({
            "email": &row.email,
            "name": &row.contact.name,
            "canonical_id": &row.contact.canonical_id,
            "score": score,
            "effective_score": effective,
            "manual_adjustment": entry.map(|e| match e.action.as_str() {
                "boost" => e.delta as i16,
                "suppress" => -(e.delta as i16),
                _ => 0,
            }).unwrap_or(0),
            "score_source": score_source(&row.contact),
            "signals": contact_signals(&row.contact),
        }),
```

In `who_knows`, apply the same two lines per row and sort/rank by `effective` instead of `score.combined`, emitting `"effective_score": effective` alongside the existing score field.

At both `Commands::Score` and `Commands::WhoKnows` call sites, load feedback before calling (inside the `with_index` closure, `cli` is in scope):

```rust
        Commands::Score(args) => with_index(cli, command, start, |index| {
            let cache_path = match resolve_cache_path(cli.cache.as_deref()) {
                Ok(path) => path,
                Err(message) => return fail(command, "cache_not_found", message, start),
            };
            let feedback = match read_feedback(&feedback_path(&cache_path)) {
                Ok(store) => store,
                Err(message) => return fail(command, "feedback_unreadable", message, start),
            };
            score_person(index, &feedback, &args.email, start)
        }),
```

(mirror for `WhoKnows`). If `with_index` already returns the resolved cache path to its closure, use that instead of re-resolving — match the existing signature.

- [ ] **Step 5: Run tests + a smoke query**

```bash
cargo test && cargo build --release
./target/release/peoplegraph --cache fixtures/contact-index.sample.json score --email $(python3 -c "import json;print(list(json.load(open('fixtures/contact-index.sample.json'))['contacts'])[0])") | python3 -m json.tool | head -20
```
Expected: tests pass; score output includes `effective_score` and `manual_adjustment`.

- [ ] **Step 6: Commit**

```bash
git add crates/peoplegraph/src/main.rs
git commit -m "peoplegraph: swipes shift people scores globally

boost/suppress deltas now apply in score and who-knows output (clamped
0-100), not just reconnect ranking.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: CLI — `feedback --action clear` escape hatch

A mistaken swipe permanently retires a contact; `clear` un-retires them (removes the overlay entry, and for deleted contacts also removes the blocklist entry so the next Gmail sync can restore them).

**Files:**
- Modify: `crates/peoplegraph/src/main.rs` — `FeedbackArgs` doc comment (~line 134), `fn feedback` (~line 1451)
- Test: `mod tests` in `main.rs`

**Interfaces:**
- Consumes: `read_feedback` (Task 2), `write_feedback`, `blocklist_path`.
- Produces: `peoplegraph feedback --email X --action clear` → `{ ok, data: { email, action: "clear", cleared: bool } }`.

- [ ] **Step 1: Write the failing test**

```rust
    #[test]
    fn feedback_clear_removes_entry() {
        let path = tmp_file(
            "clearme.json",
            r#"{"schemaVersion":1,"updatedAtUnix":1,"entries":{"x@y.com":{"action":"boost","delta":10,"updatedUnix":1}}}"#,
        );
        let mut store = read_feedback(&path).unwrap();
        assert!(store.entries.remove("x@y.com").is_some());
        write_feedback(&path, &store).unwrap();
        assert!(read_feedback(&path).unwrap().entries.is_empty());
    }
```

(The store-level behavior is what's unit-testable without a CLI harness; the arg wiring is verified by the smoke step below.)

- [ ] **Step 2: Run to verify it fails**

```bash
cargo test feedback_clear_removes_entry
```
Expected: passes only once Task 2's `Result` signature exists — if it fails to compile, fix imports, not the test.

- [ ] **Step 3: Implement `clear` in `fn feedback`**

Extend the action validation and add a clear branch before the delete branch:

```rust
    if !matches!(action.as_str(), "boost" | "suppress" | "delete" | "shown" | "clear") {
        return fail(
            command,
            "invalid_action",
            format!("unknown action '{}': use boost|suppress|delete|shown|clear", args.action),
            start,
        );
    }
```

```rust
    // clear: undo a swipe — drop the overlay entry (and the blocklist entry if
    // the contact had been deleted) so the contact can re-enter the pool.
    if action == "clear" {
        let fb_path = feedback_path(&cache_path);
        let mut store = match read_feedback(&fb_path) {
            Ok(store) => store,
            Err(message) => return fail(command, "feedback_unreadable", message, start),
        };
        let cleared = store.entries.remove(&email).is_some();
        store.updated_at_unix = unix_seconds();
        if let Err(message) = write_feedback(&fb_path, &store) {
            return fail(command, "write_failed", message, start);
        }
        let bl_path = blocklist_path(&cache_path);
        if let Ok(content) = fs::read_to_string(&bl_path) {
            if let Ok(mut blocklist) = serde_json::from_str::<Vec<String>>(&content) {
                let before = blocklist.len();
                blocklist.retain(|e| !e.eq_ignore_ascii_case(&email));
                if blocklist.len() != before {
                    if let Err(message) = write_json_value(&bl_path, &json!(blocklist)) {
                        return fail(command, "write_failed", message, start);
                    }
                }
            }
        }
        return ok(
            command,
            json!({ "email": email, "action": "clear", "cleared": cleared }),
            json!({ "ms": elapsed_ms(start) }),
        );
    }
```

Also update the `FeedbackArgs` `action` doc comment to mention `clear`.

- [ ] **Step 4: Test + smoke**

```bash
cargo test && cargo build --release
FB=$(mktemp -d)/contact-index.json && cp fixtures/contact-index.sample.json $FB
./target/release/peoplegraph --cache $FB feedback --email test@example.com --action boost
./target/release/peoplegraph --cache $FB feedback --email test@example.com --action clear
```
Expected: second call returns `"cleared": true`.

- [ ] **Step 5: Commit**

```bash
git add crates/peoplegraph/src/main.rs
git commit -m "peoplegraph: add feedback --action clear escape hatch

Undo a swipe: removes the overlay entry and any blocklist entry so the
contact can re-enter the reconnect pool.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Bridge — stable ids, state v2, diff sync

Rewrite `push()` around stable ids + diffs, harden `pull()` (ack unknown ids; route deletes through the CLI so they're gone-gone). Pure logic lives in a new testable lib module.

**Files:**
- Create: `scripts/lib/reconnect-sync.mjs`, `scripts/lib/reconnect-sync.test.mjs`
- Modify: `scripts/peoplegraph-reconnect-web.mjs`

**Interfaces:**
- Consumes: `peoplegraph reconnect --limit 5000` JSON (`people[]` with `email,name,company,last_contact,effective_score,score.combined,nudge`); CLI `feedback --email X --action delete` (Task 5's file, existing action).
- Produces (lib exports, used by the bridge and by Task 7's smoke test):
  - `stableId(saltHex: string, email: string): string` — 32 hex chars
  - `contentHash(cand: {name,company,last_contact,nudge}): string` — 16 hex chars (score intentionally excluded)
  - `diffPool(lastPush: Record<id,{h,s}>, pool: Array<{id,h,s,row}>): { upserts: row[], removeIds: string[], next: Record<id,{h,s}> }` — upsert when new, `h` changed, or `|s - prev.s| >= 3`
  - `migrateState(raw: any): state` — v2 shape `{ version:2, salt, map:{}, lastPush:{} }`
  - Worker request body (Task 7 implements the server side): `POST /api/sync { upserts: [{id,name,company,last_contact,score,nudge}], remove_ids: string[], reset?: boolean }`

- [ ] **Step 1: Write the failing tests** — `scripts/lib/reconnect-sync.test.mjs`

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { stableId, contentHash, diffPool, migrateState } from "./reconnect-sync.mjs";

const SALT = "ab".repeat(32);

test("stableId is deterministic, case/space-insensitive, 32 hex chars", () => {
	const a = stableId(SALT, "Alice@Example.com ");
	const b = stableId(SALT, "alice@example.com");
	assert.equal(a, b);
	assert.match(a, /^[0-9a-f]{32}$/);
	assert.notEqual(a, stableId(SALT, "bob@example.com"));
	assert.notEqual(a, stableId("cd".repeat(32), "alice@example.com"), "salt matters");
});

test("contentHash ignores score and day-to-day noise fields", () => {
	const base = { name: "A", company: "B", last_contact: "2026-07-01", nudge: "at B" };
	assert.equal(contentHash(base), contentHash({ ...base, extra: "ignored" }));
	assert.notEqual(contentHash(base), contentHash({ ...base, last_contact: "2026-07-20" }));
	assert.match(contentHash(base), /^[0-9a-f]{16}$/);
});

test("diffPool: new, changed, score-threshold, removed", () => {
	const rowA = { id: "a", name: "A", score: 50 };
	const rowB = { id: "b", name: "B", score: 50 };
	const last = { a: { h: "same", s: 50 }, gone: { h: "x", s: 10 } };
	const pool = [
		{ id: "a", h: "same", s: 52, row: rowA },   // hash same, |Δs|=2 -> skip
		{ id: "b", h: "new", s: 50, row: rowB },     // new id -> upsert
	];
	const { upserts, removeIds, next } = diffPool(last, pool);
	assert.deepEqual(upserts, [rowB]);
	assert.deepEqual(removeIds, ["gone"]);
	assert.deepEqual(Object.keys(next).sort(), ["a", "b"]);
	assert.equal(next.a.s, 50, "unchanged entries keep their last-pushed score");
	// score drift past threshold triggers an upsert
	const drift = diffPool({ a: { h: "same", s: 50 } }, [{ id: "a", h: "same", s: 54, row: rowA }]);
	assert.deepEqual(drift.upserts, [rowA]);
	assert.equal(drift.next.a.s, 54);
});

test("migrateState: fresh, legacy v1, and passthrough", () => {
	const fresh = migrateState(null);
	assert.equal(fresh.version, 2);
	assert.match(fresh.salt, /^[0-9a-f]{64}$/);
	assert.deepEqual(fresh.map, {});
	assert.deepEqual(fresh.lastPush, {});
	const legacy = migrateState({ batch_date: "2026-07-22", map: { uuid: "a@b.com" } });
	assert.equal(legacy.version, 2, "legacy v1 state is discarded into a fresh v2");
	assert.deepEqual(legacy.map, {}, "old uuid map is useless once decisions are wiped");
	const v2 = { version: 2, salt: SALT, map: { x: "a@b.com" }, lastPush: { x: { h: "h", s: 1 } } };
	assert.deepEqual(migrateState(v2), v2, "v2 passes through untouched");
});
```

- [ ] **Step 2: Run to verify failure**

```bash
node --test scripts/lib/
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `scripts/lib/reconnect-sync.mjs`**

```js
// Pure helpers for the reconnect bridge (scripts/peoplegraph-reconnect-web.mjs).
// Kept dependency-free and side-effect-free so `node --test scripts/lib/` covers them.
import { createHmac, createHash, randomBytes } from "node:crypto";

// Stable opaque id: same contact -> same id every push, so a swipe recorded
// any day excludes the contact forever. Not reversible without the local salt.
export function stableId(saltHex, email) {
	return createHmac("sha256", Buffer.from(saltHex, "hex"))
		.update(email.trim().toLowerCase())
		.digest("hex")
		.slice(0, 32);
}

// Hash of the display fields that rarely change. Score is EXCLUDED (it can
// drift a point or two daily); diffPool applies a >=3 threshold to it instead.
export function contentHash({ name, company, last_contact, nudge }) {
	return createHash("sha256")
		.update(JSON.stringify([name ?? null, company ?? null, last_contact ?? null, nudge ?? null]))
		.digest("hex")
		.slice(0, 16);
}

const SCORE_THRESHOLD = 3;

// lastPush: { [id]: { h, s } }  pool: [{ id, h, s, row }]
export function diffPool(lastPush, pool) {
	const upserts = [];
	const next = {};
	const poolIds = new Set();
	for (const { id, h, s, row } of pool) {
		poolIds.add(id);
		const prev = lastPush[id];
		if (!prev || prev.h !== h || Math.abs(s - prev.s) >= SCORE_THRESHOLD) {
			upserts.push(row);
			next[id] = { h, s };
		} else {
			next[id] = prev; // unchanged: keep prior score so drift accumulates toward the threshold
		}
	}
	const removeIds = Object.keys(lastPush).filter((id) => !poolIds.has(id));
	return { upserts, removeIds, next };
}

// State schema v2. Legacy v1 state (random uuids, batch_date) is discarded:
// its map is only meaningful against decisions that the migration wipes.
export function migrateState(raw) {
	if (raw && raw.version === 2 && typeof raw.salt === "string") return raw;
	return { version: 2, salt: randomBytes(32).toString("hex"), map: {}, lastPush: {} };
}
```

- [ ] **Step 4: Run lib tests**

```bash
node --test scripts/lib/
```
Expected: all pass.

- [ ] **Step 5: Rewrite the bridge around the lib**

In `scripts/peoplegraph-reconnect-web.mjs`:

Imports and constants — remove `randomUUID`; the limit-warning block (RAW_LIMIT/MAX_LIMIT) goes away entirely:

```js
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { stableId, contentHash, diffPool, migrateState } from "./lib/reconnect-sync.mjs";
```

`loadState` returns migrated state:

```js
function loadState() {
	let raw = null;
	if (existsSync(STATE_PATH)) {
		try { raw = JSON.parse(readFileSync(STATE_PATH, "utf8")); } catch { raw = null; }
	}
	return migrateState(raw);
}
```

Replace `push()` (keep `writeDailyNoteLine`, the Telegram `CANDIDATES_JSON`/`TOTAL_CANDIDATES` output lines, and chunked posting):

```js
async function push() {
	const state = loadState();

	// Full re-engage pool. The CLI excludes anyone with a feedback entry, so
	// this is exactly the not-yet-swiped set; the Worker sees only diffs.
	const res = pg(["reconnect", "--limit", "5000"]);
	if (!res.ok) die(`peoplegraph reconnect failed: ${JSON.stringify(res.error || res)}`);
	const people = res.data?.people ?? [];

	const pool = people.map((p) => {
		const id = stableId(state.salt, p.email);
		state.map[id] = p.email.trim().toLowerCase(); // merged, never clobbered
		const row = {
			id,
			name: p.name,
			company: p.company ?? null,
			last_contact: p.last_contact ?? null,
			score: p.effective_score ?? p.score?.combined ?? 0,
			nudge: p.nudge ?? null,
		};
		return { id, h: contentHash(row), s: row.score, row };
	});

	const reset = Object.keys(state.lastPush).length === 0;
	const { upserts, removeIds, next } = diffPool(state.lastPush, pool);

	if (!upserts.length && !removeIds.length && !reset) {
		console.log("pool unchanged — nothing to push");
	} else {
		const CHUNK = 400;
		for (let i = 0; i < Math.max(upserts.length, 1); i += CHUNK) {
			await api("/api/sync", {
				method: "POST",
				body: {
					upserts: upserts.slice(i, i + CHUNK),
					remove_ids: i === 0 ? removeIds : [],
					reset: reset && i === 0, // first chunk of a fresh state clears the table
				},
			});
		}
	}
	state.lastPush = next;
	saveState(state);

	writeDailyNoteLine(pool.length);
	console.log(`pool ${pool.length} candidates (${upserts.length} upserted, ${removeIds.length} removed)`);

	const preview = people.slice(0, 20);
	console.log("CANDIDATES_JSON:" + JSON.stringify(preview.map(p => ({
		name: p.name,
		company: p.company ?? null,
		days_since: p.days_since_contact ?? null,
		nudge: p.nudge ?? null,
	}))));
	console.log(`TOTAL_CANDIDATES:${pool.length}`);
}
```

In `pull()`, three changes:

1. Lowercase feedback keys when writing: `fb.entries[email]` stays correct because `state.map` values are already lowercased by the new `push()`; add `const key = email.trim().toLowerCase();` and use `fb.entries[key]` anyway (old map values may predate the migration).
2. Deletes go through the CLI so the contact leaves the cache and is blocklisted ("gone gone"):

```js
			if (d.action === "delete") {
				const res = pg(["feedback", "--email", email, "--action", "delete"]);
				if (!res.ok) {
					console.warn(`delete failed for ${email}: ${JSON.stringify(res.error || res)}`);
					continue; // not acked -> retried next run
				}
			} else {
				const delta = 10;
				fb.entries[email.trim().toLowerCase()] = { action: d.action, delta, updatedUnix: nowUnix };
			}
			acked.push(d.id);
```

3. Unknown ids are acked (once, with a warning) instead of retried forever:

```js
		const email = state.map?.[d.id];
		if (!email) {
			console.warn(`ack ${d.id} without applying: no local email mapping (pre-migration id?)`);
			acked.push(d.id);
			continue;
		}
```

Do NOT delete applied ids from `state.map` anymore (ids are stable; the map is the permanent id→email dictionary) — remove the `for (const id of acked) delete state.map[id];` loop.

Update the header comment block (lines 2–24) to describe stable ids, diff sync, and the v2 state file shape.

- [ ] **Step 6: Syntax-check and unit tests**

```bash
node --check scripts/peoplegraph-reconnect-web.mjs && node --test scripts/lib/
node scripts/peoplegraph-reconnect-web.mjs help
```
Expected: clean check, tests pass, help prints.

- [ ] **Step 7: Commit**

```bash
git add scripts/lib/ scripts/peoplegraph-reconnect-web.mjs
git commit -m "bridge: stable HMAC ids + diff sync, deletes via CLI

Stable ids make swipe decisions permanent across days; push sends only
changed/new/removed rows; delete swipes remove the contact from the cache
and blocklist; unknown decision ids ack once instead of looping.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Worker — diff sync API, pool-based candidates, schema v2

**Files:**
- Modify: `apps/reconnect-web/src/index.ts` (the Task 1 restored version), `apps/reconnect-web/schema.sql`
- Create: `apps/reconnect-web/migrations/0002-stable-ids.sql`, `apps/reconnect-web/scripts/smoke.sh`
- Modify: `apps/reconnect-web/package.json` (add `db:migrate:remote` + `smoke` scripts)

**Interfaces:**
- Consumes: bridge body `{ upserts: [{id,name,company,last_contact,score,nudge}], remove_ids: string[], reset?: boolean }` (Task 6).
- Produces:
  - `POST /api/sync` → `{ ok, upserted, removed, reset }`
  - `GET /api/candidates` (Google auth, unchanged) → `{ total: number, candidates: [{id,name,company,last_contact,score,nudge}] }`, max 500 rows, `ORDER BY score DESC`
  - `POST /api/decisions/ack` also deletes acked ids from `candidates`
  - Task 8's UI consumes the `{ total, candidates }` shape.

- [ ] **Step 1: New schema + migration**

`apps/reconnect-web/schema.sql` (full replacement):

```sql
-- Reconnect swipe app — D1 schema (v2: stable ids, no batches).
-- Privacy: no emails or message content are ever stored here. The bridge keeps
-- the salt + id -> email map locally; this DB only holds opaque ids + display fields.

CREATE TABLE IF NOT EXISTS candidates (
  id           TEXT PRIMARY KEY,      -- stable opaque id (HMAC of email, salt local to the bridge)
  name         TEXT NOT NULL,
  company      TEXT,
  last_contact TEXT,                  -- YYYY-MM-DD of last real contact (UI renders recency)
  score        INTEGER,
  nudge        TEXT,
  updated_at   INTEGER NOT NULL       -- unix seconds of last upsert
);

CREATE INDEX IF NOT EXISTS idx_candidates_score ON candidates (score DESC);

CREATE TABLE IF NOT EXISTS decisions (
  id           TEXT PRIMARY KEY,      -- references candidates.id (one decision per contact, forever)
  action       TEXT NOT NULL,         -- 'boost' (right) | 'suppress' (left) | 'delete'
  decided_by   TEXT,                  -- google email of the swiper
  decided_at   INTEGER NOT NULL,      -- unix seconds
  applied      INTEGER NOT NULL DEFAULT 0  -- 0 until the bridge applies it locally
);

CREATE INDEX IF NOT EXISTS idx_decisions_applied ON decisions (applied);
```

`apps/reconnect-web/migrations/0002-stable-ids.sql`:

```sql
-- v2 migration: stable ids replace daily random uuids.
-- Candidates are disposable (re-pushed by the bridge); legacy decisions
-- reference dead uuids and their outcomes live in reconnect-feedback.json.
-- PRECONDITION (runbook-enforced): GET /api/decisions?applied=0 is empty.
DROP TABLE IF EXISTS candidates;
DELETE FROM decisions;
CREATE TABLE candidates (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  company      TEXT,
  last_contact TEXT,
  score        INTEGER,
  nudge        TEXT,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX idx_candidates_score ON candidates (score DESC);
```

`package.json` scripts additions:

```json
    "db:migrate:remote": "wrangler d1 execute reconnect --remote --file ./migrations/0002-stable-ids.sql",
    "smoke": "bash scripts/smoke.sh"
```

- [ ] **Step 2: Rewrite the three handlers in `src/index.ts`**

Replace `sync`, `listCandidates`, `ackDecisions`; delete the now-unused batch logic. Keep `swipe`, `listDecisions`, auth helpers, and routing (route `listCandidates(request, env)` unchanged):

```ts
// GET /api/candidates — the unswiped pool, best first. Google allowlist gated:
// names/companies/nudges are relationship intelligence, not for anonymous viewers.
async function listCandidates(request: Request, env: Env): Promise<Response> {
	const auth = await requireGoogleUser(request, env);
	if ("error" in auth) return json({ error: auth.error }, 401);

	const totalRow = await env.DB.prepare(
		`SELECT COUNT(*) AS n FROM candidates c LEFT JOIN decisions d ON d.id = c.id WHERE d.id IS NULL`
	).first<{ n: number }>();

	const rows = await env.DB.prepare(
		`SELECT c.id, c.name, c.company, c.last_contact, c.score, c.nudge
		   FROM candidates c
		   LEFT JOIN decisions d ON d.id = c.id
		  WHERE d.id IS NULL
		  ORDER BY c.score DESC
		  LIMIT 500`
	).all();

	return json({ total: totalRow?.n ?? 0, candidates: rows.results ?? [] });
}

// POST /api/sync { upserts, remove_ids, reset? } — bridge diff push.
async function sync(request: Request, env: Env): Promise<Response> {
	if (!checkSyncToken(request, env)) return json({ error: "unauthorized" }, 401);

	const body = (await request.json().catch(() => null)) as
		| { upserts?: CandidateInput[]; remove_ids?: string[]; reset?: boolean }
		| null;
	if (!body || (!Array.isArray(body.upserts) && !Array.isArray(body.remove_ids) && !body.reset)) {
		return json({ error: "bad_request", message: "need upserts[] and/or remove_ids[] (or reset)" }, 400);
	}
	const upserts = body.upserts ?? [];
	const removeIds = body.remove_ids ?? [];

	const stmts: D1PreparedStatement[] = [];
	if (body.reset) stmts.push(env.DB.prepare("DELETE FROM candidates"));

	const now = nowSeconds();
	const insert = env.DB.prepare(
		`INSERT INTO candidates (id, name, company, last_contact, score, nudge, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET
		   name = excluded.name, company = excluded.company, last_contact = excluded.last_contact,
		   score = excluded.score, nudge = excluded.nudge, updated_at = excluded.updated_at`
	);
	for (const c of upserts) {
		if (!c?.id || !c?.name) continue;
		stmts.push(insert.bind(c.id, c.name, c.company ?? null, c.last_contact ?? null, c.score ?? null, c.nudge ?? null, now));
	}
	const remove = env.DB.prepare("DELETE FROM candidates WHERE id = ?");
	for (const id of removeIds) stmts.push(remove.bind(id));

	// D1 batches are transactional; chunk to stay well under statement limits.
	for (let i = 0; i < stmts.length; i += 100) {
		await env.DB.batch(stmts.slice(i, i + 100));
	}
	return json({ ok: true, upserted: upserts.length, removed: removeIds.length, reset: !!body.reset });
}
```

In `ackDecisions`, after the `UPDATE decisions SET applied = 1` statement, drop the applied candidates from the pool table:

```ts
	await env.DB.prepare(`DELETE FROM candidates WHERE id IN (${placeholders})`)
		.bind(...body.ids)
		.run();
```

Update `CandidateInput`: replace `days_since?: number | null` with `last_contact?: string | null`.

- [ ] **Step 3: Typecheck**

```bash
cd apps/reconnect-web && npm run typecheck
```
Expected: exit 0.

- [ ] **Step 4: Local smoke test** — `apps/reconnect-web/scripts/smoke.sh`

```bash
#!/usr/bin/env bash
# End-to-end smoke against `wrangler dev` (local D1). Usage: npm run smoke
# Requires: npx wrangler dev running is NOT needed — this script starts it.
set -euo pipefail
cd "$(dirname "$0")/.."
export SYNC_TOKEN="smoke-token"
npx wrangler d1 execute reconnect --local --file ./schema.sql
npx wrangler dev --port 8787 --var SYNC_TOKEN:$SYNC_TOKEN &
DEV_PID=$!
trap 'kill $DEV_PID' EXIT
for i in $(seq 1 30); do curl -sf localhost:8787/api/config >/dev/null && break; sleep 1; done

auth=(-H "authorization: Bearer $SYNC_TOKEN" -H "content-type: application/json")

echo "--- sync reset + 2 upserts"
curl -sf "${auth[@]}" -d '{"reset":true,"upserts":[
  {"id":"aaaa","name":"Alice","last_contact":"2026-07-01","score":80,"nudge":"at Acme"},
  {"id":"bbbb","name":"Bob","score":60}]}' localhost:8787/api/sync | grep '"upserted":2'

echo "--- swipe aaaa (sync-token path can't swipe: expect 401)"
curl -s "${auth[@]}" -d '{"id":"aaaa","action":"boost"}' localhost:8787/api/swipe | grep -q error

echo "--- decisions empty, remove bbbb"
curl -sf "${auth[@]}" "localhost:8787/api/decisions?applied=0" | grep '"decisions":\[\]'
curl -sf "${auth[@]}" -d '{"remove_ids":["bbbb"]}' localhost:8787/api/sync | grep '"removed":1'
echo "SMOKE OK"
```

(The Google-auth swipe path can't run headless; the swipe → ack → candidate-gone loop is covered in the rollout checklist, Task 9.)

```bash
chmod +x scripts/smoke.sh && npm run smoke
```
Expected: `SMOKE OK`.

- [ ] **Step 5: Commit**

```bash
git add apps/reconnect-web
git commit -m "reconnect-web: diff sync API + stable-id pool schema

/api/sync takes {upserts, remove_ids, reset}; /api/candidates serves the
unswiped pool (top 500 by score, total included); ack prunes candidates;
schema v2 drops batch_date/days_since for last_contact + updated_at.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: UI — swipe-loss fixes, recency from last_contact, low-queue refill

**Files:**
- Modify: `apps/reconnect-web/public/index.html` (the Task 1 restored version — it has `waitForGoogle`, `renderGate`, `decide`)

**Interfaces:**
- Consumes: `{ total, candidates: [{id,name,company,last_contact,score,nudge}] }` from Task 7.
- Produces: user-visible behavior only.

- [ ] **Step 1: Replace `load()`** (keep the 401 token-drop behavior; adapt to the new shape and track `total`)

```js
		let seen = new Set();     // ids currently or previously in the queue this session

		async function load() {
			if (!idToken) { renderGate(); return; }
			const resp = await fetch("/api/candidates", { headers: { authorization: "Bearer " + idToken } }).catch(() => null);
			if (!resp || resp.status === 401) {
				// Token likely expired (Google ID tokens last ~1h) — drop it and re-prompt.
				idToken = null;
				renderGate();
				if (window.google?.accounts?.id) google.accounts.id.prompt();
				return;
			}
			const data = await resp.json().catch(() => ({ total: 0, candidates: [] }));
			queue = (data.candidates || []).filter(c => !seen.has(c.id));
			queue.forEach(c => seen.add(c.id));
			total = data.total ?? queue.length;
			render();
		}

		// The server caps responses at 500; when the local queue runs low and the
		// pool has more, append the next slice (already-decided ids never come back).
		async function refill() {
			if (!idToken || queue.length >= 20 || seen.size >= total) return;
			const resp = await fetch("/api/candidates", { headers: { authorization: "Bearer " + idToken } }).catch(() => null);
			if (!resp || !resp.ok) return;
			const data = await resp.json().catch(() => null);
			if (!data) return;
			total = data.total ?? total;
			for (const c of data.candidates || []) {
				if (!seen.has(c.id)) { seen.add(c.id); queue.push(c); }
			}
		}
```

- [ ] **Step 2: Recency from `last_contact` in `render()`**

Replace the `days_since` lines:

```js
			const days = c.last_contact
				? Math.max(0, Math.floor((Date.now() - new Date(c.last_contact + "T00:00:00")) / 86400000))
				: null;
			const last = days == null ? "No recorded contact"
				: days === 0 ? "Last contact today"
				: `Last contact ${days} day${days === 1 ? "" : "s"} ago`;
```

Also fix the counter line to survive a growing queue:

```js
			countEl.textContent = total ? `${Math.min(seen.size - queue.length + 1, total)} / ${total}` : "";
```

- [ ] **Step 3: Replace `decide()`** — no swipe is ever dropped silently

```js
		function showNotice(msg) {
			const el = document.createElement("div");
			el.className = "gate";
			el.style.cssText = "position:fixed;bottom:90px;left:50%;transform:translateX(-50%);background:var(--card);border:1px solid #2c313c;border-radius:10px;padding:10px 16px;font-size:.85rem;z-index:10;";
			el.textContent = msg;
			document.body.appendChild(el);
			setTimeout(() => el.remove(), 2500);
		}

		async function decide(action) {
			const c = queue[0];
			if (!c) return;
			if (!idToken) { renderGate(); return; }
			// optimistic: pop the card immediately, but ALWAYS restore it on failure
			queue.shift();
			render();
			refill();
			try {
				const r = await fetch("/api/swipe", {
					method: "POST",
					headers: { "content-type": "application/json", "authorization": "Bearer " + idToken },
					body: JSON.stringify({ id: c.id, action }),
				});
				if (r.status === 401) {
					// Token expired mid-session: put the card back, re-auth, nothing lost.
					queue.unshift(c);
					idToken = null;
					renderGate();
					if (window.google?.accounts?.id) google.accounts.id.prompt();
					return;
				}
				if (r.status === 404) {
					// Contact left the pool since we loaded (re-engaged or removed) — skipping is correct.
					showNotice(`${c.name} is no longer in the pool — skipped`);
					return;
				}
				if (!r.ok) {
					queue.unshift(c); render();
					showNotice("Swipe not saved — try again");
				}
			} catch (e) {
				queue.unshift(c); render();
				showNotice("Offline? Swipe not saved — try again");
			}
		}
```

- [ ] **Step 4: Manual verification with the smoke worker**

```bash
cd apps/reconnect-web && npx wrangler dev
```
Open http://localhost:8787 — sign-in gate renders; with dev D1 seeded (Task 7 smoke) and an allowlisted Google account, cards render "Last contact N days ago" from `last_contact`, and killing the network mid-swipe restores the card with a notice.

- [ ] **Step 5: Commit**

```bash
git add apps/reconnect-web/public/index.html
git commit -m "reconnect-web UI: never drop a swipe, recency from last_contact

401 re-queues the card and re-prompts sign-in; failures restore the card
with a notice; queue refills from the 500-row pages; day counts computed
client-side.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Docs, rollout runbook, PR

**Files:**
- Modify: `apps/reconnect-web/README.md` (API shapes), `skills/peoplegraph-daily-reconnect/SKILL.md` (bridge behavior notes)
- Create: `docs/superpowers/plans/2026-07-23-reconnect-rollout-runbook.md`

**Interfaces:**
- Consumes: everything above.
- Produces: the runbook the human (or Botwick-machine session) executes; the PR.

- [ ] **Step 1: Update README + SKILL.md**

In `apps/reconnect-web/README.md`: document `POST /api/sync {upserts, remove_ids, reset?}`, `GET /api/candidates -> {total, candidates}` (auth-gated, 500-row pages), ack pruning, schema v2. In `skills/peoplegraph-daily-reconnect/SKILL.md`: note stable ids, that `run` stays the daily cron entrypoint, delete = gone-gone via CLI, and the `feedback --action clear` escape hatch.

- [ ] **Step 2: Write the runbook** — `docs/superpowers/plans/2026-07-23-reconnect-rollout-runbook.md`

```markdown
# Reconnect stable-ids rollout (run top to bottom)

## A. Pre-flight (any machine)
1. `curl -s -H "authorization: Bearer $RECONNECT_SYNC_TOKEN" "$RECONNECT_WEB_URL/api/decisions?applied=0"`
   MUST return `{"decisions":[]}`. If not: run `node scripts/peoplegraph-reconnect-web.mjs pull`
   on the source-of-truth machine with the OLD checkout first, then re-check.

## B. Deploy (this machine, branch reconnect-stable-ids)
2. `cd apps/reconnect-web && npm run typecheck && npm run deploy`
3. `npm run db:migrate:remote`   # drops candidates, clears legacy decisions
4. Sanity: unauthenticated `curl -s -o /dev/null -w "%{http_code}" $RECONNECT_WEB_URL/api/candidates` -> 401

## C. Source-of-truth machine (Botwick)
5. `git fetch && git checkout reconnect-stable-ids`
6. Rebuild/install the CLI: `bash scripts/install-peoplegraph.sh` (or `cargo build --release`
   + copy to the PATH the cron uses). VERIFY: `peoplegraph version`.
7. Feedback file sanity: `peoplegraph --cache "$PEOPLEGRAPH_CACHE" reconnect --limit 1 | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['meta']['matched'],'candidates after exclusions')"`
   Expect roughly (total re-engage pool − ~1,699 swiped). If it errors with
   feedback_unreadable, STOP and fix the JSON — do not delete the file.
8. First v2 push: `set -a; source ~/.peoplegraph/reconnect-web.env; set +a`
   `node scripts/peoplegraph-reconnect-web.mjs run`
   Expect: "pool N candidates (N upserted, 0 removed)" with N ≈ step 7's count.

## D. Verify (any machine)
9. D1 spot checks:
   - `npx wrangler d1 execute reconnect --remote --command "SELECT COUNT(*) FROM candidates"` ≈ N
   - previously boosted names are ABSENT:
     `... --command "SELECT name FROM candidates WHERE name IN ('Susan Lyne','Auren Hoffman','Steve Schlafman')"` -> 0 rows
10. Open the app, swipe one card each direction, then on Botwick:
    `node scripts/peoplegraph-reconnect-web.mjs pull` — decisions apply, ack, and
    `SELECT COUNT(*) FROM candidates` drops accordingly. Next `run` prints "pool unchanged"
    or a small diff.

## E. Rollback
- Redeploy the previous Worker (`git checkout <old-sha> apps/reconnect-web && npm run deploy`),
  re-run `db:init:remote` with the old schema.sql, and re-run the old bridge push.
  Nothing on the Botwick side is destroyed: feedback JSON only ever gains entries,
  and the v1 state file is preserved (v2 uses the same path — back it up in step 5:
  `cp ~/.peoplegraph/reconnect-web-state.json{,.v1.bak}` if it exists).
```

Add the backup line from E into step 5 of the runbook itself (belt and braces).

- [ ] **Step 3: Commit + PR**

```bash
git add -A
git commit -m "docs: reconnect stable-ids rollout runbook + API docs

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push -u origin reconnect-stable-ids
gh pr create --base main --title "Reconnect: stable contact ids + diff sync" --body "$(cat <<'EOF'
## Why
2026-07-22's "push ALL candidates" change exposed the pipeline's identity flaw:
daily random uuids meant swipes couldn't exclude contacts across days — all
1,341 boosted contacts resurfaced and swipes looked lost.

## What
- Stable HMAC ids (salt local to the bridge) — a swipe excludes a contact forever
- Bridge pushes diffs (upserts/removes), not 4.4k rows/day
- boost/suppress now shift people scores globally; delete = cache removal + blocklist
- Feedback file parsing hardened (snake/camel aliases, loud failure on corruption)
- UI never drops a swipe (401 re-queues + re-prompts; failures restore the card)
- Worker: pool-based /api/candidates (auth kept), schema v2, ack prunes candidates

Spec: docs/superpowers/specs/2026-07-23-reconnect-stable-ids-design.md
Rollout: docs/superpowers/plans/2026-07-23-reconnect-rollout-runbook.md (NOT yet executed)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review notes (performed while writing)

- **Spec coverage:** stable ids (T6), global score effects (T4), delete gone-gone (T6 pull via CLI — CLI delete already removes+blocklists), permanent deck exclusion (already on main; guarded by T2's loud-fail so it can't silently regress), diff sync + last_contact (T3/T6/T7), 500-row paging (T7/T8), swipe-loss fixes (T8), migration + verification (T9), `--clear` escape hatch (T5). The spec's "exclude any feedback entry" is already implemented on origin/main (`reconnect()` excludes boost/suppress/delete permanently, `shown` for 30 days) — no task needed beyond T2's parse hardening, which addresses why it failed in production.
- **Type consistency:** `read_feedback -> Result<FeedbackStore, String>` used in T2/T4/T5; bridge body `{upserts, remove_ids, reset}` matches T7's handler; `{total, candidates}` matches T8's `load()`; `last_contact` naming consistent across CLI output, bridge row, schema, and UI.
- **Known judgment call:** legacy `shown` entries remain honored by the CLI's 30-day cooldown; the bridge no longer writes `shown`, so they age out naturally.
