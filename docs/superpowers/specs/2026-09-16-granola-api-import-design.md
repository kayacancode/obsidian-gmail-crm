# Granola API import: five-note private pilot

Status: written design for review; not implemented or deployed.

## Approved outcome

Replace the repeated JSON-file workflow with an on-demand Granola API import. The user has approved sending five selected meeting summaries to this application's Cloudflare backend and Workers AI, reviewing the extracted themes, and saving the selected notes and themes privately to their signed-in graph account. No background sync, outreach, or firm-wide sharing is authorized by this pilot.

## Chosen approach and alternatives

Use the existing authenticated People Graph Worker, account-isolated Durable Object, and meeting-theme interface. Add a bounded import workflow and persistent saved-batch state. Keep the API key in the import dialog's memory only; forward it over HTTPS to the backend for the requested Granola reads and never persist it. A new import after closing the dialog requires entering the key again; reading previously saved imports does not.

A saved encrypted connection with continuous sync would be more convenient later but adds credential retention, scheduling and revocation requirements. The current local JSON preview remains a compatibility option, but cannot meet the persistence requirement. Neither alternative is part of this change.

## User experience

1. **Import Granola notes** opens a masked API-key field and states which data will be processed and saved. Do not ask for a key in chat or place it in a URL.
2. **Browse folders** lists only folders available to that key, with pagination and an explicit selection. Do not assume the MCP folder UUID is the public API folder ID. The user selects Betaworks; the app does not silently pick a same-named folder.
3. List note titles and dates for that folder. The user selects one to five notes, then explicitly chooses **Extract themes**. Browsing metadata does not fetch every note body or invoke AI.
4. Review a draft with extracted themes, dated evidence, attribution, suggested people matches, why-now interpretations and proposed actions. Show which five notes were processed, including notes that did not produce a theme. No heat changes before saving.
5. **Save to my graph** persists the approved batch. Saved notes and review decisions reload after refresh and sign-in to the same account. Display **Saved Granola notes**, not **This tab only**. Keep an explicit label on the older temporary JSON preview.
6. **Manage imported notes** shows the saved batch, its import date, and a confirmed removal action. The pilot keeps one saved batch per account: importing another requires an explicit replacement confirmation. A failed replacement preserves the old batch.

Reuse the existing map, all-person overview, pan/zoom, source links, introduction paths and why-now panel. Do not cap the visible network or redesign it. Theme chips show **Granola notes** separately from **Email subject**. User review controls remain **Still relevant / Resolved / Dismiss** and persist for saved themes only.

## Data and credential boundaries

- The Google-authenticated app account owns the import. Do not require the Granola account email to equal the app login; the user may legitimately connect personal Granola access to a work graph.
- The key is used only for the official `https://public-api.granola.ai` API. No arbitrary upstream URLs, credential forwarding on redirects, browser storage, saved settings, raw request logging, model prompts, error messages or public assets containing the key.
- Clear the key after successful extraction; keep the extracted draft visible for review. Clear both the key and draft UI on dialog close, refresh, sign-out, account or graph-source changes, and authentication errors. Discard stale asynchronous responses after those lifecycle transitions.
- Fetch summaries without requesting transcripts. Explicitly discard `private_notes_text`, `private_notes_markdown` and any incidental transcript fields before storage, response, or AI input; this pilot's approval concerns meeting summaries.
- Persist selected summary text, note title, API ID, source URL, meeting-date provenance, content hash, generated draft, model/extractor version and review decisions. Do not retain attendee email addresses in the saved browser payload. Never save unselected note bodies.
- All saved content is owner-private. Granola's scope named “Public notes” means workspace visibility and must **not** become this app's internet-public or Firm visibility.
- Switching to Firm, Public momentum or Off hides imported notes, theme names, source links, matches and derived heat. The server must enforce this too; hiding DOM elements alone is insufficient.
- Imported snapshots do not automatically track later Granola edits, deletion or revoked access. Label the import date and offer removal. Never claim ongoing synchronization or automatic revocation propagation.

## Components and state

