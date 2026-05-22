# Gmail CRM for Obsidian

A privacy-first CRM that pulls Gmail metadata into your Obsidian vault. No email content is accessed — only sender names, dates, and exchange counts. Includes **Harper Skill**, an AI-powered relationship intelligence layer that enriches your people pages with relationship maps, strategic context, and suggested actions.

## Features

- **Gmail Metadata Sync** — pulls contact names, last contact dates, email frequency (metadata-only scope, no email bodies)
- **Contact Sidebar** — searchable, sortable CRM view inside Obsidian
- **Relationship Graph Engine** — auto-maps connections between people via wiki links, shared meetings, introducer chains, and text mentions
- **Harper Skill Analysis** — AI-powered full rewrites of people pages with relationship maps, key themes, strategic context, communication patterns, and suggested actions
- **Privacy Firewall** — acts as a gateway between your email and AI. Gmail metadata stays in your vault, never sent to third parties unless you explicitly run Harper Skill analysis

## Install

### Via BRAT (recommended for beta)

1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat) if you don't have it
2. Settings > BRAT > Add Beta Plugin
3. Paste: `kayacancode/obsidian-gmail-crm`
4. Enable the plugin in Community Plugins

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest release
2. Create `.obsidian/plugins/gmail-crm/` in your vault
3. Copy the three files in
4. Enable in Settings > Community Plugins

## Setup

### 1. Create a Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or use an existing one)
3. Enable the **Gmail API**:
   - Go to **APIs & Services > Library**
   - Search for "Gmail API"
   - Click **Enable**

### 2. Configure OAuth Consent Screen

1. Go to **APIs & Services > OAuth consent screen**
2. Choose **External** user type
3. Fill in the app name (e.g., "Gmail CRM") and your email
4. Under **Scopes**, click **Add or remove scopes** and add:
   ```
   https://www.googleapis.com/auth/gmail.metadata
   ```
5. Under **Test users**, add your Gmail address
6. Save

### 3. Create OAuth Credentials

1. Go to **APIs & Services > Credentials**
2. Click **Create Credentials > OAuth client ID**
3. Application type: **Desktop app**
4. Name it whatever you want
5. Click **Create**
6. Copy the **Client ID** and **Client Secret**
7. Under **Authorized redirect URIs**, add:
   ```
   http://127.0.0.1:42813/callback
   ```

### 4. Configure the Plugin

1. Open Obsidian Settings > Gmail CRM
2. Paste your **Client ID** and **Client Secret**
3. Click **Connect Gmail** — this opens your browser for OAuth
4. Authorize the app — you'll see "Gmail CRM connected!" when done

### 5. Sync

Click **Sync** in the plugin settings or use the command palette: `Gmail CRM: Sync Gmail contacts`

## Harper Skill (AI Enrichment)

Harper Skill rewrites your people pages with relationship intelligence. It requires a Claude API key from Anthropic.

### Setup

