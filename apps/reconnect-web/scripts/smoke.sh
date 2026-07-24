#!/usr/bin/env bash
# End-to-end smoke against `wrangler dev` (local D1). Usage: npm run smoke
# Covers: sync reset+upsert, auth gating on candidates, decisions empty, remove.
# (The Google-auth swipe path needs a real browser sign-in; see the rollout
# runbook's post-deploy checklist for that loop.)
set -euo pipefail
cd "$(dirname "$0")/.."
export SYNC_TOKEN="smoke-token"
npx wrangler d1 execute reconnect --local --file ./schema.sql >/dev/null
npx wrangler dev --port 8787 --var SYNC_TOKEN:$SYNC_TOKEN >/tmp/reconnect-smoke-dev.log 2>&1 &
DEV_PID=$!
trap 'kill $DEV_PID 2>/dev/null || true' EXIT
for i in $(seq 1 30); do curl -sf localhost:8787/api/config >/dev/null 2>&1 && break; sleep 1; done

auth=(-H "authorization: Bearer $SYNC_TOKEN" -H "content-type: application/json")

echo "--- sync reset + 2 upserts"
curl -sf "${auth[@]}" -d '{"reset":true,"upserts":[
  {"id":"aaaa","name":"Alice","last_contact":"2026-07-01","score":80,"nudge":"at Acme"},
  {"id":"bbbb","name":"Bob","score":60}]}' localhost:8787/api/sync | grep '"upserted":2'

echo "--- candidates without Google auth -> 401"
code=$(curl -s -o /dev/null -w "%{http_code}" localhost:8787/api/candidates)
[ "$code" = "401" ] || { echo "expected 401, got $code"; exit 1; }

echo "--- swipe with sync-token (not a Google token) -> error"
curl -s "${auth[@]}" -d '{"id":"aaaa","action":"boost"}' localhost:8787/api/swipe | grep -q error

echo "--- decisions empty, remove bbbb"
curl -sf "${auth[@]}" "localhost:8787/api/decisions?applied=0" | grep -q '"decisions":\[\]'
curl -sf "${auth[@]}" -d '{"remove_ids":["bbbb"]}' localhost:8787/api/sync | grep '"removed":1'

echo "--- merge: sync 2 pairs, auth gates, decisions, remove"
curl -sf "${auth[@]}" -d '{"reset":true,"upserts":[
  {"id":"p1","confidence":0.9,"reasons":"same_name","name_a":"A One","domain_a":"x.com","name_b":"A Won","domain_b":"y.com"},
  {"id":"p2","confidence":0.88,"name_a":"B Two","name_b":"B Too"}]}' localhost:8787/api/merge/sync | grep '"upserted":2'
code=$(curl -s -o /dev/null -w "%{http_code}" localhost:8787/api/merge/candidates)
[ "$code" = "401" ] || { echo "expected 401, got $code"; exit 1; }
curl -s "${auth[@]}" -d '{"id":"p1","action":"merge"}' localhost:8787/api/merge/swipe | grep -q error
curl -sf "${auth[@]}" "localhost:8787/api/merge/decisions?applied=0" | grep -q '"decisions":\[\]'
curl -sf "${auth[@]}" -d '{"remove_ids":["p2"]}' localhost:8787/api/merge/sync | grep '"removed":1'
echo "SMOKE OK"
