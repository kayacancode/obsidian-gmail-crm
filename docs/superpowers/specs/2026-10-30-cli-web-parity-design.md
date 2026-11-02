# PeopleGraph CLI and web parity

The user authorized Botwick's concrete feedback: owner Lens writes, mutation parity, one clearly scoped credential, persisted configuration, truthful version reporting. An agent must be able to read and update the owner's saved Lens without manually visiting the editor, with the same service and concurrency checks as the web UI.

## Approach

Reuse the existing owner routes through an explicitly allowlisted machine adapter. A generic `peoplegraph api METHOD PATH --file payload.json` covers each supported owner operation; first-class Lens commands cover the primary daily workflow. Reimplementing every web service in Rust would duplicate policy and drift. Automatically trusting all browser routes would allow privilege escalation. The route registry instead declares the method, path, scope and any browser handoff requirements.

Persist one origin-bound People credential in `$XDG_CONFIG_HOME/peoplegraph/config.json` or `~/.config/peoplegraph/config.json`. Preserve environment configuration and legacy graph device profiles. Never mix a stored credential with a different destination override. `configure --token-stdin` avoids secret command arguments. A browser-approved scoped login can create the same machine credential without copying a key; existing device grants remain read-only.

## Contract

- `lens` retains confirmed-fields read compatibility. `lens set` accepts explicit fields or a JSON file plus revision, preserving omitted fields and rejecting stale revisions. Full Lens state/actions are exposed via the API registry and CLI Lens verbs.
- Both browser and machine Lens writes use `ownerLensRoute`/the same OwnerLensStore RPCs; no autonomous acceptance of inferred goals.
- Existing `people:read`/`people:write` grants cover personal People reads/edits. Additional explicit scopes isolate source settings, sharing/workspaces, booking/calendar actions and credential management. Existing keys gain no new scopes automatically. Credential administration cannot mint broader access than its caller.
- Authenticated `status` returns verified owner, credential metadata, capabilities and protocol version. CLI reports local configuration separately from live verification, and never exposes credentials. MCP Bearer authentication is the same People key, not a separate credential.
- The web graph query endpoint also accepts a People read credential. Browser device credentials remain compatible but do not silently gain edit permissions.
- Generic API accepts only registry paths/methods, bounded JSON input, and supported idempotency headers. Existing membership, ownership, revision, evidence and booking approval checks remain in effect.
- Browser-only session creation, device approval and provider OAuth callbacks are not machine mutation shortcuts. Source/calendar connection uses explicit browser handoff. Public visitor booking identity remains separate.
- All local version/describe reports describe the installed binary, regardless of legacy daemon environment settings.
- No live owner context, messages, sharing permissions or bookings are changed during verification. Test with isolated fixtures.

## Verification and delivery

Regression tests cover revision conflict, scope/owner isolation, key expiry/revocation, cross-origin config overrides, secret-free output, local version reporting, and each registry route class. Run Rust tests, Worker tests/typecheck and isolated end-to-end CLI tests. Publish a tested CLI release and deploy the backend only after review, retaining explicit release/deployment outcomes in the final report.
