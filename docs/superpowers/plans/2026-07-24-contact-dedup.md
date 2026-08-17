# Contact Dedup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One card per human in the swipe deck, batch auto-merge of corroborated duplicate contacts, and a `/merge` swipe page for reviewing uncertain pairs.

**Architecture:** Three layers, mirroring the shipped stable-ids pipeline (PR #2): the Rust CLI gains deck name-dedup and a batch `apply-duplicates` command; the Cloudflare Worker gains `merge_candidates`/`merge_decisions` tables and five endpoints that clone the contact-flow patterns; the bridge gains `merge-push`/`merge-pull` subcommands with stable HMAC pair-ids kept in the same local state file.

**Tech Stack:** Rust (clap + serde), Node ≥18 ESM (no deps, `node --test`), Cloudflare Workers + D1, vanilla-JS static UI, wrangler v4.

**Spec:** `docs/superpowers/specs/2026-07-24-contact-dedup-design.md` (committed on `contact-dedup`).

## Global Constraints

- All work happens in a **git worktree** at `/Users/kayajones/betaworks/obsidian-gmail-crm-dedup` on branch `contact-dedup` — the main checkout belongs to another active session (branch `betaworks-score-push`, dirty `main.js`). Never touch the main checkout.
- Privacy: no email addresses in D1, ever. Pair cards carry name/company/domain/last-contact/exchange-count per side. `pairId → {a, b}` emails live only in the bridge state file.
- Auto-merge bar: `--min-confidence 0.94` (corroborated tier). Review band pushed to the app: `0.88 ≤ confidence < 0.94`.
- Duplicate pair scan runs weekly (`state.lastMergeScanUnix`, 7×86400s); `merge-pull` runs daily. `run` = pull → merge-pull → push → merge-push; merge-step failures are logged, never fatal to the contact sync.
- Merge swipe actions: `merge` (right) | `keep` (left). Dismissals persist in the CLI merge queue (`--reason not_duplicate`).
- CLI version bumps to **0.3.9**; the committed `bin/peoplegraph` is refreshed at the end (Task 7).
- Every commit message ends with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Worktree setup

**Files:**
- Create worktree: `/Users/kayajones/betaworks/obsidian-gmail-crm-dedup` (branch `contact-dedup`, already pushed with the spec)
- Copy in + commit: `docs/superpowers/plans/2026-07-24-contact-dedup.md` (this file, currently untracked in the main checkout)

- [ ] **Step 1: Create the worktree**

```bash
cd /Users/kayajones/betaworks/obsidian-gmail-crm
git fetch origin
git worktree add ../obsidian-gmail-crm-dedup contact-dedup
```

- [ ] **Step 2: Bring the plan onto the branch**

```bash
cp docs/superpowers/plans/2026-07-24-contact-dedup.md ../obsidian-gmail-crm-dedup/docs/superpowers/plans/
cd ../obsidian-gmail-crm-dedup
git add docs/superpowers/plans/2026-07-24-contact-dedup.md
git commit -m "Plan: contact dedup implementation

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 3: Verify the toolchain in the worktree**

```bash
cd /Users/kayajones/betaworks/obsidian-gmail-crm-dedup/crates/peoplegraph && cargo test 2>&1 | tail -2
```
Expected: `test result: ok. 36 passed` (fresh target dir, first build takes ~1 min).

---

### Task 2: CLI — deck shows one card per human

**Files:**
- Modify: `crates/peoplegraph/src/main.rs` — `fn reconnect` (between the `people.sort_by` and `take(limit)`), new helper next to `swiped_name_set`
- Test: `#[cfg(test)] mod tests` in `main.rs`

**Interfaces:**
- Consumes: `normalized_person_name(&str) -> String` (exists, from 0.3.8).
- Produces: `fn dedupe_rows_by_name(people: Vec<(ContactRow, u8)>) -> (Vec<(ContactRow, u8)>, usize)` — input must already be sorted best-first; keeps first occurrence per normalized name; returns (deduped, dropped_count). Reconnect stats gain `"deduped_rows"`.

- [ ] **Step 1: Write the failing test**

```rust
    #[test]
    fn reconnect_pool_keeps_one_row_per_name() {
        let row = |name: &str, email: &str| ContactRow {
            email: email.to_string(),
            contact: Contact { name: name.to_string(), email: email.to_string(), ..empty_contact() },
        };
        // already sorted best-first, as reconnect() guarantees before calling
        let people = vec![
            (row("Lenka GrayDevitt", "lenka@a.com"), 80u8),
            (row("Lenka GrayDevitt", "lenka@b.com"), 60u8),
            (row("Solo Person", "solo@c.com"), 50u8),
            (row("", "noname@d.com"), 40u8),   // empty names never collapse
            (row("", "noname@e.com"), 30u8),
        ];
        let (deduped, dropped) = dedupe_rows_by_name(people);
        assert_eq!(dropped, 1);
        let emails: Vec<&str> = deduped.iter().map(|(r, _)| r.email.as_str()).collect();
        assert_eq!(emails, vec!["lenka@a.com", "solo@c.com", "noname@d.com", "noname@e.com"]);
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test reconnect_pool_keeps_one_row_per_name`
Expected: compile error — `dedupe_rows_by_name` not defined.

- [ ] **Step 3: Implement**

Helper (place directly after `swiped_name_set`):

```rust
// The index holds multiple rows per human; the deck should deal ONE card per
// person. Input is sorted best-first, so keeping the first occurrence keeps
// the highest-ranked row. Empty names never collapse (they're not comparable).
fn dedupe_rows_by_name(people: Vec<(ContactRow, u8)>) -> (Vec<(ContactRow, u8)>, usize) {
    let mut seen = HashSet::new();
    let before = people.len();
    let deduped: Vec<(ContactRow, u8)> = people
        .into_iter()
        .filter(|(row, _)| {
            let name = normalized_person_name(&row.contact.name);
            if name.is_empty() {
                return true;
            }
            seen.insert(name)
        })
        .collect();
    let dropped = before - deduped.len();
    (deduped, dropped)
}
```

In `fn reconnect`, immediately after the `people.sort_by(...)` block:

```rust
    let (people, deduped_rows) = dedupe_rows_by_name(people);
```

and add `"deduped_rows": deduped_rows,` to the stats `json!` block (next to `"matched"`). Note `total` is computed as `people.len()` — move `let total = people.len();` to AFTER the dedup call so `matched` reflects the deduped pool.

- [ ] **Step 4: Run tests**

Run: `cargo test`
Expected: 37 passed.

- [ ] **Step 5: Commit**

```bash
git add crates/peoplegraph/src/main.rs
git commit -m "peoplegraph: deck deals one card per human

reconnect dedupes the pool by normalized name (best-ranked row wins);
stats report deduped_rows.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: CLI — batch `apply-duplicates` command

**Files:**
- Modify: `crates/peoplegraph/src/main.rs` — new `ApplyDuplicatesArgs` (next to `SuggestDuplicatesArgs`, ~line 162), new `Commands::ApplyDuplicates` variant + dispatch arm + `command_name` arm (~line 4300 area), new functions next to `suggest_duplicates`; bump `Cargo.toml` version to `0.3.9`
- Test: `mod tests` in `main.rs`

**Interfaces:**
- Consumes: `duplicate_confidence`, `skip_default_duplicate_candidate`, `already_canonicalized_together`, `queue_pair_status`, `primary_duplicate`, `canonical_id_for_merge`, `merge_aliases`, `apply_canonical_to_contact`, `mark_merge_applied`, `read_merge_queue`, `write_merge_queue`, `contact_key_for_email`, `read_json_value`, `write_json_value`, `rows`, `contact_brief` (all exist).
- Produces:
  - `peoplegraph apply-duplicates [--min-confidence 0.94] [--dry-run] [--limit 1000]` → `{ ok, data: { dry_run, groups: [{canonical_id?, members: [email...], pairs: N}], applied_pairs } }` — Task 6's bridge calls this and reads `data.applied_pairs`.
  - `fn group_pairs(pairs: &[(String, String)]) -> Vec<Vec<String>>` — transitive union of pair emails, each group's member order = first-seen.

- [ ] **Step 1: Write the failing test for the grouping helper**

```rust
    #[test]
    fn group_pairs_is_transitive() {
        let pairs = vec![
            ("a@x.com".to_string(), "b@x.com".to_string()),
            ("c@y.com".to_string(), "d@y.com".to_string()),
            ("b@x.com".to_string(), "e@x.com".to_string()), // joins group 1 via b
        ];
        let groups = group_pairs(&pairs);
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0], vec!["a@x.com", "b@x.com", "e@x.com"]);
        assert_eq!(groups[1], vec!["c@y.com", "d@y.com"]);
    }
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test group_pairs_is_transitive`
Expected: compile error — `group_pairs` not defined.

- [ ] **Step 3: Implement**

Args struct (after `SuggestDuplicatesArgs`):

```rust
#[derive(Args, Debug, Clone)]
struct ApplyDuplicatesArgs {
    /// Only auto-merge at/above this confidence (corroborated tier).
    #[arg(long, default_value_t = 0.94)]
    min_confidence: f64,

