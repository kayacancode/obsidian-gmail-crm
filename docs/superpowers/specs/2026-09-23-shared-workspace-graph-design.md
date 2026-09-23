# One shared workspace graph

Status: design approved by the user; onboarding clarified and approved. Product implementation has not started.

## Agreed experience

Members of a workspace see one graph assembled from the network contributions each member explicitly shares. A person appears once when identity is confirmed. Selecting that person shows each contributing member's relationship separately and the best supported route through the team. My relationship and Our network are layers of the same graph. Personal feedback, inboxes, notes, and bots remain owned by the individual.

## Existing foundation and gap

`src/share-routes.ts` implements owner-to-viewer grants indexed in D1. `src/network-share.ts` bounds and sanitizes slices exported by the owner's MailSync Durable Object. Imports merge contacts by server-side email and preserve contributing owners in `via`. Accounts already has sharing controls.

This does not implement workspace membership. The current shared contact projection combines contact dates and meeting counts across owners and estimates shared-only scores from those counts. Those projections cannot support an honest per-member comparison. The workspace contract must preserve individual relationships rather than use that aggregate as a personal score.

## Architecture choice

Extend the existing owner export mechanism with workspace-specific consent, and assemble the shared graph on the server. Keep existing pairwise shares working independently.

A fully central copy of all members' data would increase privacy and revocation complexity. Making a workspace a collection of automatic pairwise grants would make membership changes and removal fragile. Instead, D1 holds workspace membership and contribution policy; owner Durable Objects remain authoritative for data and export only the allowed slice.

### Membership and contribution

- An authenticated user creates a named workspace and becomes its administrator. Membership never follows automatically from an email domain.
- An administrator generates an invitation for a specific Google sign-in email. A matching signed-in recipient explicitly accepts. Invitations expire after seven days, are single-use, and can be revoked. The app exposes a copyable link; it does not send an email automatically.
- Joining initially shares nothing. Each member chooses people or all owned contacts and a disclosure level using existing scope semantics. The preview lists the fields being shared, including relationship metrics. Owners may reduce scope or stop contributing immediately.
- Administrators manage membership and invitations but cannot enable another member's contribution or inspect their private sources. Members can leave. The sole administrator cannot leave until transferring administration or deleting the workspace.
- Initial limits: 20 members per workspace; existing per-slice caps remain enforced and truncation is visible. No silent omission or suggestion that the graph includes every contact.

### Shared graph contract

- A workspace graph request checks current membership before any owner exports. Each contribution is authorized by both active membership and that owner's active workspace policy. Policy revisions are checked before returning the assembled result; changes during assembly invalidate that contribution.
- The first version assembles bounded slices on request without a persistent workspace graph cache. Timeouts produce a partial graph with identified unavailable contributions, never silently retain revoked data. Responses are private and no-store.
- Merge identities by normalized exact email on the server. Do not collapse Gmail dots, plus aliases, or similar names. Cross-address identity merging requires a separately confirmed mapping; there is no new automatic alias inference in this version.
- Workspace person IDs are opaque and stable within the workspace, distinct from private owner IDs. Raw contact addresses and source credentials are not included in graph responses.
- Each person retains a relationship list: contributing member ID/name, measured relationship score, last direct contact, score version, observation date, and evidence category. No personal feedback delta, snooze, suppression, or private relevance score is exported.
- Missing relationship metrics remain unknown. Do not synthesize scores from combined meeting counts. Comparisons use the same score version and clearly identify incomplete coverage; ties remain ties.
- Every edge retains contributor provenance and its observed type. Co-attendance, an email exchange, a note mention, and an explicit introduction are not interchangeable. Paths use only the authorized recorded edges and display those distinctions.
- Workspace themes and evidence respect existing share levels. Raw email bodies, subjects, private note text, calendar titles, and personal activity timelines are not newly exported. Explicit statement-sharing retains the existing bounded consent behavior.
- Do not re-share imported contacts or inherited evidence through another member's contribution. Photos are excluded from workspace exports initially; shared nodes use initials until a separate permitted photo source exists.

## Browser onboarding

Use separate actions labelled **Add my inbox** and **Invite teammate**. Multiple inboxes belong to one member; an invitation creates a separate consenting membership. The inviter enters an email and copies the targeted invitation link. The recipient signs in, accepts, and can immediately explore the shared graph without connecting a source. Connecting Gmail, Calendar, or Granola and sharing a contribution are optional subsequent steps. Obsidian installation, a vault, CLI, manually created tokens, and importing personal data are never prerequisites for workspace access. Preserve an invitation through sign-in without accepting it automatically, and offer account switching when the signed-in email differs from the invite target.

## Interface

Add a network selector to the existing compact header: My network and the workspaces the user belongs to. Selecting a workspace opens the same Atlas canvas, search, Wander, and Answer controls, scoped entirely to authorized workspace data. Indicate the workspace name, contributor count, and partial/truncated status.

In the person sidebar, show Relationships with one row per contributing member and the best supported connector. Only the current user's row may additionally show their private adjusted People score, fetched through their own identity mapping. A teammate's measured relationship score must never be labelled as the viewer's score.

Request intro from a chosen teammate creates an editable draft. It does not send email or notify that teammate. If no supported route exists, say so. Shared search and suggestions must cite only workspace-visible evidence. My private recommendations remain in the personal layer and are not implicitly mixed into shared search results.

Accounts gains workspace creation, invitation acceptance, member management, and contribution controls alongside existing pairwise sharing. Leaving, removal, or reduced disclosure clears the affected graph, search results, and open profile on the next successful membership refresh. Refresh membership on focus and at most every 30 seconds while the workspace is open; disconnected views are marked stale. Previously viewed information cannot be recalled from a person's memory.

## Personal boundaries and scope

Not interested, Later, We connected, and Undo remain personal and cannot alter another member's score or hide a person from the workspace. Botwick remains an optional owner-specific integration with no workspace credentials or automatic access.

This implementation covers membership, consent, one merged graph, member relationship comparison, scoped exploration, and intro drafts. Outreach assignment, multiplayer live cursors, pair matchmaking, and unified CLI/reconnect migration are separate follow-ups. The existing unified reconnect draft remains independent.

## Verification and acceptance

Use separate simulated owners with overlapping contacts and a nonmember. Verify one workspace node for an exact identity, separate member scores/dates, personal adjustments staying personal, and shared-only contacts not acquiring a fake direct relationship.

Test targeted invitation acceptance, expiry, replay, role checks, same-origin mutations, cross-workspace isolation, no transitive sharing, scope/level reductions, removal during graph assembly, partial failures, caps, and absence of private fields in responses. Verify statement and theme disclosure at every level and that search/drafts cannot retrieve private evidence.

Browser tests cover create/join/contribute, switching personal/workspace graphs, sidebar relationship comparison, intro draft editing without sending, and removal invalidation. Run existing sharing, graph, feedback, and account regressions plus typecheck and browser checks. Do not enroll real colleagues or publish their data as part of testing.
