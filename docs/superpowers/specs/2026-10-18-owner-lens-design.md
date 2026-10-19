# Private owner lens

The main user needs a current, editable representation of what makes another person relevant: their work, what they need, and what they can offer. This implements the approved “Your lens” direction without adding another layer to the shared graph.

## Experience

- A compact Your lens launcher appears in the personal web network. A drawer holds Focused on, Looking for, and Can help with (500 characters each).
- Manual fields work independently of Honcho. Find people for me searches using saved, confirmed fields and shows specific conversation ideas with dated contact evidence.
- Learning is off initially. Enabling it permits selected recent work excerpts from the owner's sent email and optional authored notes to go to Honcho. Granola is a separate opt-in, off by default.
- Inferences appear as proposed updates with original sources. Use update or Dismiss controls each claim. Incoming contacts' statements never become owner evidence.
- The drawer and its in-memory data are discarded on account/source changes and sign-out. Shared network views have no lens data.

## Data and matching

Owner state lives in the existing per-owner Durable Object, outside graph/export/share payloads. Revision guards protect edits and disable/removal against late responses. Accepted learned fields retain source provenance and are withdrawn when those sources are removed; manual edits remain authoritative.

Recent sent-message metadata selects a bounded batch. Full bodies must independently verify the owner as sender. Quoted text is stripped, exact work passages retained, and raw bodies discarded. An invalid model sentence range cannot discard independently valid exact passages. A failed email extraction is retried with bounded backoff while other selected messages continue; failed emails are never marked successfully processed. If no usable evidence exists and extraction is failing or deferred, the UI reports the failure instead of a successful empty update. Diagnostic logs contain only fixed stages, codes, timings and counts. Sources expire after 90 days. Background mail sync can collect new passages; Refresh suggestions asks Honcho for proposed profile updates.

Granola learning uses up to three recent imported, visible meetings per refresh, prioritizing meetings that list a connected owner email as an attendee. Shared library notes do not automatically count as the owner’s meetings. Granola’s creator-only private-note field establishes per-note ownership for a personal API key, including an empty string; null or missing fields do not. This permits learning from key-owned notes without a matching connected Gmail address and never creates a Google identity or attributes another shared note to the owner. Verified note-owner speech and explicitly owner-attributed work in summaries/private notes can support focus, needs or offers. When those statements are absent, a verified attendee/owner may use exact professional summary excerpts as meeting activity. Recurring topics from at least two distinct meetings can suggest a focus phrased as exploring conversations; they cannot establish the owner’s projects, needs, offers or expertise. Meeting attribution stays visible in the review UI. Legacy flat transcripts are rehydrated to retain authoritative speaker attribution, with bounded pages and cached source versions. Suggestions carry dated meeting titles, links and exact excerpts. Exclusion, disconnect, reconnection, note replacement and expiry withdraw dependent context. Versioned retries prevent a broken recent note from blocking older notes. The drawer reports recent meetings available, checked and useful excerpts collected.

Honcho uses an opaque dedicated workspace per owner and an immutable source snapshot session. Recall is restricted to that session, global peer cards are disabled, and returned entries must cite known current sources with complete, exact source quotations validated locally. The output contract is also included in the query because deployed Honcho versions may omit trace evidence and ignore the response-format option. This checks source provenance; user review decides whether an inference is accurate. Writes/deletes are serialized, bounded, and abortable. Disabling removes local learned context and requests deletion of remote memory; asynchronous deletion remains pending until an exact, read-only workspace listing confirms absence. An empty session list alone does not confirm deletion.

Matching treats the confirmed lens as an explicit search request. It never creates a synthetic graph person or treats the profile as verified personal history. Existing candidate retrieval, specific-fit scoring, source attribution, and independent claim audits remain in force. Results address the owner as you/your and cite the candidate's actual context. No messages are sent.

## Delivery and verification

1. Implement and test owner storage, extraction, retention, cancellation and source withdrawal.
2. Implement the Honcho v3 adapter with replay protection, exact-source citation validation and deletion lifecycle tests.
3. Add authenticated same-origin lens actions and matching routes; reject client-supplied match profiles.
4. Add drawer, confirmed-profile search, conflict handling and source/account isolation tests.
5. Run typecheck, complete automated suite, desktop/mobile browser flows and code review. Deploy and verify live endpoints. Live learning additionally requires the user-supplied `HONCHO_API_KEY` Worker secret.

Honcho sources: [Representations](https://honcho.dev/docs/v3/documentation/core-concepts/representation), [Chat API](https://honcho.dev/docs/v3/api-reference/endpoint/peers/chat), [Session messages](https://honcho.dev/docs/v3/api-reference/endpoint/messages/create-messages-for-session).
