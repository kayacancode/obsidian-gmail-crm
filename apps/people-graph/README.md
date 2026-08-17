# People Graph

Force-directed viewer for the obsidian-gmail-crm people graph: contacts as
nodes (size = combined score, color = relationship quadrant), connections as
weighted edges (wiki-links, shared meetings). Cloudflare Worker + D1 + static
assets, no build step — same shape as `apps/reconnect-web`.

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
