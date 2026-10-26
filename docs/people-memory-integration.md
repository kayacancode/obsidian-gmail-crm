# Private People context for agents

The hosted People app accepts private text notes and voice transcripts from an authorized agent. A saved entry is tied to an exact email and appears in that owner's relationship memory. An email that is not already known creates a private manual person; it does not establish prior contact, a strong relationship, or permission to share.

This interface is separate from the Rust CLI's local contact-cache server and from the scheduling API. Botwick is an optional personal client, with no automatic access.

## Connect a client

In **Accounts → Integrations**, create a named People credential with the permissions the client needs. Copy the key when it is shown; it cannot be retrieved later. Credentials expire after 90 days and can be revoked independently. `people:read` permits exact-email lookup. `people:write` permits adding context and explicitly updating the private relationship profile.

A write-only credential receives confirmation metadata from mutations: capture returns `{personId,entryId,duplicate,revision,updatedAt}` and save returns `{personId,revision,updatedAt}`. It cannot retrieve existing notes, profile fields, or entries through those responses. Credentials with both scopes receive the full responses documented below. This restriction applies equally to REST, MCP and CLI clients. A client that needs to read the profile before editing requires both scopes; a write-only client must receive the complete editable profile and revision through an owner-authorized workflow.

Configure the client with your deployment's origin in `PEOPLEGRAPH_WEB_URL` and the key in `PEOPLEGRAPH_WEB_TOKEN`. Keep keys in the client's secret environment, not messages, notes, source control, or command-line arguments. An HTTPS origin is required except for localhost development. The Rust client does not follow redirects with a credential.

```bash
peoplegraph memory lookup --email person@example.com

peoplegraph memory capture \
  --email person@example.com \
  --name "Example Person" \
  --source-id "personal-agent:message-123" \
  --source-kind voice-transcript \
  --text-file ./meeting-context.txt
```

`--url` can override the web origin. `--text` accepts a short note directly; `--text-file -` reads stdin. Text is limited to 2,000 characters per entry. The source ID must be stable and unique within the owner's account; prefix it with the client or source name. For a retry, send exactly the same source ID and content. Changed content under an existing source ID returns `capture_conflict`; a new observation needs a new ID. If an entry was removed, retrying its old ID does not restore it.

The CLI prints its ordinary `{ok,command,data}` JSON envelope. It fails explicitly if configuration is missing and never silently writes a local cache. `PEOPLEGRAPH_HOST`, `PEOPLEGRAPH_TOKEN`, and `--remote` still refer only to the older local-cache query server; do not use them for these commands.

## REST contract

Send `Authorization: Bearer <People credential>` and JSON content types. The owner is derived from the credential; request payloads cannot select an owner or workspace. Responses use `Cache-Control: no-store`.

- `GET /api/people-agent/lookup?email=person%40example.com` → `{memory: RelationshipMemory | null}`. This is exact-email lookup, not fuzzy name matching.
- `POST /api/people-agent/capture` → `{personId,entryId,duplicate,memory}`.
- `POST /api/people-agent/save` → the updated relationship memory; requires the current `revision`.

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

For an explicit profile edit, read the current memory, remove the read-only `entries` and `updatedAt` fields, and send all writable fields to `/save`. With the Rust CLI, put that edited object in a UTF-8 JSON file and run:

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

Connect a Streamable HTTP MCP client to `<origin>/api/people-mcp` with the same bearer header. Available tools are filtered by token scopes:

- `lookup_relationship_memory` — exact-email read.
- `capture_relationship_context` — append a text note or voice transcript.
- `save_relationship_memory` — explicitly update the complete private profile with revision checking.

Every MCP request authenticates again, including after initialization. These tools never send messages or create calendar events. Scheduling remains at `/api/scheduling/mcp` with separate credentials.

Browser-only token management lives at `/api/people/integrations`: authenticated GET lists credentials and endpoint URLs; POST `{name,scopes}` returns `{token,credential}` once; POST `/:id/revoke` with `{}` revokes only that owner's credential. People bearer keys do not authorize browser sessions or token creation.
