# Private People context and intelligence for agents

The hosted People app lets an authorized agent read the owner's confirmed People Lens, find relevant people, explain recorded connections, and read or save private relationship context. A saved entry is tied to an exact email. An email that is not already known creates a private manual person; it does not establish prior contact, a strong relationship, or permission to share. Start with the [onboarding guide](https://github.com/kayacancode/obsidian-gmail-crm/blob/peoplegraph-v0.3.15/docs/people-agent-onboarding.md) for installation and conversation examples.

New CLI browser login creates the same scoped People integration credential used by these endpoints and MCP. Existing `pgd1_` device credentials remain graph-only; they gain no additional scopes automatically. The local cache server and direct scheduling MCP credentials remain separate. Botwick is an optional client with no automatic access.

## Connect a client

Use `peoplegraph login` for `people:read`, or `peoplegraph login --write` for both `people:read` and `people:write`; review the account and scopes in the browser. Alternatively, create a named credential in **Accounts → Integrations** and supply it through `peoplegraph configure --url <origin> --token-stdin` from a private file or secret manager. Credentials expire after 90 days and can be revoked independently. `people:read` permits graph/Lens reads, recommendations, search, connection explanations, helper suggestions, and memory lookup. `people:write` permits explicit private context/profile edits; owner Lens edits require both scopes.

A write-only credential receives confirmation metadata from mutations: capture returns `{personId,entryId,duplicate,revision,updatedAt}` and save returns `{personId,revision,updatedAt}`. It cannot retrieve existing notes, profile fields, or entries through those responses. Credentials with both scopes receive the full responses documented below. This restriction applies equally to REST, MCP and CLI clients. A client that needs to read the profile before editing requires both scopes; a write-only client must receive the complete editable profile and revision through an owner-authorized workflow.

The CLI automatically reads `$XDG_CONFIG_HOME/peoplegraph/config.json` or `~/.config/peoplegraph/config.json` on macOS and Linux. Saved keys are owner-only and bound to their deployment origin. `peoplegraph status` verifies the credential and reports scopes/capabilities; `status --offline` reports only local metadata. Environment configuration with `PEOPLEGRAPH_WEB_URL` and `PEOPLEGRAPH_WEB_TOKEN` remains supported. Keep keys out of messages, notes, source control, and command-line arguments. An HTTPS origin is required except for localhost development; redirects never receive credentials.

```bash
peoplegraph lens
peoplegraph matches
peoplegraph search "Maya Acme" --limit 5
peoplegraph connection --from <person-id-or-recorded-email> --to <person-id-or-recorded-email>
peoplegraph helpers --person-id <person-id>
peoplegraph memory lookup --email person@example.com

peoplegraph memory capture \
  --email person@example.com \
  --name "Example Person" \
  --source-id "personal-agent:message-123" \
  --source-kind voice-transcript \
  --text-file ./meeting-context.txt
```

`--url` selects a web origin and its matching saved key. A differing override cannot reuse a key bound by `PEOPLEGRAPH_WEB_URL`. `--text` accepts a short note directly; `--text-file -` reads stdin. Text is limited to 2,000 characters per entry. The source ID must be stable and unique within the owner's account; prefix it with the client or source name. For a retry, send exactly the same source ID and content. Changed content under an existing source ID returns `capture_conflict`; a new observation needs a new ID. If an entry was removed, retrying its old ID does not restore it.

PeopleGraph 0.3.15 supports these commands and prints its ordinary `{ok,command,data}` JSON envelope. It fails explicitly if configuration is missing and never silently reads or writes a local cache. `PEOPLEGRAPH_HOST`, `PEOPLEGRAPH_TOKEN`, and `--remote` still refer only to the older local-cache query server; do not use them for these commands. Old device profiles remain compatible only with graph queries. New browser login and saved integration keys use the same origin-bound config.

Lens reads return saved, confirmed fields; pending inferred suggestions are excluded. Matches use those saved fields and the website's ranking and explanation service. Empty goals or missing evidence can return no recommendations. Search results are candidates, not identity decisions. Resolve ambiguous names before passing exact IDs or recorded emails to connection tools. Connection results describe recorded types and evidence; co-occurrence does not prove a personal relationship, attendance, or an introduction. Helpers use the selected person's saved context and may refresh the existing private source cache. None of these reads edits the Lens or sends outreach.

