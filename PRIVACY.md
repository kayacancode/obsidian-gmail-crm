# Privacy Policy — Gmail CRM for Obsidian

**Last updated:** June 2026

## What This Plugin Does

Gmail CRM for Obsidian connects to your Google account to read **email metadata only** — sender, recipient, date, subject line, and thread structure. It does **not** read email body content.

The plugin uses this metadata to build a local contact relationship graph inside your Obsidian vault.

## What Data Is Accessed

The plugin requests the following Google API scopes:

- **gmail.metadata** — read-only access to email headers (From, To, Date, Subject). No access to email body content.
- **calendar.events.readonly** (optional) — read-only access to calendar events for meeting history.
- **userinfo.email** — your email address, used to identify your account.

## Where Data Is Stored

**All data stays on your device.** The plugin stores:

- Contact index (names, emails, scores) in your Obsidian vault's plugin data folder
- People pages (markdown notes) in your vault
- OAuth tokens in Obsidian's plugin settings (local to your device)

**No data is transmitted to any external server.** The plugin communicates only with Google's APIs directly from your machine.

## AI Enrichment (Optional)

If you choose to enable AI enrichment, the plugin sends contact metadata (not email content) to Anthropic's API using **your own API key**. This is entirely optional and must be explicitly enabled.

## Third-Party Services

- **Google APIs** — used to read email metadata and calendar events. Subject to [Google's Privacy Policy](https://policies.google.com/privacy).
- **Anthropic API** (optional) — used only if you enable AI enrichment with your own API key. Subject to [Anthropic's Privacy Policy](https://www.anthropic.com/privacy).

No other third-party services are used. There is no analytics, tracking, telemetry, or data collection of any kind.

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
