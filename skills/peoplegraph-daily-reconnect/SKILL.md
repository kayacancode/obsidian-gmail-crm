---
name: peoplegraph-daily-reconnect
description: Run the daily reconnect curation loop — push re-engage candidates (strong relationships gone dormant) to the swipe web app, write a daily-note link, and apply the human's swipe decisions back into the contact graph via `peoplegraph feedback`.
---

# PeopleGraph Daily Reconnect

Use this skill when Botwick/OpenClaw is asked to surface who the owner should reconnect with, run the daily reconnect job, or apply reconnect swipes.

The human-in-the-loop surface is a **names-only Tinder-style swipe web app** (`apps/reconnect-web`, deployed on Cloudflare). Each day Botwick pushes the top re-engage candidates to it and drops a one-line link in the daily note; the owner swipes; Botwick pulls the decisions and feeds them back into scoring. This replaces the earlier Telegram-brief approach (see the bottom of this file).

## Architecture

```
Botwick machine (source of truth)              Cloudflare                  owner's phone
  peoplegraph reconnect  ──push names + opaque ids──►  Worker + D1  ──►  swipe UI (names only)
  peoplegraph feedback   ◄──pull swipe decisions─────                ◄──  right / left / 🗑
```

**Privacy:** emails never leave the source-of-truth machine. The bridge assigns each candidate an opaque id and keeps the `id → email` map locally; D1 only ever stores names + display fields.

## Requirements

- `peoplegraph` CLI `0.3.4` or newer (has `reconnect` **and** `feedback`).
- `PEOPLEGRAPH_CACHE` → the source-of-truth `contact-index.json` (the bridge needs local writes, so run it on this machine, not over `--remote`).
- The reconnect web app deployed (see `apps/reconnect-web/README.md`). Current deployment: `https://reconnect-web.kayarjones901.workers.dev`.
- Bridge env (default `~/.peoplegraph/reconnect-web.env`):
  - `RECONNECT_WEB_URL` / `RECONNECT_PUBLIC_URL` — the Worker URL
  - `RECONNECT_SYNC_TOKEN` — matches the Worker's `SYNC_TOKEN` secret
  - `PEOPLEGRAPH_CACHE`, `PEOPLEGRAPH_BIN`, `RECONNECT_STATE` (holds the id salt + map + last-push hashes — do not delete casually)
  - optional `RECONNECT_DAILY_NOTE` — today's daily note to append the link to

## The daily job (preferred path: the bridge)

The bridge script `scripts/peoplegraph-reconnect-web.mjs` does the whole loop. Normally you just run it:

```bash
source ~/.peoplegraph/reconnect-web.env
node scripts/peoplegraph-reconnect-web.mjs run     # = pull, merge-pull, push, merge-push
```

- `push` — runs `peoplegraph reconnect` for the full unswiped pool, derives **stable opaque ids** (HMAC of email; salt kept in `RECONNECT_STATE`, never leaves the machine), and POSTs only the **diff** (upserts/removes) to `/api/sync`, plus a single click-through line to the daily note. Stable ids mean a swipe on any day excludes that contact from the deck forever. The deck is name-deduped (one card per person, `deduped_rows` in the stats) so a contact with several email addresses no longer shows up twice.
- `pull` — GETs `/api/decisions`, maps each stable id back to its email locally, applies boost/suppress to the feedback overlay directly and routes `delete` through `peoplegraph feedback` (cache removal + blocklist), then acks.
- `merge-push` / `merge-pull` — the duplicate-review half of `run`; see "Duplicate review" below.

## Duplicate review

Separate from reconnect swipes, the bridge also runs a **contact-dedup** loop so the same human doesn't linger under two contact records:

