# People Graph

Private relationship viewer for the obsidian-gmail-crm people graph, backed by the existing Google sign-in and per-user graph snapshot. The default route uses the shared BetaworksOS photographic graph: complete recorded-text search, labelled relationships, evidence inspection, arbitrary introduction paths and session-only saved route context. The former spatial viewer remains byte-for-byte available at `/spatial`, and the force-directed viewer remains at `/classic.html`. Cloudflare Worker + D1 + static assets; no frontend build step.

**Multi-tenant:** the tenant key is the Google-verified People sign-in email. Each owner can connect up to ten Google inboxes. Connected inboxes contribute to that owner's network; they do not change the People login identity.

**Privacy:** cloud import stores message IDs, participant addresses, names, subjects and dates in a per-owner Durable Object. Refresh grants are encrypted using a dedicated server secret. Normal sync never requests message bodies or attachments. A separate, explicit **Retrieve more context** confirmation can transiently read up to 50 matching messages from the selected inbox and time window, with a cumulative 1 MB decoded-body cap; raw bodies are discarded after extraction and are never retained in SQL, KV, graph responses or logs. Browser graph responses use tenant-scoped opaque IDs and email-domain labels. The optional Obsidian snapshot uses its existing vault-hashed IDs. Disconnect removes an inbox's stored grants and imported contributions; it does not delete Gmail messages. Gmail deletions are not otherwise reconciled.

## Flow

1. Sign in to People and open **Accounts**.
2. Choose **Last 90 days** or **All history**, then **Connect Google account** and approve access in Google.
3. Import, relationship scoring and graph updates run automatically. Add another inbox the same way.

Imports continue when the page closes. Connected accounts refresh hourly; the graph checks for updates every 15 seconds while visible. Sync now runs an incremental import; Import all history includes older messages. Failed requests retry with backoff, and revoked access prompts reconnection.

After cloud contacts exist, the default relationship graph uses connected email accounts. The original vault snapshot remains available with `/?source=obsidian`, and Connect Obsidian retains the legacy push-token flow. Sources are not merged because vault IDs cannot reliably be matched to mailbox identities. A saved path is held only for the current authenticated browser session, is bound to its account and graph generation, and is cleared when that context changes.

## Setup (once)

```sh
npm install
npx wrangler d1 create people-graph   # paste database_id into wrangler.jsonc
npm run db:init:remote
npx wrangler secret put TOKEN_SECRET  # long random string; rotating it revokes all push tokens
npm run deploy
```

Then add the deployed origin (e.g. `https://people-graph.<account>.workers.dev`)
to the Google OAuth client's authorized JavaScript origins (same client as
reconnect-web).

## Enable Google inbox connections (one administrator setup)

The existing web OAuth client must have Gmail API access and the callback below registered as an authorized redirect URI:

`https://people-graph.kayarjones901.workers.dev/api/accounts/callback`

Use the matching web-client secret (not the desktop plugin OAuth client). Set secrets interactively from this directory:

```sh
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put MAIL_TOKEN_KEY
```

Use a fresh cryptographically random key for MAIL_TOKEN_KEY. Keep it stable: changing it makes existing encrypted grants unreadable and requires reconnecting inboxes. Never put either secret in source control or chat. APP_ORIGIN and GOOGLE_CLIENT_ID are configured in wrangler.jsonc. Deploy the MailSync SQLite Durable Object migration with the Worker. The Accounts connection button stays disabled until server configuration exists. Verify a real consent callback and completed import before considering inbox connections activated.

The OAuth consent screen must permit the intended users and requested Gmail read scope. Its publication/verification settings are an administrator responsibility; browser fixture tests cannot validate them.

Email scores use frequency, reciprocity and recency, independently of the optional vault's scoring model. Domain groups are not verified employers. Shared-email edges mean co-recipients, not confirmed introductions.

## Contextual relevance and evidence

