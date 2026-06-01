---
name: peoplegraph-daily-reconnect
description: Send a daily Telegram "people to reconnect with" brief from PeopleGraph — the re-engage quadrant (strong relationships that have gone dormant), with snooze/dismiss handling. Read-only against the contact graph.
---

# PeopleGraph Daily Reconnect

Use this skill when Botwick/OpenClaw is asked to surface who the owner should reconnect with, or to send the daily reconnect brief. It mirrors how the meeting summaries go out: a short, scannable Telegram message once a day.

It reads the **re-engage quadrant** (strong + dormant — people you have a real relationship with who have gone quiet) ranked by combined score. It is **read-only** against the contact graph; the only state it writes is its own snooze/dismiss queue.

## Requirements

- `peoplegraph` CLI version `0.3.3` or newer (the `reconnect` command).
- `PEOPLEGRAPH_CACHE` points to the source-of-truth `contact-index.json` (local mode), **or** `PEOPLEGRAPH_HOST` + `PEOPLEGRAPH_TOKEN` are set to reach Botwick's read-only server (remote mode).
- `TELEGRAM_BOT_TOKEN` available to the Telegram runtime.
- `TELEGRAM_RECONNECT_CHAT_ID` — the chat that receives the brief (default to the owner's DM).
- `PEOPLEGRAPH_RECONNECT_STATE` — JSON state file for snooze/dismiss. Default `$HOME/.peoplegraph/reconnect-state.json`.

## Core Rules

- **Never write to the contact graph.** This skill only reads (`reconnect`, `contact-card`, `score`). Snooze/dismiss live in `PEOPLEGRAPH_RECONNECT_STATE`, not in the cache.
- Suggestions come only from the `re-engage` quadrant. Do not invent candidates or pull from other quadrants.
- Respect snooze/dismiss: never re-surface a person who is dismissed or whose snooze has not expired.
- Keep the brief short — default 5 people. This is a nudge, not a CRM dump.
- The `nudge` string from the CLI is a starting point; you may rephrase it warmly, but never fabricate facts (last-contact timing, email counts, role) beyond what the CLI returns.

## Pull Today's Candidates

Local mode:

```bash
peoplegraph --cache "$PEOPLEGRAPH_CACHE" reconnect --limit 5
```

Remote mode (Botwick's read-only server):

```bash
peoplegraph --remote reconnect --limit 5
```

Optionally raise the bar with `--min-score 40` to only surface higher-confidence relationships. Each person comes back with `name`, `email`, `company`, `days_since_contact`, `score` (combined/strength/momentum/quadrant), and a `nudge`.

To over-fetch so you can skip snoozed/dismissed people and still land 5, request more (e.g. `--limit 15`) and filter locally against `PEOPLEGRAPH_RECONNECT_STATE`.

## State File

`PEOPLEGRAPH_RECONNECT_STATE` holds per-person action state keyed by email:

```json
{
  "harper@2389.ai": { "status": "snoozed", "until": "2026-07-01", "updated": "2026-06-01" },
  "old@friend.com": { "status": "dismissed", "updated": "2026-05-20" }
}
```

Filtering rules when building the brief:

- `dismissed` → skip permanently (until the owner clears it).
- `snoozed` with `until` in the future → skip; once `until` has passed, eligible again.
- `contacted` within the last 60 days → skip (the next sync usually moves a genuine reply out of re-engage on its own; this just avoids nagging if they marked it but never wrote).
- No entry → eligible.

## Render The Brief

Send one Telegram message to `TELEGRAM_RECONNECT_CHAT_ID`, e.g.:

```text
☀️ Reconnect — 3 people worth a note today

1. Harper Reed · Founder at Nata2
   No contact in 4 months — previously active (58 emails)

2. Jane Okafor · Betaworks
   Last contact 73 days ago — previously active (24 emails)

3. Sam Lee · Acme
   No contact in 5 months
```

Attach inline buttons per person (one row each) so the owner can act without typing:

```json
{
  "inline_keyboard": [
    [
      { "text": "✅ Reached out · Harper", "callback_data": "pgr:harper@2389.ai:contacted" },
      { "text": "💤 Snooze",              "callback_data": "pgr:harper@2389.ai:snooze" },
      { "text": "🚫 Dismiss",             "callback_data": "pgr:harper@2389.ai:dismiss" }
    ]
  ]
}
```

`callback_data` has a small size limit — if an email is too long for the payload, store a short id → email map in the state file and put the short id in the button instead.

## Handle Button Callbacks

On a `callback_query`:

1. Parse `callback_data` as `pgr:<key>:<action>`.
2. Resolve `<key>` to an email (directly, or via the short-id map).
3. Update `PEOPLEGRAPH_RECONNECT_STATE`:
   - `contacted` → `{ "status": "contacted", "updated": "<today>" }`
   - `snooze` → `{ "status": "snoozed", "until": "<today + 30 days>", "updated": "<today>" }`
   - `dismiss` → `{ "status": "dismissed", "updated": "<today>" }`
4. Call Telegram `answerCallbackQuery`, then edit the message line to reflect the action (e.g. strike-through or a ✓).

Owner can also act by text: `reconnected with harper`, `snooze harper`, `dismiss harper`, `who should I reconnect with?` (re-run the pull on demand).

## Daily Cadence

Run once a day on the machine that can reach the cache/server (cron, launchd, or the OpenClaw scheduler):

```bash
# 8am daily
0 8 * * *  cd /path/to/obsidian-gmail-crm && node scripts/<reconnect-bridge-or-agent-entrypoint>
```

If no candidates remain after filtering, send nothing (or a once-a-week "inbox zero — nobody overdue" note). Don't send an empty brief every morning.

## Failure Handling

- If `peoplegraph` exits with `ok: false`, surface `error.kind` + `error.message`; do not retry blindly.
- If `PEOPLEGRAPH_CACHE`/`PEOPLEGRAPH_HOST` is unset, tell the operator to configure it; do not guess a path.
- If Telegram send fails, keep the state file unchanged so the same people are eligible next run.

## Audit Trail

Keep in the state file (or a sibling log), per action: email, action, timestamp, and the Telegram user id who pressed the button. Do not store Telegram bot tokens, Google credentials, or email bodies.
