# People Plugin

Build a personal CRM in your Obsidian vault from Gmail activity, keep Markdown people notes, and explore your relationships in a People graph tab.

**Desktop only.** Requires Obsidian 1.15.0 or later. Gmail sync requires a Google account and Google OAuth authorization. The optional hosted People graph requires a separate People sign-in and internet access; shared networks require membership.

## Features

- Create people and company notes from Gmail metadata.
- Track contact activity, relationship scores, and contacts worth reconnecting with.
- Explore a local People intelligence workspace and CRM table.
- Open personal and shared People graphs inside an Obsidian tab.
- Optionally enrich people notes with Anthropic using your own API key.

## Install

This plugin has been submitted to the [Obsidian Community directory](https://community.obsidian.md/plugins/gmail-crm) and is undergoing automated review.

Until approval, download **main.js**, **manifest.json**, and **styles.css** from a [plugin release](https://github.com/kayacancode/obsidian-gmail-crm/releases), place them in `<vault>/.obsidian/plugins/gmail-crm/`, then enable **People Plugin** under **Settings → Community plugins**. BRAT remains an optional beta installation method.

After the plugin is approved, install it from **Settings → Community plugins → Browse** by searching for **People Plugin**.

## Start using it

1. Open **Settings → People Plugin** and connect Google. If the shared OAuth client is unavailable to your account, configure your own Desktop app credentials using the [setup guide](docs/obsidian-plugin.md#2-set-up-google-oauth).
2. Enable **Create contact notes** in settings if you want generated Markdown people pages, then run **People Plugin: Sync contacts** from the command palette. Review the generated people notes and relationship scores.
3. Run **People Plugin: View people graph**. Choose **Sign in using your browser**, sign in to People, approve the Obsidian connection, and return to the tab. Select a shared network in the People app if you belong to one.

Opening the hosted graph does not upload your vault. Graph uploads are a separate command and require a configured server and push token. The hosted graph needs an online service; the plugin’s local notes and intelligence workspace are stored in your vault.

Read the [complete plugin guide](docs/obsidian-plugin.md) for setup, commands, scoring, and troubleshooting.

## Accounts, network use, and privacy

- **Google:** normal sync requests message metadata, not email bodies. The current OAuth grant is broader: `gmail.readonly`, Calendar event read access, and read-only Google Contacts access. Review the permissions before connecting. Calendar and photo use can be optional in the UI even though their scopes are requested together.
- **Anthropic, optional:** enrichment sends the selected person’s existing note content (including meeting notes), mapped relationships, connected-person names, and Gmail statistics/recent subjects. It uses your API key. Review your notes before enabling it.
- **People on Cloudflare, optional:** opening the graph connects to the hosted People deployment (or your configured server). It uses account sessions for private graphs and network membership for shared graphs. Browser handoff requests expire in five minutes; the embedded session lasts up to 24 hours. Explicit graph pushes upload selected contact and relationship data. Cloud features may process data using Workers AI.
- **Custom score server, optional:** a configured score endpoint receives contact scores and your configured account identity when you use score push.
- OAuth credentials, API keys, contact indexes, and notes are stored in the vault’s plugin data or Markdown files. Vault sync and backups may copy these files to other devices or providers. Credentials are not encrypted by this plugin.
- Google sign-in temporarily listens on `127.0.0.1:42813` for the browser callback. The plugin does not install executables or update itself. The separately installed PeopleGraph CLI is optional.

See [PRIVACY.md](PRIVACY.md) for storage, retention, cloud processing, and revocation details. There is no client-side analytics or advertising tracker. Relationship scores are estimates, not proof of closeness, expertise, or willingness to make an introduction.

## Development

```sh
npm ci
npm run check:release
```

Release assets are generated in `dist/plugin/`. The Git tag must exactly match the manifest version, without a `v` prefix. See the [release checklist](docs/community-release.md).

This repository also contains a standalone People web app and CLI: [project overview](docs/people-overview.md).

## License and support

[MIT](LICENSE). Report problems or request features in [GitHub Issues](https://github.com/kayacancode/obsidian-gmail-crm/issues). Please remove tokens, email addresses, private notes, and contact indexes from reports.
