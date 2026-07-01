---
name: gmail-crm
description: Query and manage your Gmail CRM contact graph — find people, check relationship scores, surface reconnect candidates, and read contact data from Obsidian vault pages.
tags: [gmail, crm, contacts, peoplegraph, relationships, obsidian]
triggers:
  - who do I know
  - find person
  - contact score
  - reconnect
  - relationship strength
  - who knows
  - people at company
  - contact graph
version: 1
---

# Gmail CRM — Agent Skill

Query your Gmail-based contact relationship graph. Data comes from the Gmail CRM Obsidian plugin which syncs email metadata into a scored contact index.

## Two Ways to Access Data

### 1. PeopleGraph CLI (fast, structured)
Best for: specific queries, scores, company lookups, reconnect candidates.

```bash
# Install (if not already)
curl -fsSL https://raw.githubusercontent.com/kayacancode/obsidian-gmail-crm/main/scripts/install-peoplegraph.sh | bash

# Auto-detects your Obsidian vault — no --cache needed
peoplegraph find-person "Chris Dixon"
peoplegraph who-knows --company "a16z"
peoplegraph score chris@a16z.com
peoplegraph reconnect --limit 20
peoplegraph contact-card chris@a16z.com
```

### 2. Reading Obsidian Vault Directly (rich, full context)
Best for: reading enriched people pages, relationship maps, meeting history, AI-generated context.

People pages live at `<vault>/People/p- Firstname Lastname.md` with YAML frontmatter:

```yaml
email: chris@a16z.com
company: "[[Companies/A16z|A16z]]"
role: "Partner at a16z"
last_contact: "2025-09-30"
first_contact: "2013-03-29"
total_exchanges: 93
sent: 75
received: 18
strength_score: 59
momentum_score: 17
combined_score: 25
quadrant: re-engage
staleness_label: stale
depth: 4
recency: 1
nudge: "No contact in 9 months — previously active (93 emails)"
override: boost
```

## Commands Reference

### Find a Person
```bash
peoplegraph find-person "Jane Smith"
peoplegraph find-person "jane@example.com"
```
Fuzzy matches by name or email. Groups results by identity (same person, multiple emails). Returns name, email, company, score, and all known aliases.

### Who Do You Know at a Company?
```bash
peoplegraph who-knows --company "betaworks"
peoplegraph who-knows --company "google" --limit 10
```
Returns contacts at that domain ranked by relationship score. Useful for "do we know anyone at X?" questions.

### Score a Contact
```bash
peoplegraph score jane@example.com
```
Returns full score card: quadrant, depth, recency, combined score, plus raw signals (sent/received counts, thread metadata, first/last contact dates).

### Reconnect Candidates
```bash
peoplegraph reconnect --limit 20
peoplegraph reconnect --limit 50 --min-score 30
```
Surfaces strong-but-dormant contacts (re-engage quadrant) ranked by combined score. Each result includes a nudge reason explaining why they're worth reaching out to.

### Contact Card
```bash
peoplegraph contact-card jane@example.com
```
Minimal card with name, email, company, role, and scores.

### Suggest Duplicates
```bash
peoplegraph suggest-duplicates --limit 10
```
Find contacts that look like the same person across different emails (e.g., david@company.com and david.smith@gmail.com).

## Understanding Scores

### Quadrants (the big picture)
| Quadrant | Meaning | Action |
|----------|---------|--------|
| **nurture** | Strong + active | Keep investing |
| **re-engage** | Strong + dormant | Reach out — relationship going cold |
| **developing** | Weak + active | New/growing — potential to build |
| **deprioritize** | Weak + dormant | Low priority — let it be |

### Strength Score (0-100)
How deep is the relationship overall?
- Volume (25 pts) — log-scaled email count
- Depth (30 pts) — back-and-forth threads, thread depth
- Initiation Balance (25 pts) — 50/50 sent/received = max
- Time Span (15 pts) — how long you've known each other
- Calendar (20 pts) — shared meetings boost score

### Momentum Score (0-100)
How active is it right now?
- Recency Decay (80 pts) — exponential, half-life ~35 days
- Activity Trend (20 pts) — recent thread depth bonus

### Combined Score (0-100)
Average of strength + momentum. The single sortable number.

### Staleness Labels
| Score | Label |
|-------|-------|
| 70-100 | active |
| 50-69 | warm |
| 30-49 | cooling |
| 10-29 | stale |
| 0-9 | dormant |

### Overrides (from swipe decisions)
- **boost** — swiped right, pinned to top of quadrant
- **suppress** — swiped left, hidden from reconnect
- **delete** — trashed, blocklisted

Check the `override` field in frontmatter to see swipe decisions.

## Common Agent Tasks

### "Who should I reconnect with?"
```bash
peoplegraph reconnect --limit 10
```
Read the nudge field for conversation starters.

### "Do we know anyone at [company]?"
```bash
peoplegraph who-knows --company "[company]"
```

### "What's my relationship like with [person]?"
```bash
peoplegraph find-person "[name]"
# Then read their People page for full context:
cat "<vault>/People/p- Firstname Lastname.md"
```

### "Who are my strongest relationships?"
Read People pages and sort by `combined_score` or `strength_score` in frontmatter. Or check the CRM.base file in Obsidian.

### "Draft a re-engagement email for [person]"
1. Get their score: `peoplegraph score email@example.com`
2. Read their People page for context, last subjects, role
3. Use the nudge and recent_subjects to craft a relevant message

## Pitfalls

1. **PeopleGraph auto-detects the vault** — reads Obsidian's config to find the contact-index.json. No --cache needed unless you have multiple vaults.
2. **Scores update when the user runs "Update staleness scores" in Obsidian** — the CLI reads cached scores, not live-computed ones.
3. **The `override` field reflects swipe decisions** — respect these. Don't suggest reconnecting with suppressed/deleted contacts.
4. **Never modify the contact-index.json directly** — the plugin manages it. Use `peoplegraph feedback` for swipe decisions only.
5. **Email content is never available** — the plugin only stores metadata (From/To/Date/Subject). Don't promise to look up what was discussed.
