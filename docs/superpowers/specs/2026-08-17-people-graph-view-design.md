# People graph view — design

**Date:** 2026-08-17 · **Card:** "People score graph view deployment" (SWB board)
**Decisions made with Kaya:** multi-tenant (each user sees only their own graph) ·
plugin push + Google sign-in · richer context (last-contact dates + edge contexts
such as meeting titles; still no email addresses).

## Goal

Let any obsidian-gmail-crm user push their vault's people graph (contacts with
scores, edges with connection strengths) to a Cloudflare-hosted viewer and
explore it as an interactive force-directed graph. Team members test by pushing
their own vaults; nobody can see anyone else's graph.

## Non-goals (follow-up cards if wanted)

- Sharing/viewing someone else's graph.
- Auto-push on every sync (manual command only for v1).
- Anything touching `reconnect-web`, John's deck, or the single-runner bridge.
- The Bestmate/AskTwin knowledge graph or its RAG pipeline speedup.

## Architecture

New Cloudflare Worker at `apps/people-graph/` — same shape as `reconnect-web`
(hand-written worker, D1, static assets, no build step). Tenancy key is the
Google-verified email.

### Storage (D1 `people-graph`)

```sql
graphs(email TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at INTEGER NOT NULL)
```

One blob per tenant — the only read is "give me my whole graph."

### Endpoints

| Route | Auth | Behavior |
|---|---|---|
| `GET /api/config` | none | `{ googleClientId }` for GIS boot |
| `GET /api/token` | Google ID token | Mints a stateless push token bound to the email: `pg1.<b64url(email)>.<hex(HMAC-SHA256(email, TOKEN_SECRET))>` |
| `POST /api/push` | Bearer push token | Verifies HMAC, upserts the caller's `graphs` row. Rejects payloads > 4 MB or containing `@` in node ids |
| `GET /api/graph` | Google ID token | Returns the signed-in email's blob (`{ graph: null }` if none) |
| everything else | — | static assets (`public/`) |

Google ID token verification mirrors `reconnect-web` (`tokeninfo` endpoint, `aud`
check) but with **no allowlist** — any Google account may sign in and sees only
its own data. Secret: `TOKEN_SECRET` via `wrangler secret put`.

### Plugin push (`src/graph-push.ts`)

Pure serializer + `requestUrl` push, modeled on `betaworks-push.ts`:

- **Nodes** from scored pages: `id`, `name`, `company`, `quadrant`, `combined`,
  `strength`, `momentum`, `staleness`, `label`, `lastContact`. `id` =
  `sha256(salt + email)` hex-truncated; the salt is random, generated once, and
  stored in plugin settings (`graphPushSalt`) so ids are stable across pushes
  and emails never leave the vault.
- **Edges** from `contactIndex.edges`, merged undirected per node pair:
  `source`, `target`, `weight` (count of underlying relationship edges — the
  connection strength), `types` (distinct), `contexts` (up to 5 sample
  contexts, e.g. meeting titles — the "richer context" choice).
- Settings: `graphPushUrl`, `graphPushToken`, `graphPushSalt` (hidden).
- Command: **"Push people graph to web"**. Failures never block scoring.

### Viewer (`public/index.html`)

d3-force page (vendored `d3.v7.min.js`), visual language adapted from the
AskTwin knowledge graph: node radius = combined score, color = quadrant
(nurture green, developing blue, re-engage orange, deprioritize gray), edge
width/opacity = weight, hover tooltip (scores, last contact, shared contexts),
click highlights the neighborhood, name search box, zoom/pan. Signed-out state
shows the GIS button; signed-in-but-empty state shows push instructions and a
"Get push token" button that calls `/api/token` and displays the token to
paste into Obsidian settings.

## Error handling

- Worker: malformed JSON → 400; bad/expired Google token → 401 (UI re-prompts,
  same pattern as reconnect); bad push token → 401; oversized payload → 413.
- Plugin: push wrapped in try/catch with `Notice`, mirroring betaworks push.

## Testing

- `apps/people-graph/scripts/smoke.sh` against `wrangler dev --local`: config,
  401 without auth, mint-format check, push with a bash-minted HMAC token,
  fetch-401 without Google token, size/`@` guards.
- `npm run typecheck` in the app; plugin `npm run build` + eslint (repo has no
  TS unit-test runner; serializer is kept pure for future testability).

## Deploy

`wrangler d1 create people-graph` → `db:init:remote` → `wrangler secret put
TOKEN_SECRET` → `npm run deploy`. Manual console step: add the new
`people-graph.<account>.workers.dev` origin to the existing Google OAuth
client (same client id as reconnect-web).
