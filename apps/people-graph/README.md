# People Graph

Spatial discovery viewer for the obsidian-gmail-crm people graph. Perspective orbit/zoom, person and company evidence cards, local drafts and shortlists, backed by the existing Google sign-in and per-user graph snapshot. The previous force-directed viewer remains at `/classic.html`. Cloudflare Worker + D1 + static assets; no frontend build step.

**Multi-tenant:** the tenant key is a Google-verified email. Anyone can sign
in; each account sees only the graph pushed from its own vault. No sharing.

**Privacy:** contact email addresses never reach this Worker. The plugin
hashes them with a vault-local salt into opaque node ids; the blob holds
names, scores, edge weights, and edge contexts (e.g. meeting titles). The
only email stored is the tenant's own sign-in address (the row key).

## Flow

1. Open the page, sign in with Google, click **Get my push token**.
2. In Obsidian → Gmail CRM settings, set **Graph push URL** to this app's URL
   and paste the token into **Graph push token**.
3. Run the command **Push people graph to web**, reload the page.

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
