# People — personal and shared relationship graphs

Explore who you know, understand the activity behind a connection, and find a path to someone new through a shared network.

People brings together **Gmail activity, Google Calendar invitations, and optional meeting or note context**. Start with a person or topic, inspect the evidence behind a connection, and request an introduction from a network member.

**You do not need Obsidian.** This repository contains both a standalone web app and an optional Obsidian plugin. The repository name reflects the project's origins as Gmail CRM for Obsidian.

> Active development. Features and data coverage vary by connected source. Relationship scores are estimates; invitations are not proof of attendance, and a graph path does not guarantee an introduction.

## Choose how to use it

| Path | Best for | What you need |
| --- | --- | --- |
| **Web app** | Personal graphs, shared networks, Discover, and introduction requests | A configured People deployment and a Google account |
| **Obsidian plugin** | Markdown people pages and a CRM inside your vault | Obsidian desktop and your own Google OAuth credentials |
| **PeopleGraph CLI** | Querying a local contact index from a terminal or coding agent | A plugin-generated contact index; Rust to build from source |

- [Web app setup and deployment](apps/people-graph/README.md)
- [Obsidian installation, commands, and scoring guide](docs/obsidian-plugin.md)
- [Privacy and data handling](PRIVACY.md)

## What you can do

- **Explore your network:** search people, inspect contact activity, and navigate the graph.
- **Share a network:** invite members and choose which contacts and context to contribute. Each contributor's relationship evidence stays distinguishable.
- **Walk from A to B:** follow recorded connections and inspect the evidence and uncertainty at each step.
- **Discover people by topic:** enter a goal or question and find new people with matching shared evidence. The current Discover goal matcher uses keywords, not guaranteed semantic understanding.
- **Ask for an introduction:** review and submit an in-app request to a contributor. Completed-introduction counts include only requests marked completed in that workspace.
- **See relationship activity:** sent/received email counts, last contact, shared calendar invitations, mutual accepted RSVPs, and upcoming invitations, where available.
- **Add optional context:** Granola and published Obsidian evidence can explain why a person or topic is relevant.

For example: enter **“agent memory”** in Discover. If a new person has matching shared evidence and a supported contributor connection, their card shows the evidence, source/date, a suggested conversation, an intro action, and a graph walk. If that evidence is missing, the app does not invent a reason to meet them.

## Start in the web app

On an existing, configured deployment:

1. Sign in with Google and open **Accounts**.
2. Select **Connect Google**. Review Google's requested permissions for Gmail, Calendar, and contact photos.
3. Let the first import finish. Start with 90 days of email history or select all history. Calendar imports cover the past year and next 30 days of your primary calendar.
4. Open your personal network. Optionally join or create a shared network under **Accounts → Shared networks**.
5. Choose which people to share and how much context to include. Other members make their own choices.

Obsidian and Granola are optional. Connecting Google does not require installing a browser extension or Gmail add-on.

**For self-hosting:** follow the [web deployment guide](apps/people-graph/README.md#setup-once). You need your own Cloudflare resources and Google web OAuth client. The checked-in deployment identifiers belong to the maintainer; replace them before deploying. Google OAuth testing/publication settings can limit who is allowed to connect.

## What each source contributes

| Source | Used for | Important distinction |
| --- | --- | --- |
| Gmail | Sent/received activity, reciprocity, contact dates, and thread metadata | Normal sync does not import bodies or attachments. Metadata alone cannot establish expertise. |
| Google Calendar | Shared invitations, mutual accepted RSVPs, and upcoming invitations | Accepted invitations do not prove attendance. Calendar counts do not increase shared email or meeting counts. |
| Granola, optional | Meeting attendees, topics, and permitted discussion context | A meeting topic linked to an attendee is not a statement attributed to them. |
| Obsidian, optional | Published people records, scores, links, and selected topic evidence | A person appearing in a vault does not establish a personal relationship. |
| In-app introductions | Request status and completed introduction counts | Requests are not counted as completed introductions, and ordinary emails are not guessed to be intros. |

## Sharing and privacy

The plugin and web app have different storage models:

- **Obsidian plugin:** the contact index and generated notes are stored in your vault. Optional graph uploads and AI enrichment send selected data to their configured services.
- **Web app:** connected-source data is stored on Cloudflare, scoped to the signed-in account. Google refresh grants and Granola API keys are encrypted on the server.
- **Shared networks:** members choose the people and context they contribute. Connection activity can be shared without sharing discussion text. Event titles are not included in the shared calendar activity summary.
- **Optional deeper email retrieval:** a separate confirmation permits bounded body processing—up to 50 matching messages and 1 MB of decoded text. Raw bodies are not retained after processing. The web app requests Gmail read access; normal sync still imports metadata only.
- **Actions:** introduction requests are sent inside People only when a user submits them. The app does not automatically email contacts or guarantee that a contributor will introduce you.

Read [PRIVACY.md](PRIVACY.md) before connecting real accounts. Do not commit credentials, tokens, contact indexes, vault notes, or production data when contributing.

## Current limitations

- Discover depends on context actually shared into the network. A large contact list or high relationship score alone is not enough for a relevant recommendation.
- Calendar currently enriches existing imported contacts; invite-only people are not automatically added to the graph.
- Shared calendar counts describe the imported window, not lifetime activity. Missing data is not evidence of no relationship.
- Personal vault and web imports have separate source views. Shared-network identity matching requires compatible published identities; older vault snapshots may need a fresh push.
- Gmail deletions are not automatically reconciled with previously imported metadata. Disconnecting an inbox removes its imported contributions.
- Browser fixture tests do not verify live Google OAuth approval, API access, or real-account sync.

## Develop locally

Use a recent Node.js release with `node:sqlite` support for the web tests (Node 22.13+). Cloud deployment also requires a Cloudflare account and Google OAuth configuration.

```bash
git clone https://github.com/kayacancode/obsidian-gmail-crm.git
cd obsidian-gmail-crm
npm ci
```

### Obsidian plugin

```bash
npm run test:intelligence
npx tsc --noEmit
npm run build
```

Install the built `main.js`, `manifest.json`, and `styles.css` into your vault as described in the [plugin guide](docs/obsidian-plugin.md). For a synthetic-data UI preview, run `npm run preview:intelligence`.

### Web app

```bash
cd apps/people-graph
npm ci
npm run typecheck
npm test
```

Follow the [web setup guide](apps/people-graph/README.md#setup-once) before running `npm run dev` or `npm run deploy`. Deployment builds the required static bundles through the `predeploy` script.

### CLI

```bash
# From the repository root; requires Rust/Cargo
npm run build:peoplegraph
./crates/peoplegraph/target/release/peoplegraph --help
```

The CLI queries a local plugin contact index. It does not require the shared web app.

## Repository map

| Directory | Purpose |
| --- | --- |
| `src/` | Obsidian plugin |
| `apps/people-graph/` | Main web app, API, Google/Granola integrations, shared networks |
| `shared/` | Shared scoring and data contracts |
| `crates/peoplegraph/` | Rust CLI |
| `tests/` | Plugin and intelligence tests |
| `apps/people-graph/tests/` | Web unit, integration, and browser tests |
| `docs/` | Guides and design documents; proposals are not a feature guarantee |
| `apps/people-graph-lab/`, `apps/reconnect-web/` | Related experiments and companion apps |

## Contributing

Open an issue with the problem, reproduction steps, and expected behavior. Use synthetic examples instead of private contact data. For a pull request, describe the behavior change and run the checks for the component you changed. Keep source permissions, contributor attribution, and the distinction between inferred and confirmed relationships intact.

## License

[MIT](LICENSE).
