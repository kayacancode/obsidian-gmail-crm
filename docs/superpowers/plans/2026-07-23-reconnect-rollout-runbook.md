# Reconnect stable-ids rollout (run top to bottom)

Branch: `reconnect-stable-ids`. Sections B runs on the machine that deploys the
Worker (Kaya's); section C runs on the source-of-truth machine (John's / "Botwick").

## A. Pre-flight (any machine with the sync token)

1. Confirm no pending decisions:
   ```bash
   curl -s -H "authorization: Bearer $RECONNECT_SYNC_TOKEN" "$RECONNECT_WEB_URL/api/decisions?applied=0"
   ```
   MUST return `{"decisions":[]}`. If not: run `node scripts/peoplegraph-reconnect-web.mjs pull`
   on the source-of-truth machine with the OLD checkout first, then re-check.

## B. Deploy Worker + migrate D1 (branch `reconnect-stable-ids`)

2. ```bash
   cd apps/reconnect-web && npm run typecheck && npm run deploy
   ```
3. ```bash
   npm run db:migrate:remote   # drops candidates, clears legacy decisions
   ```
4. Sanity — auth gate still on:
   ```bash
   curl -s -o /dev/null -w "%{http_code}" $RECONNECT_WEB_URL/api/candidates   # -> 401
   ```

## C. Source-of-truth machine (Botwick)

5. ```bash
   git fetch && git checkout reconnect-stable-ids
   cp ~/.peoplegraph/reconnect-web-state.json{,.v1.bak} 2>/dev/null || true   # keep a rollback copy
   ```
6. Install the CLI (the cron must run THIS build). Do NOT use
   `scripts/install-peoplegraph.sh` — it downloads the latest GitHub *release*
   (0.3.4), which predates these fixes. Use the prebuilt arm64 binary committed
   on this branch (or `cargo build --release` if Rust is installed):
   ```bash
   cp bin/peoplegraph ~/.local/bin/peoplegraph
   peoplegraph version   # MUST print 0.3.7
   ```
7. Feedback file sanity (this is the check that would have caught the July incident):
   ```bash
   peoplegraph --cache "$PEOPLEGRAPH_CACHE" reconnect --limit 1 \
     | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['stats']['matched'],'candidates after exclusions')"
   ```
   Expect roughly (total re-engage pool − ~1,699 swiped). If it errors with
   `feedback_unreadable`, STOP and repair the JSON — do NOT delete the file.
8. First v2 push (state file auto-migrates; salt generated; full pool uploads once):
   ```bash
   set -a; source ~/.peoplegraph/reconnect-web.env; set +a
   node scripts/peoplegraph-reconnect-web.mjs run
   ```
   Expect: `pool N candidates (N upserted, 0 removed)` with N ≈ step 7's count.
   The daily cron line needs no change (`run` is still the entrypoint).

## D. Verify

9. D1 spot checks (from the repo, `apps/reconnect-web/`):
   ```bash
   npx wrangler d1 execute reconnect --remote --command "SELECT COUNT(*) AS n FROM candidates"        # ≈ N
   npx wrangler d1 execute reconnect --remote --command \
     "SELECT name FROM candidates WHERE name IN ('Susan Lyne','Auren Hoffman','Steve Schlafman')"     # -> 0 rows
   ```
   (Those three were boosted in June/July — if they're absent, swipe history is being honored.)
10. Open the app, swipe one card right and one left, then on Botwick:
    ```bash
    node scripts/peoplegraph-reconnect-web.mjs pull
    ```
    Decisions apply + ack; `SELECT COUNT(*) FROM candidates` drops by 2; the next
    `run` prints `pool unchanged — nothing to push` or a small diff. Check the two
    entries landed in `reconnect-feedback.json` (camelCase, lowercase emails).

## E. Rollback (if something is wrong)

- Redeploy the previous Worker:
  ```bash
  git checkout <old-sha> -- apps/reconnect-web && cd apps/reconnect-web && npm run deploy
  npm run db:init:remote    # old-schema tables
  ```
- On Botwick: `git checkout main`, restore `~/.peoplegraph/reconnect-web-state.json.v1.bak`,
  re-run the old bridge `push`.
- Nothing destructive happened to source data: `reconnect-feedback.json` only ever
  gains entries, and `contact-index.json` is untouched except by explicit deletes.
