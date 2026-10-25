# Private relationship memory

In **My Network**, select a person and open **Your context**. Record what you know, use **Organize this note** to propose editable details, then save. The structured fields cover company, what they are building, what they need, what they can help with, and work interests. Dictation is available when the browser supports its speech service; typed and pasted notes always work. Organizing and dictation never save automatically.

**Relationship preferences** lets you mark a closer or weaker relationship (+10/-10 on your private People score), choose a point person to check with first, and pause recommendations until a date. These controls stay separate from email/meeting activity and do not send messages. Existing suppression and seven-day snooze still apply. Scores for established synced contacts used by Booking reflect the same explicit strength adjustment; prose and newly created manual contacts do not independently grant booking priority.

Saved context and captured updates support recommendations on both sides: when asking who could help this person, when they are a potential match for another person, and in matches to your confirmed owner lens. Explicit search refinements still override the saved search context. Source attribution distinguishes your report from someone else's words. Suggestions require specific supported context and an independent source audit. Point-person guidance appears with the match; you can explore the graph or copy the reason for review before using it in an introduction.

## Privacy and sharing

Memory remains private to the signed-in owner. It is never inserted into imported signals, workspace exports, shared match evidence or public booking responses. Shared introductions use only already-shared evidence and receive their own grounded explanation. Your confirmed owner lens is not silently rewritten by a note about another person.

## APIs

- `GET /api/people/memory?personId=<own-id>` reads the profile and its ten latest saved updates.
- `POST /api/people/memory` replaces editable fields with an expected `revision`.
- `POST /api/people/memory/structure` with `{text}` returns a draft of structured fields without saving.
- `DELETE /api/people/memory/entry` with `{personId,entryId,revision}` removes a captured update.
- Legacy `GET/POST /api/people/context` still reads/edits the 1,000-character note and preserves all other fields.
- `GET/POST/DELETE /api/people/person-merges` reads, applies or undoes an owner-confirmed duplicate profile (`sourceId`, plus `targetId` for POST). Writes require the same-origin signed-in session. The chosen target ID remains canonical; existing source links resolve to it.

## Duplicate profiles and connection labels

The private profile's **Duplicate profiles** control combines confirmed aliases. Same-name candidates are suggestions only. Raw imported records stay separate, and **Separate this profile** restores them. Connections, topic membership and activity references follow the canonical profile; overlapping counts and scores are not added. The chosen target's measurements remain authoritative. Original private notes remain readable under **Context from combined profiles** and continue to inform private recommendations.

Selecting a person reveals their permitted connected neighbors through search and overview filters. Connection labels distinguish **Intro**, **Shared email**, and **Meeting**, and expandable details show supplied source evidence. Private Gmail introduction metadata is discovered during the bounded, consented introduction lookup, including introductions sent by the owner. It requires current authored introduction language and two unambiguous recipients. An introduction does not establish present closeness or willingness. Quotes and private introduction metadata do not enter shared exports; shared views use only their supplied evidence.

The profile uses one opaque revision across fields, note and captured updates. Stale writes return 409. Removed entries retain only retry metadata and a content fingerprint, preventing a retried capture from resurrecting the text. New text/voice-transcript captures use a stable source ID; a changed payload with that ID conflicts. Recommendations use up to five latest captured entries per person, preserving complete passages, and invalidate results if notes, policy, identity, consent or source evidence changes while inference runs.

**Accounts → Integrations** creates separately scoped, expiring and revocable People API/MCP keys. See [the integration guide](../../docs/people-memory-integration.md) for Rust `peoplegraph memory lookup|capture|save`, REST and MCP. Bot clients submit transcribed voice text; installing/configuring Botwick is not automatic.

Agent capture resolves an exact email or creates an explicitly manual private contact. Names and domains never merge identities; manual records do not fabricate email/meeting activity and are excluded from shared exports and automatic booking recognition. Company for a new manual contact becomes an editable profile field. Editing an existing person's other fields uses the revisioned save operation.

## Bounds and verification

Notes allow 1,000 characters; company allows 160; building, needs and offers allow 600 each; and up to eight interests allow 80 each. Captures allow 2,000 characters, with up to 100 source entries per person and 500 manual contacts per owner. Errors leave the editor's draft intact.

`npm test`, `npm run test:person-context-runtime`, `npm run test:relationship-memory-browser`, and `npm run test:person-context-browser` cover storage/auth/privacy, source attribution, matching races, real SQLite/RPC reload, editor conflicts/focus, manual contacts, integration keys and mobile layout. Browser scripts accept `PLAYWRIGHT_MODULE`. Rust CLI behavior is tested with synthetic loopback HTTP. Tests do not change real contacts, create invitations or send email.
