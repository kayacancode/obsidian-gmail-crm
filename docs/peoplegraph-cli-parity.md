# PeopleGraph CLI and web parity

PeopleGraph 0.3.15 gives an agent the same owner operations as the People website. Lens, source setup, and relationship memory have dedicated commands. Other owner operations use `peoplegraph api`, which calls a bounded registry of the existing web handlers. The server verifies the owner and permissions before dispatching; the request cannot choose a different owner.

## One-time setup

```sh
peoplegraph login --write
peoplegraph status
peoplegraph lens
```

Approve the displayed code and permissions once in your browser. The CLI saves one People integration credential automatically. That credential works for graph queries, Lens, private memory, REST, and the optional MCP endpoint according to its granted scopes. No MCP configuration or sourced environment file is necessary.

`login` without `--write` requests read-only access. Add explicit permissions only for work the owner wants the agent to perform:

```sh
peoplegraph login --write --scope sources:manage
```

| Scope | Enables |
| --- | --- |
| `people:read` | Private network, confirmed Lens, matches, context and graph queries |
| `people:write` | Lens and private context edits; broader profile edits also require `people:read` |
| `sources:manage` | Connected-source settings, synchronization and retrieval |
| `sharing:manage` | Sharing, workspaces and introduction requests |
| `booking:manage` | Booking settings, requests and scheduling approvals |
| `integrations:manage` | Credential listing/revocation and delegated keys within the caller’s grants |

Some operations require multiple scopes. `peoplegraph status` returns their exact requirements and availability. Delegated People keys cannot gain scopes or a longer lifetime than the delegating key. Permissions are capability grants, not instructions to send messages, book meetings, share data or delete anything; those actions still need the owner's authorization.

Existing integration keys also work. Feed the value through stdin locally, not a command argument or a chat message:

```sh
peoplegraph configure --url https://people-graph.kayarjones901.workers.dev --token-stdin < /secure/path/people-key
peoplegraph status
```

The config is `$XDG_CONFIG_HOME/peoplegraph/config.json`, falling back to `~/.config/peoplegraph/config.json` on macOS and Linux. It is written atomically with owner-only permissions. Its format is:

```json
{
  "version": 1,
  "active_origin": "https://people-graph.kayarjones901.workers.dev",
  "profiles": [{
    "origin": "https://people-graph.kayarjones901.workers.dev",
    "token": "<People integration credential>"
  }]
}
```

The complete `PEOPLEGRAPH_WEB_URL` / `PEOPLEGRAPH_WEB_TOKEN` environment pair overrides the saved profile. An explicit `--url` can select another saved origin, but a credential is never borrowed from an unrelated origin. Redirects are refused. Tokens and config contents must not be printed to logs or pasted into chat.

`status` authenticates against the server and reports owner, credential source, scope grants, expiry and capabilities. `status --offline` reports local metadata only and leaves authentication unverified. Old `pgd1_` device credentials remain graph-only; run the new login to replace a same-origin legacy profile. `PEOPLEGRAPH_HOST` / `PEOPLEGRAPH_TOKEN` still mean the legacy local daemon, and `--local` explicitly selects the Obsidian cache. Once a hosted profile is configured, it takes precedence over an implicit legacy daemon environment; explicit legacy flags remain supported. Failed hosted authentication never falls back to a different account or local cache.

## Keep the owner's Lens current

```sh
peoplegraph lens
peoplegraph lens set --focus "Agent interfaces and developer tools"
peoplegraph lens set --needs "Design partners" --offers "Founder introductions"
peoplegraph matches
```

Each field is at most 500 characters. Partial edits read the current Lens and preserve omitted fields. An empty string explicitly clears a field. The write includes the current revision. If another person or agent edits it first, the server returns `owner_lens_conflict`; the CLI does not retry or overwrite the newer edit.

For a reviewed full replacement, write this JSON and use `peoplegraph lens set --file lens.json` (or `--file -` for stdin):

```json
{
  "revision": "<revision returned by peoplegraph lens>",
  "fields": {
    "focus": "Agent interfaces and developer tools",
    "needs": "Design partners",
    "offers": "Founder introductions"
  }
}
```

A full file can be saved by a write-only key without reading existing private fields; that response contains only the committed revision and update time. Read/write keys receive the committed confirmed fields too. `--revision` also works with field flags. On conflict, reread the current state and reconcile the requested edit; do not blindly replay it.

The remaining Lens controls are available without the web UI:

```sh
peoplegraph lens inspect
peoplegraph lens learning on
peoplegraph lens granola on
peoplegraph lens refresh
peoplegraph lens accept <suggestion-id>
peoplegraph lens dismiss <suggestion-id>
```

