# CLI source setup implementation plan

> **For agentic workers:** Use test-driven implementation and independent review of the combined change.

**Goal:** Let agents connect and sync permitted sources with direct CLI commands and diagnose Lens refresh state.

**Architecture:** Rust source commands call the existing scoped machine adapter. OwnerLensStore adds derived refresh diagnostics while retaining revision checks and explicit provider invocation.

**Tech stack:** Rust/clap/ureq, TypeScript Cloudflare Worker, existing SQLite fixtures and Node test runner.

**Spec:** `docs/superpowers/specs/2026-10-30-cli-sources-design.md`

## Constraints and review focus

- Keep source permissions explicit; no automatic scope escalation.
- Never emit Granola keys or forward a People credential to another origin.
- A browser handoff and an accepted sync request are not completed imports.
- Pending source ingestion, pending Honcho projection, and insufficient match evidence are separate states.
- Preserve concurrent edit, cancellation, source withdrawal, and existing source consent behavior.

## Tasks

- [x] Add failing CLI protocol tests in `crates/peoplegraph/tests/sources_cli.rs`; implement `src/sources.rs` and register commands in `src/main.rs`. Verify permission errors, bounded stdin, exact account selection, and handoff validation.
- [x] Add failing store/UI tests for enabled-but-idle and empty refresh states; update `apps/people-graph/src/owner-lens.ts` and `public/owner-lens.mjs` without automatic Honcho calls.
- [x] Update onboarding, parity guide, bundled agent skills, and installer guidance with source setup and evidence troubleshooting.
- [x] Run Rust tests, web tests, TypeScript checks, installer tests, and independent review. Exercise source-scoped API behavior using isolated fixtures.
- [x] Publish a versioned CLI update and deploy the compatible server/UI changes after verification; verify published assets and report the remaining Google consent requirement.

## Verification

- Rust suite: 114 passed, including 14 source-command cases.
- Web `npm test`: passed; backend 1,073 passed. TypeScript and Lens browser checks passed.
- Installer: 20 passed. Compiled CLI against an isolated local Worker passed scoped login, source status and consent handoff, scope denial, Lens idle state, and existing auth/CAS checks.
- Independent review found no actionable issue. No real source, Lens, or booking data was changed by tests.
- Published `peoplegraph-v0.3.15` at `2245adaa3475a4e339badd1c8b461a3971ce2da8`. All ten asset checksums passed; the published installer, native macOS binary, skill, and four offline guides were verified in an isolated temporary home.
- Deployed Worker `49527f49-3cd6-4b68-aa0e-bd9b8417b32b`; public Lens and integration modules byte-match the verified source.
