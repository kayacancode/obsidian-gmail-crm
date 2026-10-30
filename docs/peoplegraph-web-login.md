# One People account, in your browser and terminal

PeopleGraph 0.3.13 browser login creates one scoped People integration credential. The CLI saves it automatically and uses it for graph queries, your Lens, and private relationship context.

```sh
peoplegraph login
peoplegraph status
peoplegraph find-person "Ada"
peoplegraph lens
peoplegraph matches
```

Login opens the website and prints an approval code. Check the displayed People account and permissions before approving. `login` requests `people:read`; `login --write` also requests `people:write` so an agent can save edits you request. `--scope sources:manage`, `sharing:manage`, `booking:manage`, and `integrations:manage` request additional permission groups explicitly. Repeat `--scope` for multiple groups. `login --no-browser` prints the URL for you to open. `login --url https://your-people-origin` selects another deployment.

This authorizes the client, not a new Gmail inbox. Pending Lens suggestions do not become instructions automatically. Provider OAuth, source/calendar connection, and public booking visitor identity retain their own browser steps.

## Saved configuration and status

Both macOS and Linux use `$XDG_CONFIG_HOME/peoplegraph/config.json` when set, otherwise `~/.config/peoplegraph/config.json`. The directory is mode 700 and the file mode 600. Symlink files and insecure file permissions are refused. `login` and `configure` preserve other origins' saved keys and select the newly configured origin.

An existing integration key can be saved without environment exports:

```sh
peoplegraph configure --url https://your-people-origin --token-stdin < /path/to/private-key.txt
peoplegraph status
```

Provide the key through stdin from a private file or secret manager, never in a command argument or chat. The client binds every stored credential to its origin and refuses redirects. `--url` selects only a key saved for that exact origin. Environment credentials remain supported; an explicit URL differing from `PEOPLEGRAPH_WEB_URL` cannot reuse `PEOPLEGRAPH_WEB_TOKEN`.

`status` reports the installed CLI version, selected origin, configuration source, authenticated owner, credential scopes/expiry, and supported API operations. `status --offline` reports local metadata with authentication unverified. Neither command prints the key. `version`, `--version`, and `describe` always refer to the installed binary rather than a configured legacy daemon.

Credentials normally expire after 90 days and are independently revocable in **Accounts → Integrations**. `peoplegraph logout` revokes the selected saved credential and then removes that local profile. If the server cannot be reached, the profile remains for retry. Logging in again does not revoke older keys automatically.

## Query and edit behavior

Read commands use the same visible graph and source-selection rules as the website. Queries return source, backend, and available freshness metadata. Ambiguous names remain candidates; resolve an exact person before editing. Web scores retain their own meaning, and unknown values remain null.

```sh
peoplegraph lens set --needs "Clinical workflow design partners"
peoplegraph lens inspect
peoplegraph api GET /api/lens
```

Lens partial edits preserve omitted fields and use the current revision; stale edits fail instead of overwriting newer data. `status` exposes the generic API capability list and required scopes. Registered API operations retain the corresponding web route's authorization and validation. A `people:write` key alone does not grant sharing, source administration, or booking permissions.

## Local Obsidian mode

```sh
peoplegraph --local find-person "Ada"
peoplegraph --local --cache /path/to/contact-index.json find-person "Ada"
```

Merge, import, deduplication, feedback, and strict-name-order cache operations remain local and require `--local` when hosted access is configured. Hosted errors never silently select the local cache.

## Older clients and credentials

Existing device credentials stay read-only graph credentials. Their legacy profiles remain at `~/Library/Application Support/peoplegraph/web-profile.json` on macOS and `$XDG_CONFIG_HOME/peoplegraph/web-profile.json` or `~/.config/peoplegraph/web-profile.json` on Linux. They do not silently gain private Lens/memory or edit permissions. Run the new `login` flow to approve the scoped access needed.

`serve`, `--remote`, `--host`, `PEOPLEGRAPH_HOST`, and `PEOPLEGRAPH_TOKEN` remain available for older cache-server integrations. Explicit legacy backend selection and its separate token never receive a saved People key. `--local` ignores those legacy environment settings. During login, `--host` remains a compatibility alias for the People deployment; prefer `--url`.

## Development verification

Use isolated local D1 and temporary HOME/XDG directories for CLI tests. Apply the schema and CLI migrations before starting the Worker. `npm run test:cli-integration` exercises a local Worker; `cargo test --locked --manifest-path crates/peoplegraph/Cargo.toml` covers config permissions, scoped login, no credential forwarding, Lens conflicts, and API routing with local fixtures. Do not use live owner data for mutation verification.
