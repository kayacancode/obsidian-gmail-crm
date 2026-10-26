# One People network, in your browser and terminal

The normal remote backend is the People website. You do not need to run a query server, copy API tokens, or reconnect Gmail for the CLI.

```sh
peoplegraph login
peoplegraph find-person "Ada"
peoplegraph who-knows --company "acme.com"
peoplegraph contact-card "Ada"
peoplegraph get-neighbors <person-id>
peoplegraph reconnect
peoplegraph logout
```

Login opens the website and prints a short approval code. Enter the code, check the displayed People account, and approve read-only access. Use `login --no-browser` to open the printed link yourself. This authorizes the CLI; it does not connect a Gmail inbox. Credentials expire after 30 days. Accounts → Connected CLI devices lets you revoke access sooner.

After login, supported read commands query the same visible graph as the website, including its source selection, sharing permissions, and current snapshot limits. They do not load every historical source record. Overlapping inbox contacts are handled by the existing website identity logic. Queries return a versioned JSON envelope with owner, backend, source, score model, and available freshness metadata. Web scores retain their own meaning; absent scores stay null. Names matching several people return candidate IDs. Email lookup works only for contacts recorded in your own web network; shared-only and Obsidian people should be queried by name or opaque ID.

Reconnect ranks people with known contact dates and scores by oldest contact first, then combined score. This differs from local reconnect's feedback-aware ranking. Web `find-person` searches recorded names, companies, and roles, then uses the website's evidence search when there is no direct match.

## Local Obsidian mode

```sh
peoplegraph --local find-person "Ada"
peoplegraph --local --cache /path/to/contact-index.json find-person "Ada"
```

Merge, import, deduplication, feedback, and strict-name-order operations stay local. With a saved web login they require `--local`. Web errors never silently select your local cache.

## Credentials and recovery

The macOS profile is `~/Library/Application Support/peoplegraph/web-profile.json`; Linux uses `$XDG_CONFIG_HOME/peoplegraph/web-profile.json` or `~/.config/peoplegraph/web-profile.json`. Files are owner-only. These are the currently released CLI platforms; Windows web credential storage fails closed until a supported secure store is available.

If logout cannot reach the server, the local profile is retained so you can retry. Revocation through Accounts also works without this computer. Run login again after expiry or revocation. Login can replace an existing local profile; prior devices remain independently revocable in Accounts.

## Legacy compatibility

Existing `serve`, `--remote`, `--host`, and `PEOPLEGRAPH_HOST` interfaces remain available for older integrations, but are not part of normal setup. An explicit legacy host or remote setting takes precedence over the saved web profile and uses only its separately supplied legacy token. A saved People credential is never sent to a host override. `--local` ignores legacy environment settings. During login, `--host` selects a different People deployment rather than a legacy server.

## Development verification

From `apps/people-graph`, apply `schema.sql` to an isolated local D1 database and start Wrangler on port 8789 with `TOKEN_SECRET=local-cli-test-secret` and a local `MAIL_TOKEN_KEY`. Build the Rust debug CLI and run `npm run test:cli-integration`. The integration creates only local fixture accounts and uses an isolated temporary HOME. Browser tests use `npm run test:cli-browser` with a static server on port 4183 and Playwright available.

Deploy `migrations/20260922_cli_devices.sql` before the Worker update. Existing graph and account tables are unchanged.