Relevance heat is an advisory view of recent metadata and user-confirmed evidence, not a measure of relationship strength, expertise, closeness, consent or willingness. Evidence remains partitioned by exact visibility: **My mind** can use all evidence authorized for that owner, **Firm** uses only explicitly firm evidence, and **Public momentum** uses only public evidence. Meeting-summary preview files remain local. The separate Granola connection below stores an encrypted API key and syncs meeting content — title, date, attendees, summary, private notes and transcript — into the graph in the background; that evidence is owner-private and never included in Firm or Public momentum. Obsidian material stays local unless the user explicitly pushes a bounded graph snapshot; public URLs are fetched only after a preview and confirmation.

Connector rings summarize documented or inferred graph structure. They do not prove that anyone is close to the user, willing to help, or able to make an introduction. The system never sends outreach, emails or introduction requests; it only presents context for a person to review and act on themselves.

The top **Topics & themes** strip labels each theme's source; all themes remain in its picker. Gmail's normal sync supplies subject-derived signals, not body-understood topics. The overview promotes up to five non-boilerplate themes and paints at most three localized fields; selecting a theme focuses one field and brings its members into view. Up to three labeled **Why now** controls expose evidence at close zoom. The full authorized network occupies a spaced world canvas: **Fit** frames every person, drag/arrow keys pan, and zoom or selection reveals names and details. Portraits, heat and labels share one camera transform; viewport size never caps the network. **Off** removes heat without moving the current people.

An **Ask your network** search field above the graph lets you type a question — "who can help with…" — and ranks your people against it using their attached evidence rather than a plain keyword match; when TypeSafe is configured the results carry a **Ranked by Jev** label, and otherwise fall back to a keyword-only ranking labeled **Keyword match only**. Selecting a result focuses that person in the graph the same way clicking their node does.

## Granola sync

Open **Accounts → Granola** (or `/accounts?tab=granola`), sign in to People, paste a Granola API key and choose **Last 90 days** or **All meetings**. The key is stored encrypted on the server (same protection as Gmail refresh tokens) so meetings sync in the background and refresh hourly. Every folder syncs by default; uncheck a folder to hide its meetings from your graph and stop syncing it. **Disconnect** removes the key and everything imported.

What is imported per meeting: title, date, link, folder membership, attendees, the Granola summary, your private notes and the transcript (capped at 400,000 characters per meeting). Attendees become people using the same identity as Gmail contacts, so a person you email and meet is one node; each meeting counts as one reciprocal interaction in the relationship score. Co-attendance becomes a **shared meeting** edge. The connected-email graph still draws at most 1,500 people, a cap now shared between Gmail contacts and meeting attendees and filled in order of interaction count. Sync holds at most 20,000 notes; once existing meetings reach that limit, new meetings stop importing and the card shows **Meeting limit reached; newest meetings are kept.**

Workers AI reads the summary, private notes and transcript (in bounded chunks) and returns allowed topics plus per-attendee statements (ask, commitment, intro, follow-up, interest). A statement is kept only when it names an attendee and quotes the source verbatim; the graph shows the label and the quote, never model-written prose. Statements and topics appear in the why-now panel under a theme — a Granola folder that TypeSafe (see below) judges the meeting belongs to when configured, else the note's first folder, else a matched topic, else Meetings — and decay from the meeting date. The panel shows each meeting statement as text only: source chips, a link back to the note in Granola and a **shared meeting** entry in the edge legend are not shown yet and are planned as a follow-up. Everything is owner-private: the Firm and Public momentum lenses never include Granola evidence.

Deletions in Granola reconcile weekly. A revoked key shows **Reconnect required** on the card and pauses sync without deleting anything. Run `npm run test:granola-browser` against a local server for the fictional card tests.

## TypeSafe (Jev) judgments

