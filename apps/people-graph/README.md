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
