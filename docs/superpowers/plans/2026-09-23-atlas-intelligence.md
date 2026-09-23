# People atlas intelligence implementation plan

**Goal:** Make the approved atlas interactive with time lenses, an evidence-backed daily digest, scored profiles, introduction drafts, and the existing Jev search.

**Design:** The approved conversation and clickable atlas previews define the interaction. Keep exploration as the default. Search highlights the answer within the same network. Date lenses preview on hover and commit on click. Profiles show recorded relationship strength separately from query relevance. Introduction actions prepare editable drafts, never send.

**Architecture:** Add a pure client intelligence module for date windows, digest ranking, score comparisons, and introduction candidates. Preserve direct-contact provenance in the graph payload. Extend the existing renderer and host search integration. Reuse existing Granola identity review and Jev backend; do not duplicate them.

**Constraints:** No inferred location, invented meeting counts, invented scores for other people's relationships, or fabricated evidence. Unknown data remains unknown. Shared-only contacts cannot be presented as direct conversations. A mention in notes is distinct from a conversation. No external messages are sent.

## Tasks
- [x] Test and implement direct-contact provenance, calendar window boundaries, source-supported digest reasons, and score/intro comparison helpers.
- [x] Add time controls with hover/focus preview and click selection; add clickable digest and profile evidence.
- [x] Connect Jev results to graph highlighting and profile relevance; keep keyword fallback labeling and clear/reset behavior.
- [x] Add editable introduction drafts grounded in actual graph routes.
- [x] Validate pure helpers, backend type checks, existing host/browser suites, and an end-to-end intelligence fixture at desktop and mobile widths.

## Review focus
Missing dates or scores, future dates, shared-only identities, empty search responses, asynchronous account changes, reduced motion, narrow viewports, and unsupported introduction claims must remain explicit and safe.