    /// Print what would merge without writing anything.
    #[arg(long, default_value_t = false)]
    dry_run: bool,

    #[arg(long, default_value_t = 1000)]
    limit: usize,
}
```

Enum variant (after `SuggestDuplicates`): `/// Auto-apply high-confidence duplicate merges in one batch pass.` + `ApplyDuplicates(ApplyDuplicatesArgs),`. Dispatch arm (next to `Commands::SuggestDuplicates`): `Commands::ApplyDuplicates(args) => apply_duplicates(cli, command, args, start),`. `command_name` arm: `Commands::ApplyDuplicates(_) => "apply-duplicates",`.

Grouping helper (pure, near `suggest_duplicates`):

```rust
// Transitive union of pair emails: (a,b) + (b,e) -> [a,b,e]. Order of members
// is first-seen so group[0] is the highest-confidence primary.
fn group_pairs(pairs: &[(String, String)]) -> Vec<Vec<String>> {
    let mut groups: Vec<Vec<String>> = Vec::new();
    for (a, b) in pairs {
        let ia = groups.iter().position(|g| g.iter().any(|m| m == a));
        let ib = groups.iter().position(|g| g.iter().any(|m| m == b));
        match (ia, ib) {
            (None, None) => groups.push(vec![a.clone(), b.clone()]),
            (Some(i), None) => groups[i].push(b.clone()),
            (None, Some(j)) => groups[j].push(a.clone()),
            (Some(i), Some(j)) if i != j => {
                let (keep, drain) = (i.min(j), i.max(j));
                let moved = groups.remove(drain);
                for m in moved {
                    if !groups[keep].contains(&m) {
                        groups[keep].push(m);
                    }
                }
            }
            (Some(_), Some(_)) => {} // already same group
        }
    }
    groups
}
```

(Use ONLY the second implementation; the first sketch must not appear in the code.)

Main command:

```rust
fn apply_duplicates(
    cli: &Cli,
    command: &'static str,
    args: &ApplyDuplicatesArgs,
    start: Instant,
) -> Response {
    let (cache_path, index) = match load_index(cli, command, start) {
        Ok(loaded) => loaded,
        Err(response) => return *response,
    };
    let queue_path = merge_queue_path(&cache_path);
    let mut queue = read_merge_queue(&queue_path);
    let min_confidence = args.min_confidence.clamp(0.0, 1.0);
    let contact_rows = rows(&index);

    // Same scan as suggest-duplicates, but collect only the auto-merge tier.
    let mut pairs: Vec<(f64, String, String)> = Vec::new();
    for (left_index, left) in contact_rows.iter().enumerate() {
        for right in contact_rows.iter().skip(left_index + 1) {
            if already_canonicalized_together(left, right) {
                continue;
            }
            if queue_pair_status(&queue, &left.email, &right.email).is_some() {
                continue;
            }
            if skip_default_duplicate_candidate(left, right) {
                continue;
            }
            if let Some((confidence, _reasons)) = duplicate_confidence(left, right)
                && confidence >= min_confidence
            {
                let (primary, duplicate) = primary_duplicate(left, right);
                pairs.push((confidence, primary.email.clone(), duplicate.email.clone()));
            }
        }
    }
    pairs.sort_by(|a, b| b.0.total_cmp(&a.0));
    pairs.truncate(args.limit.max(1));
    let pair_emails: Vec<(String, String)> =
        pairs.iter().map(|(_, a, b)| (a.clone(), b.clone())).collect();
    let groups = group_pairs(&pair_emails);

    let groups_json: Vec<Value> = groups
        .iter()
        .map(|members| {
            json!({
                "canonical_id": canonical_id_for_merge(&index, &members[0], members.get(1).map(String::as_str).unwrap_or(&members[0])),
                "members": members,
            })
        })
        .collect();

    if args.dry_run {
        return ok(
            command,
            json!({ "dry_run": true, "applied_pairs": 0, "groups": groups_json }),
            json!({ "matched": pair_emails.len(), "groups": groups.len(), "ms": elapsed_ms(start) }),
        );
    }

    // ONE cache read/write for the whole batch.
    let mut index_json = match read_json_value(&cache_path) {
        Ok(value) => value,
        Err(message) => return fail(command, "cache_read_failed", message, start),
    };
    let canonical_synced_at = unix_seconds_iso();
    for members in &groups {
        let canonical_id = canonical_id_for_merge(
            &index,
            &members[0],
            members.get(1).map(String::as_str).unwrap_or(&members[0]),
        );
        // Union of every member's aliases, accumulated pairwise.
        let mut aliases: Vec<String> = Vec::new();
        for member in members {
            push_unique_email(&mut aliases, member);
            for alias in merge_aliases(&index, &members[0], member) {
                push_unique_email(&mut aliases, &alias);
            }
        }
        for member in members {
            let Some(key) = contact_key_for_email(&index, member) else {
                continue;
            };
            if let Err(message) = apply_canonical_to_contact(
                &mut index_json,
                &key,
                &canonical_id,
                &aliases,
                &canonical_synced_at,
            ) {
                return fail(command, "cache_write_failed", message, start);
            }
        }
    }
    if let Err(message) = write_json_value(&cache_path, &index_json) {
        return fail(command, "cache_write_failed", message, start);
    }
    for (_, a, b) in &pairs {
        mark_merge_applied(&mut queue, &index, a, b);
    }
    if let Err(message) = write_merge_queue(&queue_path, &queue) {
        return fail(command, "queue_write_failed", message, start);
    }

    ok(
        command,
        json!({ "dry_run": false, "applied_pairs": pair_emails.len(), "groups": groups_json }),
        json!({ "matched": pair_emails.len(), "groups": groups.len(), "ms": elapsed_ms(start) }),
    )
}
```

