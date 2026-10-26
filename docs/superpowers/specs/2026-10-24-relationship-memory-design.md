# Reusable relationship memory

The owner can record what someone is building, needs, offers, and is interested in, including offline conversations. These records should improve recommendations and the explanation of an introduction while remaining distinct from imported email/meeting evidence.

The user authorized the six-part Oct 23 meeting synthesis: capture real-world context; reflect relationship judgments; generate specific introduction reasons; respect timing and point people; link recommendations to the graph; and preserve private/shared boundaries. Implementation choices below are engineering defaults within that approved scope.

## Approach

Extend the existing Cloudflare/SQLite private context system rather than creating a second CRM. A separate owner-scoped People API/MCP adapter and explicit Rust `memory` commands make the same records usable by external agents. Local Rust cache APIs remain compatible. Browser dictation and bot-supplied voice transcripts use editable text; raw audio is not retained. Botwick installation/configuration outside this repository is a separate integration step.

Alternatives considered: notes only would not affect candidate matching; putting notes into imported graph signals would blur provenance and sharing permissions. Use a separate recommendation snapshot with explicit owner attribution instead.

## Records and behavior

- Retain the existing 1,000-character steering note and its revision contract.
- Add company (160), building/needs/offers (600 each), up to eight interests (80 each), pointPersonId, notBefore (YYYY-MM-DD), and relationship neutral/closer/weaker. Relationship is an explicit +/-10 adjustment; weaker does not hide a person. Existing suppression/snooze still applies separately.
- An extraction endpoint suggests structured fields from text. It cannot save, infer relationship strength, choose identities, set sharing, or execute source instructions. The owner can edit all suggested fields before saving.
- Agent capture appends idempotent source entries (2,000 chars each, text or voice_transcript) and resolves people by exact email. New contacts are explicit private manual entities, with no fabricated mail/meeting activity. Company is stored explicitly on the person; domains/names never merge people.
- Entry deletion and all profile updates use revision checks. Capture retries return the original result, conflicting reuse fails. Deletion does not resurrect on retry.
- Recommendation memory includes eligible own profiles and entries, exact provenance and preferences. Candidate and selected-person evidence use this same context; owner-lens searches reuse candidates without silently changing the owner's confirmed lens. Explicit user refinements override the saved selected-person brief.
- The latest private notes and policy snapshot are checked after model work. Edits, source withdrawal and feedback changes invalidate stale results.
- Suppressed or deferred people are excluded; relationship strength breaks ties without manufacturing relevance. Point-person guidance says to check with that person first and never sends automatically.
- Shared introductions receive specific audited reasons using shared evidence only. Private notes and preferences are never exported or inserted into shared graph signals. Existing explicit sharing controls continue to govern imported context.
- Helper cards expose the grounded introduction reason, a copy action, and graph exploration. All drafts remain unsent.

## Interface and privacy

`/api/people/memory` is the signed-in profile API. `/structure` is preview-only and `/entry` removes an entry. A separately scoped, revocable `people_` credential grants `people:read`/`people:write` to `/api/people-agent` and `/api/people-mcp`. Booking and graph-push credentials never imply People access. API identity comes from credentials, not request fields.

Manual identities enter only the owner's graph and recommendation flow, not shared exports or automatic booking recognition. Existing relationship feedback may affect established synced-contact scores as before; private context prose does not independently grant booking priority.

## Verification

Exercise persistence and legacy compatibility; owner isolation; exact identities; CAS and capture retries; source withdrawal; score adjustments; exclusion/routing; real SQLite/RPC reload; candidate note provenance and full audit; shared isolation; UI save/reload/conflict/focus/mobile; Rust CLI request shapes; credential expiry/revocation and REST/MCP parity. No test sends messages, books meetings, or writes invented notes to real contacts.
