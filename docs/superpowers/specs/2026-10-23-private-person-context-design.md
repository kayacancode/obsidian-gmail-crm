# Private person context

## Intent
The owner sees unhelpful derived topic labels under Recent context and wants to add what they know about a person when no meeting notes exist. Make that knowledge persistent and useful for the selected person's helper suggestions.

## Approach
Use a separate private per-person note, displayed above Recent context. Reuse the existing manual helper brief path when no one-off refinement was supplied. A transient search field already exists but forgets input; turning notes into extracted email/meeting facts would misrepresent provenance and risk shared exports. The user explicitly chose to save it on the person's profile and use it for future suggestions.

## Behavior
My Network synced own contacts get a Your context section. One plain-text field (1000 characters) covers what they are building, need, and how the owner knows them. Save, edit and remove are supported. Show Private and last-updated time. Failed saves preserve text; stale writes require reloading the latest note rather than overwriting. Notes survive reload and do not leak between people or signed-in accounts.

Hide generic Activity involving, Recorded topic and Subject metadata matched lines from the personal Recent context summary. Preserve actual specific excerpts. Do not delete underlying signals.

The selected person's saved note becomes the default helper brief; a nonempty one-off search refinement takes precedence. The result explicitly labels the actual note used as Your saved context, never as their speech or conversation history. Editing/removing the note invalidates in-flight results and refreshes an open helper panel. Candidate-side evidence requirements remain unchanged. No automatic introductions or messages.

## Boundaries
Initial support is own synced My Network contacts with verified owner-scoped opaque IDs. No notes for shared-only, workspace or pushed Obsidian contacts. Separate DO storage; no theme signals, graph export, owner-lens mutation, booking-policy mutation, or public sharing. Notes steer searches for the selected person only in this increment.

## Integrity
Authenticated owner comes from session, same-origin bounded mutations, exact own contact lookup. Opaque revision for every update including removal prevents stale resurrection. Private GET uses no-store. Existing source/identity checks and quote grounding apply. No notes are created on behalf of the user during verification.