- `granola-client.ts`: validated official-API requests, bounded responses, pagination, safe error mapping and note normalization. Use returned `not_`/`fol_` IDs and returned `web_url`, never construct a source link from an API note ID. Allow only validated HTTPS Granola note URLs.
- `granola-extractor.ts`: a summary-specific structured extractor using the existing Workers AI binding and configured supported model. Keep it separate from the Gmail extractor, whose fixed topic vocabulary and mail-specific data rules must remain unchanged.
- `granola-store.ts`: saved batch, short-lived draft and feedback in the existing owner's Durable Object, with transactional replacement, revision checking and idempotent save. No new global multi-user store and no background scheduler.
- `granola-routes.ts`: authenticated `/api/granola/*` handlers, delegated from the Worker. Resolve the owner from the session, never from request JSON. Same-origin checks on all credential-bearing POSTs and all writes; bounded schemas, opaque identifiers, `no-store` responses and safe errors.
- Existing host and meeting-theme UI: credential entry, folder/note selection, extraction progress, review/save, automatic saved-batch reload, and distinct persistence messaging. Route saved Granola evidence and feedback to its own handlers, never the temporary-preview or unrelated theme APIs.

Draft content expires after 30 minutes. Store no more than one pending draft and one saved batch per owner. Maximum five notes, 40 KB UTF-8 summary text per note, 200 KB total summary text, ten extracted themes, ten evidence items per theme and twelve people candidates per theme. Over-limit notes produce a clear error rather than silent truncation or extra API requests.

Use bounded external request deadlines and a total extraction deadline. One extraction may run per owner; retries reuse the same idempotency key and completed draft. Do not automatically retry a possibly completed paid AI request. Save references a server-held draft and revision, not arbitrary browser-provided evidence. Account, graph-source and dialog generations fence late responses; cancellation prevents abandoned work from becoming saved graph data.

## Evidence, matching and heat

Treat every summary as untrusted data, not instructions. AI may suggest themes and next steps but may not invoke tools, generate authoritative identity mappings, infer introduction willingness, or create graph edges.

Every theme must cite at least one selected note. Evidence excerpts must be validated against the imported summary. A quote from a summary is labeled as summary evidence, not a verbatim speaker transcript. Statements attributed to John must be explicitly attributed in the source; otherwise use “Meeting summary; speaker not identified.” Keep our why-now inference and suggested action in separate fields and labels. Reject unsupported source IDs, invalid dates, extra fields and invalid outputs.

Map people only using existing authorized identities and source-supported context. Exact unique name-and-organization matches remain labeled suggested; ambiguous or unknown people stay unmatched and receive no person-level heat. Presence on an attendee list is not proof of involvement in every theme. Existing graph IDs, relationships and scores are unchanged.

Preserve the pilot's transparent meeting-date decay and user-confirmed relevance behavior for saved batches. Do not use import date to make old meetings appear fresh. Prefer the supplied scheduled meeting date, otherwise use note creation date and label that fallback. Resolved, dismissed and superseded items retain evidence but produce no heat. AI-inferred statuses are reviewable suggestions, not verified completion claims. No useful supported themes is a valid extraction result.

## Errors and verification

Show specific, safe messages for invalid/revoked keys, insufficient scope, empty folders, unavailable notes, oversized summaries, rate limits, timeouts, invalid AI output and failed saves. Do not replace existing graph content on error. Disable duplicate submissions while retaining a recoverable draft where safe.

Required tests: unauthenticated and cross-account access; key absent from storage/responses/logs/model input; origin checks; untrusted redirects and source URLs; private-note/transcript exclusion; five-note and byte limits; malformed pagination and Granola payloads; evidence grounding; ambiguous people; injection-resistant rendering; idempotent extraction/save; expiry; replacement races; persistent feedback; account/source/sign-out transitions; Firm/Public/Off server and DOM isolation; fresh reload restores saved batch; full-network spacing and paths stay intact at desktop and mobile widths.

Use fictional fixtures only. Run model, Worker, typecheck and browser suites before deploying. After deployment, verify served assets and the actual key-entry UI. The user enters the live key directly; then verify a selected five-note import, review/save and refresh without inspecting or echoing the credential. Do not claim live API success until this last step passes.

## Documentation references

- [Granola API access and scopes](https://docs.granola.ai/help-center/sharing/integrations/granola-api)
- [List folders](https://docs.granola.ai/api-reference/list-folders)
- [List notes and folder filtering](https://docs.granola.ai/api-reference/list-notes)
- [Get note fields and web URL](https://docs.granola.ai/api-reference/get-note)

The current app implementation is in `apps/people-graph`; the temporary preview model is `public/relationship-graph/meeting-preview.mjs`. This change does not release or modify the Obsidian plugin.
