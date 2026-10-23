# Private person context

In **My Network**, select one of your synced contacts and choose **Your context → Add context**. Save up to 1,000 characters about what they are building, need, or how you know them. The note appears above useful recent conversation excerpts. Edit or remove it from the same section.

**Who could help this person?** uses the saved note when the temporary **Refine this search** field is empty. A temporary refinement takes precedence for that search. Results identify the actual saved context used, while candidates still need supported conversation evidence. Saving a change refreshes an open helper panel. These notes steer searches for the selected person; they do not automatically become evidence for matching that person to somebody else's search.

Notes remain private to the signed-in owner and separate from imported email/meeting evidence. They are not exported to shared networks and do not change the owner's lens or Booking rules. This version supports own synced My Network contacts, not shared-only people or pushed Obsidian records. Generic topic labels such as “Activity involving…” no longer occupy the personal Recent context summary; underlying signals are retained.

## API and storage

- `GET /api/people/context?personId=<opaque-own-contact-id>`
- `POST /api/people/context` with `{personId,text,revision}`; `revision` is null initially and an opaque UUID thereafter. Empty text removes the note.
- Response: `{personId,text,revision,updatedAt}`; timestamps are milliseconds since epoch.
- Same-origin mutations, bounded input, Google session owner and exact owner-scoped contact identity are required. Responses use `Cache-Control: no-store`.
- Conflicting writes return `409 person_context_conflict`. A removed note retains a revision tombstone so a stale editor cannot restore it.
- Notes live in a separate per-owner MailSync SQLite table. No new namespace, secret, D1 migration or external service is required.
- Helper results expose `contextSource` (`saved_note`, `brief`, `automatic`) and the actual `brief`. Note changes or identity withdrawal while the model runs invalidate the result.

## Verification

`npm test` covers storage, exact identity, route authorization, privacy/export isolation, concurrent edits, removal and helper precedence/races. `npm run test:person-context-runtime` exercises real workerd SQLite/RPC, a 1,500-contact graph, and the production class export after reload. `npm run test:person-context-browser` covers save/reopen/remove, failure/conflict recovery, person switching, saved-note attribution, typing focus during graph refreshes and mobile layout. Set `PLAYWRIGHT_MODULE` when Playwright is supplied by an external runtime. No verification writes notes to real contacts or sends messages.

Validated on 2026-10-23: 999 app tests and four real runtime checks pass, along with the person-context and existing helper desktop/mobile browser checks. Deployed Worker version: `8c6780ad-b794-4749-91d9-a5bc2100c2aa`. Live profile loading and the editor were verified without saving a real note.
