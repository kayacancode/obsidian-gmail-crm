# People Agent Release Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans or delegated implementation with independent review. Track tasks with the checkboxes below.

**Goal:** Let authorized agents use the same saved People Lens and relationship evidence as the app, with a reliable coordinated upgrade.

**Architecture:** Merge the published CLI branch into current main, retain device query authentication, and extend scoped People API/MCP read operations. Shared recommendation services serve both browser and machine routes. Rust commands use the same machine endpoints and explicit People credentials.

**Tech Stack:** Cloudflare Workers/D1/Durable Objects, TypeScript, Rust, MCP, Obsidian and shell release tooling.

**Spec:** ../specs/2026-10-26-people-agent-release-design.md

## Global constraints
- CLI 0.3.12; plugin 0.9.5. Preserve published 0.3.11 login and local-mode behavior.
- Private reads use People credentials; old device tokens never gain private lens/memory scope.
- Recommendations use confirmed saved lens and current source/profile revisions.
- Do not send real messages, book meetings, or provision new user credentials during verification.

## Review focus
- Old installed clients and login profiles must keep working after reconciliation.
- Withdrawn sources or concurrent profile edits must invalidate in-flight results.
- Exact identity resolution must preserve aliases without joining ambiguous names.
- Failed installer downloads/checksums must preserve installed files.
- Setup templates must not accidentally copy secrets into URLs, logs or source files.

## Tasks
- [x] Reconcile release branch conflicts while preserving current graph augmentation, account tabs, schemas and every test entry point. Run baseline app and Rust suites.
- [x] Add failing service/API/MCP tests for saved lens, matching, search, connection and helpers; implement shared services, scoped routes and tool schemas; run app suite.
- [x] Add failing Rust transport/compatibility tests; preserve login plus memory, implement lens/matches/search/connection/helpers, update describe and version; run Cargo suite.
- [x] Add installer failure/retry tests; implement checked release assets, explicit skill targets and complete documentation bundle. Update conflicting skills and onboarding guide.
- [x] Add Integrations setup templates and a read-only session connection check; verify browser behavior, token dismissal and account switching.
- [x] Run full app/Rust/plugin checks plus relevant browser/runtime suites. Independently review changes and fix concrete findings.
- [ ] Push and create/attach PR, deploy verified Worker with additive schema, verify live onboarding. Build/publish CLI and plugin releases, verify downloaded artifact versions and bundled docs. Report exact release links and remaining client setup.
