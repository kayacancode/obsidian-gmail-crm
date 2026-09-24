# Maps, Memory, and Meaning: contextual network walks

Status: proposed design for review; not implemented.

## Purpose

Help a person find useful answers and unexpected people without having to interpret a dense network map. The central experience is: question or current concern → supporting memory → relevant person → evidenced route → proposed action. The map follows the sidebar and remains available for free exploration.

The motivating example is the event “Agent Interfaces: Maps, Memory, and Meaning”: identify people who can contribute a specific perspective, explain the evidence behind that judgment, and show a credible way to reach them. Do not hardcode the event or invented example people into production.

## Existing foundations and gaps

The app already has evidence-based search in `src/network-search.ts`, shared network projection in `src/workspace-graph.ts`, bounded topic-pair discovery in `src/workspace-introductions.ts`, and path traversal in `public/relationship-graph/paths.mjs`. The graph sidebar lives in `public/relationship-graph/graph.mjs`.

Discovery currently proposes pairs with matching themes and different contributors, then optionally asks Jev to rank them. It does not establish a viewer-specific reason to meet someone. Path traversal already distinguishes recorded relationships from co-occurrence, but search results, evidence, and routes need one coherent presentation.

## User experience

### Answer

Submitting a question opens a sidebar with up to three initial person cards and access to additional supported results. Each card contains:

- Available photo, display name, role/company when supported, and contributing member names/colors.
- Why this person fits the question, explicitly labeled as an interpretation.
- Supporting memories with source type, date, and authorized excerpts or summaries. Email contact, meeting attendance, and note mentions remain distinct.
- A route from the viewer through a workspace member or recorded contacts, with the basis for every step. Relationship strength is shown only when measured, scoped to the correct member, and accompanied by its meaning; it is not presented as willingness to introduce.
- Explore route and Draft intro request. Drafting never sends a message.

A good match without a supported route remains visible with “No introduction route recorded.” No invented connections fill the gap. If evidence does not support a result, return an honest empty state instead of recent-contact fillers.

### Guided walk

Selecting a card opens a sequence within the same sidebar: Your question → Why this person → Supporting memory → Route → Next step. A persistent breadcrumb and Back control preserve the original query, result selection, map position, and filters.

Selecting a route step highlights only the corresponding nodes and recorded edges. Contextual similarity is visually distinct from a relationship and never inserted as a real edge. Co-occurrence is marked “Shared meeting/context; connection unverified,” not a confirmed introduction route. Member-to-contact relationships may supply a route even when members are not ordinary contact nodes; represent that step explicitly rather than fabricating graph nodes or contact-to-contact edges.

### Wander

Wander uses the same person cards and walk, seeded by a selected recent meeting, open question, or current project. Start with a small set of explained suggestions, not a new graph visualization. The selected context stays visible and can be changed or cleared.

“Someone unexpected” favors relevant people with no recorded direct relationship to the viewer and varies communities, contributors, and perspectives. It does not claim they have never met. A complementary perspective requires specific evidence, not a generic shared topic. “Another perspective” changes the candidate mix without weakening the evidence requirement. Reconnect stays a separate purpose for existing relationships; pair introductions remain a separate action from “Who should I meet?”

## Architecture and contracts

Introduce focused modules for candidate preparation, evidence/route assembly, and sidebar rendering rather than expanding the graph controller with all new logic.

Use one answer-card contract across query and Wander: person ID, authorized identity fields, contributors, fit explanation with evidence references, novelty basis, typed evidence items, route steps with relationship basis, and available draft action. All person, evidence, and relationship references must resolve against the authorized current snapshot. Include query/context identity and snapshot revision in responses.

Candidate retrieval uses bounded indexes over shared evidence, themes, and member relationships. Keep direct relevance and novelty separate: novelty diversifies supported matches, never rescues unsupported ones. Retrieve candidates before model ranking; avoid an all-pairs network scan. Jev ranks a bounded shortlist and selects evidence references; server validation rejects unknown references and unsupported routes. Route construction is deterministic and does not depend on a model inventing intermediate people.

