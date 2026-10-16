# One People score and reconnect loop

Status: proposed for review. Extends the 2026-09-22 unified CLI design; implementation has not started.

## Intended outcome

The user wants the website, Wander recommendations, Needs attention, reconnect cards, and CLI to use the same people and feedback within each individual account. Botwick is one user’s private bot, not a shared product service. A decision in one interface must be reflected in the others. Reuse the existing People account and source connections.

## Authority and identities

The hosted People service is authoritative for connected mode within each owner account. Feedback, preferences, effective scores and recommendation history belong to that owner; they are never global person attributes. Two users can know the same person and have independent scores and decisions. Explicit network sharing does not share feedback or authorize edits to another owner’s scores. All interfaces read its canonical owner-scoped person IDs, score model, effective score, and feedback revision. Confirmed email aliases resolve to that ID; names alone never merge people. Local offline mode remains explicit and reports its snapshot age. No silent local fallback or independent score recomputation in connected mode.

Gmail, Calendar, Granola and Obsidian remain evidence sources with separate provenance and permissions. Imported Obsidian identities require an exact known address/alias mapping or explicit review. Shared-only records retain their visibility limits and do not gain invented direct scores.

## Shared decisions and score semantics

One server-side feedback service supports the website, authenticated CLI and reconnect UI. It records an idempotent operation ID, person, action, server revision, timestamp and previous state for audit and undo. Clients submit an expected revision; conflicting changes return the current state for review, rather than silently overwriting newer decisions.

- We connected: positive ten-point preference adjustment, applied once; clears existing attention items at the acknowledged timestamp. It is a manual report, labelled separately from imported evidence.
- Not interested: negative ten-point preference adjustment, applied once; hides the person from recommendation decks until undone. The profile remains searchable.
- Later: seven-day snooze with no change to the existing score adjustment.
- Show another: session rotation only, no score change.
- Undo: reverse the selected decision if still current; do not erase a newer decision from another client.

The effective People score is the server's measured base plus the active preference adjustment, clamped to 0–100. Profiles and CLI output include base, adjustment, effective value and model version. Jev relevance is distinct from relationship strength. Calendar RSVPs never become confirmed attendance. A repeated event imported from multiple sources must not produce repeated score credit.

## Recommendations and delivery

Wander and reconnect cards consume one recommendation service: Reconnect, Meet next and Unexpected connection, with dated supporting evidence and any recorded route. Suppression and snooze apply everywhere. Upcoming accepted events pause reconnect nudges, without completing unrelated promises. Show another rotates among eligible supported candidates and permits exhaustion.

Pair recommendations have a separate pair-level decision record (already know each other / not a fit). These choices never modify either individual's score.

Retain the old reconnect URL as a route into the unified experience. Retire its independent deck/feedback authority after migration. Optional personal bots can read only the recommendations of the account that explicitly authorizes them, through a revocable credential bound to that account and approved scopes. Botwick is just one such private client. There is no global Botwick identity, default bot enrollment, shared bot token or cross-account bot access. Delivery does not constitute engagement. No new schedule or outbound message is created by this change.

## CLI and authorization

Extend the existing proposed browser device-login flow with explicit network-read and person-feedback scopes. Existing read-only credentials cannot write feedback. Tokens cannot manage Google connections, delete source records, create shares or send messages. Account isolation, token expiry, revocation and origin binding remain as specified in the earlier CLI design.

The CLI in connected mode requests scores, recommendations and feedback from the hosted service. Keep the legacy local-only workflow available explicitly during transition, with clear separate-state messaging. After migration, the old bridge stops writing local feedback independently for the connected profile.

## Migration and rollout

1. Implement shared revisioned feedback and recommendation contracts, then make the website use them.
2. Implement CLI/device access and connect the reconnect UI. Provide an optional account-scoped client interface for personal bots; do not enroll or connect any bot automatically.
3. Build a dry-run migration preview over the old local feedback and pending reconnect decisions. Map only exact identities, deduplicate origin decision IDs and show conflicts or unknown people. Existing current web feedback wins conflicts by default; never add local deltas on top of web deltas.
4. Apply only a reviewed migration batch, keep a backup and migration journal, then switch the old bridge to the shared authority. Deletes/blocklists are not automatically translated into source-data deletion.
5. Verify a decision and undo round trip across web, CLI and reconnect before claiming unification complete.

## Acceptance checks

Identical effective scores for the same person/revision across clients; repeated requests do not stack; stale undo cannot overwrite newer state; account boundaries and scope restrictions hold, including a bot authorized by owner A being unable to read or change owner B’s scores, feedback or recommendations; aliases do not duplicate feedback; unknown identities stay unresolved; import replay is safe; suppression/snooze are respected by all decks; pair feedback leaves individual scores unchanged. Failed/offline operations remain visibly pending and never falsely appear saved.