Bump `crates/peoplegraph/Cargo.toml`: `version = "0.3.9"`.

- [ ] **Step 4: Tests + fixture smoke**

```bash
cargo test   # 38 passed
cargo build --release
D=$(mktemp -d) && cp fixtures/contact-index.sample.json $D/contact-index.json
./target/release/peoplegraph --cache $D/contact-index.json apply-duplicates --dry-run | python3 -m json.tool | head -20
./target/release/peoplegraph --cache $D/contact-index.json apply-duplicates | python3 -c "import json,sys;d=json.load(sys.stdin);print('applied:',d['data']['applied_pairs'])"
./target/release/peoplegraph --cache $D/contact-index.json apply-duplicates | python3 -c "import json,sys;d=json.load(sys.stdin);print('rerun applied:',d['data']['applied_pairs'])"
```
Expected: dry-run lists groups without writing; second real run applies **0** (queue marks them applied — idempotent).

- [ ] **Step 5: Commit**

```bash
git add crates/peoplegraph
git commit -m "peoplegraph 0.3.9: batch apply-duplicates command

Auto-merges corroborated duplicate pairs (default >=0.94) with transitive
grouping in a single cache write; --dry-run previews; queue-idempotent.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Worker — merge review API

**Files:**
- Modify: `apps/reconnect-web/src/index.ts`, `apps/reconnect-web/schema.sql`, `apps/reconnect-web/package.json`, `apps/reconnect-web/scripts/smoke.sh`
- Create: `apps/reconnect-web/migrations/0003-merge-review.sql`

**Interfaces:**
- Consumes: existing `requireGoogleUser`, `checkSyncToken`, `json`, `nowSeconds`.
- Produces (Task 5 UI and Task 6 bridge depend on these exact shapes):
  - `GET /api/merge/candidates` (Google auth) → `{ total, candidates: [{id, confidence, reasons, name_a, company_a, domain_a, last_contact_a, exchanges_a, name_b, company_b, domain_b, last_contact_b, exchanges_b}] }`, confidence DESC, LIMIT 500
  - `POST /api/merge/swipe {id, action: "merge"|"keep"}` (Google auth) → `{ok,id,action}`; 404 `unknown_pair`
  - `POST /api/merge/sync {upserts, remove_ids, reset?}` (SYNC_TOKEN) → `{ok, upserted, removed, reset}`
  - `GET /api/merge/decisions?applied=0` + `POST /api/merge/decisions/ack {ids}` (SYNC_TOKEN); ack deletes acked pairs from `merge_candidates`

- [ ] **Step 1: Schema + migration**

Append to `schema.sql` (and the same content is `migrations/0003-merge-review.sql`, minus `IF NOT EXISTS` it keeps them — use identical `CREATE TABLE IF NOT EXISTS` in both):

```sql
-- Merge review: uncertain duplicate pairs (0.88-0.93) for human judgment.
-- Same privacy rule: opaque pair ids; emails never stored here.

