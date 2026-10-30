# CLI web parity implementation plan

Spec: `docs/superpowers/specs/2026-10-30-cli-web-parity-design.md`. The user supplied and authorized the feature requirements; routine implementation decisions follow the existing services.

1. Add Rust origin-bound persisted configuration and a shared HTTP client; test precedence, file permissions, input bounds and no credential disclosure.
2. Add server credential metadata/status, additional explicit scopes and a method/path capability registry. Reuse owner handlers, preserve all existing authority checks, and test denial by default.
3. Add scoped browser login without silently elevating existing device credentials. Share integration credentials across graph and private APIs, with browser consent displaying scopes.
4. Add `lens set` and Lens actions, `configure`, `status`, `api` and capability discovery. Test revision-preserving edits and API failures through real HTTP fixtures.
5. Fix local version/describe dispatch and release smoke tests; update onboarding, skill and parity documentation.
6. Run focused and full tests, independent review, isolated end-to-end verification and release/deployment checks. Record any unsupported browser-only operation explicitly.

Review focus: cross-origin credential binding; a read-only key performing mutations; stale Lens revision loss; excessive machine scope or credential delegation; API/browser semantic differences (Origin, OAuth cookies, idempotency and response bounds).
