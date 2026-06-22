# Gmail CRM for Obsidian

A privacy-first CRM that builds a relationship graph from your Gmail metadata — entirely inside Obsidian. No data leaves your machine. No email content is read.

## What It Does

Gmail CRM syncs your email metadata (sender, recipient, date, subject line, thread structure) and builds:

- **People pages** — one markdown note per contact with frontmatter stats
- **Company pages** — auto-created stubs linked to people
- **Relationship scores** — staleness, strength, momentum, and quadrant assignments
- **CRM base view** — sortable/filterable table of all contacts
- **Quadrant view** — 2×2 grid: nurture / re-engage / developing / deprioritize
- **AI enrichment** (optional) — Claude rewrites people pages with structured sections
- **Calendar integration** (optional) — meeting history as a relationship signal

## Getting Started

### 1. Install the Plugin

**Via BRAT (recommended for now):**
1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat) if you haven't
2. Add `kayacancode/obsidian-gmail-crm` as a beta plugin
3. Enable "Gmail CRM" in Community Plugins

**Manual install:**
1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/kayacancode/obsidian-gmail-crm/releases)
2. Create `<vault>/.obsidian/plugins/gmail-crm/` and place the files there
3. Enable "Gmail CRM" in Community Plugins

### 2. Set Up Google OAuth

The plugin needs read-only access to your Gmail metadata. You create your own OAuth credentials — no shared API key, no third-party server.