CREATE TABLE IF NOT EXISTS merge_candidates (
  id             TEXT PRIMARY KEY,   -- opaque pair id (HMAC, salt local to bridge)
  confidence     REAL,
  reasons        TEXT,               -- comma-joined tags e.g. 'same_name,very_similar_name'
  name_a         TEXT NOT NULL,
  company_a      TEXT,
  domain_a       TEXT,
  last_contact_a TEXT,
  exchanges_a    INTEGER,
  name_b         TEXT NOT NULL,
  company_b      TEXT,
  domain_b       TEXT,
  last_contact_b TEXT,
  exchanges_b    INTEGER,
  updated_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_merge_candidates_conf ON merge_candidates (confidence DESC);

CREATE TABLE IF NOT EXISTS merge_decisions (
  id           TEXT PRIMARY KEY,     -- references merge_candidates.id
  action       TEXT NOT NULL,        -- 'merge' (right) | 'keep' (left)
  decided_by   TEXT,
  decided_at   INTEGER NOT NULL,
  applied      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_merge_decisions_applied ON merge_decisions (applied);
```

`package.json` scripts: add `"db:migrate:0003": "wrangler d1 execute reconnect --remote --file ./migrations/0003-merge-review.sql"`.

- [ ] **Step 2: Routes + handlers in `src/index.ts`**

Add to the router (before the `pathname.startsWith("/api/")` 404):

```ts
			if (pathname === "/api/merge/candidates" && request.method === "GET") {
				return await listMergeCandidates(request, env);
			}
			if (pathname === "/api/merge/swipe" && request.method === "POST") {
				return await mergeSwipe(request, env);
			}
			if (pathname === "/api/merge/sync" && request.method === "POST") {
				return await mergeSync(request, env);
			}
			if (pathname === "/api/merge/decisions" && request.method === "GET") {
				return await listMergeDecisions(request, env);
			}
			if (pathname === "/api/merge/decisions/ack" && request.method === "POST") {
				return await ackMergeDecisions(request, env);
			}
```

Handlers (mirror the contact flow exactly):

```ts
const MERGE_ACTIONS = new Set(["merge", "keep"]);

interface MergePairInput {
	id: string;
	confidence?: number | null;
	reasons?: string | null;
	name_a: string; company_a?: string | null; domain_a?: string | null;
	last_contact_a?: string | null; exchanges_a?: number | null;
	name_b: string; company_b?: string | null; domain_b?: string | null;
	last_contact_b?: string | null; exchanges_b?: number | null;
}

// GET /api/merge/candidates — undecided pairs, most confident first.
async function listMergeCandidates(request: Request, env: Env): Promise<Response> {
	const auth = await requireGoogleUser(request, env);
	if ("error" in auth) return json({ error: auth.error }, 401);
	const totalRow = await env.DB.prepare(
		`SELECT COUNT(*) AS n FROM merge_candidates m LEFT JOIN merge_decisions d ON d.id = m.id WHERE d.id IS NULL`
	).first<{ n: number }>();
	const rows = await env.DB.prepare(
		`SELECT m.* FROM merge_candidates m
		   LEFT JOIN merge_decisions d ON d.id = m.id
		  WHERE d.id IS NULL
		  ORDER BY m.confidence DESC
		  LIMIT 500`
	).all();
	return json({ total: totalRow?.n ?? 0, candidates: rows.results ?? [] });
}

// POST /api/merge/swipe { id, action: merge|keep }
async function mergeSwipe(request: Request, env: Env): Promise<Response> {
	const auth = await requireGoogleUser(request, env);
	if ("error" in auth) return json({ error: auth.error }, 401);
	const body = (await request.json().catch(() => null)) as { id?: string; action?: string } | null;
	if (!body?.id || !body.action || !MERGE_ACTIONS.has(body.action)) {
		return json({ error: "bad_request", message: "need id + action in {merge,keep}" }, 400);
	}
	const exists = await env.DB.prepare("SELECT id FROM merge_candidates WHERE id = ?").bind(body.id).first();
	if (!exists) return json({ error: "unknown_pair" }, 404);
	await env.DB.prepare(
		`INSERT INTO merge_decisions (id, action, decided_by, decided_at, applied)
		 VALUES (?, ?, ?, ?, 0)
		 ON CONFLICT(id) DO UPDATE SET
		   action = excluded.action, decided_by = excluded.decided_by,
		   decided_at = excluded.decided_at, applied = 0`
	).bind(body.id, body.action, auth.email, nowSeconds()).run();
	return json({ ok: true, id: body.id, action: body.action });
}

// POST /api/merge/sync { upserts, remove_ids, reset? }
async function mergeSync(request: Request, env: Env): Promise<Response> {
	if (!checkSyncToken(request, env)) return json({ error: "unauthorized" }, 401);
	const body = (await request.json().catch(() => null)) as
		| { upserts?: MergePairInput[]; remove_ids?: string[]; reset?: boolean }
		| null;
	if (!body || (!Array.isArray(body.upserts) && !Array.isArray(body.remove_ids) && !body.reset)) {
		return json({ error: "bad_request", message: "need upserts[] and/or remove_ids[] (or reset)" }, 400);
	}
	const upserts = body.upserts ?? [];
	const removeIds = body.remove_ids ?? [];
	const stmts: D1PreparedStatement[] = [];
	if (body.reset) stmts.push(env.DB.prepare("DELETE FROM merge_candidates"));
	const now = nowSeconds();
	const insert = env.DB.prepare(
		`INSERT INTO merge_candidates (id, confidence, reasons,
		   name_a, company_a, domain_a, last_contact_a, exchanges_a,
		   name_b, company_b, domain_b, last_contact_b, exchanges_b, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET
		   confidence = excluded.confidence, reasons = excluded.reasons,
		   name_a = excluded.name_a, company_a = excluded.company_a, domain_a = excluded.domain_a,
		   last_contact_a = excluded.last_contact_a, exchanges_a = excluded.exchanges_a,
		   name_b = excluded.name_b, company_b = excluded.company_b, domain_b = excluded.domain_b,
		   last_contact_b = excluded.last_contact_b, exchanges_b = excluded.exchanges_b,
		   updated_at = excluded.updated_at`
	);
	for (const p of upserts) {
		if (!p?.id || !p?.name_a || !p?.name_b) continue;
		stmts.push(insert.bind(
			p.id, p.confidence ?? null, p.reasons ?? null,
			p.name_a, p.company_a ?? null, p.domain_a ?? null, p.last_contact_a ?? null, p.exchanges_a ?? null,
			p.name_b, p.company_b ?? null, p.domain_b ?? null, p.last_contact_b ?? null, p.exchanges_b ?? null,
			now
		));
	}
	const remove = env.DB.prepare("DELETE FROM merge_candidates WHERE id = ?");
	for (const id of removeIds) stmts.push(remove.bind(id));
	for (let i = 0; i < stmts.length; i += 100) {
		await env.DB.batch(stmts.slice(i, i + 100));
	}
	return json({ ok: true, upserted: upserts.length, removed: removeIds.length, reset: !!body.reset });
}

// GET /api/merge/decisions?applied=0
async function listMergeDecisions(request: Request, env: Env): Promise<Response> {
	if (!checkSyncToken(request, env)) return json({ error: "unauthorized" }, 401);
	const url = new URL(request.url);
	const onlyPending = url.searchParams.get("applied") !== "1";
	const query = onlyPending
		? "SELECT id, action, decided_by, decided_at, applied FROM merge_decisions WHERE applied = 0 ORDER BY decided_at"
		: "SELECT id, action, decided_by, decided_at, applied FROM merge_decisions ORDER BY decided_at";
	const rows = await env.DB.prepare(query).all();
	return json({ decisions: rows.results ?? [] });
}

// POST /api/merge/decisions/ack { ids } — mark applied + prune the pairs.
async function ackMergeDecisions(request: Request, env: Env): Promise<Response> {
	if (!checkSyncToken(request, env)) return json({ error: "bad_request" }, 401);
	const body = (await request.json().catch(() => null)) as { ids?: string[] } | null;
	if (!Array.isArray(body?.ids) || body.ids.length === 0) {
		return json({ error: "bad_request", message: "need ids[]" }, 400);
	}
	const placeholders = body.ids.map(() => "?").join(",");
	await env.DB.prepare(`UPDATE merge_decisions SET applied = 1 WHERE id IN (${placeholders})`).bind(...body.ids).run();
	await env.DB.prepare(`DELETE FROM merge_candidates WHERE id IN (${placeholders})`).bind(...body.ids).run();
	return json({ ok: true, acked: body.ids.length });
}
```

(Note: fix the ack error code — `json({ error: "unauthorized" }, 401)`, matching the others, not "bad_request".)

- [ ] **Step 3: Typecheck**

Run: `cd apps/reconnect-web && npm run typecheck` — exit 0.

- [ ] **Step 4: Extend the smoke test** — append to `scripts/smoke.sh` before `echo "SMOKE OK"`:

```bash
echo "--- merge: sync 2 pairs, auth gates, decisions, remove"
curl -sf "${auth[@]}" -d '{"reset":true,"upserts":[
  {"id":"p1","confidence":0.9,"reasons":"same_name","name_a":"A One","domain_a":"x.com","name_b":"A Won","domain_b":"y.com"},
  {"id":"p2","confidence":0.88,"name_a":"B Two","name_b":"B Too"}]}' localhost:8787/api/merge/sync | grep '"upserted":2'
code=$(curl -s -o /dev/null -w "%{http_code}" localhost:8787/api/merge/candidates)
[ "$code" = "401" ] || { echo "expected 401, got $code"; exit 1; }
curl -s "${auth[@]}" -d '{"id":"p1","action":"merge"}' localhost:8787/api/merge/swipe | grep -q error
curl -sf "${auth[@]}" "localhost:8787/api/merge/decisions?applied=0" | grep -q '"decisions":\[\]'
curl -sf "${auth[@]}" -d '{"remove_ids":["p2"]}' localhost:8787/api/merge/sync | grep '"removed":1'
```

Run: `npm run smoke` — expect `SMOKE OK`.

- [ ] **Step 5: Commit**

```bash
git add apps/reconnect-web
git commit -m "reconnect-web: merge review API (pair tables + 5 endpoints)

Mirrors the contact flow: diff sync, auth-gated candidates/swipe,
SYNC_TOKEN pull/ack, ack prunes pairs. Migration 0003.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: UI — `/merge` swipe page