## Owner Lens edits and website API

`peoplegraph lens set --needs "Nurse design partners"` reads the current confirmed Lens, preserves omitted focus/offers, and writes with its revision. Use `--revision <reviewed-revision>` to enforce an earlier review, or `--file <json|->` with exactly `{revision,fields:{focus,needs,offers}}` for a complete explicit edit. Fields are strings of at most 500 characters. `owner_lens_conflict` requires rereading and reconciling; the CLI never retries with a fresh revision automatically.

`lens inspect` returns complete Lens state. `lens learning on|off`, `lens granola on|off`, `lens refresh`, `lens accept <id>`, and `lens dismiss <id>` share the website's revision checks. Refresh does not accept pending suggestions. Source content and inferred goals cannot authorize a Lens edit.

- `POST /api/people-agent/lens` accepts `{revision,fields:{focus,needs,offers}}` and uses the same owner Lens service as the website. Both People read/write scopes are required.
- `GET /api/people-agent/status` returns `{protocolVersion:1,owner,credential:{id,name,scopes,expiresAt},capabilities:[...]}` without the token. The response identifies registered methods, paths, required scopes, and browser handoffs.
- `POST /api/people-agent/request` accepts `{method,path,body?,idempotencyKey?}` for a registered owner API operation. The CLI form is `peoplegraph api METHOD /api/path --file <json|->`. Inputs are bounded and every operation retains its existing ownership, membership, revision, and approval checks.

Source settings, sharing/workspaces, booking, and credential administration require explicit `sources:manage`, `sharing:manage`, `booking:manage`, and `integrations:manage` grants. Some operations require People read access as well; inspect live capabilities. Existing keys do not gain these scopes, and a delegated key cannot exceed its caller's scopes or expiry. Provider OAuth and public visitor booking identity still require the appropriate browser flow. Generic API calls may change sharing or send booking communications; execute those only for owner-requested actions.