Granola sync, note drafting and network search can optionally call [TypeSafe](https://typesafe.ai)'s Jev model to make small, typed judgments instead of generating text. During extraction, Jev never writes anything: it is shown verbatim spans of your own meeting summary, private notes and transcript and picks, for each span, which attendee it is about and what kind of statement it is (ask, commitment, intro, follow-up, interest); the displayed statement stays your own words. Why-now heat combines Jev's calibrated urgency, open-loop and their-ask scores with the attendee match, in code, not by the model narrating a score. Each meeting's theme is chosen over your own Granola folders and a fixed topic list, so a statement lands under the folder or topic Jev judges the meeting belongs to. Every outreach draft from **Draft a note** is checked before it is shown to you: Jev flags a draft that states something not present in your evidence, reads as too blunt or off-tone for a professional contact, or asks for money or credentials, and those warnings render above the draft. On the Accounts → Granola card, Jev also proposes identity matches — a meeting attendee who looks like an existing email contact — under **Possible matches**, which you confirm or dismiss yourself; confirming folds that attendee into the contact's node so future meetings and messages count toward the same person. In the graph, **Ask your network** lets you type a question and ranks your people against it using their evidence, rather than a plain keyword match.

Enable it from this directory with `npx wrangler secret put TYPESAFE_API_KEY`; an optional `npx wrangler secret put JEV_MODEL` overrides the model (default `jev-latest`). Without the key, every one of these features falls back to its previous behaviour: the Llama extractor, unchecked drafts, no identity suggestions, and keyword-only network search. Once the key is set, every meeting re-analyses once — the extraction version becomes `granola-v3-jev` — which shows up only indirectly, as theme chips and evidence change on the next sync. If TypeSafe rejects the key, extraction pauses and the Granola card shows a rejected-key message until the key is fixed.

TypeSafe bills for input tokens only; its output is free. Re-analysing from scratch runs on the order of 5–10 million input tokens for about 150 meetings, roughly 35–80k per meeting. What reaches TypeSafe: your own note text, sent as bounded spans rather than whole transcripts; attendee names and emails (and, for identity suggestions, the matched email contact’s name, address, domain and subject-line theme words); folder names; meeting titles; the evidence lines and text of a draft being checked; and, for an **Ask your network** search, the question together with each candidate's name, company, last-contact date and five newest evidence lines. The Granola API key never reaches Jev, and only your own graph is ever sent — never another owner's data.

## Sharing your network

From **Accounts → Sharing**, an owner can share a bounded slice of their own network with another People user by their sign-in email. The owner chooses who to share (all meetings, chosen Granola folders, or chosen people) and one of three levels: **Names and companies only** (who the owner knows and where they work), **Plus themes and meeting titles** (also theme names, topic/heat signals and the titles of the meetings those people were in, but no quotes), or **Plus quoted statements** (also short verbatim quotes from the owner's notes about those people). Nothing is shared until the owner explicitly creates the share, and the owner can change the scope or level at any time.

On the viewer's side, shared people are merged into the viewer's own graph and labelled "via `<owner>`" with a dashed ring on the portrait; a person the viewer already knows stays one node and just gains the `via` label and any newer last-contact date. The viewer never receives the shared person's email address, and never sees anything the level does not cover — no note text beyond a level-appropriate quote, no Gmail subject lines, no Granola note links. Shared evidence lands as `firm`-visibility signals under a synthetic account (`share:<owner>`), so it shows only in the **Firm** lens; it never appears in **Public momentum**, and never in the owner's own **My mind** lens for the viewer. The owner's key material and note contents never leave the owner's own object; only the slice described above crosses over.

A viewer can **Hide** an incoming share to decline it (their cached copy of that owner's people is dropped immediately) and **Show** it again later to bring it back. An owner can **Revoke** a share outright; revoking also drops the viewer's cached copy right away rather than waiting for a refresh. Aside from these immediate pushes, a viewer's cached shares are refreshed at most every 10 minutes on graph load, within a 20-second budget; that refresh also drops any owner who is no longer sharing with the viewer (revoked or hidden).

Drafting a note about someone the viewer knows only through a share never addresses that person directly: **Draft a note** instead produces an "Intro request to `<owner>`" addressed to the sharing owner, asking for an introduction, and says so in the draft body.

Limits: an owner can share with at most 50 viewers, and a viewer can hold at most 20 incoming shares.

To test locally with two accounts: sign in as owner A in one browser (or profile), go to Accounts → Sharing, and share with B's Google sign-in email; sign in as B in a separate browser profile, open the graph, and switch to the **Firm** lens to see A's shared people. `wrangler dev` reads secrets from `.dev.vars`. As a local-only shortcut, `demo/session.mjs <email>` mints a session cookie for any email against the local dev instance, letting you drive both sides without two real Google sign-ins.

## Private meeting preview

**Meeting preview** accepts a manually reviewed JSON distillation of at most five Granola notes and ten suggestions, scoped to the signed-in graph account. This pilot does not connect to Granola, fetch notes, call AI, or upload its file. Meeting summaries are never bundled with the public application. The batch and **Still relevant / Resolved / Dismiss** choices live only in browser memory; refresh, graph-source changes, account changes, and sign-out clear them. **Review meeting batch** retains resolved/superseded items for inspection without heat.

The file uses `version: 1`, an opaque `id`, `account`, `reviewedAt`, `notes` (`id`, `title`, `date`), and `themes` (`id`, `name`, `status`, `whyNow`, `suggestion`, `evidence`, `people`). Each evidence item binds `noteId`, `text`, and `attribution` to a note in the batch. Each person has `label`, `context`, `matchName`, and `matchCompany`; the last two are either both null (unmatched) or an exact unique name/organization match, explicitly labeled suggested in the UI. Ambiguous and restricted identities never get heat. No relationship edges are created.

The private preview appears only under **My mind**. Its transparent priority heuristic starts at 40 plus 10 per distinct source meeting, capped at 80, with a 14-day half-life and a 45-day cutoff based on meeting dates, not import dates. A **Still relevant** confirmation gives a 65-point floor for seven days; this is advisory preview priority, not confidence or relationship strength. This small-batch UI validates a reviewed distillation; it is not an automated topic-extraction or proactive-notification pipeline.

Run `npm run test:meeting-preview-browser` against the local development server to exercise import, privacy, evidence links, review controls, and lifecycle clearing with fictional data.

## Development

```sh
npm run typecheck
npm run smoke        # end-to-end against wrangler dev --local
```

## Relationship discovery

Search the full authorized graph by recorded names, companies, roles and relationship context. The canvas retains every returned person; only an explicit search or path view narrows the rendered set. Selecting people or themes moves the camera without replacing the network. The paginated directory remains an alternative, not the only way to reach off-screen people. Select a person, inspect labelled links and their source context, compare arbitrary routes, and return to the prior canvas state. Co-recipient routes are marked as requiring verification; path output is never a claim that someone is willing to make an introduction.

A person panel action, **Draft a note**, writes an editable outreach draft from that person's why-now evidence for you to copy or open in your mail client; nothing is sent from the app. When TypeSafe is configured, each draft is checked before you see it, and the dialog shows warnings above the draft for anything it flags as unsupported by your evidence, off-tone, or a request for money or credentials.

The browser never writes the current graph or route to durable storage. API graph ownership must match the signed-in account, stale in-flight requests are ignored after account/source changes, and a sign-out is accepted only after the server confirms it.

Run `npm run test:relationship-browser` against the local Worker for account races, session isolation, source transitions, errors, path restore and 320px layout coverage.
Run `npm run test:readability-browser` for a 115-person/123-theme fixture, desktop/mobile spacing including long labels and zoom, bounded heat, off-canvas theme discovery, keyboard focus, and Off layout parity.

## Former spatial discovery (`/spatial`)

Search names, companies, roles and relationship context. Results show literal supporting evidence and label partial matches. This is local evidence retrieval, not a semantic AI answer or a live location/news service. Company cards aggregate recorded connection context and do not invent hiring, funding or current employment claims.

The scene shows up to 12 people and 8 company nodes. All results remain available in a paginated, keyboard-accessible list. Drag to rotate or use the rotation/zoom buttons. Photos use only Google-hosted contact images; older snapshots fall back to initials. New plugin pushes include optional role and photo fields. Raw contact email addresses and whole notes are not added to the snapshot.

Shortlists and drafts persist in this browser, separately for each authenticated account. They do not sync between devices. Storage failures retain session state and display a notice. Sign-out clears visible data and authentication; saved local drafts remain available on subsequent sign-in. Export a shortlist as JSON, or copy a draft into your email client. Nothing sends or schedules messages.

Use **Connect Obsidian** to obtain a push token even if a graph already exists. Refresh fetches the latest snapshot. API responses are marked no-store, and in-flight results from previous sign-ins are ignored.

Validation:

```sh
npm test
npm run typecheck
npm run smoke
# Serve public/ on localhost:4183, then with Playwright available:
npm run test:browser
```

Browser tests substitute Google and the graph API with test fixtures. They cover sign-in, expiry, server errors, first push setup, two-account isolation, draft/shortlist persistence, storage failure, search/evidence navigation, bounded scene, pagination, and mobile overflow. They do not replace a live Google OAuth check.

## Ten-view spatial lab

Open `/lab/` from **3D lab** in the viewer navigation. Each experiment has a direct URL, for example `/lab/?view=city`. Available view IDs: `galaxy`, `orbits`, `helix`, `city`, `sphere`, `bridges`, `terrain`, `islands`, `panel`, `tunnel`.

The gallery defaults to clearly labeled fictional data. **Use my network** explicitly fetches the current signed-in owner's graph through the existing authenticated API. An expired session leaves the demo labeled as demo and offers a sign-in link. Private data is held in page memory; it is not added to URLs or browser storage. Refreshing the page starts the demo again. This experimental gallery does not poll for updates.

Each view uses 3D coordinates, perspective projection, depth shading and orbit/zoom controls rendered locally on Canvas. Keyboard camera controls and an accessible person list accompany mouse/touch picking. Search uses recorded text through the shared model. A view displays up to 96 matching people with a paginated list; users can narrow the search. The scene fits large groups automatically. Panel shortlists are local to the open page session.

Mappings are described in each scene. Company/domain groups are not inferred employment; topic islands use frequent context words, not verified expertise; the globe is not geography. Time layouts show last-contact dates, not complete message history. Canvas point size reflects recorded degree.

Run `npm run test:lab-browser` against the local static server, with Playwright available as documented above. It exercises all ten layouts, person evidence, shortlist interaction, camera controls, empty search, pagination, authentication gating, source switching and mobile overflow.

## Material studies

`/studio/` offers three distinct visual treatments: `?theme=architecture` (WebGL glass towers, landscaped base and architectural lighting), `?theme=editorial` (paper portrait collage), and `?theme=pastel` (portrait discs and translucent context cards based on the supplied wireframes). The existing ten-view lab remains available separately.

All three use the shared search/graph model and explicit demo/private data switch. Demo portraits are locally generated SVG illustrations of fictional people. Real contacts display their approved photo URL or initials; illustrations are never assigned to real contacts. Architecture paginates six groups, the portrait scenes eight people. Tower floor counts use normalized square-root counts to keep large organizations visible. Shortlists are in page memory only. Select groups/people, search recorded context, drag or use arrow-key camera controls, and switch themes without losing the current query or shortlist.

`npm run test:studio-browser` covers all three views, scene selection, context cards, search, shortlist, camera controls, mobile overflow, invalid theme fallback, authentication gating, and private/demo separation. It uses mocked graph responses; existing backend authentication is unchanged.

The architecture study now uses a lazily loaded, locally bundled Three.js renderer with orbit/pinch/scroll controls, tower focus and raycast floor selection. It renders on demand and merges static details by material to reduce draw calls. Each displayed tower offers a sample of people through floor selection; its organization button opens the complete matching roster. Shapes and illuminated windows are artistic interpretations, not real properties or activity indicators. A WebGL failure preserves the organization buttons and context panel.

Run `npm run build:district` after editing `src/visuals/district.mjs`; commit the generated `public/studio/district.bundle.mjs` and the Three.js license. `npm run deploy` rebuilds it automatically. `npm run test:district-browser` additionally checks rendering budget, 1,500-person framing, raycast selection, repeated data rebuild/disposal, theme switching and renderer-load fallback.

### Inside a building

Selecting a district tower or organization button now enters a company workspace. The 3D room displays eight selectable miniature people per directory floor. Selecting a figure or directory row opens person details and shortlist actions. People/Context tabs and company-scoped search support exploration. Floors are a paginated directory, not inferred offices or teams.

Back to district and browser Back/Forward restore the exterior/interior transition. Navigation uses opaque history keys with an in-memory route map; company names are not added to URLs. Source changes clear the interior, shortlist and route map. Theme changes leave the room. Missing WebGL still permits the company directory and context panel. Room textures and geometry are disposed when rebuilding.

Run `npm run test:building-browser` for interior navigation, scoped search, directory floors, person/context selection, shortlist, mobile, history and source reset. The district renderer test also verifies raycast selection inside the room.

Interior people now use articulated, faceless miniature figures with colored clothing. They walk along bounded local paths, stop under the pointer or when selected, and show a small name label on hover/selection. They are illustrative representations, not inferred appearance or live presence. Movement can be paused and follows the browser's reduced-motion preference. Animation runs at a maximum of approximately 30 FPS only in a visible interior; exterior navigation, hidden tabs, context loss and disposal stop it. Run `npm run test:figures-browser` for animation, pause, selection, reduced-motion and cleanup checks.

## People World

`/world/` is a separate pixel-art town inspired by the Software World reference, with original Canvas graphics. Enter a company building to explore its office: desks, lounge, meeting table, and selectable characters. Directory buttons provide the same interactions as the canvas. Search recorded people/context, highlight connection participants, and build a session-only shortlist.

Town pages contain up to 12 company groups; office pages contain up to 16 matching people. Buildings group recorded company labels or email domains. Character appearances, movement, furniture and locations are illustrative, not live presence. Context comes from attached graph snippets, not live events. Pause walking and reduced-motion preferences stop animation; hidden tabs stop rendering. Drag/arrow keys pan, scroll or +/- zoom, and Fit map resets framing.

The fictional demo opens by default. Use my network loads the existing authenticated graph; expired sessions retain the labeled demo with a sign-in link. Private data stays in memory and is never placed in URLs or storage. Source changes clear routes, selections and shortlists. Browser Back/Forward supports office navigation within the page session.

Run `npm run test:world-browser` against the static server with `PLAYWRIGHT_MODULE` pointing to Playwright when necessary. It checks navigation, person details, context, shortlist, search, source isolation, pagination, mobile/long labels, motion and canvas picking.

The Accounts screen now uses one primary Add Gmail inbox action, with import range and per-inbox management under optional disclosures. It checks the authenticated Obsidian graph once per owner/page and offers a direct link when a snapshot exists. This recognizes an existing network, not individual plugin-managed inboxes; OAuth grants and graph identifiers are not migrated. Missing server mail configuration is shown separately from connection notices. Accounts browser checks include owner-mismatched graph responses and configuration/empty/existing-network states.

## Full pastel network and contact photos

The main pastel scene now renders all people in the loaded snapshot (the email snapshot still caps at 1,500). Search and shortlist restrict membership; the side directory remains paginated. Dense scenes spread contacts through a sunflower layout, use smaller circles, and enlarge hovered/keyboard-focused/selected contacts. Zoom supports closer inspection. Relationship lines are sampled to 160 with selected edges first; company spokes are retained.

Google Contacts photos are imported with the optional `contacts.readonly` OAuth grant. Enable Google People API for the OAuth project. Existing Gmail-only accounts show **Enable contact photos**; approving Contacts access for the same inbox starts a new import. Gmail metadata itself does not include photos. `people/me/connections` pages through email addresses and photos, matches exact normalized email addresses, skips default avatars/unapproved hosts, and attaches available URLs to the graph. This covers saved Google Contacts and their available profile photos, not every email correspondent.

Photos are stored per inbox inside its owner's Durable Object, refreshed with sync jobs, reconciled after a complete photo listing, removed on disconnect or access denial, and never prevent Gmail imports when unavailable. No raw refresh token is returned to the browser. Run the mail tests and `test:all-people-browser` plus the main browser suite for coverage.

The photo lookup also supports automatically saved Other contacts via `contacts.other.readonly`. It requests both CONTACT and PROFILE sources explicitly, pages through saved contacts before Other contacts, and reconciles stale photos only when all authorized sources finish. Existing Contacts-only grants show **Include more contact photos**. Accounts reports usable email-photo mappings and overlap with imported email contacts; a completed lookup can legitimately return zero. These APIs do not provide an unrestricted profile-photo lookup for arbitrary email addresses.
