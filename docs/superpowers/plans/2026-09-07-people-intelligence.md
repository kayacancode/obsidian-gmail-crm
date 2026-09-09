# People Intelligence Implementation Plan

**Goal:** Deliver an Obsidian workspace with evidence-backed people discovery, relationship timeline, goals matrix, introduction paths, and focused graph.
**Architecture:** A pure TypeScript intelligence model consumes the existing index, exact-email-matched vault notes, and a separate local interaction journal. A framework-free renderer is shared by the Obsidian ItemView and a browser verification harness. Goals and feedback persist separately from the CLI-owned contact index.
**Tech Stack:** TypeScript, Obsidian ItemView, DOM/SVG, esbuild, Node test runner.
**Spec:** Approved conversation design, September 7: preserve existing graph/Base; implement all three visualizations and shared person panel.

## Constraints
- No email bodies, outbound messaging, external enrichment, or invented historical activity.
- Preserve current uncommitted changes; work in the existing feature checkout.
- Separate observed evidence from proposed relevance and potential introductions.
- Unknown historical coverage is explicit. Imported metadata accumulates without duplicate events.
- All views support keyboard controls and empty results.

## Tasks
- [x] Test and implement pure evidence matching, alias resolution, dated event deduplication, weekly buckets, trend coverage gates, and credible introduction candidates (`src/intelligence-model.ts`, `tests/intelligence.test.ts`).
- [x] Retain Gmail/calendar interactions in a separate journal through existing sync callbacks; atomic local persistence and errors surfaced (`src/intelligence-store.ts`, `src/gmail-api.ts`, `src/calendar-sync.ts`, `src/main.ts`).
- [x] Implement shared workspace renderer: attention, timeline, editable goals matrix, paths, focused graph, filters, pagination, person evidence panel, feedback (`src/intelligence-workspace.ts`, `styles.css`).
- [x] Register Obsidian view, command/ribbon, live refresh, note links and state persistence (`src/intelligence-view.ts`, `src/main.ts`).
- [x] Verify model and sync integrations with Node tests, typecheck and production build, then browser-check actual renderer with labeled synthetic fixtures. Document usage and limitations in README.

## Validation
Run `node scripts/test-intelligence.mjs`, `npx tsc --noEmit`, and `npm run build`. Browser checks cover all tabs, selection, goals editing/persistence, filters, empty data, narrow layout, and escaping user-controlled content.

## Verification results

- 17 Node tests passed: metadata capture, sync failure handling, persistence, evidence matching, alias ambiguity, accepted-calendar recency, event deduplication, and trend gates.
- TypeScript `npx tsc --noEmit` and production `npm run build` passed.
- Browser smoke checks passed against the actual renderer with synthetic data: all views, source links, goal persistence, graph keyboard/click controls, filtering/detail consistency, mobile width, and empty state; no runtime errors. Screenshots reviewed.
- Fixed the pre-existing optional first-contact type error with a guard.
- No live-vault deployment or real Gmail/Calendar requests performed. Existing unrelated checkout changes preserved.

## 0.9.0 release integration

Release branch is based on 0.8.1, preserving the web graph and incremental/full scoring split. Automatic intelligence refreshes reuse source notes and coalesce in-flight reads; manual refresh reloads them. Incremental scoring propagates photo changes. Release verification: 19 intelligence tests, 7 reconnect tests, typecheck and production build passed; merge review approved.

## 0.9.1 hotfix

Obsidian's `FileSystemAdapter.rename` throws `Destination file already exists!` instead of overwriting, so the store's tmp+rename save only ever succeeded once; every later Gmail sync, calendar sync, and goal edit aborted. Saves now write the file directly (serialized, like `contact-index.json`), and the test adapter refuses to rename over an existing file so this cannot hide again. The People API pager retried a rate-limited page every 15s forever; it now retries each page at most 3 times, including the first page, then fails the photo sync. 22 intelligence tests, typecheck and production build passed.
