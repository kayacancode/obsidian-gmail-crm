# Reconnect Web

A names-only, Tinder-style swipe UI for reviewing daily reconnect suggestions, backed by a Cloudflare Worker + D1. Built for John's human-in-the-loop curation flow.

## How it fits together

```
Botwick machine (source of truth)             Cloudflare (this app)          John's phone
  peoplegraph reconnect (full pool)  ──POST /api/sync (diff)──►  Worker + D1  ──►  swipe UI
  apply swipes (overlay / delete)    ◄──GET /api/decisions──────              ◄──  right/left/🗑
```

**Privacy:** this app never receives emails or message content. The Botwick bridge
derives a **stable opaque id** per contact (HMAC of the email with a salt that never
leaves the machine) and keeps the `id → email` map locally; D1 only ever stores ids +
display fields. Because ids are stable, a swipe recorded on any day excludes that
contact from the deck forever.

## Swipe semantics

| Gesture | Action sent | Effect (applied by the bridge on pull) |
|---|---|---|
| Swipe right / ♥ / → | `boost` | out of the deck forever + people score raised globally |
| Swipe left / ✕ / ← | `suppress` | out of the deck forever + people score lowered globally |
| 🗑 (confirm) | `delete` | removed from the cache + added to `reconnect-blocklist.json` |

Mistake? `peoplegraph feedback --email X --action clear` un-retires a contact.

## Endpoints

- `GET /` — swipe UI (static)
- `GET /api/config` — public, returns the Google client id for sign-in
- `GET /api/candidates` — unswiped pool, top 500 by score, `{total, candidates[]}` — **requires Google sign-in** (allowlisted email)
- `POST /api/swipe` `{id, action}` — **requires Google sign-in** (allowlisted email)
- `POST /api/sync` `{upserts[], remove_ids[], reset?}` — **SYNC_TOKEN bearer** (bridge diff push)
- `GET /api/decisions?applied=0` — **SYNC_TOKEN** (bridge pull)
- `POST /api/decisions/ack` `{ids[]}` — **SYNC_TOKEN** (mark applied; also prunes the candidates)

## One-time setup

```bash
cd apps/reconnect-web
npm install

# 1. Create the D1 database, then paste the returned id into wrangler.jsonc
wrangler d1 create reconnect

# 2. Create tables (local + remote)
npm run db:init           # local dev
npm run db:init:remote    # production D1

# 3. Configure auth
#    - In Google Cloud console, make an OAuth 2.0 Web client; put its id in
#      wrangler.jsonc GOOGLE_CLIENT_ID, and add your Worker URL as an authorized origin.
#    - Set the allowlist (who can swipe) in wrangler.jsonc ALLOWED_EMAILS.
#    - Set the machine sync secret:
wrangler secret put SYNC_TOKEN     # use the same value in the Botwick bridge

# 4. Deploy
npm run deploy
```

## Local dev

```bash
npm run dev    # wrangler dev; uses local D1. Seed with: wrangler d1 execute reconnect --file ./schema.sql
```

The Botwick bridge that pushes candidates and applies decisions lives at
`scripts/peoplegraph-reconnect-web.mjs` (repo root).
