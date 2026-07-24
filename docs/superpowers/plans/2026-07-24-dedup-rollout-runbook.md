# Contact dedup rollout

## A. Deploy (Kaya's machine, branch contact-dedup)
1. cd apps/reconnect-web && npm run typecheck && npm run smoke && npm run deploy
2. npm run db:migrate:0003
3. curl -s -o /dev/null -w "%{http_code}" $RECONNECT_WEB_URL/api/merge/candidates  -> 401

## B. John's machine
4. cd ~/obsidian-gmail-crm && git fetch && git checkout contact-dedup && git pull
5. shasum -a 256 bin/peoplegraph   # must match 75eb4be300ba873eb1b61195756fb754493d89b21d9c0b556356b68082ce2b54 (the hash in the PR description)
   rm -f ~/.local/bin/peoplegraph && cp bin/peoplegraph ~/.local/bin/peoplegraph
   codesign --force --sign - ~/.local/bin/peoplegraph && hash -r
   peoplegraph version   # 0.3.9
6. DRY RUN FIRST — eyeball what would auto-merge (send the output to Kaya/John):
   set -a; source ~/.peoplegraph/reconnect-web.env; set +a
   peoplegraph --cache "$PEOPLEGRAPH_CACHE" apply-duplicates --dry-run \
     | python3 -c "import json,sys;d=json.load(sys.stdin);print(len(d['data']['groups']),'groups');[print(' | '.join(g['members'])) for g in d['data']['groups'][:30]]"
7. If the sample looks right:
   node scripts/peoplegraph-reconnect-web.mjs merge-push --force
   node scripts/peoplegraph-reconnect-web.mjs push
   (push refreshes the contact deck: merged + name-deduped pool shrinks)

## C. Verify
8. Deck count drops (name-dedup + auto-merges); /merge shows the review pairs.
9. Swipe one pair right + one left on /merge, then:
   node scripts/peoplegraph-reconnect-web.mjs merge-pull
   -> "merged a + b" and "kept apart a | b"; pair rows pruned after ack.
10. Susan Lyne check: peoplegraph --cache "$PEOPLEGRAPH_CACHE" find-person "Susan Lyne"
    -> her rows share one canonical_id.

## D. After merge to main
11. Both checkouts: git checkout main && git pull. Cron unchanged.