Initial rollout uses an explicit query and the existing authorized shared graph. A subsequent increment adds viewer-selected personal context for Wander after the same answer and evidence contract is verified. Personal context is evaluated for the requesting viewer only and is never written into the shared graph or shared response cache. Existing provider policy and sharing controls continue to apply; richer evidence is not silently enabled.

## Privacy, identity, and reliability

- Rebuild or validate access against current workspace membership and sharing revision before returning shared results or drafts. Revoked evidence must not persist in visible cards or cached responses.
- Use stable matched identities. Ambiguous Granola names and legacy unmatched vault records cannot establish a route or a confident person attribution. Surface uncertainty when it affects a result.
- Send the ranking provider only the minimum evidence authorized for the requesting viewer and supported by the existing integration. Never send credentials or full private note bodies as a shortcut.
- Do not expose the viewer's private context to other contributors, shared analytics payloads, or shared caches. Drafts containing private context require deliberate user inclusion.
- Abort stale requests on query, account, workspace, or context change; reject late responses. Cards show loading, evidence-only fallback, insufficient-evidence, and no-route states distinctly.
- Jev has a bounded deadline and optional reranking. Deterministic evidence-backed results remain usable if it fails. Keep map nodes mounted during navigation; selecting a card must not relayout the full network.
- No score mutation merely because someone is recommended, viewed, or skipped. Existing reconnect feedback semantics remain unchanged in this work.

## Acceptance criteria

1. An event-planning query returns supported people cards that explain fit, show dated sources, and expose a route or explicitly state its absence.
2. A person contributed only by another member can appear above familiar contacts when evidence supports a stronger match. No-direct-connection status is viewer-specific.
3. Each walk step is navigable without understanding the map. Back restores the prior results and graph state; keyboard and narrow-screen interactions work.
4. No note mention or co-attendance is mislabeled as a confirmed relationship. Every displayed route step has a resolvable evidence basis.
5. Identity ambiguity, revoked sharing, cross-workspace requests, and stale responses cannot leak or misattribute evidence.
6. Jev failure leaves usable, clearly labeled evidence-based results. Unsupported results are not shown.
7. A representative 5,000-person graph remains interactive while the sidebar loads and changes. Verify mounted node stability and bounded candidate/path work with the existing browser harness.
8. Tests cover viewer-specific novelty, complementary evidence, member routes, unavailable routes, evidence reference validation, privacy boundaries, request cancellation, and the complete query-to-draft UI flow.

## Delivery boundaries

Build the Answer sidebar and inspectable walk first; then reuse it for context-seeded Wander and diversity-aware recommendations. Preserve the current visual language and contributor colors. No additional graph modes, automatic outreach, new global people-score formula, or fabricated demo data in live results.

## Approved visual direction and human handoff

The user selected the iOS-style prototype: a quiet map, large contact photos, rounded contact sheet, system typography, evidence disclosure, and Messages-style introduction composer. On mobile the sheet opens from the bottom; on desktop it sits beside the selected person. Preserve graph location, honor reduced motion, use available authorized photos with honest fallback, and never ship the prototype's stock portraits or fabricated evidence.

An introduction request is an in-app exchange between its requester and a selected workspace member, not an email sent by an agent. Both must be current members. Before submission show the exact message, destination, person card, and optional shared evidence. No private source material is automatically attached. The recipient can agree to introduce, check interest, suggest another currently shared person, or decline. An alternative requires recipient-authored context and remains attributed to them. Agreement, checking interest, and introduction completed are separate states; completion requires an explicit human report. Neither viewing, declining, nor suggesting someone changes measured relationship scores.

Requests appear in each participant's real signed-in account. Never ship a control that impersonates John. Other members and workspace administrators do not gain access to request messages merely by role. Shared profile/evidence references are revalidated on read; revoked shared attachments disappear, while deliberately sent request messages remain visible only to current authorized participants. Removed members cannot retrieve or mutate requests. No email, push notification, calendar invitation, or automatic outbound introduction is included in the first release.

The first delivery implements the shared-graph answer sheet, visible routes, request/reply loop, and the existing shared-context discovery entry point. Personal-context ingestion and automated daily suggestions remain the subsequent Wander increment described above.
