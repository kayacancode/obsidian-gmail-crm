---
name: gmail-crm
description: Answer any question about the owner's people and relationships — who they know somewhere, how strong or stale a relationship is, when they last spoke to someone, who to reconnect with, or who could make an intro. Queries the Gmail CRM contact graph through the read-only peoplegraph CLI; needs no contacts in the Obsidian vault.
tags: [gmail, crm, contacts, peoplegraph, relationships, obsidian]
triggers:
  - who do I know
  - do we know anyone at
  - find person
  - contact score
  - people score
  - relationship strength
  - who knows
  - people at company
  - contact graph
  - reconnect
  - who should I reach out to
  - who should I email
  - who am I losing touch with
  - when did I last talk to
  - last contact with
  - how well do I know
  - what's my relationship with
  - can anyone intro me
  - warm intro
  - follow up with
version: 3
---

# Gmail CRM — Agent Skill

Query a Gmail-based contact relationship graph. Email metadata (From/To/Date/Subject —
never message bodies) is synced into a scored contact index; the `peoplegraph` CLI reads
that index and answers questions about people and relationship strength.

## Which setup are you on?

**Query-only (Botwick on John's Mac mini).** The contact graph is *not* mirrored into the
Obsidian vault — that was a deliberate decision, because ~23k contacts would swamp the
vault. Everything comes from the CLI. Use the read-only commands below and nothing else.

**Owner's own machine (vault present).** The CLI works the same, and People pages may also
exist under `<vault>/People/` for richer per-person context.

## Getting the binary

**Never run `scripts/install-peoplegraph.sh`, and never `curl` the install script from
GitHub.** It pulls from `releases/latest`, which is stale (0.3.4) and lacks the swipe,
dedup, and name-exclusion behavior everything else assumes. Installing it silently
reintroduces bugs that were already fixed.

The good binary is committed in-repo at `bin/peoplegraph`. To install or update it on
macOS, replace the file rather than overwriting in place — overwriting a running/signed
binary gets it killed by AMFI (`zsh: killed peoplegraph`):

```bash
cd ~/obsidian-gmail-crm && git pull
rm -f ~/.local/bin/peoplegraph
cp bin/peoplegraph ~/.local/bin/peoplegraph
codesign --force --sign - ~/.local/bin/peoplegraph
xattr -d com.apple.quarantine ~/.local/bin/peoplegraph 2>/dev/null
hash -r
peoplegraph version   # must print the version you expect
```

Always confirm with `peoplegraph version` after replacing it. A stale shell (or a
`PEOPLEGRAPH_BIN` pointing elsewhere) will happily keep running the old binary and report
a version that does not match what actually executes.

## Pointing at the right cache

The CLI needs `contact-index.json`. Resolution order: `--cache <path>`, then the
`PEOPLEGRAPH_CACHE` environment variable, then Obsidian vault auto-detection.

**On John's machine, always use the explicit path** — auto-detection can find a different
(stale) copy, and there is more than one checkout on that box:

```bash
set -a; source ~/.peoplegraph/reconnect-web.env; set +a
peoplegraph --cache "$PEOPLEGRAPH_CACHE" score jane@example.com
```

With the env file sourced, `PEOPLEGRAPH_CACHE` is already set, so plain `peoplegraph score …`
also resolves correctly. Being explicit is still the safer habit when a result looks wrong.

## Read-only commands — safe to run any time

These never write to the cache, so they cannot corrupt state or collide with the daily sync.

| Command | Use it for |
|---|---|
| `peoplegraph find-person "Jane Smith"` | Fuzzy match by name, email, or alias. Matches reordered names ("Jaffe Bruce" finds "Bruce Jaffe"); pass `--strict-name-order` to disable. Groups rows belonging to one identity. |
| `peoplegraph score jane@example.com` | Full score card for one person: quadrant, strength, momentum, combined, plus raw signals. |
| `peoplegraph who-knows --company "a16z"` | Everyone at a company/domain, ranked by relationship score. The "do we know anyone at X?" query. |
| `peoplegraph reconnect --limit 20 [--min-score 30]` | Strong-but-dormant contacts worth reaching out to, each with a nudge reason. |
| `peoplegraph contact-card jane@example.com` | Minimal card — name, email, company, role, scores. |
| `peoplegraph get-neighbors jane@example.com` | Connected contacts (requires edge data in the cache). |
| `peoplegraph get-edges --from a@x.com --to b@y.com` | The relationship between two specific people. |
| `peoplegraph suggest-duplicates --limit 10` | Rows that look like the same human across addresses. Read-only — it only suggests. |
| `peoplegraph describe` | The live command surface, with per-command status and notes. Use this instead of guessing. |

Every command returns JSON on stdout (`--format jsonl` for line-delimited). Check the
top-level `ok` field before trusting `data`.

## Write commands — do NOT run these as Botwick

`feedback`, `apply-duplicates`, `apply-merge`, `dismiss-merge`, `propose-merge`,
`import-cache`, `apply-external-merge`, `dismiss-external-merge`.

These mutate the contact cache or the feedback overlay. **The single-runner rule applies:
only the daily reconnect cron (7:08 AM ET) may write.** Two writers with different id salts
corrupt each other's state — this already caused an 8,346-row pollution incident. If a task
seems to need a write, surface it to the owner instead of running it.

## Understanding scores

### Quadrants
| Quadrant | Meaning | Action |
|----------|---------|--------|
| **nurture** | Strong + active | Keep investing |
| **re-engage** | Strong + dormant | Reach out — relationship going cold |
| **developing** | Weak + active | New/growing — potential to build |
| **deprioritize** | Weak + dormant | Low priority |

### The three numbers
- **Strength (0-100)** — how deep the relationship is overall: volume, thread depth,
  initiation balance (50/50 sent/received scores highest), time span, shared calendar events.
- **Momentum (0-100)** — how active it is right now: recency decay (half-life ~35 days) plus
  a recent-activity bonus.
- **Combined (0-100)** — the average, and the single sortable number.

### Staleness labels
70-100 active · 50-69 warm · 30-49 cooling · 10-29 stale · 0-9 dormant

### Swipe overrides affect what you see
The owner swipes contacts in the reconnect web app, and those decisions feed back into
scoring: **boost** raises the effective score (+10) and pins the person, **suppress** lowers
it (−10) and hides them from `reconnect`, **delete** removes them entirely and blocklists
them. `score`, `who-knows`, and `reconnect` all return the *effective* score with the
override already applied. Respect these — never suggest reconnecting with someone the owner
suppressed or deleted.

### Merged duplicates
Many contacts have been consolidated: one human with several addresses shares a
`canonical_id` and carries the other addresses as `aliases`. `find-person` groups these, so
a single person may legitimately show several email rows. Scores are per-row, so when a
person has multiple addresses, prefer the primary row (highest score / most exchanges)
rather than summing.

## Common tasks

The owner asks in plain language; map it to a command rather than guessing or answering
from memory. Always answer from command output — never state a score, a date, or whether
someone is known without running a query first.

| They ask | Run |
|---|---|
| "Who should I reconnect with?" / "who am I losing touch with?" | `reconnect --limit 10` — read each `nudge` as the reason |
| "Do we know anyone at Sequoia?" / "who do I know at X?" | `who-knows --company "Sequoia"` |
| "What's my relationship with Jane?" / "how well do I know her?" | `find-person "Jane"` for the address, then `score <email>` |
| "When did I last talk to Jane?" | `find-person "Jane"` — read `last_contact` |
| "Who could intro me to someone at Acme?" | `who-knows --company "Acme"` — the top-scoring contacts are the warmest paths |
| "Should I follow up with anyone this week?" | `reconnect --limit 20 --min-score 30` |
| "Tell me about Jane before my call" | `contact-card <email>`, plus `score <email>` for the full picture |

Answer conversationally with the numbers behind it — "you and Jane are in re-engage: 47
emails, but nothing since March" beats dumping raw JSON. When a name is ambiguous,
`find-person` returns every match; ask which one rather than picking.

**"Draft a re-engagement email"** → get the score card, use the `nudge` and any
`recent_subjects` for relevance. You have metadata only — never claim to know what was
actually discussed in a thread.

## Pitfalls

1. **The install script is stale.** Use `bin/peoplegraph` from the repo. See above.
2. **Verify the binary version after replacing it** — a stale shell or a `PEOPLEGRAPH_BIN`
   override can keep executing the old one while reporting something else.
3. **Scores are cached, not live** — they refresh when the CRM sync runs, not per query.
4. **Never edit `contact-index.json` directly.** The plugin owns it.
5. **Never delete `reconnect-feedback.json`.** It is the durable record of every swipe the
   owner has made. A malformed overlay makes the CLI fail loudly (`feedback_unreadable`) —
   that error means fix the file, not delete it.
6. **Email bodies are never available** — metadata only. Don't promise to look up content.
7. **On John's machine there are no People pages in the vault.** Answer from CLI output; do
   not go looking for `<vault>/People/*.md` there.