1. Get an API key from [console.anthropic.com](https://console.anthropic.com/)
2. In plugin settings under **Harper Skill Analysis**, paste your API key
3. Set your **People pages folder** (the vault folder with your people notes)
4. Choose a model:
   - **Sonnet 4.6** — fast, good balance of speed and quality
   - **Opus 4.6** — most thorough analysis
   - **Haiku 4.5** — cheapest, good for large vaults

### Usage

**Command palette:**
- `Enrich all people (relationships + Harper Skill)` — rewrites all people pages
- `Enrich current person (Harper Skill)` — rewrites the currently open person page
- `Map relationships only (no AI)` — adds `## Relationships` section with wiki links, no API calls

**Settings buttons:**
- **Enrich All** — runs Harper Skill on every page in your people folder
- **Map Only** — relationship links only, free and instant

### What Harper Skill Generates

Each person page gets rewritten with:

- **Overview** — role, email, connection context
- **Background** — synthesized bio
- **Relationship Map** — `[[p- Name]]` wiki links with connection types and strength signals
- **Key Themes & Interests** — what they care about
- **Strategic Context** — why they matter in your network
- **Communication Pattern** — email frequency and engagement (if Gmail data available)
- **Meeting History** — all existing meeting entries preserved verbatim
- **Suggested Actions** — concrete next steps

## PeopleGraph CLI

PeopleGraph is the agent-facing CLI for querying the Gmail CRM contact cache without scraping Obsidian markdown.

Install from the Homebrew tap:

```bash
brew tap kayacancode/tap
brew install peoplegraph
```

Example commands:

```bash
peoplegraph who-knows --company betaworks
peoplegraph find-person "Harper Reed"
peoplegraph score harper@2389.ai
peoplegraph suggest-duplicates --limit 10
```

The CLI auto-discovers the active Gmail CRM cache when run near a vault, or you can set `PEOPLEGRAPH_CACHE` / pass `--cache`.

### Botwick / OpenClaw source-of-truth setup

Use this on the computer that has the real Obsidian vault and Gmail CRM plugin. That machine owns the source-of-truth `.obsidian/plugins/gmail-crm/contact-index.json`.

1. Install PeopleGraph:

   ```bash
   brew tap kayacancode/tap
   brew install peoplegraph
   ```

2. In Obsidian, run the plugin sync commands so the cache is current:

   ```text
   Gmail CRM: Sync Gmail contacts
   Gmail CRM: Update staleness scores
   ```

3. Start the read-only PeopleGraph server:

   ```bash
   export PEOPLEGRAPH_CACHE="/path/to/vault/.obsidian/plugins/gmail-crm/contact-index.json"
   export PEOPLEGRAPH_TOKEN="$(openssl rand -hex 32)"
   echo "$PEOPLEGRAPH_TOKEN"

   peoplegraph --cache "$PEOPLEGRAPH_CACHE" serve --bind 127.0.0.1:8787
   ```

4. Configure Botwick/OpenClaw to call the local server:

   ```bash
   export PEOPLEGRAPH_HOST="http://127.0.0.1:8787"
   export PEOPLEGRAPH_TOKEN="the-token-from-step-3"

   peoplegraph --host "$PEOPLEGRAPH_HOST" --token "$PEOPLEGRAPH_TOKEN" who-knows --company betaworks
   ```

Keep `--bind 127.0.0.1:8787` when Botwick runs on the same computer. If other machines need access, put this behind a trusted private network, SSH tunnel, Tailscale, or a reverse proxy with HTTPS. Do not expose the raw HTTP server publicly.

### Query-only client setup

Use this on another person's computer. They do not need Obsidian or the Gmail CRM plugin. They only need the PeopleGraph CLI, the Botwick host URL, and the token from the source-of-truth machine.

1. Install PeopleGraph:

   ```bash
   brew tap kayacancode/tap
   brew install peoplegraph
   ```

2. If Botwick is exposed through a private URL, query it directly:

   ```bash
   export PEOPLEGRAPH_HOST="http://botwick-host-or-tailnet-name:8787"
   export PEOPLEGRAPH_TOKEN="token-shared-by-botwick-owner"

   peoplegraph --host "$PEOPLEGRAPH_HOST" --token "$PEOPLEGRAPH_TOKEN" who-knows --company disney
   peoplegraph --host "$PEOPLEGRAPH_HOST" --token "$PEOPLEGRAPH_TOKEN" find-person "Harper Reed"
   peoplegraph --host "$PEOPLEGRAPH_HOST" --token "$PEOPLEGRAPH_TOKEN" score harper@2389.ai
   ```

3. If Botwick is only bound to localhost, create an SSH tunnel first:

   ```bash
   ssh -N -L 8787:127.0.0.1:8787 user@botwick-machine
   ```

   Then query through the tunnel:

   ```bash
   peoplegraph --host http://127.0.0.1:8787 --token "$PEOPLEGRAPH_TOKEN" who-knows --company disney
   ```

Remote mode is read-only in V1. Query-only users can run `describe`, `version`, `find-person`, `score`, `who-knows`, `get-neighbors`, `get-edges`, `suggest-duplicates`, and `merge-queue`. Merge writes still run only on the source-of-truth cache/queue so Botwick's graph stays protected behind explicit review.

### People Page Format

The plugin expects people pages named `p- Firstname Lastname.md` in your people folder. Example:

```
p- John Borthwick.md
p- Alice Albrecht.md
p- Chris Perry.md
```

## Privacy & Security

- **Gmail metadata only** — the plugin uses the `gmail.metadata` scope, which grants access to email headers (sender, recipient, date, subject) but **never email bodies**
- **Local storage** — all data stays in your vault. The contact index is stored in `.obsidian/plugins/gmail-crm/`
- **No telemetry** — the plugin makes zero external calls except to Gmail API and (optionally) Anthropic API
- **You control the AI** — Harper Skill only runs when you explicitly trigger it. Your people pages are sent to Claude API for analysis — if that's a concern, use **Map Only** mode instead

## Commands

| Command | Description |
|---------|-------------|
| Open Gmail CRM | Opens the contact sidebar |
| Sync Gmail contacts | Pulls latest Gmail metadata |
| Enrich all people | Harper Skill rewrite on all people pages |
| Enrich current person | Harper Skill rewrite on the open page |
| Map relationships only | Adds relationship links without AI |

## License

MIT
