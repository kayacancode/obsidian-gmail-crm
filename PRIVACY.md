# Privacy Policy — People Plugin for Obsidian

**Last updated:** November 16, 2026

## What This Plugin Does

People Plugin for Obsidian's normal sync reads **email metadata only** — sender, recipient, date, subject line, and thread structure. It does not read email bodies during normal sync. If the separate People Graph service is enabled, a user can explicitly confirm a one-time deeper retrieval for a selected person, inbox and 30- or 90-day window. That retrieval is capped at 50 matching messages and 1 MB of decoded body text.

The plugin uses this metadata to build a local contact relationship graph inside your Obsidian vault.

## What Data Is Accessed

The plugin requests the following Google API scopes:

- **gmail.readonly** — read-only Gmail access, including the ability to read message bodies. Normal plugin sync requests metadata only; the granted permission is broader than normal sync usage.
- **calendar.events.readonly** (optional) — read-only access to calendar events for meeting history.
- **contacts.readonly** and **contacts.other.readonly** — read-only contact access for contact photos.

These scopes are requested together during connection, even if you do not use the calendar or photo features.

The separate web app requests `gmail.readonly`, `calendar.events.readonly`, and read-only Google Contacts scopes for authorized contact photos. Normal web sync imports email metadata only. Calendar invitation/RSVP counts can appear on shared connection cards for contributed contacts; event titles are not included in those shared activity summaries. Invitations do not establish attendance.

## Where Data Is Stored

The desktop plugin stores the following data on your device:

- Contact index (names, emails, scores) in your Obsidian vault's plugin data folder
- People pages (markdown notes) in your vault
- OAuth tokens and API keys in Obsidian's plugin settings, without plugin-level encryption. Vault sync and backups may copy them to other devices or providers.

Local Obsidian content stays local unless you explicitly push a bounded graph snapshot to the People Graph service. Connecting Granola directly to the web app imports meeting content into your account’s cloud storage; workspace sharing is a separate choice. A pushed snapshot uses vault-hashed contact IDs and contains only the graph fields shown for upload; it does not contain raw email bodies. Cloud inbox metadata and encrypted refresh grants are isolated inside the signed-in owner's Durable Object. Public, firm and private evidence are stored and returned as separate visibility classes: Firm views receive only firm evidence, Public views receive only public evidence, and the owner's My view can use all evidence authorized for that owner.

Explicit deeper retrieval holds decoded body text only in transient memory while extracting server-owned topic identifiers. Raw bodies are not retained in SQL, KV, graph responses or logs. Public pages or feeds are also fetched only after preview and confirmation, with redirect, content-type, timeout and 1 MB response limits.

## AI Enrichment (Optional)

If you choose to enable AI enrichment, the plugin sends the existing person note (including meeting history and other content in that note), mapped relationships, connected-person names, and Gmail statistics/recent subjects to Anthropic's API using **your own API key**. Normal sync does not retrieve email bodies, but notes may contain sensitive text you added yourself. This is entirely optional and must be explicitly enabled.

## Third-Party Services

- **Google APIs** — used to read email metadata and calendar events. Subject to [Google's Privacy Policy](https://policies.google.com/privacy).
- **Anthropic API** (optional) — used only if you enable AI enrichment with your own API key. Subject to [Anthropic's Privacy Policy](https://www.anthropic.com/privacy).

The optional People Graph service uses Cloudflare Workers, Durable Objects, D1 and Workers AI for the confirmed cloud features described above. There is no product analytics or advertising tracker.

## Advisory outputs and user control

Metadata heat is advisory and may be incomplete or wrong. Connector rings distinguish documented from inferred structure but do not establish closeness, willingness, consent or the ability to introduce someone. People Graph sends in-app introduction requests when a user explicitly submits them. It does not automatically email contacts. Shared cards include aggregate counts of requests marked completed within that workspace, not request messages or inferred email introductions.

## Data Retention

The plugin does not delete your data. Contact data persists in your vault until you manually delete it. To remove all plugin data:

1. Disable the plugin in Obsidian
2. Delete the `<vault>/.obsidian/plugins/gmail-crm/` folder
3. Delete the People and Companies folders the plugin created

## Revoking Access

To revoke the plugin's access to your Google account:

1. Go to [Google Account Security](https://myaccount.google.com/permissions)
2. Find "Gmail CRM for Obsidian" in the list of third-party apps
3. Click "Remove Access"

You can also disconnect within the plugin: Settings → People Plugin → Disconnect.

## Contact

For questions about this privacy policy or the plugin's data practices, please open an issue at [github.com/kayacancode/obsidian-gmail-crm](https://github.com/kayacancode/obsidian-gmail-crm/issues).

## Embedded People graph sign-in

Opening the graph connects to the configured People server, or the hosted Cloudflare deployment. Browser authorization creates a five-minute, single-use connection request bound to the requesting tab. Approval establishes an HttpOnly, Secure, partitioned embedded session lasting up to 24 hours. Sign out using the People app to clear that session. Opening the graph does not itself upload vault notes.

The optional custom score endpoint receives contact scores and the configured owner identity when score push is used. The local Google OAuth callback listens temporarily on `127.0.0.1:42813`.
