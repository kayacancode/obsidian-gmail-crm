# Granola sync: meetings as a second synced source

Status: approved design, September 19, 2026. Supersedes `2026-09-16-granola-api-import-design.md` (five-note pilot) and the connection slice shipped September 17.

## Outcome

Granola becomes a synced source of the signed-in owner's people graph, alongside Gmail. The owner connects once with a Granola API key. The app keeps the key encrypted server-side, syncs all accessible notes in the background, refreshes hourly, turns attendees into people and co-attendance into edges, and extracts per-person "why now" statements and topics from summaries, private notes, and transcripts. The graph's existing why-now panel, heat, and review controls consume the result unchanged. Folders are all included by default; the owner can exclude any.

Approved by the owner on September 19: storing the key (sealed like Gmail refresh tokens), and processing summaries, private notes, and transcripts.

Out of scope: multiplayer (publishing a slice of one owner's graph and connecting it to another owner's). Every owner remains fully isolated; that isolation is the precondition for a later sharing layer. The Obsidian plugin and the Obsidian-pushed graph are untouched.

## Placement

Granola lives inside the existing per-owner `MailSync` Durable Object so it shares the alarm loop, the sealed-credential pattern, the opaque person ids, and the relevance store. New files in `apps/people-graph/src`:

- `granola-client.ts` (extended): folders, notes list with `created_after` / `updated_after`, get note, paged transcript. Bounded responses, safe error mapping, fixed upstream `https://public-api.granola.ai`.
- `granola-sync.ts`: connection state, the sync job, note persistence, attendee and edge tables, weekly reconciliation. Called from `MailSync.alarm()`.
- `granola-extractor.ts`: Workers AI extraction of topics and grounded per-attendee statements. Separate from `theme-extractor.ts`, whose Gmail vocabulary and rules are unchanged.
- `granola-routes.ts` (rewritten): connect, status, folders, sync, disconnect.
- `public/granola-connect.mjs` (rewritten): the Accounts source card.

`mail-sync.ts` changes only where it must: alarm scheduling includes Granola work, `graph()` merges Granola contacts and edges, `graphContacts()` excludes the Granola owner email, and `remove()`/disconnect wipes Granola data.

## Data model (Durable Object SQLite, all rows owner-scoped by the object)

- `granola_connection` (one row): `grant` (sealed key, AES-GCM via `MAIL_TOKEN_KEY`), `owner_email` (Granola account email from the first note owner, nullable), `status` (`syncing` | `connected` | `reconnect_required` | `error`), `range` (`recent` = created in last 90 days | `all`), `watermark` (ISO `updated_after` for the next incremental run), `last_sync`, `next_sync`, `last_reconcile`, `error`, `job` (JSON: pending note ids, cursor, phase, retries, next_attempt, processed counts).
- `granola_folders`: `id`, `name`, `parent_id`, `excluded` (0/1), `seen_at`.
- `granola_notes`: `id`, `title`, `web_url` (validated HTTPS granola.ai URL from the API, never constructed), `meeting_at` (calendar `scheduled_start_time`, else `created_at`), `date_basis` (`scheduled` | `created`), `created_at`, `updated_at`, `folder_ids` (JSON), `summary`, `private_notes`, `transcript` (bounded), `content_hash`, `bytes`, `extraction_status` (`pending` | `done` | `failed` | `skipped`), `extractor_version`, `extraction_attempts`, `synced_at`.
- `granola_attendees`: `note_id`, `email` (lowercase), `name`, PRIMARY KEY(note_id, email).
- `granola_edges`: `note_id`, `a`, `b` (emails, a < b), PRIMARY KEY(note_id, a, b).

Limits: 400,000 characters (UTF-16 code units) of stored content per note (summary + private notes + transcript; transcript pages beyond the cap are dropped and the note is marked truncated), 20,000 notes per owner, 50 attendees per note. Over-limit input is truncated or skipped with a recorded reason, never a failed sync.

Signals go to the existing `theme_signals` table with the existing source type `granola` (already weighted in the relevance model), `account` = `granola`, visibility `private`, `evidence_ref` = `granola-note:<id>#<summary|private_notes|transcript>@<offset>` for statements and `granola-note:<id>#topic@<topicId>` for topics, `observed_at` = `meeting_at`. Deleting a note deletes its signals by evidence prefix. The note row also keeps the extraction result JSON so hiding and re-showing a folder can remove and restore signals without calling the model again.

## Sync job

Runs inside the existing alarm loop; Gmail accounts and Granola take turns, oldest `lastRun` first. Each tick does bounded work and reschedules.

