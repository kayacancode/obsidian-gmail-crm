# Contact dedup: one card per human + canonical merges

**Date:** 2026-07-24
**Status:** Draft for review
**Builds on:** `2026-07-23-reconnect-stable-ids-design.md` (shipped in PR #2)

## Problem

The contact index has ~2,007 names with 2+ contact rows (same human, multiple
email addresses; `canonical_id` unpopulated). Consequences: the swipe deck deals
multiple cards for one person (unswiped duplicates — the "Lenka twice" report),
and scores/`who-knows`/contact lookups are fragmented across rows. The stable-ids
rebuild made swipes retire all same-name rows, but only *after* a swipe.

## Product decisions (settled with Kaya)

1. **Scope: both layers.** Fix the deck display (one card per person) AND
   canonicalize the underlying CRM rows via the CLI's existing merge tooling.
2. **Auto-merge bar: corroborated only (confidence ≥ 0.94).** Shared
   email/alias (0.99), same name + same non-generic domain (0.96), name-prefix +
   same domain (0.94) merge automatically on John's machine. Same-name-different-
   domain (0.90) and fuzzy names (0.88) are NEVER auto-merged.
3. **Review surface: a `/merge` page on the reconnect web app.** The uncertain
   band (0.88–0.93) becomes swipeable pair-cards: **right = same person (merge),
   left = different people (keep separate)**. Dismissals persist in the CLI merge
   queue so a rejected pair never resurfaces.

## Privacy model (unchanged in spirit)

No email addresses in D1, ever. A merge pair-card carries per side: name,
company, domain, days-since-contact, total exchanges, plus the confidence and
reason tags. The bridge keeps `pairId → {emailA, emailB}` in its local state
(same file, new `mergeMap` section), exactly like the contact `map`.
`pairId = stableId(salt, sort(emailA, emailB).join("|"))` — deterministic, so a
pair pushed twice keeps its id and a decision on it excludes it forever.

## Components

### 1. CLI — `crates/peoplegraph`

- **`reconnect` name-dedup (deck fix):** after existing filtering, keep only the
  highest-ranked row per `normalized_person_name` (rank = effective score, then
  total_exchanges — same ordering the sort already uses). One card per human,
  effective immediately, independent of merges. Stats gain
  `deduped_rows: <n dropped>`.
- **New `apply-duplicates` command (batch auto-merge):**
  `peoplegraph apply-duplicates --min-confidence 0.94 [--dry-run] [--limit N]`.
  Runs the same pair scan as `suggest-duplicates`, takes every suggestion at or
  above the threshold, and applies all merges in ONE cache read/write pass
  (canonical_id + unioned aliases per pair-group, transitively: A=B and B=C land
  in one canonical group). Marks pairs applied in the merge queue. `--dry-run`
  prints the pairs without writing. Rationale: `apply-merge` is one-pair-per-
  invocation with a full 16MB cache rewrite each time; hundreds of merges need a
  batch path.
- Existing `suggest-duplicates`, `propose-merge`, `apply-merge`, `dismiss-merge`,
  and the merge queue are used as-is by the bridge.

### 2. Worker — `apps/reconnect-web`

New table pair mirroring candidates/decisions (migration `0003-merge-review.sql`):

```sql
CREATE TABLE merge_candidates (
  id TEXT PRIMARY KEY,            -- opaque pair id (HMAC, salt local to bridge)
  confidence REAL, reasons TEXT,  -- reasons = comma-joined tags
  name_a TEXT NOT NULL, company_a TEXT, domain_a TEXT, last_contact_a TEXT, exchanges_a INTEGER,
  name_b TEXT NOT NULL, company_b TEXT, domain_b TEXT, last_contact_b TEXT, exchanges_b INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE TABLE merge_decisions (
  id TEXT PRIMARY KEY,            -- references merge_candidates.id
  action TEXT NOT NULL,           -- 'merge' (right) | 'keep' (left = not duplicates)
  decided_by TEXT, decided_at INTEGER NOT NULL,
  applied INTEGER NOT NULL DEFAULT 0
);
```

Endpoints, same auth split as the contact flow:

- `GET /api/merge/candidates` — Google allowlist; undecided pairs, confidence
  DESC, LIMIT 500, `{total, candidates[]}`.
- `POST /api/merge/swipe {id, action: merge|keep}` — Google allowlist; upsert
  decision, 404 on unknown pair.
- `POST /api/merge/sync {upserts, remove_ids, reset?}` — SYNC_TOKEN; same diff
  semantics as `/api/sync`.
- `GET /api/merge/decisions?applied=0` + `POST /api/merge/decisions/ack {ids}` —
  SYNC_TOKEN; ack also deletes the pair from `merge_candidates`.

### 3. UI — `apps/reconnect-web/public/merge.html`

Served at `/merge` by the existing assets binding. Same auth gate, styles, drag
gestures, and never-drop-a-swipe error handling as the main deck (copy-adapt).
Card layout: confidence + reason tags on top, then the two contacts side by side
(name, company, domain, "last contact Nd ago", "N emails"). Stamps read MERGE
(right) / KEEP APART (left). No delete button. Header links the two pages
(`☀️ Reconnect ↔ 🧬 Merge review`) with the pending count.

### 4. Bridge — `scripts/peoplegraph-reconnect-web.mjs`

Two new subcommands, and `run` grows to: `pull → merge-pull → push → merge-push`
(cron line unchanged).

- **`merge-push`:**
  1. `peoplegraph apply-duplicates --min-confidence 0.94` — auto-merge the
     corroborated tier locally. Log the applied count.
  2. `peoplegraph suggest-duplicates --min-confidence 0.88 --limit 2000` — what
     remains is the uncertain band (≥0.94 already merged; queue-dismissed pairs
     are skipped by the CLI). Build pair-cards, `pairId` via salt, store
     `state.mergeMap[pairId] = {a, b}`, diff against `state.lastMergePush`
     (same `diffPool` helper), sync to `/api/merge/sync`.
  3. **Weekly cadence:** the pair scan is O(n²) over 23k contacts; `merge-push`
     runs only if `state.lastMergeScanUnix` is older than 7 days (or `--force`),
     and records the scan time. `merge-pull` still runs daily.
- **`merge-pull`:** fetch `/api/merge/decisions?applied=0`; for each: map id via
  `mergeMap` (unknown id → warn + ack, same rule as contacts);
  `action=merge` → `propose-merge a b` then `apply-merge a b`;
  `action=keep` → `dismiss-merge a b --reason not_duplicate`; CLI failure →
  skip un-acked (retried next run); then ack.
- State file gains `mergeMap` and `lastMergePush` and `lastMergeScanUnix`;
  `migrateState` defaults them to `{}` / `{}` / `0` (still version 2 — additive).

## Interplay with the swipe deck

After any merge, the rows share aliases, so an existing swipe on either email
excludes both rows via `feedback_entry_for`; the reconnect name-dedup covers
display regardless. Order within `run` (merge-pull before push) means a morning
"merge" decision consolidates rows before the day's contact push computes.

## Failure modes

- Pair scan too slow: weekly cadence bounds it; if a scan exceeds ~5 minutes,
  log a warning suggesting `--limit`/schedule tuning. Never blocks pull/push
  (merge steps run last and their failures are caught + logged, not fatal to
  the contact sync).
- Bad auto-merge discovered later: rows keep all original fields;
  `apply-merge`'s canonical metadata can be corrected manually. Not building an
  unmerge command now (YAGNI — dry-run + corroborated-only threshold is the
  guard).
- One state file, one runner: unchanged single-runner rule covers merge sync too.

## Testing

- CLI: unit tests — reconnect name-dedup keeps the top-ranked row; batch
  `apply-duplicates --dry-run` returns the ≥0.94 set and groups transitively;
  applied pairs vanish from a rerun.
- Bridge: `node --test` for pairId determinism/ordering and mergeMap state
  migration.
- Worker: extend `scripts/smoke.sh` — merge sync/candidates-401/swipe-401/
  remove round-trip.
- E2E checklist: on John's machine, dry-run first (`apply-duplicates --dry-run`
  output reviewed before the first real run), then one full merge-push, two
  swipes on `/merge` (one right, one left), merge-pull applies + dismisses, and
  the canary check: Susan Lyne's three rows share a canonical_id afterward.

## Out of scope

- Unmerge tooling.
- Cross-source external merges (`import-cache` / external merge commands).
- Deduping the 60 deleted contacts' orphan rows.