- `run` now does **pull → merge-pull → push → merge-push**, in that order (merge steps are wrapped so a merge-endpoint hiccup never blocks the ordinary reconnect sync).
- `merge-push` auto-merges pairs at confidence >= 0.94 locally via `peoplegraph apply-duplicates`, honoring an existing canonical id from either member of the group. It then syncs the uncertain band (confidence 0.88-0.93) to the `/merge` review deck as pair cards (names/company/domain/last-contact only — no emails). This scan is **weekly**, not every run — pass `--force` to make the bridge re-scan immediately (`node scripts/peoplegraph-reconnect-web.mjs merge-push --force`).
- The owner reviews pairs at `/merge`: swipe right to merge, swipe left to keep them apart forever.
- `merge-pull` fetches those verdicts and applies them via `peoplegraph apply-merge` / the dismiss path, then acks.
- **Preview before a bulk merge push**: `peoplegraph --cache "$PEOPLEGRAPH_CACHE" apply-duplicates --dry-run` shows exactly which pairs/groups would auto-merge without writing anything — always eyeball this before a forced `merge-push` (see the rollout runbook for the full command).
- **Don't confuse this with `feedback --action clear`** — that command only undoes a reconnect boost/suppress/delete swipe. It has no effect on merges; there is currently no "undo" for a `/merge` decision, so get the dry-run preview right before merging.

Cron it once a day on the machine with the cache:

```bash
0 8 * * *  source ~/.peoplegraph/reconnect-web.env && node /path/to/obsidian-gmail-crm/scripts/peoplegraph-reconnect-web.mjs run
```

## Swipe semantics → feedback

The web app records one of three actions; the bridge applies each via `peoplegraph feedback`:

| Swipe | action | effect |
|---|---|---|
| right / ♥ | `boost` | out of the deck forever + people score raised globally (`score`, `who-knows`, …) |
| left / ✕ | `suppress` | out of the deck forever + people score lowered globally |
| 🗑 (confirm) | `delete` | remove the contact from the cache + add to `reconnect-blocklist.json` |

```bash
peoplegraph --cache "$PEOPLEGRAPH_CACHE" feedback --email <email> --action boost|suppress|delete
# undo a mistaken swipe (also un-blocklists a deleted contact):
peoplegraph --cache "$PEOPLEGRAPH_CACHE" feedback --email <email> --action clear
```

`reconnect` honors this overlay (`reconnect-feedback.json`): ANY entry excludes the contact from the pool. If the overlay file is malformed the CLI now fails loudly (`feedback_unreadable`) instead of silently treating it as empty — never delete the file to "fix" that; repair the JSON.

## Core rules

- **Suggestions come only from the `re-engage` quadrant** (strong + dormant). Don't invent candidates or pull from other quadrants.
- The deck is the **whole unswiped pool, best first** — the owner swipes as much or as little as they like; the rest waits. The daily push is a cheap diff, not a re-upload.
- The `nudge` string from `reconnect` is the human-facing reason; you may rephrase it warmly but never fabricate facts (last-contact timing, email counts, role) beyond what the CLI returns.
- `feedback` is a **local write** — it only runs on the source-of-truth machine, never over `--remote`.
- If nothing is in re-engage after filtering, push nothing and skip the daily-note line. Don't post an empty batch every morning.

## Doing it by hand (no bridge)

If asked to run a step manually or the bridge isn't available:

```bash
# see today's candidates
peoplegraph --cache "$PEOPLEGRAPH_CACHE" reconnect --limit 5

# apply a decision the owner tells you in chat ("keep harper", "suppress sri", "delete dr goldberg")
peoplegraph --cache "$PEOPLEGRAPH_CACHE" feedback --email harper@2389.ai --action boost
```

The owner can also act conversationally: "who should I reconnect with?" → run `reconnect`; "keep / suppress / delete <name>" → resolve the name to an email (`peoplegraph find-person`) then `feedback`.

## Failure handling

- If `peoplegraph` exits with `ok: false`, surface `error.kind` + `error.message`; don't retry blindly.
- If `PEOPLEGRAPH_CACHE` is unset, ask the operator to configure it; don't guess a path.
- If the Worker is unreachable on `pull`, leave decisions un-acked so they're retried next run; on `push`, just skip — no candidates is safe.

## Deprecated: Telegram brief

An earlier version of this skill delivered the daily list as a Telegram message with inline buttons (modeled on `skills/peoplegraph-telegram-merge-review`). That's superseded by the web swipe app. If a Telegram-only delivery is ever needed again, the same `reconnect` + `feedback` commands back it — send the brief, map `pgr:<email>:<action>` callbacks to `peoplegraph feedback`, and skip the web push/pull.