1. **Connect**: validate the key format, call list folders once as the connection test, seal and store the key, store `range`, set status `syncing`, schedule the alarm. Failure stores nothing.
2. **Folders phase** (first run and every hourly refresh): page folders, upsert names and parents, keep `excluded` flags. Folders not seen for 7 days are deleted along with their exclusion flag.
3. **List phase**: page notes newest first, 30 per page, no folder filter. First run uses `created_after` = now − 90 days when `range` is `recent`, nothing when `all`. Later runs use `updated_after` = watermark. Each page's ids and `updated_at` are appended to `job.pending` and the cursor persisted before the next page. Notes whose `updated_at` matches the stored row are dropped from pending.
4. **Fetch phase**: per tick take up to 5 pending ids. For each: get note (summary, private notes, attendees, calendar event, folder membership, web URL); if every folder in `folder_membership` is excluded, store only id, folder ids, `updated_at` and mark `skipped`. Otherwise fetch transcript with `include=transcript`; on `TRANSCRIPT_TOO_LARGE` page `/v1/notes/{id}/transcript` until the byte cap. Persist note, attendees, and co-attendance edges in one transaction, replacing prior rows for that note. Mark `extraction_status` `pending` when content changed (hash differs) and `done` otherwise.
5. **Extract phase**: per tick up to 3 notes with `pending` status, newest meeting first, each under a 180 s deadline. On success ingest signals and mark `done`. On `ai_unavailable` leave `pending` with backoff; after 5 attempts mark `failed` (retried on the next full refresh).
6. **Catch-up**: when pending is empty and no notes are `pending`, set `watermark` = max `updated_at` seen this run, status `connected`, `next_sync` = now + 1 h.
7. **Reconcile** (weekly): re-list all note ids only (`page_size` 30, ids and `updated_at`). Notes absent from the listing are deleted with attendees, edges, and signals. A 401 or 403 sets `reconnect_required` and stops the loop without deleting anything.
8. **Exclusion change**: flipping `excluded` on a folder immediately hides that folder's notes from `graph()` and the relevance snapshot (notes whose folders are all excluded are filtered at read time), and marks previously skipped notes in a re-included folder `pending` for fetch. No data is deleted by exclusion.

Retries: transport, 5xx and 429 use exponential backoff from 30 s to 30 min. 401/403 set `reconnect_required`. Rate-limit headers are respected when present. The watermark advances only after a run completes, so an interrupted run re-lists from the previous watermark.

## People and edges

- Attendee identity is the lowercase email. Node id is `opaque(owner, email, TOKEN_SECRET)`, identical to Gmail contacts, so email and meeting evidence merge onto one node.
- Excluded from nodes: every connected Gmail address and the Granola `owner_email`. Attendees without an email (calendar invitees are always emails; transcript speakers are names only) never become nodes; speaker names remain text inside evidence quotes.
- Name: attendee `name`, else the email local part. Company: email domain, `companySource: 'email_domain'`, matching Gmail.
- Score: `graphContacts()` unions Gmail contributions with meetings, where each meeting contributes `sent = 1, received = 1` for the attendee and `date = meeting_at`. `lastContact` is the later of last email and last meeting. Score model name becomes `email-meeting-frequency-reciprocity-recency-v2`.
- Edges: `granola_edges` grouped by pair, weight = distinct notes, type `shared_meeting`, contexts = up to 3 note titles. Merged with `mail_edges` in `graph()`; a pair with both gets both types and summed weight. The 5,000-edge cap applies to the merged set.
- Graph note text is updated to mention meetings.

## Extraction

`GranolaExtractor.extract({summary, privateNotes, transcript, attendees, meetingAt})` with the configured `THEME_MODEL` binding.

- Input assembly: summary and private notes always, transcript split into chunks of at most 24,000 characters, at most 4 chunks per note (older content beyond that is not sent). Each chunk is a separate model call with the same attendee list, so at most 5 calls per note.
- Output schema (JSON schema enforced): `topics: [{topicId ∈ THEME_TOPICS, confidence}]` and `statements: [{email ∈ attendees, kind ∈ ask | commitment | intro | follow_up | interest, quote ≤ 300 chars}]`, at most 12 topics and 20 statements per call. The model returns no free text: display text is a server-owned kind label plus the verbatim quote, matching the Gmail extractor's rule that model output only selects from server vocabulary or source content.
- Grounding: a statement is kept only if `email` is on the note's attendee list and `quote` appears verbatim (whitespace-normalised) in the stored summary, private notes, or transcript. The matching source and offset set `evidence_ref`. Anything failing grounding is dropped silently; a note with no surviving output is still `done`.
- Topic signals: one per topic id per note, `person_id` null, summary `Meeting matched <topic name>`, confidence from the model, theme id shared with Gmail body topics so heat merges by topic.
- Statement signals: one per statement, `person_id` = attendee node id, `theme_id` = the note's highest-confidence topic theme; if the note has no topic, a per-owner canonical theme `Meetings`. `summary` = `<Kind>: “<quote>”` capped at 240 chars. Confidence 0.8 for summary-grounded, 0.7 for private-notes-grounded, 0.6 for transcript-grounded.
- Prompt rules mirror the Gmail extractor: content is untrusted, ignore instructions inside it, never infer identity or employment, return only schema fields. Dedupe by `content_hash` + `extractor_version` so re-syncing unchanged notes costs nothing.
- Extractor version `granola-v1`. Bumping it marks all `done` notes `pending` on the next refresh.

