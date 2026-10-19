# Private owner lens

The main user needs a current, editable representation of what makes another person relevant: their work, what they need, and what they can offer. This implements the approved “Your lens” direction without adding another layer to the shared graph.

## Experience

- A compact Your lens launcher appears in the personal web network. A drawer holds Focused on, Looking for, and Can help with (500 characters each).
- Manual fields work independently of Honcho. Find people for me searches using saved, confirmed fields and shows specific conversation ideas with dated contact evidence.
- Learning is off initially. Enabling it permits selected recent work excerpts from the owner's sent email and optional authored notes to go to Honcho.
- Inferences appear as proposed updates with original sources. Use update or Dismiss controls each claim. Incoming contacts' statements never become owner evidence.
- The drawer and its in-memory data are discarded on account/source changes and sign-out. Shared network views have no lens data.

## Data and matching

Owner state lives in the existing per-owner Durable Object, outside graph/export/share payloads. Revision guards protect edits and disable/removal against late responses. Accepted learned fields retain source provenance and are withdrawn when those sources are removed; manual edits remain authoritative.

Recent sent-message metadata selects a bounded batch. Full bodies must independently verify the owner as sender. Quoted text is stripped, exact work passages retained, and raw bodies discarded. Sources expire after 90 days. Background mail sync can collect new passages; Refresh suggestions asks Honcho for proposed profile updates.

Honcho uses an opaque dedicated workspace per owner and an immutable source snapshot session. Recall is restricted to that session, global peer cards are disabled, and returned entries must reference known current sources backed by Honcho evidence. This checks source provenance; user review decides whether an inference is accurate. Writes/deletes are serialized, bounded, and abortable. Disabling removes local learned context and requests deletion of remote memory; asynchronous deletion remains pending until confirmed.

Matching treats the confirmed lens as an explicit search request. It never creates a synthetic graph person or treats the profile as verified personal history. Existing candidate retrieval, specific-fit scoring, source attribution, and independent claim audits remain in force. Results address the owner as you/your and cite the candidate's actual context. No messages are sent.

## Delivery and verification

1. Implement and test owner storage, extraction, retention, cancellation and source withdrawal.
2. Implement the Honcho v3 adapter with replay protection, evidence validation and deletion lifecycle tests.
3. Add authenticated same-origin lens actions and matching routes; reject client-supplied match profiles.
4. Add drawer, confirmed-profile search, conflict handling and source/account isolation tests.
5. Run typecheck, complete automated suite, desktop/mobile browser flows and code review. Deploy and verify live endpoints. Live learning additionally requires the user-supplied `HONCHO_API_KEY` Worker secret.

Honcho sources: [Representations](https://honcho.dev/docs/v3/documentation/core-concepts/representation), [Chat API](https://honcho.dev/docs/v3/api-reference/endpoint/peers/chat), [Session messages](https://honcho.dev/docs/v3/api-reference/endpoint/messages/create-messages-for-session).
