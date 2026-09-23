# One People network: website and CLI

Status: proposed for user review; web integration is not implemented.

## Outcome

Keep one People website and one CLI as two interfaces to the same network. The user's immediate CLI upgrade is complete: the installed executable is 0.3.10 and the previous Homebrew binary is retained. Do not add another graph, Gmail sync engine, or per-inbox credentials.

## Proposed experience

- `peoplegraph login --host https://people-graph.kayarjones901.workers.dev` opens a browser approval page. Sign in to the existing People account once. This authorizes CLI access to that account's network; it does not reauthorize or reconnect Gmail inboxes.
- The CLI reports which owner and source it is using. A successful login explicitly selects web mode; `--local` selects the existing Obsidian cache. Web failures never silently fall back to local data.
- Existing read commands cover person search, contact cards, company/domain lookup, scores, neighbors, edges, and reconnect candidates. Email or opaque person IDs resolve server-side only within the caller's visible network. Ambiguous name matches return candidates.
- Web output retains the existing JSON envelope (`ok`, `command`, `data`, `stats`, `error`), with a documented, versioned web data contract. Source, score model, missing values, and data freshness remain explicit. Do not pretend web relationship strength is identical to every local-cache score field.
- Merge, deduplication, import, and feedback writes remain local-only. In web mode these return a clear unsupported-operation error.
- `peoplegraph logout` revokes the device credential and removes the local profile. Accounts lists connected CLI devices and offers revocation.

## Shared data and behavior

Extract the website's current graph-loading logic into a shared service used by the existing web endpoint and CLI endpoints. Preserve email/Obsidian fallback behavior, Granola augmentation, sharing refresh, evidence provenance, tenant boundaries, and current snapshot limits. CLI queries do not bypass graph limits or expose source records hidden from the website.

Reuse existing deterministic ranking and filtering where equivalent. Semantic/evidence search uses the existing search service and its sharing restrictions. Add missing projections over the shared graph rather than copying the SQL ingestion pipeline. Email resolution uses owner-scoped internal identities; shared people without a disclosed email remain addressable by opaque ID only. Reconnect ranking must be explicit about available dates and scores.

Keep existing CLI HTTP-server mode, `--host` behavior, and local commands backward compatible. Use an explicit persisted backend type so an existing PeopleGraph query server is not mistaken for the hosted app. Never send stored credentials to an arbitrary host override.

## Authentication

Use a device-authorization exchange with a short-lived, one-use challenge, polling secret, and human approval code. The browser shows the requested device name, owner, and read-only scope before approval. Expire pending challenges after ten minutes, bound polling, and rate-limit issuance. Browser approval requires the existing signed-in session plus same-origin protection. No credential is placed in URLs.

On approval, issue an opaque, 256-bit device credential scoped to read-only People queries. Store its hash, owner, expiry, and revocation state server-side; expire it after 30 days. It cannot push graphs, manage inboxes, create shares, or call draft-generation/write endpoints. Revocation takes effect on the next query. Tokens are redacted from logs and errors.

Store the local profile with owner-only permissions in the OS configuration directory; do not modify shell startup files or place tokens in shell arguments/history. Permit localhost HTTP only for development; production connections use HTTPS. Bind each credential to its configured origin.

## Validation and rollout

1. Baseline the existing Rust CLI and web tests.
2. Test login expiry, single use, polling limits, approval ownership, revocation, invalid credentials, origin checks, and endpoint scope isolation.
3. Compare website and CLI results against the same fixtures: multiple inboxes, overlapping identities, Obsidian fallback, missing scores, shared evidence, and revoked shares.
4. Verify local CLI regressions and backend selection; exercise browser approval with a local worker and the real compiled CLI.
5. Deploy additive endpoints and the device-management UI, then publish/install a new CLI version with browser login. Perform a real user-approved login and compare one network query before calling integration complete.

## Outside this change

No merge of local and web identity stores, new geography/world visualization, changes to relationship scoring, global public people lookup, or automatic migration of local feedback and merge decisions.