**Files:**
- Create: `apps/reconnect-web/public/merge.html`
- Modify: `apps/reconnect-web/public/index.html` (header link only)

**Interfaces:**
- Consumes: `GET /api/merge/candidates` `{total, candidates}` and `POST /api/merge/swipe {id, action}` from Task 4; `GET /api/config` for the Google client id.
- Produces: page served at `/merge` (Cloudflare assets serve `merge.html` for `/merge`).

- [ ] **Step 1: Header link in `index.html`**

Replace `<h1>☀️ Reconnect</h1>` with:

```html
		<h1>☀️ Reconnect <a href="/merge" style="font-size:.75rem;color:var(--muted);text-decoration:none;">🧬 merge review</a></h1>
```

- [ ] **Step 2: Create `merge.html`** — same skeleton/styles/behavior as `index.html` (auth gate, `waitForGoogle`, One Tap, never-drop-a-swipe, refill), with a pair card. Full file:

```html
<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
	<title>Merge review</title>
	<script src="https://accounts.google.com/gsi/client" async defer></script>
	<style>
		:root { --bg:#0f1115; --card:#1a1d24; --muted:#8a90a0; --text:#eef0f5; --accent:#6ca2dc; --good:#4ec98b; --bad:#e0656f; }
		* { box-sizing: border-box; }
		body { margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; background:var(--bg); color:var(--text); height:100vh; display:flex; flex-direction:column; align-items:center; }
		header { width:100%; max-width:480px; display:flex; align-items:center; justify-content:space-between; padding:16px; }
		header h1 { font-size:1.1rem; margin:0; letter-spacing:.02em; }
		header h1 a { font-size:.75rem; color:var(--muted); text-decoration:none; }
		#count { color:var(--muted); font-size:.85rem; }
		main { flex:1; width:100%; max-width:480px; padding:0 16px; display:flex; flex-direction:column; justify-content:center; }
		.card { position:relative; background:var(--card); border:1px solid #262a33; border-radius:18px; padding:24px 20px; min-height:320px; display:flex; flex-direction:column; gap:12px; touch-action:none; user-select:none; transition:transform .15s ease, opacity .15s ease; }
		.question { text-align:center; color:var(--muted); font-size:.85rem; }
		.pill { font-size:.72rem; padding:2px 8px; border-radius:10px; background:#262a33; color:var(--muted); }
		.pair { display:flex; gap:12px; }
		.person { flex:1; background:rgba(108,162,220,.07); border-radius:12px; padding:14px 12px; display:flex; flex-direction:column; gap:6px; }
		.person .name { font-size:1.05rem; font-weight:700; line-height:1.15; }
		.person .meta { color:var(--muted); font-size:.8rem; }
		.stamp { position:absolute; top:20px; font-size:1.2rem; font-weight:800; letter-spacing:.08em; padding:4px 10px; border-radius:8px; border:3px solid; opacity:0; z-index:2; }
		.stamp.merge { right:20px; color:var(--good); border-color:var(--good); transform:rotate(12deg); }
		.stamp.keep { left:20px; color:var(--bad); border-color:var(--bad); transform:rotate(-12deg); }
		.actions { display:flex; align-items:center; justify-content:center; gap:18px; padding:22px 0 32px; }
		.btn { width:60px; height:60px; border-radius:50%; border:1px solid #2c313c; background:var(--card); color:var(--text); font-size:1.4rem; cursor:pointer; display:flex; align-items:center; justify-content:center; transition:transform .1s; }
		.btn:active { transform:scale(.92); }
		.btn.good { color:var(--good); border-color:var(--good); }
		.btn.bad { color:var(--bad); border-color:var(--bad); }
		.hint { color:var(--muted); font-size:.75rem; text-align:center; padding-bottom:16px; }
		.empty { text-align:center; color:var(--muted); padding:60px 20px; }
		#signin { display:flex; justify-content:flex-end; }
		.gate { text-align:center; padding:50px 20px; color:var(--muted); }
	</style>
</head>
<body>
	<header>
		<h1>🧬 Merge review <a href="/">☀️ reconnect</a></h1>
		<span id="count"></span>
	</header>
	<main>
		<div id="signin"></div>
		<div id="stage"></div>
		<div class="actions" id="actions" hidden>
			<button class="btn bad" id="b-keep" title="Different people — keep separate (left)">⇹</button>
			<button class="btn good" id="b-merge" title="Same person — merge (right)">⧉</button>
		</div>
		<div class="hint">swipe right = same person (merge) · left = different people · ← / → keys work too</div>
	</main>

	<script>
		const stage = document.getElementById("stage");
		const actionsEl = document.getElementById("actions");
		const countEl = document.getElementById("count");
		let idToken = null;
		let queue = [];
		let total = 0;
		let seen = new Set();

		function waitForGoogle(timeoutMs = 10000) {
			return new Promise((resolve) => {
				if (window.google?.accounts?.id) return resolve(true);
				const start = Date.now();
				const t = setInterval(() => {
					if (window.google?.accounts?.id) { clearInterval(t); resolve(true); }
					else if (Date.now() - start > timeoutMs) { clearInterval(t); resolve(false); }
				}, 100);
			});
		}

		async function boot() {
			stage.innerHTML = `<div class="gate">Loading…</div>`;
			const cfg = await fetch("/api/config").then(r => r.json()).catch(() => ({}));
			if (!cfg.googleClientId) {
				stage.innerHTML = `<div class="gate">Sign-in unavailable — missing Google config.</div>`;
				return;
			}
			const ready = await waitForGoogle();
			if (!ready) {
				stage.innerHTML = `<div class="gate">Couldn't load Google sign-in. <button id="retry">Retry</button></div>`;
				document.getElementById("retry").onclick = boot;
				return;
			}
			google.accounts.id.initialize({
				client_id: cfg.googleClientId,
				callback: (resp) => { idToken = resp.credential; load(); },
			});
			google.accounts.id.renderButton(document.getElementById("signin"), { theme: "outline", size: "large" });
			google.accounts.id.prompt();
			renderGate();
		}

		function renderGate() {
			actionsEl.hidden = true;
			countEl.textContent = "";
			stage.innerHTML = `<div class="gate">Sign in with Google to review possible duplicates.</div>`;
		}

		async function load() {
			if (!idToken) { renderGate(); return; }
			const resp = await fetch("/api/merge/candidates", { headers: { authorization: "Bearer " + idToken } }).catch(() => null);
			if (!resp || resp.status === 401) {
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

		async function refill() {
			if (!idToken || queue.length >= 20 || seen.size >= total) return;
			const resp = await fetch("/api/merge/candidates", { headers: { authorization: "Bearer " + idToken } }).catch(() => null);
			if (!resp || !resp.ok) return;
			const data = await resp.json().catch(() => null);
			if (!data) return;
			total = data.total ?? total;
			for (const c of data.candidates || []) {
				if (!seen.has(c.id)) { seen.add(c.id); queue.push(c); }
			}
		}

		function personHtml(name, company, domain, lastContact, exchanges) {
			const ts = lastContact ? Date.parse(lastContact.includes("T") ? lastContact : lastContact + "T00:00:00") : NaN;
			const days = Number.isFinite(ts) ? Math.max(0, Math.floor((Date.now() - ts) / 86400000)) : null;
			const bits = [];
			if (company) bits.push(company);
			if (domain) bits.push(domain);
			if (days != null) bits.push(`last contact ${days}d ago`);
			if (exchanges != null) bits.push(`${exchanges} emails`);
			const wrap = document.createElement("div");
			wrap.className = "person";
			const n = document.createElement("div"); n.className = "name"; n.textContent = name;
			wrap.appendChild(n);
			for (const b of bits) {
				const m = document.createElement("div"); m.className = "meta"; m.textContent = b;
				wrap.appendChild(m);
			}
			return wrap;
		}

		function render() {
			countEl.textContent = total ? `${Math.min(seen.size - queue.length + 1, total)} / ${total}` : "";
			if (queue.length === 0) {
				actionsEl.hidden = true;
				stage.innerHTML = `<div class="empty">No duplicate pairs to review. 🎉</div>`;
				countEl.textContent = "";
				return;
			}
			const c = queue[0];
			actionsEl.hidden = false;
			const card = document.createElement("div");
			card.className = "card";
			card.innerHTML = `
				<div class="stamp merge">MERGE</div>
				<div class="stamp keep">KEEP APART</div>
				<div class="question">Same person?</div>
				<div class="pair"></div>
				<div class="question"><span class="pill"></span></div>
			`;
			const pair = card.querySelector(".pair");
			pair.appendChild(personHtml(c.name_a, c.company_a, c.domain_a, c.last_contact_a, c.exchanges_a));
			pair.appendChild(personHtml(c.name_b, c.company_b, c.domain_b, c.last_contact_b, c.exchanges_b));
			const pill = card.querySelector(".pill");
			pill.textContent = `${c.confidence != null ? Math.round(c.confidence * 100) + "% match" : ""}${c.reasons ? " · " + c.reasons.replaceAll(",", ", ").replaceAll("_", " ") : ""}`;
			stage.innerHTML = "";
			stage.appendChild(card);
			wireDrag(card);
		}

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
			queue.shift();
			render();
			refill();
			try {
				const r = await fetch("/api/merge/swipe", {
					method: "POST",
					headers: { "content-type": "application/json", "authorization": "Bearer " + idToken },
					body: JSON.stringify({ id: c.id, action }),
				});
				if (r.status === 401) {
					queue.unshift(c);
					idToken = null;
					renderGate();
					if (window.google?.accounts?.id) google.accounts.id.prompt();
					return;
				}
				if (r.status === 404) {
					showNotice("Pair already resolved — skipped");
					return;
				}
				if (!r.ok) {
					queue.unshift(c); render();
					showNotice("Not saved — try again");
				}
			} catch (e) {
				queue.unshift(c); render();
				showNotice("Offline? Not saved — try again");
			}
		}

		document.getElementById("b-merge").onclick = () => decide("merge");
		document.getElementById("b-keep").onclick = () => decide("keep");
		document.addEventListener("keydown", (e) => {
			if (e.key === "ArrowRight") decide("merge");
			else if (e.key === "ArrowLeft") decide("keep");
		});

		function wireDrag(card) {
			let startX = 0, dx = 0, dragging = false;
			const mergeStamp = card.querySelector(".stamp.merge");
			const keepStamp = card.querySelector(".stamp.keep");
			const down = (x) => { dragging = true; startX = x; };
			const move = (x) => {
				if (!dragging) return;
				dx = x - startX;
				card.style.transform = `translateX(${dx}px) rotate(${dx / 25}deg)`;
				mergeStamp.style.opacity = dx > 0 ? Math.min(1, dx / 120) : 0;
				keepStamp.style.opacity = dx < 0 ? Math.min(1, -dx / 120) : 0;
			};
			const up = () => {
				if (!dragging) return;
				dragging = false;
				if (dx > 120) decide("merge");
				else if (dx < -120) decide("keep");
				else { card.style.transform = ""; mergeStamp.style.opacity = 0; keepStamp.style.opacity = 0; }
				dx = 0;
			};
			card.addEventListener("pointerdown", (e) => { card.setPointerCapture(e.pointerId); down(e.clientX); });
			card.addEventListener("pointermove", (e) => move(e.clientX));
			card.addEventListener("pointerup", up);
			card.addEventListener("pointercancel", up);
		}

		boot();
	</script>
</body>
</html>
```

- [ ] **Step 3: Syntax-check the inline script**

```bash
cd apps/reconnect-web && python3 - <<'EOF'
import re
html = open('public/merge.html').read()
script = re.search(r'<script>\n(.*?)\n\t</script>', html, re.S).group(1)
import os
os.makedirs('/tmp/dedup-check', exist_ok=True)
open('/tmp/dedup-check/merge-ui.js','w').write(script)
EOF
node --check /tmp/dedup-check/merge-ui.js && echo "merge UI syntax OK"
```

- [ ] **Step 4: Visual check** — `npx wrangler dev`, open `http://localhost:8787/merge`: gate renders; with the smoke pairs seeded and an allowlisted sign-in, the pair card shows two persons side by side with confidence pill.

- [ ] **Step 5: Commit**

```bash
git add apps/reconnect-web/public
git commit -m "reconnect-web: /merge swipe page for duplicate review

Pair cards (right = merge, left = keep apart), same auth/never-drop
patterns as the main deck; cross-links in both headers.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Bridge — `merge-push` / `merge-pull`

**Files:**
- Modify: `scripts/lib/reconnect-sync.mjs`, `scripts/lib/reconnect-sync.test.mjs`, `scripts/peoplegraph-reconnect-web.mjs`

**Interfaces:**
- Consumes: CLI `apply-duplicates` (Task 3), `suggest-duplicates` (`data.suggestions[].{confidence, reasons, primary, duplicate}` where primary/duplicate are `contact_brief` objects with `email, name, company, domain, last_contact, total_exchanges`), Worker merge endpoints (Task 4).
- Produces:
  - lib: `pairId(saltHex, emailA, emailB): string` — order-insensitive (sorts the two lowercased emails, HMACs `a|b`, 32 hex chars); `hashValues(values: any[]): string` — 16-hex generic hash; `migrateState` now also defaults `mergeMap: {}`, `lastMergePush: {}`, `lastMergeScanUnix: 0` (still `version: 2`, additive — an existing v2 state gains the fields without losing salt/map/lastPush).
  - bridge commands: `merge-push [--force]`, `merge-pull`; `run` = pull → merge-pull → push → merge-push (merge steps wrapped in try/catch).

- [ ] **Step 1: Write the failing lib tests** (append to `reconnect-sync.test.mjs`)

```js
import { pairId, hashValues } from "./reconnect-sync.mjs";

test("pairId is order-insensitive and distinct per pair", () => {
	const a = pairId(SALT, "A@x.com", "b@y.com");
	const b = pairId(SALT, "b@y.com", "a@x.com ");
	assert.equal(a, b);
	assert.match(a, /^[0-9a-f]{32}$/);
	assert.notEqual(a, pairId(SALT, "a@x.com", "c@z.com"));
});

test("hashValues is stable and ignores nothing it's given", () => {
	assert.equal(hashValues(["x", 1, null]), hashValues(["x", 1, null]));
	assert.notEqual(hashValues(["x", 1, null]), hashValues(["x", 2, null]));
	assert.match(hashValues(["x"]), /^[0-9a-f]{16}$/);
});

test("migrateState adds merge fields to existing v2 state without clobbering", () => {
	const v2 = { version: 2, salt: SALT, map: { x: "a@b.com" }, lastPush: { x: { h: "h", s: 1 } } };
	const out = migrateState(v2);
	assert.equal(out.salt, SALT);
	assert.deepEqual(out.map, { x: "a@b.com" });
	assert.deepEqual(out.mergeMap, {});
	assert.deepEqual(out.lastMergePush, {});
	assert.equal(out.lastMergeScanUnix, 0);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test scripts/lib/*.test.mjs` — FAIL (`pairId` not exported).

- [ ] **Step 3: Implement lib additions** (in `reconnect-sync.mjs`)

```js
// Opaque pair id for merge-review cards: order-insensitive over the two emails.
export function pairId(saltHex, emailA, emailB) {
	const [a, b] = [emailA, emailB].map((e) => e.trim().toLowerCase()).sort();
	return createHmac("sha256", Buffer.from(saltHex, "hex"))
		.update(`${a}|${b}`)
		.digest("hex")
		.slice(0, 32);
}

// Generic stable content hash for diffing arbitrary card fields.
export function hashValues(values) {
	return createHash("sha256").update(JSON.stringify(values)).digest("hex").slice(0, 16);
}
```

and extend `migrateState` (replace the passthrough branch):

```js
export function migrateState(raw) {
	if (raw && raw.version === 2 && typeof raw.salt === "string") {
		return {
			...raw,
			mergeMap: raw.mergeMap ?? {},
			lastMergePush: raw.lastMergePush ?? {},
			lastMergeScanUnix: raw.lastMergeScanUnix ?? 0,
		};
	}
	return {
		version: 2,
		salt: randomBytes(32).toString("hex"),
		map: {},
		lastPush: {},
		mergeMap: {},
		lastMergePush: {},
		lastMergeScanUnix: 0,
	};
}
```

NOTE: the existing `migrateState` passthrough test asserts deep-equality on a bare v2 object — update that assertion to expect the merge fields added:

```js
	assert.deepEqual(migrateState(v2), { ...v2, mergeMap: {}, lastMergePush: {}, lastMergeScanUnix: 0 });
```

Run: `node --test scripts/lib/*.test.mjs` — all pass (7 tests).

- [ ] **Step 4: Bridge commands** (in `peoplegraph-reconnect-web.mjs`)

Import additions: `import { stableId, contentHash, diffPool, migrateState, pairId, hashValues } from "./lib/reconnect-sync.mjs";`

```js
const MERGE_SCAN_INTERVAL_SECS = 7 * 86400; // pair scan is O(n^2) — weekly is plenty
const AUTO_MERGE_CONFIDENCE = "0.94";
const REVIEW_MIN_CONFIDENCE = "0.88";

// merge-push: auto-merge the corroborated tier locally, then sync the
// uncertain band (0.88-0.93) to the /merge review deck. Weekly unless --force.
async function mergePush({ force = false } = {}) {
	const state = loadState();
	const nowUnix = Math.floor(Date.now() / 1000);
	if (!force && nowUnix - state.lastMergeScanUnix < MERGE_SCAN_INTERVAL_SECS) {
		console.log("merge scan ran recently — skipping (use merge-push --force to override)");
		return;
	}

	const applied = pg(["apply-duplicates", "--min-confidence", AUTO_MERGE_CONFIDENCE]);
	if (!applied.ok) die(`apply-duplicates failed: ${JSON.stringify(applied.error || applied)}`);
	console.log(`auto-merged ${applied.data?.applied_pairs ?? 0} corroborated pairs`);

	const res = pg(["suggest-duplicates", "--min-confidence", REVIEW_MIN_CONFIDENCE, "--limit", "2000"]);
	if (!res.ok) die(`suggest-duplicates failed: ${JSON.stringify(res.error || res)}`);
	const suggestions = (res.data?.suggestions ?? []).filter((s) => s.confidence < 0.94);

	const pool = suggestions.map((s) => {
		const id = pairId(state.salt, s.primary.email, s.duplicate.email);
		state.mergeMap[id] = {
			a: s.primary.email.trim().toLowerCase(),
			b: s.duplicate.email.trim().toLowerCase(),
		};
		const row = {
			id,
			confidence: s.confidence,
			reasons: (s.reasons ?? []).join(","),
			name_a: s.primary.name, company_a: s.primary.company ?? null,
			domain_a: s.primary.domain ?? null, last_contact_a: s.primary.last_contact ?? null,
			exchanges_a: s.primary.total_exchanges ?? null,
			name_b: s.duplicate.name, company_b: s.duplicate.company ?? null,
			domain_b: s.duplicate.domain ?? null, last_contact_b: s.duplicate.last_contact ?? null,
			exchanges_b: s.duplicate.total_exchanges ?? null,
		};
		return { id, h: hashValues([row.confidence, row.reasons, row.name_a, row.name_b, row.company_a, row.company_b]), s: 0, row };
	});

	const reset = Object.keys(state.lastMergePush).length === 0;
	const { upserts, removeIds, next } = diffPool(state.lastMergePush, pool);
	if (!upserts.length && !removeIds.length && !reset) {
		console.log("merge pairs unchanged — nothing to push");
	} else {
		const CHUNK = 200;
		for (let i = 0; i < Math.max(upserts.length, 1); i += CHUNK) {
			await api("/api/merge/sync", {
				method: "POST",
				body: {
					upserts: upserts.slice(i, i + CHUNK),
					remove_ids: i === 0 ? removeIds : [],
					reset: reset && i === 0,
				},
			});
		}
	}
	state.lastMergePush = next;
	state.lastMergeScanUnix = nowUnix;
	saveState(state);
	console.log(`merge review pool: ${pool.length} pairs (${upserts.length} upserted, ${removeIds.length} removed)`);
}

// merge-pull: apply human verdicts. right/'merge' -> apply-merge (canonical id
// + unioned aliases); left/'keep' -> dismiss-merge (never suggested again).
async function mergePull() {
	const state = loadState();
	const { decisions = [] } = await api("/api/merge/decisions?applied=0");
	if (decisions.length === 0) {
		console.log("no pending merge decisions");
		return;
	}
	const acked = [];
	for (const d of decisions) {
		const pair = state.mergeMap?.[d.id];
		if (!pair) {
			console.warn(`ack merge ${d.id} without applying: no local pair mapping`);
			acked.push(d.id);
			continue;
		}
		if (d.action === "merge") {
			const res = pg(["apply-merge", pair.a, pair.b]);
			if (!res.ok) {
				console.warn(`apply-merge failed for ${pair.a}+${pair.b}: ${JSON.stringify(res.error || res)}`);
				continue; // not acked -> retried next run
			}
			console.log(`merged ${pair.a} + ${pair.b}`);
		} else if (d.action === "keep") {
			const res = pg(["dismiss-merge", pair.a, pair.b, "--reason", "not_duplicate"]);
			if (!res.ok) {
				console.warn(`dismiss-merge failed for ${pair.a}+${pair.b}: ${JSON.stringify(res.error || res)}`);
				continue;
			}
			console.log(`kept apart ${pair.a} | ${pair.b}`);
		} else {
			console.warn(`skip merge ${d.id}: unknown action ${d.action}`);
			continue;
		}
		acked.push(d.id);
	}
	if (acked.length) {
		for (let i = 0; i < acked.length; i += 50) {
			try {
				await api("/api/merge/decisions/ack", { method: "POST", body: { ids: acked.slice(i, i + 50) } });
			} catch (e) {
				console.warn(`merge ack chunk failed: ${e.message}`);
			}
		}
	}
	saveState(state);
	console.log(`applied ${acked.length}/${decisions.length} merge decisions`);
}
```

Dispatch + help (replace the existing tail):

```js
const cmd = process.argv[2] || "help";
if (cmd === "help" || cmd === "-h" || cmd === "--help") {
	help();
} else {
	requireEnv();
	const forceReset = process.argv.includes("--reset");
	const force = process.argv.includes("--force");
	if (cmd === "push") await push({ forceReset });
	else if (cmd === "pull") await pull();
	else if (cmd === "merge-push") await mergePush({ force });
	else if (cmd === "merge-pull") await mergePull();
	else if (cmd === "run") {
		await pull();
		try { await mergePull(); } catch (e) { console.warn(`merge-pull failed (contact sync unaffected): ${e.message}`); }
		await push({ forceReset });
		try { await mergePush({ force }); } catch (e) { console.warn(`merge-push failed (contact sync unaffected): ${e.message}`); }
	}
	else { help(); process.exit(1); }
}
```

Update `help()` to list `merge-push [--force]` and `merge-pull`, and note that `run` includes both.

- [ ] **Step 5: Checks**

```bash
node --check scripts/peoplegraph-reconnect-web.mjs
node --test scripts/lib/*.test.mjs
node scripts/peoplegraph-reconnect-web.mjs help
```
Expected: clean, 7 tests pass, help shows the merge commands.

- [ ] **Step 6: Commit**

```bash
git add scripts/
git commit -m "bridge: merge-push/merge-pull for duplicate review

Auto-merges >=0.94 locally via apply-duplicates, syncs the 0.88-0.93 band
as pair cards (stable pair ids, weekly scan), applies merge/keep verdicts
via apply-merge/dismiss-merge. run = pull, merge-pull, push, merge-push.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Binary refresh, docs, rollout runbook, PR

**Files:**
- Modify: `bin/peoplegraph` (rebuild), `apps/reconnect-web/README.md`, `skills/peoplegraph-daily-reconnect/SKILL.md`
- Create: `docs/superpowers/plans/2026-07-24-dedup-rollout-runbook.md`

- [ ] **Step 1: Rebuild + commit the binary**

```bash
cd crates/peoplegraph && cargo build --release
cp target/release/peoplegraph ../../bin/peoplegraph
../../bin/peoplegraph version | grep '"version"'    # 0.3.9
cd ../.. && shasum -a 256 bin/peoplegraph           # record for the runbook
```

- [ ] **Step 2: Docs**

`apps/reconnect-web/README.md`: add the five `/api/merge/*` endpoints (auth split), the `/merge` page, and the merge/keep semantics table row. `skills/peoplegraph-daily-reconnect/SKILL.md`: note that `run` now includes merge-pull/merge-push, the weekly scan, `/merge` review page, and `apply-duplicates --dry-run` as the preview tool.

- [ ] **Step 3: Runbook** — `docs/superpowers/plans/2026-07-24-dedup-rollout-runbook.md`:

```markdown
# Contact dedup rollout

## A. Deploy (Kaya's machine, branch contact-dedup)
1. cd apps/reconnect-web && npm run typecheck && npm run smoke && npm run deploy
2. npm run db:migrate:0003
3. curl -s -o /dev/null -w "%{http_code}" $RECONNECT_WEB_URL/api/merge/candidates  -> 401

## B. John's machine
4. cd ~/obsidian-gmail-crm && git fetch && git checkout contact-dedup && git pull
5. shasum -a 256 bin/peoplegraph   # must match the hash in the PR description
   rm -f ~/.local/bin/peoplegraph && cp bin/peoplegraph ~/.local/bin/peoplegraph
   codesign --force --sign - ~/.local/bin/peoplegraph && hash -r
   peoplegraph version   # 0.3.9
6. DRY RUN FIRST — eyeball what would auto-merge (send the output to Kaya/John):
   set -a; source ~/.peoplegraph/reconnect-web.env; set +a
   peoplegraph --cache "$PEOPLEGRAPH_CACHE" apply-duplicates --dry-run \
     | python3 -c "import json,sys;d=json.load(sys.stdin);print(len(d['data']['groups']),'groups');[print(' | '.join(g['members'])) for g in d['data']['groups'][:30]]"
7. If the sample looks right:
   node scripts/peoplegraph-reconnect-web.mjs merge-push --force
   node scripts/peoplegraph-reconnect-web.mjs push
   (push refreshes the contact deck: merged + name-deduped pool shrinks)

## C. Verify
8. Deck count drops (name-dedup + auto-merges); /merge shows the review pairs.
9. Swipe one pair right + one left on /merge, then:
   node scripts/peoplegraph-reconnect-web.mjs merge-pull
   -> "merged a + b" and "kept apart a | b"; pair rows pruned after ack.
10. Susan Lyne check: peoplegraph --cache "$PEOPLEGRAPH_CACHE" find-person "Susan Lyne"
    -> her rows share one canonical_id.

## D. After merge to main
11. Both checkouts: git checkout main && git pull. Cron unchanged.
```

- [ ] **Step 4: Commit + PR**

```bash
git add -A
git commit -m "docs: contact dedup rollout runbook + API docs + 0.3.9 binary

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push -u origin contact-dedup
gh pr create --base main --title "Contact dedup: one card per human + canonical merges" --body "<summary per template, include bin/peoplegraph sha256>

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

---

## Self-review notes (performed while writing)

- **Spec coverage:** deck name-dedup (T2), batch auto-merge ≥0.94 (T3), /merge page (T5), Worker API + migration (T4), bridge push/pull + weekly cadence + state additions (T6), dry-run-first rollout + docs (T7). Privacy: pair cards carry no emails (T4 schema, T6 card builder).
- **Type consistency:** pair card fields (`name_a/company_a/domain_a/last_contact_a/exchanges_a`, `_b` mirror) identical across T4 schema, T4 `MergePairInput`, T5 `personHtml` call sites, T6 row builder. `{upserts, remove_ids, reset}` and `{total, candidates}` match the contact flow. `applied_pairs` produced by T3, consumed by T6.
- **Known judgment calls:** `s: 0` in the merge diff pool (score unused for pairs; the hash carries all change detection).