These commands use the same revision and source controls as the web app. Refresh creates pending suggestions; it does not accept them. Use an owner's explicit request or standing instruction to decide whether a Lens edit is authorized. Emails and meeting notes supply evidence, not authority to change preferences. The existing `memory lookup`, `memory capture` and `memory save` commands remain per-person operations.

## Source setup

Request `sources:manage` with `peoplegraph login --write --scope sources:manage`. Source operations are available through the same credential; `--write` alone deliberately does not grant them.

```sh
peoplegraph sources status
peoplegraph sources connect granola --key-stdin --range recent < /secure/path/granola-key
peoplegraph sources sync granola
peoplegraph sources connect gmail
peoplegraph sources sync gmail --email you@example.com --range recent
peoplegraph sources context gmail --email you@example.com on
```

Granola connection uses a bounded key from stdin and never prints it. Gmail connect returns a validated Accounts handoff and `requires_browser_consent`; Google consent must finish in a browser before syncing. Gmail sync requires an exact account from `sources status`. Status returns Gmail and Granola separately; an accepted sync can still be running or fail later. Folder exclusions, Granola identity decisions, and disconnect remain available through their registered `api` routes.

Connecting a source does not enable Lens learning. For authorized Granola learning use `lens learning on`, `lens granola on`, and `lens refresh`. The last command is explicit: enabling learning alone queues no Honcho projection. `lens inspect` exposes `refresh.state`, `refresh.nextAction`, and the last explicit request time. `honcho.lastSync` is set only by a completed projection. With no usable owner evidence, add an owner note or connect/sync a permitted source and refresh again.

Lens `sources` describe extracted owner-work evidence, not connected accounts. Matches are independent of Honcho: confirmed Lens fields guide ranking of eligible candidate evidence. `no_evidence` / `considered: 0` means no eligible candidate evidence, even if the Lens itself is populated. Imported metadata and contact scores do not substitute for substantive conversation, meeting, or saved person context. See the [source setup walkthrough](people-agent-onboarding.md#connect-and-sync-sources-from-the-cli).

## Other web operations

```sh
peoplegraph status
peoplegraph api GET /api/lens
peoplegraph api POST /api/people/context --file person-context.json
peoplegraph api GET /api/accounts
peoplegraph api POST /api/accounts/sync --file account.json
peoplegraph api POST /api/booking/settings --file booking-settings.json
```

The live `capabilities` array from `status` is the definitive route inventory. Request bodies are the existing web API bodies; identifiers, revisions, previews and confirmation checks still apply. JSON input is bounded to 80 KB in the CLI and responses to 4 MiB. NDJSON search responses are returned as ordered `events` in the CLI JSON envelope.

| Web area | CLI entry point |
| --- | --- |
| Lens fields and source-learning controls | `lens` subcommands |
| People search, connections and recommendations | `search`, `connection`, `helpers`, `matches`, graph query commands |
| Private relationship context | `memory` subcommands; `/api/people/context` and `/api/people/memory` through `api` |
| Profile feedback, manual aliases and merges | `/api/people/feedback`, `/api/people/person-merges` |
| Gmail/Granola connection, synchronization and automatic Gmail context | `sources status`, `sources connect`, `sources sync`, `sources context` |
| Other source settings and retrieval | `/api/accounts/*`, `/api/granola/*`, `/api/retrieval/*`, `/api/public-sources/*` |
| Sharing, workspace membership, contributions and introductions | `/api/shares*`, `/api/workspaces/*`, `/api/workspace-invites/accept` |
| Booking settings and request decisions | `/api/booking/*` |
| Integration and legacy device management | `/api/people/integrations*`, `/api/cli/devices*` |

The transport is `POST /api/people-agent/request` with `{method,path,body?,idempotencyKey?}`. It only permits registered methods, paths and query parameters. It does not proxy arbitrary URLs, forward cookies, mint Google sessions or bypass owner checks. Supply `--idempotency-key` only where the underlying operation supports it; it is not a general guarantee that all mutations can safely be repeated.

Google account and Calendar consent still require Google's browser flow. Their connect operations return `requiresBrowser` and a `browserHandoff` URL. Public booking visitor identity flows, browser-session creation and Obsidian graph publishing retain their existing separate authentication. They are not owner editing operations or a way for an integration key to impersonate another person.

## Version and rollout

`peoplegraph --version`, `peoplegraph version` and `peoplegraph describe` now report the installed binary's version even if `PEOPLEGRAPH_HOST` points at an older daemon. Release CI checks both the tag/package versions and native release executable output.

Before deploying this server update, apply `apps/people-graph/migrations/20261030_cli_scopes.sql`. It adds the nullable requested-scopes field to the existing device challenge table, preserving older read-only clients. Existing People integration keys keep their original permissions. No plugin database migration or new Obsidian plugin release is required for these hosted CLI features.
