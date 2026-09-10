# People Graph

Spatial discovery viewer for the obsidian-gmail-crm people graph. Perspective orbit/zoom, person and company evidence cards, local drafts and shortlists, backed by the existing Google sign-in and per-user graph snapshot. The previous force-directed viewer remains at `/classic.html`. Cloudflare Worker + D1 + static assets; no frontend build step.

**Multi-tenant:** the tenant key is the Google-verified People sign-in email. Each owner can connect up to ten Google inboxes. Connected inboxes contribute to that owner's network; they do not change the People login identity.

**Privacy:** cloud import stores message IDs, participant addresses, names, subjects and dates in a per-owner Durable Object. Refresh grants are encrypted using a dedicated server secret. Message bodies and attachments are never requested. Browser graph responses use tenant-scoped opaque IDs and email-domain labels. The optional Obsidian snapshot uses its existing vault-hashed IDs. Disconnect removes an inbox's stored grants and imported contributions; it does not delete Gmail messages. Gmail deletions are not otherwise reconciled.

## Flow

1. Sign in to People and open **Accounts**.
2. Choose **Last 90 days** or **All history**, then **Connect Google account** and approve access in Google.
3. Import, relationship scoring and graph updates run automatically. Add another inbox the same way.

Imports continue when the page closes. Connected accounts refresh hourly; the graph checks for updates every 15 seconds while visible. Sync now runs an incremental import; Import all history includes older messages. Failed requests retry with backoff, and revoked access prompts reconnection.

After cloud contacts exist, the default graph uses connected email accounts. The original vault snapshot remains available with `/?source=obsidian`, and Connect Obsidian retains the legacy push-token flow. Sources are not merged because vault IDs cannot reliably be matched to mailbox identities.

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

## Development

```sh
npm run typecheck
npm run smoke        # end-to-end against wrangler dev --local
```

## Spatial discovery

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
