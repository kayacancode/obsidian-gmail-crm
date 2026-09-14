# Privacy Policy — Gmail CRM for Obsidian

**Last updated:** September 14, 2026

## What This Plugin Does

Gmail CRM for Obsidian's normal sync reads **email metadata only** — sender, recipient, date, subject line, and thread structure. It does not read email bodies during normal sync. If the separate People Graph service is enabled, a user can explicitly confirm a one-time deeper retrieval for a selected person, inbox and 30- or 90-day window. That retrieval is capped at 50 matching messages and 1 MB of decoded body text.

The plugin uses this metadata to build a local contact relationship graph inside your Obsidian vault.

## What Data Is Accessed

The plugin requests the following Google API scopes:

- **gmail.metadata** — read-only access to email headers (From, To, Date, Subject). No access to email body content.
- **calendar.events.readonly** (optional) — read-only access to calendar events for meeting history.
- **userinfo.email** — your email address, used to identify your account.

## Where Data Is Stored

The desktop plugin stores the following data on your device:

- Contact index (names, emails, scores) in your Obsidian vault's plugin data folder
- People pages (markdown notes) in your vault
- OAuth tokens in Obsidian's plugin settings (local to your device)

Granola and Obsidian content stays local unless you explicitly push a bounded graph snapshot to the People Graph service. A pushed snapshot uses vault-hashed contact IDs and contains only the graph fields shown for upload; it does not contain raw email bodies. Cloud inbox metadata and encrypted refresh grants are isolated inside the signed-in owner's Durable Object. Public, firm and private evidence are stored and returned as separate visibility classes: Firm views receive only firm evidence, Public views receive only public evidence, and the owner's My view can use all evidence authorized for that owner.

Explicit deeper retrieval holds decoded body text only in transient memory while extracting server-owned topic identifiers. Raw bodies are not retained in SQL, KV, graph responses or logs. Public pages or feeds are also fetched only after preview and confirmation, with redirect, content-type, timeout and 1 MB response limits.

## AI Enrichment (Optional)

If you choose to enable AI enrichment, the plugin sends contact metadata (not email content) to Anthropic's API using **your own API key**. This is entirely optional and must be explicitly enabled.

## Third-Party Services

- **Google APIs** — used to read email metadata and calendar events. Subject to [Google's Privacy Policy](https://policies.google.com/privacy).
- **Anthropic API** (optional) — used only if you enable AI enrichment with your own API key. Subject to [Anthropic's Privacy Policy](https://www.anthropic.com/privacy).

The optional People Graph service uses Cloudflare Workers, Durable Objects, D1 and Workers AI for the confirmed cloud features described above. There is no product analytics or advertising tracker.

## Advisory outputs and user control

Metadata heat is advisory and may be incomplete or wrong. Connector rings distinguish documented from inferred structure but do not establish closeness, willingness, consent or the ability to introduce someone. Gmail CRM and People Graph never send outreach, email or introduction requests; any action remains with the user.

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

You can also disconnect within the plugin: Settings → Gmail CRM → Disconnect.

## Contact

For questions about this privacy policy or the plugin's data practices, please open an issue at [github.com/kayacancode/obsidian-gmail-crm](https://github.com/kayacancode/obsidian-gmail-crm/issues).
