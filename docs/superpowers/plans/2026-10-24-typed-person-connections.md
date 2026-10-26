# Typed person connections

The selected person should expose their actual incident connections, including when a search or overview hides the other endpoint. A connection label describes recorded evidence (intro, shared email, meeting), without asserting closeness or willingness.

1. Add reversible owner-confirmed identity merges for My Network. Keep raw contacts and private memories intact; project edges, signals and old deep links onto the selected canonical person. Same names alone never merge.
2. Add a private profile control for merging duplicate records and undoing a merge. Session ownership and same-origin checks protect the API.
3. Preserve and render typed connection evidence in personal and shared graphs. Selected neighbors and edge labels remain visible. Shared views only render their supplied shared evidence.
4. Reuse strict authored-email introduction detection for contact-to-contact intros, including owner-sent introductions. Inspect only messages already in the bounded consented origin lookup. Store source metadata privately; no introduction quotes in graph/share exports. Co-occurrence remains distinct from a confirmed personal relationship.
5. Cover alias preservation/undo/privacy, route validation, extraction negatives, and selected-node rendering with tests. Run typecheck/full suite, review, deploy and verify the selected profile in the live app.

Real contact identities and private email contents are excluded from committed fixtures. No outreach is part of this change.
