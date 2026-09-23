# Contextual relevance and theme heat

**Date:** 2026-09-14  
**Status:** Approved design  
**Release target:** Obsidian Gmail CRM `0.9.2` and the existing People Graph Worker

## Purpose

Keep the current photographic relationship explorer intact while adding an explainable, temporary relevance layer. The map should show not only that two people shared an email or meeting, but also the themes around them, what they appear to be working on, what is active in the user's attention now, and which people can bridge those areas.

The product should create serendipity without turning weak signals into facts. Every theme, heat value, connector treatment, and recommendation must remain inspectable and correctable.

## Direct meeting takeaways and our decisions

### John — directly attributed takeaways

- Relationship strength and connector nodes are two key graph dimensions. Email frequency can proxy for relationship weight, while prolific introducers such as Harper and Gilad should "glow." John also said working on one's own graph matters because the owner has an intuitive human map of the data. Source: [Sep 9 · People graph visualization and Astro integration exploration](https://notes.granola.ai/d/7a875b4f-dedf-4aa1-be51-f7cb6a83bd69).
- The graph needs experimentation and should reveal relevant adjacent people around a recommendation, not only one obvious node. Source: [Aug 17 · Kaya and JB](https://notes.granola.ai/d/639d6b8a-69ee-4f99-bcaa-60e98057aad2).
- Seventeen years of email is too much to ingest indiscriminately. Prefer recent windows and people/freshness thresholds to choose where deeper retrieval is worthwhile. Source: [Aug 17 · Kaya and JB](https://notes.granola.ai/d/639d6b8a-69ee-4f99-bcaa-60e98057aad2).
- Human judgment must be able to override graph scoring, and a reconnect should include the reason for the match and its connection to current meetings. Source: [Aug 11 · JB / Kaya](https://notes.granola.ai/d/eb0b95f3-44b9-4a06-bd57-b87a38e3d76e).

### Relevant meeting context not directly attributed to John

- The shared contact record should stay minimal while each person's richer relationship context remains separate; merging viewpoints creates misleading averages. Sources: [May 15 · Kaya +JB](https://notes.granola.ai/d/59da244b-dfe9-44c5-a469-4e491036e9e2) and [May 22 · Kaya](https://notes.granola.ai/d/a926386b-f15d-41ce-809b-7e0854f2f355).
- The current plugin derives relationship scores from Gmail metadata rather than message bodies and proposes selective sync by recency or score. Source: [Jul 27 · People scoring plugin, graph visualization, and Granola API updates](https://notes.granola.ai/d/081be075-3394-4e50-9530-1aaffb595a05).

These points are kept out of the "John — directly attributed" list because the notes do not identify him as the speaker for those statements.

### Repeated themes that become product requirements

| Repeated theme | Meeting evidence | Product requirement |
| --- | --- | --- |
| Context beats a universal static map | [Aug 17](https://notes.granola.ai/d/639d6b8a-69ee-4f99-bcaa-60e98057aad2), [Sep 9](https://notes.granola.ai/d/7a875b4f-dedf-4aa1-be51-f7cb6a83bd69) | The graph must remap through explicit lenses while preserving the user's spatial layout and direct-manipulation workflow. |
| Recent, selective context beats bulk history | [Jul 27](https://notes.granola.ai/d/081be075-3394-4e50-9530-1aaffb595a05), [Aug 11](https://notes.granola.ai/d/eb0b95f3-44b9-4a06-bd57-b87a38e3d76e), [Aug 17](https://notes.granola.ai/d/639d6b8a-69ee-4f99-bcaa-60e98057aad2) | Default to lightweight recent signals; make deeper body retrieval explicit, bounded, inspectable, and disposable. |
| A score is advisory, not truth | [Aug 11](https://notes.granola.ai/d/eb0b95f3-44b9-4a06-bd57-b87a38e3d76e), [Aug 17](https://notes.granola.ai/d/639d6b8a-69ee-4f99-bcaa-60e98057aad2), [Sep 9](https://notes.granola.ai/d/7a875b4f-dedf-4aa1-be51-f7cb6a83bd69) | Separate relationship, relevance, and connector scores; explain every treatment and provide correction, pin, mute, and expiry controls. |
| Serendipity comes from adjacent people and connector paths | [May 15](https://notes.granola.ai/d/59da244b-dfe9-44c5-a469-4e491036e9e2), [Aug 11](https://notes.granola.ai/d/eb0b95f3-44b9-4a06-bd57-b87a38e3d76e), [Aug 17](https://notes.granola.ai/d/639d6b8a-69ee-4f99-bcaa-60e98057aad2), [Sep 9](https://notes.granola.ai/d/7a875b4f-dedf-4aa1-be51-f7cb6a83bd69) | Surface a few non-obvious adjacent discoveries with a trusted introduction path, a concrete "why now," and evidence uncertainty. |
| Shared identity and subjective relationship context need different boundaries | [May 15](https://notes.granola.ai/d/59da244b-dfe9-44c5-a469-4e491036e9e2), [May 22](https://notes.granola.ai/d/a926386b-f15d-41ce-809b-7e0854f2f355) | Store identity, private assertions, firm-shareable assertions, and public evidence in distinct permission domains. |

### Our conclusions

- Theme heat, personal relevance, connector leverage, and relationship strength are different signals and must never share one visual encoding or one score.
- A theme field means "this subject is active in this lens now." A node pulse means "this person is currently relevant to the active subject." A connector ring means "this person structurally bridges people," with evidence quality visible. A line continues to mean a recorded relationship or contextual association.
- Automatic lightweight discovery should run from recent metadata and existing notes. Deeper email-body analysis is explicit, bounded, and on demand.
- Public evidence may enrich a theme, but it remains visibly separate from private first-party evidence and never silently changes a private relationship judgment.

Granola enhanced notes are useful retrieval evidence but can contain summarization errors. Speaker-specific claims remain linked to their meeting source and can be corrected in the product.

## Approved product behavior

### Existing layout remains the product

Do not replace the current header, source selector, search, graph canvas, path finder, evidence panels, session trails, all-results directory, or responsive behavior.

Add a removable **Relevance now** lens with four choices:

- **My mind:** owner-scoped recent signals and explicit feedback.
- **Firm:** only firm-shareable signals visible to the signed-in user.
- **Public momentum:** only public, timestamped sources.
- **Off:** the exact current relationship graph without heat.

The selected visual intensity is **Balanced**:

- Soft, labeled theme fields sit behind the graph.
- A small number of highly relevant people receive restrained pulses.
- Connector rings remain visually distinct from heat.
- Text, photographs, relationship labels, path emphasis, and evidence stay dominant.
- Motion respects `prefers-reduced-motion`; reduced-motion and print modes use static borders and opacity rather than animation.

### Theme fields

Themes are canonical entities with aliases, not unstructured decorative labels. A theme may come from email, a meeting, an Obsidian note, a public source, or an explicit user action.

On the canvas:

- A theme is drawn as a soft field with its canonical name and a compact reason such as "3 recent notes · meeting tomorrow."
- People may belong to more than one field. Overlap is intentional and creates adjacent discovery.
- Selecting a theme narrows the directory, emphasizes related people, and opens its evidence panel.
- Selecting a person continues to center that person and reveal their relationships; their current themes become a secondary layer.
- Introduction paths traverse people and trusted personal edges only. Theme associations and co-occurrence may explain a route but never prove that an introduction is possible.

### Why this is hot now

Clicking a field, pulse, or relevance badge opens a **Why this is hot now** panel containing:

- a plain-language reason;
- score components and their dates;
- separate private, firm, and public evidence groups;
- source freshness and extraction method;
- actions to pin, mute, correct, expire, or retrieve more context;
- a link or safe reference back to the source when permitted.

No glow may appear without at least one visible reason. The UI must never present a subject line, public article, or generated summary as a verified claim about a person.

## Signal architecture

### Automatic baseline

The existing relationship score remains unchanged:

- strength derives from interaction volume and reciprocity;
- momentum derives from recency;
- the combined relationship score remains separate from theme relevance.

An incremental signal collector creates lightweight theme candidates from:

- Gmail subject, participant, and timestamp metadata;
- calendar event titles and accepted meetings;
- Granola and Obsidian summaries, decisions, action items, and `Key Themes` sections;
- searches, pinned themes, saved paths, corrections, and explicit mutes inside the product;
- public URLs and RSS/Atom sources explicitly attached to a person or company.

For `0.9.2`, Granola and Obsidian signals arrive only through the existing local plugin/vault processing path and its authenticated graph push. This release does not add a server-side Granola OAuth connection or silently crawl the user's vault. If those local sources are absent or disabled, Gmail metadata, calendar metadata, product activity, and explicitly attached public sources still produce the baseline.

The `0.9.2` public-source implementation supports explicit company/person URLs and RSS/Atom feeds. It does not bulk scrape LinkedIn, bypass access controls, or infer current employment from an email domain. Later provider adapters must use an authorized API or connector and preserve the same provenance contract.

### Selective deep retrieval

The web graph offers **Retrieve more context** only from a selected person or theme. The confirmation preview shows:

- the Gmail account being queried;
- the selected person or theme;
- a default 30-day window and an optional 90-day window;
- a hard cap of 50 messages and 1 MB of decoded text per request;
- that bodies are analyzed ephemerally and are not retained.

After confirmation, the existing per-owner Durable Object:

1. obtains a fresh Gmail token from the already-authorized account;
2. retrieves only matching messages in the approved window;
3. strips attachments, quoted history, common signatures, tracking markup, and unsafe HTML;
4. sends bounded plain text to a `ThemeExtractor` adapter;
5. validates the adapter's structured output against a strict schema;
6. stores only theme assertions, generated summaries, dates, confidence, model version, and opaque source references;
7. discards decoded bodies before returning or scheduling more work.

The Worker must not log message content, prompts containing message content, model output containing raw bodies, OAuth tokens, or source references that reveal another tenant. A retrieval request is idempotent by owner, scope, window, source revision, and extractor version.

The first implementation uses a Cloudflare AI binding behind the `ThemeExtractor` interface. Deep retrieval fails closed when the binding or configured model is unavailable; automatic metadata heat and the existing relationship graph continue to work. Deployment chooses and pins a currently supported structured-output-capable model and records the exact model identifier on every extracted assertion.

### Public enrichment

Public fetches are opt-in per URL or feed and use conditional requests, content-type and size limits, redirect limits, private-network blocking, and a bounded text extractor. Public content produces public-only signals. Failed or stale public sources do not delete private signals.

Each public assertion includes the canonical URL, publisher, published or observed time, retrieved time, content hash, confidence, and extractor version. The UI labels an observed retrieval time when no trustworthy publication time exists.

## Data model

All records are owner-scoped unless their visibility explicitly permits firm sharing.

### Theme

```ts
interface Theme {
  id: string;
  owner: string;
  canonicalName: string;
  aliases: string[];
  description: string;
  status: "active" | "muted" | "merged";
  mergedInto?: string;
  createdAt: string;
  updatedAt: string;
}
```

### Theme signal

```ts
interface ThemeSignal {
  id: string;
  owner: string;
  personId?: string;
  themeId: string;
  sourceType:
    | "gmail_subject"
    | "gmail_body_derived"
    | "calendar"
    | "granola"
    | "obsidian_note"
    | "product_activity"
    | "public_url"
    | "public_feed";
  visibility: "private" | "firm" | "public";
  observedAt: string;
  ingestedAt: string;
  confidence: number;
  summary: string;
  evidenceRef: string;
  contentHash: string;
  extractorVersion: string;
}
```

### Relevance feedback

```ts
interface RelevanceFeedback {
  id: string;
  owner: string;
  themeId: string;
  personId?: string;
  action: "pin" | "mute" | "correct" | "expire";
  replacementThemeId?: string;
  expiresAt?: string;
  createdAt: string;
}
```

Corrections are append-only events. Materialized theme state may be rebuilt from signals and feedback so actions remain reversible and auditable.

## Relevance and connector scoring

### Relevance heat

Each permitted signal contributes:

```text
contribution = source weight × confidence × exp(-age / source half-life) × feedback multiplier
```

Initial source weights and half-lives are versioned configuration:

| Signal | Weight | Half-life |
| --- | ---: | ---: |
| Explicit product activity | 1.20 | 7 days |
| Meeting/action item | 1.00 | 30 days |
| Obsidian or Granola note | 0.95 | 45 days |
| Gmail body-derived assertion | 0.90 | 30 days |
| Gmail subject hint | 0.45 | 14 days |
| Public article/feed | 0.60 | 21 days |

A pin supplies a visible floor until its expiry; it does not falsify underlying evidence. A mute removes the theme from the selected personal lens without deleting evidence. Scores are normalized to 0–100 within the selected lens and include a version identifier. The UI shows relative heat, not a claim of objective importance.

### Connector treatment

Connector leverage is computed independently from relevance heat:

- A solid connector ring requires documented personal or introduction edges.
- A dashed ring may indicate a structural bridge derived only from co-occurrence; it must say that introduction ability is unverified.
- Shared email recipients alone never produce the label "can introduce."
- The score uses unique documented neighborhoods and bounded betweenness/path participation, with an explanation available from the node panel.

### Theme-to-person association

Theme associations are assertions, not personal relationship edges. They may influence search, clustering, and serendipity ranking but never enter trusted introduction path traversal.

## Serendipity ranking

The system surfaces a small number of adjacent discoveries rather than a wall of recommendations. A candidate ranks higher when it has:

- high relevance to an active theme;
- a meaningful but non-obvious graph distance;
- a strong or documented connector path;
- recent evidence;
- diversity from people already viewed;
- no mute, suppression, permission conflict, or unresolved identity ambiguity.

Each recommendation explains the active theme, unexpected bridge, evidence freshness, and relationship uncertainty. The user can save the path, inspect evidence, snooze it, mute it, or correct the theme. Nothing sends outreach or requests an introduction without an explicit later action.

## API and module boundaries

The implementation adds focused units rather than expanding the renderer or sync object into one large module:

- `theme-model`: schemas, normalization, aliases, visibility, and evidence references.
- `theme-candidates`: deterministic candidate generation from metadata and imported notes.
- `theme-extractor`: provider-neutral structured semantic extraction.
- `relevance-score`: pure time-decay and feedback calculations.
- `connector-score`: pure connector metrics with evidence-class distinctions.
- `theme-store`: owner-scoped persistence, deduplication, corrections, and retrieval jobs.
- `public-sources`: guarded URL/feed retrieval and checkpointing.
- `relevance-routes`: authenticated preview, confirm, status, evidence, feedback, and source endpoints.
- `heat-overlay`: theme fields, pulses, connector rings, lens controls, and accessible non-visual summaries.

Proposed authenticated endpoints:

- `GET /api/relevance?lens=my|firm|public`
- `GET /api/themes/:id/evidence`
- `POST /api/retrieval/preview`
- `POST /api/retrieval/confirm`
- `GET /api/retrieval/:id`
- `POST /api/themes/:id/feedback`
- `POST /api/public-sources/preview`
- `POST /api/public-sources/confirm`

Every mutation requires same-origin checks, the verified owner session, bounded JSON, and an idempotency key. Preview creates no source, signal, job, or body fetch. Confirm is the only operation that starts retrieval.

## Permissions and multiplayer

- Private signals remain visible only to their owner.
- Firm heat includes only assertions deliberately marked firm-shareable; it does not expose private snippets or private scoring components.
- Public heat contains public sources only.
- Sharing a theme assertion does not automatically share its evidence.
- Identity, assertions, evidence, and feedback retain separate permission checks.
- A user without permission sees neither the hidden person/theme association nor its heat contribution.

The Gmail CRM Worker remains tenant-isolated. BetaworksOS may later aggregate permitted firm signals through its existing assertion/evidence sharing model; `0.9.2` does not silently create cross-user sharing.

## Failure behavior

- Gmail permission or token failure marks the source as unavailable and offers reconnect; existing graph data remains usable.
- AI binding or model failure records a safe job error without storing bodies; the user may retry.
- Malformed model output is rejected and creates no assertions.
- Public fetch failure preserves the previous successful revision and displays its freshness.
- Stale extraction responses cannot replace a newer retrieval or lens selection.
- Unsupported or unsafe URLs fail during preview.
- Large result sets remain fully searchable while the canvas renders a bounded subset.
- An image failure falls back to initials without affecting heat or selection.

## Migration and compatibility

- Existing contact, message metadata, photo, relationship, and graph records remain valid.
- Theme tables and indexes are additive and created idempotently.
- Existing `/api/graph` clients continue to receive the current node and edge fields. The response may add a versioned `themes`, `themeSignals`, and `relevance` section; old clients ignore it.
- Obsidian graph pushes add versioned theme assertions only when enabled. The server accepts old payloads.
- Existing source selection, authentication, account refresh, sign-out, spatial view, and classic graph remain available.

## Testing and acceptance

### Pure logic

- candidate normalization, alias merging, and unsafe/malformed rejection;
- deterministic time decay at fixed timestamps;
- lens and permission filtering;
- pins, mutes, corrections, expiry, and score versioning;
- trusted versus inferred connector metrics;
- theme associations excluded from introduction traversal;
- idempotency and stale-generation protection.

### Gmail retrieval

- preview causes no Gmail body request or write;
- confirm fetches only the selected account/scope/window;
- 30/90-day, 50-message, and 1 MB caps are enforced;
- attachments, quotes, signatures, and unsafe HTML are excluded;
- bodies do not enter Durable Object storage, application logs, API responses, or error messages;
- structured-output validation and model failures leave no partial assertions;
- disconnect removes account-owned retrieval jobs, signals, and opaque references.

### Public retrieval

- private-network, credentialed, non-HTTP, oversized, redirect-loop, and unsafe content requests are rejected;
- conditional fetches, hashes, publication dates, and stale source preservation work;
- public assertions never inherit private visibility.

### Browser acceptance

- existing graph layout remains visually and behaviorally intact with the lens off;
- Balanced fields, pulses, solid/dashed connector rings, and explanations render correctly;
- My/Firm/Public/Off lenses cannot leak hidden signals;
- why-now evidence, retrieve preview/confirm, progress, feedback, and source links work;
- paths, evidence panels, session trails, search, history, refresh, account switching, expiry, and sign-out remain correct;
- 320 px mobile, keyboard operation, reduced motion, image failure, empty states, and 1,500-person graphs pass.

### Live acceptance

- authenticate with a real account and confirm metadata heat without body analysis;
- run one explicitly confirmed bounded retrieval and verify no raw body persistence;
- verify a real contact photo still renders;
- add one safe public feed and inspect provenance;
- confirm another tenant cannot see any theme, signal, retrieval job, or evidence;
- confirm `/spatial` and `/classic.html` remain available.

## Release `0.9.2`

Release only after all repository tests, type checks, browser acceptance, production build checks, security/privacy assertions, and live smoke tests pass.

The release sequence is:

1. update plugin version metadata and compatibility mapping to `0.9.2`;
2. build the committed plugin bundle and hosted Worker assets;
3. deploy the Worker and retain the prior deployment for rollback;
4. push the completed feature branch;
5. integrate the release commit into `main` without overwriting unrelated work;
6. create and push annotated tag `0.9.2` from the verified release commit;
7. publish a GitHub release containing `main.js`, `manifest.json`, `styles.css`, and release notes;
8. verify the public tag, release assets, checksums, hosted graph, authentication gate, and rollback version.

The release notes must state that theme heat is advisory, body retrieval is explicit and bounded, public and private signals are separate, raw bodies are not retained, and no action or introduction is sent automatically.

## Non-goals for `0.9.2`

- Bulk mailbox-body ingestion or historical backfill.
- Bulk LinkedIn scraping or access-control circumvention.
- Autonomous outreach, introduction requests, or CRM writes.
- Treating themes as verified expertise, employment, or intent.
- Merging private relationship viewpoints into a firm-wide average.
- Replacing the current graph layout or removing previous visualizations.
