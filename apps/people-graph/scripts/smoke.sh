#!/usr/bin/env bash
# End-to-end smoke against `wrangler dev` (local D1). Usage: npm run smoke
# Covers: config, push auth gating, HMAC push-token verification, the no-emails
# guard, and graph-read gating. (The Google-auth read path needs a real browser
# sign-in; check it after deploy.)
set -euo pipefail
cd "$(dirname "$0")/.."
export TOKEN_SECRET="smoke-secret"
EMAIL="tester@example.com"
SIG=$(printf %s "$EMAIL" | openssl dgst -sha256 -hmac "$TOKEN_SECRET" | awk '{print $NF}')
B64=$(printf %s "$EMAIL" | base64 | tr '+/' '-_' | tr -d '=')
TOKEN="pg1.${B64}.${SIG}"

npx wrangler d1 execute people-graph --local --file ./schema.sql >/dev/null
npx wrangler dev --port 8788 --var TOKEN_SECRET:$TOKEN_SECRET >/tmp/people-graph-smoke-dev.log 2>&1 &
DEV_PID=$!
trap 'kill $DEV_PID 2>/dev/null || true' EXIT
for i in $(seq 1 30); do curl -sf localhost:8788/api/config >/dev/null 2>&1 && break; sleep 1; done

json=(-H "content-type: application/json")

echo "--- config exposes client id"
curl -sf localhost:8788/api/config | grep -q googleClientId

echo "--- push without token -> 401"
code=$(curl -s -o /dev/null -w "%{http_code}" "${json[@]}" -d '{"nodes":[],"edges":[]}' localhost:8788/api/push)
[ "$code" = "401" ] || { echo "expected 401, got $code"; exit 1; }

echo "--- push with bad signature -> 401"
code=$(curl -s -o /dev/null -w "%{http_code}" "${json[@]}" -H "authorization: Bearer pg1.${B64}.deadbeef" -d '{"nodes":[],"edges":[]}' localhost:8788/api/push)
[ "$code" = "401" ] || { echo "expected 401, got $code"; exit 1; }

echo "--- push with email node id -> 400 (privacy guard)"
code=$(curl -s -o /dev/null -w "%{http_code}" "${json[@]}" -H "authorization: Bearer $TOKEN" \
  -d '{"nodes":[{"id":"leak@example.com","name":"X"}],"edges":[]}' localhost:8788/api/push)
[ "$code" = "400" ] || { echo "expected 400, got $code"; exit 1; }

echo "--- valid push -> ok with counts"
curl -sf "${json[@]}" -H "authorization: Bearer $TOKEN" -d '{
  "pushedAt":"2026-08-17T00:00:00Z",
  "nodes":[{"id":"a1","name":"Alice","quadrant":"nurture","combined":90},
           {"id":"b2","name":"Bob","quadrant":"re-engage","combined":40}],
  "edges":[{"source":"a1","target":"b2","weight":3,"types":["shared_meeting"],"contexts":["Standup"]}]
}' localhost:8788/api/push | grep '"nodes":2'

echo "--- graph read without Google token -> 401"
code=$(curl -s -o /dev/null -w "%{http_code}" localhost:8788/api/graph)
[ "$code" = "401" ] || { echo "expected 401, got $code"; exit 1; }

echo "--- push token is not a Google token -> 401 on read"
code=$(curl -s -o /dev/null -w "%{http_code}" -H "authorization: Bearer $TOKEN" localhost:8788/api/graph)
[ "$code" = "401" ] || { echo "expected 401, got $code"; exit 1; }

echo "--- stored row is scoped to the token email"
npx wrangler d1 execute people-graph --local --command "SELECT email FROM graphs" 2>/dev/null | grep -q "$EMAIL"

echo "SMOKE OK"