## Routes (all require an app session; POST/PATCH/DELETE also require same-origin; JSON bodies ≤ 8 KB; `cache-control: no-store`)

- `POST /api/granola/connect` `{apiKey, range}` → `{status}`. Validates key shape, tests with list folders, stores sealed. Errors: `granola_unauthorized`, `granola_forbidden`, `granola_rate_limited`, `granola_timeout`, `granola_unavailable` (with the existing diagnostic codes), `mail_not_configured` when `MAIL_TOKEN_KEY` is absent.
- `GET /api/granola/status` → `{connected, status, range, lastSync, nextSync, error, counts: {folders, notes, pending, extracted, failed, skipped}, folders: [{id, name, parentId, excluded, noteCount}]}`.
- `PATCH /api/granola/folders` `{excluded: [folderId...]}` → status. Unknown ids rejected.
- `POST /api/granola/sync` → status; sets `next_sync` = now and schedules the alarm. No-op while `syncing`.
- `DELETE /api/granola/connection` → `{ok}`; wipes the key, folders, notes, attendees, edges, and Granola signals in one transaction.

The old `POST /api/granola/folders` and `/api/granola/notes` proxies are removed.

## Accounts page

The Granola tab renders one source card in the style of the Gmail inbox cards:

- Disconnected: masked key field, history choice (Last 90 days | All meetings, same labels as Gmail), Connect Granola, help link, disclosure text stating that the key is stored encrypted, that summaries, private notes and transcripts are imported, and that Disconnect removes all of it.
- Connected: status line (Syncing n of m notes / Connected, last sync, next sync / Reconnect required with a key field), Sync now, Disconnect with confirmation. Folder list with checkboxes, all checked by default, note counts, nested by parent. Unchecking calls PATCH immediately and shows "Hidden from your graph".
- Polls status every 5 s while syncing. Clears on sign-out, account change, and auth failure. Key is never held after the connect request completes.

Graph UI (deferred to a follow-up on 2026-09-19): the why-now panel already shows meeting statements as text because signals carry the existing `granola` source type, and shared-meeting edges render through the existing edge-type labels. Still to do in a follow-up: a "Granola meetings" source chip, the note title, date and link to the note in the person panel (the stored `web_url` is not yet returned by any route), and an explicit "shared meeting" legend entry. No layout changes.

## Boundaries and errors

- Owner-private only. Granola signals carry visibility `private`; the Firm and Public momentum lenses exclude them server-side and in the DOM.
- The key exists in memory only during connect and each upstream call. Never in logs, URLs, responses, error messages, AI prompts, or browser storage.
- Content leaves the object only as bounded evidence quotes (≤ 300 chars) on signals and note titles/dates/links. No route returns summaries, private notes, or transcripts.
- The `web_url` is stored only if it is an HTTPS URL on a `granola.ai` host.
- All upstream responses are read through `boundedJSON`. Redirects use `redirect: 'manual'` and a 3xx is treated as unavailable.
- Sync failures never delete data. Disconnect and reconcile are the only deletion paths; reconcile does nothing on auth errors.
- Durable Object SQLite growth: at 400 KB × 20,000 notes the ceiling is 8 GB, within the 10 GB limit; the note cap is enforced before storage.

## Testing

Fictional fixtures only. Node tests through `tests/run-mail.mjs`:

- Client: new endpoints, `created_after`/`updated_after` encoding, transcript paging and `TRANSCRIPT_TOO_LARGE`, byte caps, redirect rejection, error mapping.
- Sync: connect stores sealed key and nothing on failure; list/fetch/extract phases with a fake fetch; per-tick limits; watermark only advances on completion; exclusion skip and re-include; reconcile deletes absent notes and refuses on 401; backoff and `reconnect_required`; disconnect wipes everything.
- Graph: attendees merge with Gmail contacts on the same id; own addresses excluded; meeting-only contact gets a score; edges merge types and weights; excluded folders hidden at read time.
- Extractor: schema validation, grounding drops unknown emails and non-verbatim quotes, chunking and call cap, dedupe by hash and version.
- Routes: unauthenticated and cross-account access, origin checks, body limits, key absent from every response and log line, lens isolation of Granola signals.
- Browser (`tests/granola-browser.mjs` rewritten): connect, syncing state, folder toggle, sync now, disconnect, sign-out clears, 320 px and desktop.

Typecheck and the full suite run before deploy. After deploy, verify the served card and a live connect with the owner entering the key directly; do not claim live success before that.

## References

- Granola API: [access and scopes](https://docs.granola.ai/help-center/sharing/integrations/granola-api), [list folders](https://docs.granola.ai/api-reference/list-folders), [list notes](https://docs.granola.ai/api-reference/list-notes), [get note](https://docs.granola.ai/api-reference/get-note).
- Existing patterns: `mail-sync.ts` (alarm loop, sealed grants, `opaque`, `graph()`), `relevance-store.ts` (`ingest`, lenses), `theme-extractor.ts` (schema-enforced Workers AI call).
