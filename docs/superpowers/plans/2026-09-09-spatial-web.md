# Spatial people web implementation plan

Goal: replace the web graph landing page with the approved spatial discovery experience using authenticated, real graph snapshots.

Architecture: keep the existing Google authentication, per-tenant D1 snapshot and push-token protocol. Separate the browser into model, scene, session and application modules. Search uses explicit matching against names, companies, roles and relationship context. Never infer current whereabouts or fabricate company news. Preserve the classic graph at /classic.html.

- [x] Add tested normalization, evidence search, bounded graph selection and tenant-scoped local state. Reject malformed snapshots and unsafe photos. Search results include the actual matching field/context. No matches are an explicit empty state.
- [x] Build perspective scene with capped visible nodes, company nodes, orbit/zoom, keyboard selection and a paginated accessible result list.
- [x] Connect Google sign-in, reload, sign-out, push-token setup, expiry/network/empty states. Identity comes from the authenticated graph endpoint. Tokens remain in memory; user drafts and shortlist are local and keyed by authenticated account.
- [x] Implement results/person/company/evidence/shortlist/draft cards. Company context aggregates recorded connections, not live news. Persist edits before navigation. Export shortlist and copy drafts without sending messages.
- [x] Add optional role and Google photo URL fields to plugin push, backward-compatible with older snapshots and constrained URLs. Keep all raw email and note text local.
- [x] Verify model tests, plugin typecheck/build, Worker typecheck/smoke, browser auth/error/tenant switching flows, keyboard and mobile. Deploy the web assets after verification; document plugin source changes separately from installed binaries.

Verification: 6 model tests, 23 plugin tests, plugin TypeScript/build, Worker TypeScript and local smoke, dry-run deployment, browser regression script and independent review all passed. Browser OAuth was tested via a substituted SDK/API; live Google sign-in still requires the user’s session.