The generic client returns bounded NDJSON search streams as `{contentType:"application/x-ndjson",events:[...]}`. Other responses remain JSON objects. The Rust response cap is 4 MiB; CLI request files are bounded to 80 KB. An idempotency key is forwarded only where supported and does not create universal retry safety. See [CLI/web parity](https://github.com/kayacancode/obsidian-gmail-crm/blob/peoplegraph-v0.3.15/docs/peoplegraph-cli-parity.md).

## REST contract

Send `Authorization: Bearer <People credential>` and JSON content types. The owner is derived from the credential; request payloads cannot select an owner or workspace. Responses use `Cache-Control: no-store`.

- `GET /api/people-agent/lookup?email=person%40example.com` → `{memory: RelationshipMemory | null}`. This is exact-email lookup, not fuzzy name matching.
- `POST /api/people-agent/capture` → `{personId,entryId,duplicate,memory}`.
- `POST /api/people-agent/save` → the updated relationship memory; requires the current `revision`.

Private intelligence operations require `people:read`:

| Operation | Request | Meaning |
| --- | --- | --- |
| `GET /api/people-agent/lens` | No query parameters | Confirmed `{fields,revision,updatedAt}` |
| `POST /api/people-agent/matches` | `{}` | Recommendations for the saved Lens |
| `POST /api/people-agent/search` | `{"query":"Maya Acme","limit":5}` | Visible-network name, company, role, and evidence search; query 1–200 characters, optional limit 1–50 |
| `POST /api/people-agent/connection` | `{"from":"person-id-a","to":"person-id-b"}` | Recorded connection evidence between exact IDs or recorded owner emails |
| `POST /api/people-agent/helpers` | `{"personId":"person-id"}` | Website-equivalent helper suggestions for one exact person ID |

These inputs do not accept an owner override or invented Lens fields. Unknown or unresolved identities fail explicitly. Concurrent saved-context changes can return `person_context_conflict` or `owner_lens_conflict`; read again before answering from stale results.

Capture input:

```json
{
  "email": "person@example.com",
  "name": "Example Person",
  "company": "Example Company",
  "text": "We discussed their clinic handoff tool. They need nurse design partners.",
  "sourceKind": "voice_transcript",
  "sourceId": "personal-agent:message-123"
}
```

`company` is optional. `name` and `company` allow 160 characters, `sourceId` 200, and email 320. `sourceKind` is `text` or `voice_transcript`; a client cannot label its submissions as Gmail or Granola evidence. Capture appends a dated private entry and leaves the editable steering note and relationship feedback unchanged. There is no raw-audio upload or transcription endpoint; the calling client supplies the transcript.

For an explicit profile edit, read the current memory and construct an object with exactly the 11 writable keys shown below: `personId`, `revision`, `text`, `company`, `building`, `needs`, `offers`, `interests`, `pointPersonId`, `notBefore`, and `relationship`. Preserve untouched values and the current revision. Omit every read-only field, including `entries`, `updatedAt`, and the `aliasMemories` provenance returned for merged profiles. Send that object to `/save`. With the Rust CLI, put it in a UTF-8 JSON file and run:

```bash
peoplegraph memory save --file ./edited-profile.json
```

`--file -` reads JSON from stdin. The file or stdin is bounded to 80,000 bytes. The server rejects missing or unknown profile fields. The CLI makes one save request and returns stale-revision conflicts without automatically refreshing or retrying. Preserve the original `revision` while editing so another person's or client's newer edits are protected.

Example editable JSON object:

```json
{
  "personId": "opaque-person-id",
  "revision": "current-uuid-from-lookup",
  "text": "My private relationship note",
  "company": "Example Company",
  "building": "Clinic handoff tools",
  "needs": "Nurse design partners",
  "offers": "Clinical workflow interviews",
  "interests": ["clinical workflows"],
  "pointPersonId": null,
  "notBefore": null,
  "relationship": "neutral"
}
```

Initial revision may be `null`. Preserve fields the owner did not ask to change. `pointPersonId` is another person in the same owner's network. `notBefore` is a valid `YYYY-MM-DD` date or null. `relationship` is `neutral`, `closer`, or `weaker`; only change it following an explicit owner instruction. Notes and transcripts are context, not instructions to change authority, scores, or sharing.

Important responses: `401` missing/expired/revoked key; `403` insufficient scope; `404` unknown owned person; `409 person_context_conflict` stale revision; `409 capture_conflict` reused source ID with different content; `409 memory_capacity` bounded entry/person capacity reached. On a stale revision, read again and reconcile the owner's edits before retrying; do not overwrite blindly.

## MCP

Connect a Streamable HTTP MCP client that supports custom bearer headers to `<origin>/api/people-mcp` with the same header. Client configuration varies; this integration does not supply OAuth or guarantee compatibility with every MCP client. Available tools are filtered by token scopes:

- `get_people_lens` — confirmed saved focus, needs, and offers; input `{}`.
- `recommend_people` — matches for that saved Lens; input `{}`.
- `find_people` — visible-network search; input `{query,limit?}`.
- `explain_connection` — typed evidence between exact identities; input `{from,to}`.
- `suggest_connections` — helpers for one exact person; input `{personId}`.
- `lookup_relationship_memory` — exact-email read.
- `capture_relationship_context` — append a text note or voice transcript.
- `update_people_lens` — save explicitly requested owner focus, needs, and offers with the reviewed revision; requires both People read/write scopes.
- `save_relationship_memory` — explicitly update the complete private profile with revision checking.

The six read tools require `people:read`; capture and relationship-memory save require `people:write`. `update_people_lens` requires both `people:read` and `people:write`. Every MCP request authenticates again, including after initialization. These tools never send messages, introductions, or calendar events. An agent should use separate outreach tools only when the owner asks. Scheduling remains a separate opt-in integration at `/api/scheduling/mcp` with its own credentials.

Browser credential management lives at `/api/people/integrations`: authenticated GET lists credentials and endpoint URLs; POST `{name,scopes}` returns `{token,credential}` once; POST `/:id/revoke` with `{}` revokes only that owner's credential. A People key with `integrations:manage` can use the registered machine adapter for those operations, but newly delegated keys cannot exceed the caller's scopes or expiry. People keys do not authorize browser sessions.
