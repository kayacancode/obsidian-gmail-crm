# Reconnect pipeline: stable IDs + diff sync

**Date:** 2026-07-23
**Status:** Draft for review
**Motivation:** On 2026-07-22 the bridge switched to pushing the entire re-engage pool daily
(`8e6d715` "push ALL candidates, no limit, no dedup"). Because the bridge mints new random
UUIDs for every contact on every push, previously swiped (boosted) contacts reappeared at the
top of the deck ("swipes lost"), the deck filled with 4,400+ dormant contacts ("contacts went
stale"), and D1 grows by ~4.4k rows/day. This design keeps the intent — push the whole pool
every day — and fixes identity, exclusion, sync cost, and the swipe-loss paths.

## Product decisions (settled)

1. **Swipes do exactly three things.**
   - Swipe right (**boost**): raises the contact's people score by `+delta` — globally, on
     every score surface, not just reconnect ranking (today the delta only affects the deck).
   - Swipe left (**suppress**): lowers the contact's people score by `−delta` — globally
     (today suppress's delta is stored but never applied anywhere).
   - **Delete**: the contact is gone for good — removed from `contact-index.json` and
     blocklisted so future syncs skip them (this is already the current behavior; unchanged).
2. **A swiped contact never reappears in the deck.** Any feedback entry (boost, suppress, or
   delete tombstone) excludes the contact from the reconnect pool permanently. The score
   effects above live on in the wider CRM; the deck only ever shows never-swiped contacts.
3. **The deck is the whole unswiped pool, best first.** No daily cap, no dedup window. Whatever
   isn't swiped today is still there tomorrow.
4. **No re-swiping.** The 1,699 existing decisions in `reconnect-feedback.json` (keyed by email)
   carry over untouched; the 1,341 boosted contacts get retired from the deck the moment the
   new exclusion rule ships, and their boosts start counting toward their global score.

## Root defect being fixed

The bridge assigns a fresh `randomUUID()` per contact per push and clobbers the id→email map
(`state.map = {}`) on every run. Consequences: the Worker's "already decided" join can never
match across days; decisions recorded against yesterday's ids become unmappable; the only
exclusion that survives is the CLI-side feedback file, which does not exclude boosts.

**Fix: contact identity becomes stable.** `id = HMAC-SHA256(salt, lowercase(trim(email)))`,
hex, truncated to 32 chars. The salt is 32 random bytes generated once and stored only in the
local bridge state file, so ids remain opaque off-machine (privacy model unchanged: emails and
salt never leave the source-of-truth machine).

## Components

### 1. CLI — `crates/peoplegraph`

- **Feedback deltas apply to the people score globally.** Today the overlay is read only by
  `reconnect` (`read_feedback` has a single call site) and only `boost` does anything. New
  shared helper — `effective_score(contact, feedback) = clamp(combined ± delta, 0, 100)` —
  applied wherever a people score is computed or reported (`score`, `search`, `reconnect`,
  and any surface using `infer_score` output). Boost adds its delta, suppress subtracts its
  delta, delete needs nothing (the contact is out of the cache entirely).
- **`reconnect` excludes contacts with any feedback entry** (currently only
  `suppress`/`delete` exclude; `boost` merely adds rank points — `main.rs:1349-1360`). The
  pool then contains only never-swiped contacts, so boost re-ranking inside `reconnect`
  becomes dead code and is removed. The JSON shape is unchanged (`manual_boost` stays, always
  0, for compatibility).
- **`delete` behavior is already correct** (removes the contact from `contact-index.json`,
  adds the email to `reconnect-blocklist.json`, leaves a tombstone in the overlay): unchanged.
- `nudge` strings must not embed absolute day counts (else they change every day and defeat
  diff sync — see §2). Recency wording ("it's been N days") moves to the UI, computed from
  `last_contact`. `reconnect_nudge` keeps only day-independent content.
- New escape hatch: `peoplegraph feedback --email X --clear` removes a feedback entry, letting
  a mistakenly swiped contact re-enter the pool on the next push.

### 2. Bridge — `scripts/peoplegraph-reconnect-web.mjs`

**State file v2** (`RECONNECT_STATE`, default `~/.peoplegraph/reconnect-web-state.json`):

```json
{
  "version": 2,
  "salt": "<hex, generated once>",
  "map": { "<stable-id>": "email@example.com", "...": "..." },
  "lastPush": { "<stable-id>": "<content-hash>", "...": "..." }
}
```

- `map` is **merged, never clobbered**. With stable ids an entry never goes stale.
- `lastPush` records a content hash per id of what the Worker currently holds.

**Push becomes a diff sync:**

1. Run `peoplegraph reconnect --limit 5000` (keep the 50MB `maxBuffer` from `84b2a62`).
2. For each contact compute the stable id and a content hash over the display fields:
   `(name, company, last_contact, score, nudge)`. To avoid daily churn, `days_since` is
   **replaced by `last_contact`** (a `YYYY-MM-DD` string) — it only changes when real contact
   happens. Score updates are pushed only when `|Δscore| ≥ 3` or `last_contact` changed
   (threshold keeps slow score drift from re-uploading the pool).
3. Diff against `lastPush`:
   - `upserts` — ids that are new or whose hash changed.
   - `remove_ids` — ids in `lastPush` but no longer in the pool (swiped, re-engaged, or
     deleted contact).
4. `POST /api/sync { upserts, remove_ids, reset? }`. `reset: true` is sent when `lastPush` is
   empty (first v2 run, or state file lost) and tells the Worker to clear `candidates` first.
5. On 2xx, update `map` + `lastPush` and save state. On failure, state is not updated, so the
   next run re-sends the same diff (sync is idempotent: upserts are UPSERTs, removes are
   DELETEs).

Steady-state daily payload: a handful of rows instead of 4,400.

**Pull hardening:**

- A decision whose id has no `map` entry is logged **and acked** (today it is skipped and
  retried forever). With a persistent map this should never fire; acking makes it a one-time
  warning instead of a permanent loop.
- A decision whose `peoplegraph feedback` call fails stays un-acked and retries next run
  (unchanged).
- `run` remains pull-then-push so decisions are applied before the pool is recomputed, and a
  just-swiped contact is removed from D1 in the same run (its id drops out of the pool via the
  new feedback exclusion → lands in `remove_ids`).

### 3. Worker — `apps/reconnect-web/src/index.ts` + `schema.sql`

- **`POST /api/sync`** (SYNC_TOKEN, breaking change — single consumer, coordinated deploy):
  body `{ upserts: CandidateInput[], remove_ids: string[], reset?: boolean }`. Executes as
  chunked `env.DB.batch` (500 statements per chunk): optional `DELETE FROM candidates` (reset),
  UPSERTs, then `DELETE FROM candidates WHERE id IN (…)`. `batch_date` semantics disappear;
  the column is dropped.
- **`GET /api/candidates`**: no more "latest batch" — return all candidates with no matching
  decision, `ORDER BY score DESC`, `LIMIT 500`. The UI re-fetches when its local queue runs
  low, so a 4.4k-contact pool never ships as one ~1MB response.
- **`POST /api/decisions/ack`**: in addition to setting `applied = 1`, delete the acked ids
  from `candidates` (belt-and-braces; the bridge's next `remove_ids` would catch them anyway).
- **Schema** (applied via one-time migration, table is cleared anyway):
  `candidates(id, name, company, last_contact TEXT, score, nudge, updated_at)` —
  `days_since`, `batch_date`, and the batch index go away. `decisions` is unchanged.

### 4. Web UI — `apps/reconnect-web/public/index.html`

- `decide()` **401 path** (the real swipe-loss bug): put the card back at the front of the
  queue, clear `idToken`, show the gate, and re-run the One Tap prompt — mirroring the
  existing `load()` 401 handling. After re-sign-in the user swipes the same card again;
  nothing is lost.
- `decide()` **404 path** (`unknown_candidate`): the card is genuinely stale (contact left the
  pool since load); skip it and continue — but show a brief inline notice instead of a bare
  `console.warn`.
- Other non-OK responses: re-queue the card and show a non-blocking error.
- Compute the "Last contact N days ago" line from `last_contact` client-side.
- When `queue.length < 20`, fetch the next page of candidates (the server already excludes
  decided ids, so paging is just "call `/api/candidates` again and append unseen ids").

## Migration / rollout (order matters)

All steps run on the source-of-truth machine ("Botwick") after merging to `main`; the daily
cron needs no change (`run`).

1. Verify no pending decisions: `GET /api/decisions?applied=0` must be empty (it is today).
2. Deploy the new Worker + apply the schema migration (clears `candidates`; optionally clears
   the 1,699 historical `decisions` rows — the feedback file is the durable record; keeping
   them is harmless but they reference dead UUIDs. **Decision: delete them** for a clean
   post-migration invariant: every `decisions.id` is a stable id).
3. `git pull` + rebuild `peoplegraph` (feedback-exclusion change), then run the bridge once.
   With no `lastPush` it sends `reset: true` + the full pool (~3,000 contacts after the 1,341
   boosts retire) as the first diff.
4. Smoke-check the deck: previously boosted names (e.g. Susan Lyne, Auren Hoffman) must NOT
   appear; count should be ≈ pool size, best-scored first.

## Failure modes

- **State file lost** → new salt → new ids. Bridge sends `reset: true`, Worker starts clean;
  worst case is a one-time full re-push. Pending decisions at that instant would be
  unmappable — mitigated by `run`'s pull-before-push ordering and by ack-with-warning.
- **Sync fails mid-run** → state not saved; next run re-sends the same idempotent diff.
- **Swipe on a stale card** → 404, UI skips with a notice; no phantom decisions.
- **Token expires mid-session** → swipe is re-queued, user re-auths via One Tap, swipe is
  re-sent. No loss.
- **Two machines running the bridge** → unsupported, as today: state, salt, and the feedback
  file live on one machine. Documented in the script header.

## Testing

- **CLI (rust, `crates/peoplegraph`):** unit tests against fixtures — a contact with a `boost`
  feedback entry is excluded from `reconnect`; boost raises and suppress lowers the score
  reported by `score`/`search` (clamped to 0–100); `--clear` re-admits a contact; nudges
  contain no day counts.
- **Bridge (node):** extract `stableId(salt, email)` and `diffPool(lastPush, pool)` as
  exported helpers in the script; cover with `node --test`: stable across runs, diff yields
  correct upserts/removes, hash insensitive to day rollover.
- **Worker:** `npm run typecheck` plus a scripted curl smoke test against `wrangler dev`
  (sync reset → candidates → swipe → decisions → ack → candidate gone).
- **E2E checklist (manual, post-deploy):** step 4 of the rollout above, plus one real swipe
  round-tripped through `pull` and verified in `reconnect-feedback.json`.

## Out of scope

- Cooldown/reshow logic for boosted contacts (product decision: never reappear).
- Multi-user decks or per-user decision tracking (single shared deck, as today).
- Worker-side auth changes (the June auth commits stay as-is).
