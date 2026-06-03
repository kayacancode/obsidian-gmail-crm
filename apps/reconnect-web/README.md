# Reconnect Web

A names-only, Tinder-style swipe UI for reviewing daily reconnect suggestions, backed by a Cloudflare Worker + D1. Built for John's human-in-the-loop curation flow.

## How it fits together

```
Botwick machine (source of truth)          Cloudflare (this app)          John's phone
  peoplegraph reconnect --limit 5  ──POST /api/sync (names+ids)──►  Worker + D1  ──►  swipe UI
  peoplegraph feedback (apply)     ◄──GET /api/decisions───────────              ◄──  right/left/🗑
```

**Privacy:** this app never receives emails or message content. The Botwick bridge
assigns each candidate an **opaque id** and keeps the `id → email` map locally; D1
only ever stores names + display fields. That's why the page can be near-public.

## Swipe semantics

| Gesture | Action sent | Effect (applied by Botwick via `peoplegraph feedback`) |
|---|---|---|
| Swipe right / ♥ / → | `boost` | keep + raise score |
| Swipe left / ✕ / ← | `suppress` | hide from future suggestions + lower score |
| 🗑 (confirm) | `delete` | remove from the cache + add to `reconnect-blocklist.json` |

## Endpoints

- `GET /` — swipe UI (static)
- `GET /api/config` — public, returns the Google client id for sign-in
- `GET /api/candidates` — pending candidates (names only) — **public read**
- `POST /api/swipe` `{id, action}` — **requires Google sign-in** (allowlisted email)
- `POST /api/sync` `{batch_date, candidates[], replace?}` — **SYNC_TOKEN bearer** (Botwick push)
- `GET /api/decisions?applied=0` — **SYNC_TOKEN** (Botwick pull)
- `POST /api/decisions/ack` `{ids[]}` — **SYNC_TOKEN** (mark applied)

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
