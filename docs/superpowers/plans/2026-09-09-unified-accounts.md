# Unified email accounts implementation plan

Spec: ../specs/2026-09-09-unified-accounts.md

- [x] Metadata and cryptography: tests for multiple recipients, account-self exclusion, scoring, opaque identity, authenticated encryption, malformed inputs.
- [x] Per-owner Durable Object: single-use connect state, encrypted grants, account list/start/remove, idempotent metadata storage, checkpointed alarm batches, hourly incremental scheduling, retry/reconnect states and generation fences.
- [x] Authenticated Worker routes: account listing, OAuth start/callback, sync/disconnect, graph source selection. Preserve existing graph and token paths. All private responses no-store.
- [x] Accounts UI: Google connection, recent/all choice, polling progress, reconnect, sync now, disconnect, vault graph fallback and clear configuration error. No copying tokens in new flow.
- [x] Verification: unit and local Worker integration tests, browser account flow tests, independent review, deployment dry run. Activate only when OAuth server credentials and callback registration are confirmed.

Activation outstanding: GOOGLE_CLIENT_SECRET, MAIL_TOKEN_KEY and Google callback/consent configuration; real OAuth and mailbox import have not been exercised. Unit and browser tests use mocked Google responses.