1. Go to [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
2. Create a new project (or use an existing one)
3. Enable the **Gmail API** (and optionally **Google Calendar API**)
4. Go to **OAuth consent screen** → set to "Internal" (Workspace) or "External" (personal Gmail)
   - For personal Gmail: add your email as a test user
5. Create **OAuth 2.0 Client ID** → Application type: **Desktop app**
6. Copy the **Client ID** and **Client Secret**
7. In Obsidian → Gmail CRM settings:
   - Paste Client ID and Client Secret
   - Click **Connect** — a browser window opens for Google sign-in
   - Authorize the app — you'll be redirected back automatically

### 3. Run Your First Sync

- Open the command palette (Cmd/Ctrl + P) → **Gmail CRM: Sync Gmail contacts**
- The plugin scans your email metadata and builds the contact index
- First sync may take a few minutes depending on mailbox size
- Subsequent syncs are incremental (only new messages)

### 4. Explore Your CRM

After your first sync, you'll have a **People/** folder with one markdown note per contact. Here's how to make sense of it all:

#### People Pages

Each contact gets a markdown note (e.g., `p- Jane Smith.md`) with YAML frontmatter containing their email stats:

```yaml
---
email: jane@example.com
company: "[[Companies/Acme Corp|Acme Corp]]"
role: "CTO at Acme Corp"
sent: 45
received: 38
total_exchanges: 83
threads: 22
first_contact: "2023-03-15"
last_contact: "2026-06-10"
staleness: 85
staleness_label: active
strength_score: 72
momentum_score: 65
combined_score: 69
quadrant: nurture
depth: 4
recency: 9
nudge: null
---
```

If you enable AI enrichment, the page body gets structured sections: Overview, Background, Relationship Map, Key Themes, and Suggested Actions.

#### Company Pages

The plugin auto-creates stub notes in the **Companies/** folder, linked from people pages via wiki-links. This lets you click through from a person to see everyone you know at that company.

#### CRM Base View

Run **Gmail CRM: Create base view** (Cmd/Ctrl + P) to generate `CRM.base` — a sortable, filterable table of all your contacts. It includes 6 pre-built views:

| View | What It Shows |
|------|---------------|
| **CRM** | All contacts sorted by combined score |
| **Re-engage** | Strong relationships that have gone quiet — people worth reaching out to |
| **By Company** | Contacts grouped by company |
| **Nurture** | Your strongest, most active relationships |
| **Developing** | New or weak relationships with recent activity — potential to grow |
| **Quadrants** | All contacts with their quadrant assignment visible |

You can sort by any column, filter by company or score range, and click through to any person's page.

#### Staleness Scores

Run **Gmail CRM: Update staleness scores** to compute relationship scores for every contact. Each person gets:

- **Staleness** (0–100) — how fresh is the relationship?
- **Strength** (0–100) — how deep and balanced is it overall?
- **Momentum** (0–100) — how active is it right now?
- **Combined** (0–100) — single sortable number (average of strength + momentum)
- **Quadrant** — nurture / re-engage / developing / deprioritize
- **Nudge** — suggested reason to re-engage (for stale contacts that were once strong)

See [How Scoring Works](#how-scoring-works) below for the full algorithm.

#### Quadrant View

Run **Gmail CRM: Create quadrant view** to generate `_Quadrants.md` — a visual 2×2 grid showing your contacts organized by relationship health:

```
         DEVELOPING        │        NURTURE
    (new but active)       │   (strong + active)
                           │
  ─────────────────────────┼─────────────────────────
                           │
       DEPRIORITIZE        │       RE-ENGAGE
    (weak + dormant)       │   (strong but dormant)
```

- **Nurture** — your best relationships, keep them going
- **Re-engage** — strong relationships going cold, reach out
- **Developing** — new contacts with momentum, invest here
- **Deprioritize** — low activity, low depth, let these be

#### Relationship Mapping

Run **Gmail CRM: Map relationships** to build a graph of connections between your contacts. The engine detects relationships from:

- Wiki-links between people pages (`[[p- Jane Smith]]` mentioned in another person's page)
- Shared email threads (introduced-by patterns)
- Shared calendar meetings
- Role/company overlaps

These edges feed into the strength score and show up in AI-enriched pages under "Relationship Map."

#### Calendar Integration

Run **Gmail CRM: Sync calendar** to pull meeting history from Google Calendar. This adds:

- Total meetings with each contact
- Meetings in the last 90 days
- Whether they organized meetings with you
- Calendar acceptance count

Calendar data feeds into the strength score (up to 20 bonus points) and can override the quadrant assignment — if you've shared 2+ calendar events with someone, they're treated as a strong relationship regardless of email volume.

## Commands

| Command | Description |
|---------|-------------|
| Sync Gmail contacts | Incremental sync of new email metadata |
| Full re-sync | Wipe and rebuild the entire contact index |
| Update staleness scores | Recompute all relationship scores and quadrants |
| Create base view | Generate/refresh the CRM.base sortable table |
| Create quadrant view | Generate/refresh the _Quadrants.md grid |
| Enrich current person | AI-rewrite the current people page (requires Anthropic API key) |
| Enrich all people pages | AI-rewrite all people pages |
| Map relationships | Build relationship edges from wiki-links and shared meetings |
| Sync calendar | Pull Google Calendar meeting history into contact records |

## How Scoring Works

Every contact gets scored on multiple dimensions. The system uses **only metadata** — it never reads email body content.

### Staleness Score (0–100)

How fresh is your relationship? Based on days since last contact:

| Days Since Contact | Score Range |
|---|---|
| ≤ 7 days | 100 (fresh) |
| 8–30 days | 70–90 |
| 31–90 days | 40–70 |
| 91–180 days | 15–40 |
| 181–360 days | 0–15 |
| > 360 days | 0 (dormant) |

**Boosts:** +10 for contacts with 50+ email exchanges, +5 for 20+, +5 for 5+ relationship edges in the graph.

The staleness score maps to a label:

| Score | Label |
|---|---|
| 70–100 | **Active** |
| 50–69 | **Warm** |
| 30–49 | **Cooling** |
| 10–29 | **Stale** |
| 0–9 | **Dormant** |

### Relationship Depth (1–5)

How deep is the conversation? Driven by email thread metadata:

| Depth | Pattern |
|---|---|
| **5** | 3+ back-and-forth threads, 20+ exchanges, threads 5+ messages deep |
| **4** | At least 1 back-and-forth thread with 8+ exchanges |
| **3** | 8+ exchanges with threads 3+ deep |
| **2** | 3+ exchanges (unless mostly RSVPs → drops to 1) |
| **1** | Minimal contact or RSVP-only threads |

Key insight: **back-and-forth replies are the strongest signal**. A deep email thread means a real conversation. Single RSVP responses are explicitly down-weighted.

### Relationship Recency (1–10)

Fine-grained recency scale:

| Days | Score |
|---|---|
| 0–2 | 10 |
| 3–7 | 9 |
| 8–14 | 8 |
| 15–21 | 7 |
| 22–30 | 6 |
| 31–60 | 5 |
| 61–90 | 4 |
| 91–120 | 3 |
| 121–180 | 2 |
| 180+ | 1 |

### Strength Score (0–100)

Composite score measuring overall relationship strength. Five weighted components:

| Component | Max Points | How It's Calculated |
|---|---|---|
| **Volume** | 25 | Log-scaled email count: `log2(exchanges + 1) × 4` |
| **Depth** | 30 | Back-and-forth threads (×5, max 20) + max thread depth (×2, max 10) |
| **Initiation Balance** | 25 | How balanced is sent vs received? 50/50 = 25, one-sided = 5 |
| **Time Span** | 15 | How long you've been in contact. ~2 years = max |
| **Calendar** | 20 | Shared meetings: 5+ in 90 days = 20, 3+ = 16, 1+ = 12, etc. |

**Total possible: 115, clamped to 100.** The calendar component means people you actually meet in person get a meaningful boost even with low email volume.

### Momentum Score (0–100)

How active is the relationship right now? Two components:

| Component | Max Points | How It's Calculated |
|---|---|---|
| **Recency Decay** | 80 | Exponential decay: `e^(-0.02 × days)`. Half-life ≈ 35 days |
| **Activity Trend** | 20 | Recent thread depth (max 10) + back-and-forth threads (max 10) |

The exponential decay is aggressive by design — a strong past relationship that has gone quiet will show up in the "re-engage" quadrant, not stay in "active."

### Combined Score (0–100)

Simple average of Strength + Momentum: `(strengthScore + momentumScore) / 2`. This is the single sortable number used in the CRM base view.

### Quadrant Assignment

Contacts are placed in a 2×2 grid based on strength and momentum:

```
                    High Momentum
                         │
         DEVELOPING      │      NURTURE
       (weak + active)   │   (strong + active)
                         │
  ───────────────────────┼───────────────────────
                         │
       DEPRIORITIZE      │      RE-ENGAGE
       (weak + dormant)  │   (strong + dormant)
                         │
                    Low Momentum
```

**Thresholds:** Strength ≥ 40, Momentum ≥ 30.

**Hard overrides** (these trump the thresholds):
- **Back-and-forth override:** If you've had at least 1 real two-way conversation AND sent 2+ messages, the contact is treated as "strong" — never deprioritized.
- **Calendar override:** If you've both accepted 2+ shared calendar events, treated as "strong" — real-world face time trumps email patterns.

### Nudges

Stale or cooling contacts that were previously strong/moderate get a nudge — a suggested reason to re-engage:

- How long since last contact
- Previous activity level ("previously active — 45 emails")
- Context from the person's page (role, key context)

## AI Enrichment (Optional)

If you add an Anthropic API key in settings, you can use Claude to rewrite people pages with structured sections:

- **Overview** — who they are
- **Background** — career, education
- **Relationship Map** — how you're connected
- **Key Themes** — what you discuss
- **Strategic Context** — why the relationship matters
- **Communication Pattern** — how/when you interact
- **Suggested Actions** — what to do next

This uses the metadata and existing page content — it does not read your emails.

## Privacy & Security

- **No email content is read** — only metadata (From, To, Date, Subject, thread structure)
- **Everything stays local** — the contact index lives in your vault's plugin data folder
- **Your OAuth credentials** — you create and control them
- **No external servers** — the plugin talks directly to Gmail API from your machine
- **AI enrichment is optional** — only runs when you explicitly trigger it, using your own API key

## Settings

| Setting | Description |
|---------|-------------|
| Client ID / Secret | Your Google OAuth credentials |
| Blocked domains | Comma-separated domains to exclude from sync |
| Sync interval | Auto-sync frequency (15–480 minutes) |
| Max messages | Limit how many messages to scan (100–50000, or All) |
| Contact notes folder | Where people pages are created (default: People) |
| Companies folder | Where company stubs are created (default: Companies) |
| Your name | Used for AI enrichment personalization |
| Anthropic API key | For AI enrichment (optional) |
| Model | Claude model for enrichment (Sonnet/Opus/Haiku) |
| Enrich on sync | Auto-run AI enrichment after each sync |

## License

MIT — see [LICENSE](LICENSE).
