# Private People context and intelligence for agents

The hosted People app lets an authorized agent read the owner's confirmed People Lens, find relevant people, explain recorded connections, and read or save private relationship context. A saved entry is tied to an exact email. An email that is not already known creates a private manual person; it does not establish prior contact, a strong relationship, or permission to share. Start with the [onboarding guide](https://github.com/kayacancode/obsidian-gmail-crm/blob/peoplegraph-v0.3.12/docs/people-agent-onboarding.md) for installation and conversation examples.

This interface is separate from browser-approved CLI graph login, the local contact-cache server, and the scheduling API. Existing `peoplegraph login` credentials remain read-only graph credentials and do not authorize these private endpoints. Botwick is an optional client with no automatic access.

## Connect a client

In **Accounts → Integrations**, create a named People credential with the permissions the client needs. Copy the key when it is shown; it cannot be retrieved later. Credentials expire after 90 days and can be revoked independently. `people:read` permits Lens, recommendations, people search, connection explanations, helper suggestions, and exact-email memory lookup. `people:write` permits adding context and explicitly updating the private relationship profile.

A write-only credential receives confirmation metadata from mutations: capture returns `{personId,entryId,duplicate,revision,updatedAt}` and save returns `{personId,revision,updatedAt}`. It cannot retrieve existing notes, profile fields, or entries through those responses. Credentials with both scopes receive the full responses documented below. This restriction applies equally to REST, MCP and CLI clients. A client that needs to read the profile before editing requires both scopes; a write-only client must receive the complete editable profile and revision through an owner-authorized workflow.

Configure the client with your deployment's origin in `PEOPLEGRAPH_WEB_URL` and the key in `PEOPLEGRAPH_WEB_TOKEN`. Keep keys in the client's secret environment, not messages, notes, source control, or command-line arguments. An HTTPS origin is required except for localhost development. The Rust client does not follow redirects with a credential.

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

`--url` can override the web origin. `--text` accepts a short note directly; `--text-file -` reads stdin. Text is limited to 2,000 characters per entry. The source ID must be stable and unique within the owner's account; prefix it with the client or source name. For a retry, send exactly the same source ID and content. Changed content under an existing source ID returns `capture_conflict`; a new observation needs a new ID. If an entry was removed, retrying its old ID does not restore it.

PeopleGraph 0.3.12 supports these commands and prints its ordinary `{ok,command,data}` JSON envelope. It fails explicitly if configuration is missing and never silently reads or writes a local cache. `PEOPLEGRAPH_HOST`, `PEOPLEGRAPH_TOKEN`, and `--remote` still refer only to the older local-cache query server; do not use them for these commands. The saved browser-login profile is also separate.

Lens reads return saved, confirmed fields; pending inferred suggestions are excluded. Matches use those saved fields and the website's ranking and explanation service. Empty goals or missing evidence can return no recommendations. Search results are candidates, not identity decisions. Resolve ambiguous names before passing exact IDs or recorded emails to connection tools. Connection results describe recorded types and evidence; co-occurrence does not prove a personal relationship, attendance, or an introduction. Helpers use the selected person's saved context and may refresh the existing private source cache. None of these reads edits the Lens or sends outreach.

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
- `save_relationship_memory` — explicitly update the complete private profile with revision checking.

The first six tools require `people:read`; capture and save require `people:write`. Every MCP request authenticates again, including after initialization. These tools never send messages, introductions, or calendar events. An agent should use separate outreach tools only when the owner asks. Scheduling remains a separate opt-in integration at `/api/scheduling/mcp` with its own credentials.

Browser-only token management lives at `/api/people/integrations`: authenticated GET lists credentials and endpoint URLs; POST `{name,scopes}` returns `{token,credential}` once; POST `/:id/revoke` with `{}` revokes only that owner's credential. People bearer keys do not authorize browser sessions or token creation.
