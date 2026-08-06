---
name: peoplegraph
description: Query and maintain the Obsidian Gmail CRM contact graph with the peoplegraph CLI — look people up, rank relationships, surface reconnect candidates, and review/apply contact merges. Use whenever the owner asks who they know, how strong a relationship is, who to reconnect with, or to clean up duplicate contacts.
---

# PeopleGraph CLI

`peoplegraph` is a local CLI over the contact cache (`contact-index.json`) that the Obsidian Gmail CRM plugin builds from the owner's email. Every command prints a single JSON object: `{"ok": true, "command": ..., "data": ...}` on success, `{"ok": false, "error": {"kind": ..., "message": ...}}` on failure. Always check `ok`; on failure surface `error.kind` and `error.message` to the owner — don't retry blindly.

Run `peoplegraph describe` for the full, self-documenting command surface of the installed version. Prefer it over guessing flags.

## Setup

- Binary: `~/.local/bin/peoplegraph` (installed by `scripts/install-peoplegraph.sh`). Verify with `peoplegraph version`.
- Cache resolution order: `--cache <path>` flag → `PEOPLEGRAPH_CACHE` env var → auto-discovery of `.obsidian/plugins/gmail-crm/contact-index.json` in known Obsidian vaults or parent directories.
- If no cache is found, ask the owner where their vault is — don't guess a path.
- Remote mode: `peoplegraph --remote <command>` queries a `peoplegraph serve` instance instead of a local cache. Requires `PEOPLEGRAPH_HOST` (or `--host`) and `PEOPLEGRAPH_TOKEN` (or `--token`). Only read commands work remotely.

## Read commands (safe anywhere, including --remote)

```bash
peoplegraph find-person "Bruce Jaffe"        # fuzzy match by name/email/alias; handles reordered names
peoplegraph score bruce@example.com          # relationship score fields for one email
peoplegraph who-knows --company Disney       # people at a company/domain, ranked by relationship score
peoplegraph reconnect --limit 5              # strong-but-dormant contacts worth reconnecting with
peoplegraph contact-card "Bruce Jaffe"       # minimal source-aware contact card
peoplegraph suggest-duplicates --limit 25 --min-confidence 0.82
peoplegraph merge-queue --status pending --limit 25
```

Typical conversational mappings:

- "who do I know at X?" → `who-knows --company X`
- "who is <name>?" / "what's <name>'s email?" → `find-person`, then `contact-card`
- "who should I reconnect with?" → `reconnect --limit 5` — relay each candidate's `nudge` and `days_since_contact`; you may rephrase warmly but never fabricate facts beyond what the CLI returns
- "how strong is my relationship with X?" → `find-person` to resolve the email, then `score`

## Write commands (local source-of-truth machine only — never over --remote)

These mutate the cache or its sidecar files. Rules:

- **Ask before irreversible writes.** `feedback --action delete` removes a contact from the cache and blocklists them; `apply-merge` rewrites canonical identity metadata. Confirm with the owner unless they just explicitly asked for that exact action.
- **Back up first for bulk operations.** Before applying a batch of merges or deletes, copy `contact-index.json` aside.
- Don't treat rapid bulk approvals as strong signal — if the owner right-swipes everything in seconds, guard in the scan/review step rather than trusting each swipe.

```bash
# record a reconnect swipe decision (boost = keep+raise, suppress = hide+lower, delete = remove+blocklist)
peoplegraph feedback --email <email> --action boost|suppress|delete
peoplegraph feedback --email <email> --action clear    # undo, also un-blocklists

# merge review lifecycle
peoplegraph propose-merge <emailA> <emailB>
peoplegraph apply-merge <emailA> <emailB>
peoplegraph dismiss-merge <emailA> <emailB> --reason not_duplicate

# cross-cache import (source-aware)
peoplegraph import-cache --source <name> <other-contact-index.json>
peoplegraph suggest-external-merges --source <name> --limit 25
peoplegraph apply-external-merge ... / dismiss-external-merge ...
```

If the reconnect feedback overlay (`reconnect-feedback.json`) is malformed the CLI fails loudly with `feedback_unreadable` — repair the JSON, never delete the file to "fix" it.

## Companion skills

If present in the repo's `skills/` directory, `peoplegraph-daily-reconnect` covers the daily swipe-deck loop and `peoplegraph-telegram-merge-review` covers merge review over Telegram. This skill is the general command reference.
