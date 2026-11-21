# PeopleGraph 0.3.16

PeopleGraph 0.3.16 moves Lens refresh into a durable background job and makes CLI failures easier to distinguish.

## What is new

- **Durable Lens refresh:** an authorized refresh returns HTTP 202 after saving a job. Use `peoplegraph lens inspect` or `peoplegraph api GET /api/lens` to follow `refresh.job`; queued/running jobs call for inspection, not another refresh. Jobs report completed, failed, or cancelled outcomes and retain existing revision, consent, and source-withdrawal checks.
- **Separate completion signals:** a completed job means its explicit batch finished. Check `refresh.state`, `refresh.nextAction`, and `honcho.lastSync` for projection and suggestion readiness. Honcho can still be pending or awaiting cleanup. Idle without an active job is not work that will finish by waiting.
- **Accurate CLI failures:** `web_request_timeout` identifies a client deadline. `stats.httpStatus` reports a status only when one was actually received; actual 503 responses preserve safe codes such as `people_memory_failed` and `people_request_failed` without exposing provider text.
- **Ranking budgets:** matches/helpers allow 180 seconds for the 15-second shortlist, 60-second explanation, and 60-second verification stages plus data reads. Ordinary reads and refresh enqueue retain 30-second client limits.
- **Private diagnostics:** failed match reads identify the stage, safe error category, and elapsed time. Exception text, credentials, owner identity, and source content are excluded from these diagnostics.

## Source context and matches

Enabling Gmail conversation context starts an independent backfill of recent incoming mail. Matches use confirmed Lens fields and eligible evidence about other people; Lens refresh and Honcho completion are not prerequisites. `no_evidence` with `considered: 0` means no eligible candidate evidence reached ranking. Inspect source/context ingestion or save real authorized per-person context. Neither a completed import nor populated owner goals guarantees matches.

## Updating

Install the versioned CLI and reload the bundled agent skill using the [onboarding guide](../people-agent-onboarding.md). Existing People credentials retain their scopes. Deployments upgrading from before 0.3.15 still need the existing `20261030_cli_scopes.sql` migration; 0.3.16 needs no additional D1 migration or Obsidian plugin release.

The release workflow packages three platform binaries, both agent skills, the installer, four offline guides, and SHA-256 checksums. Current source documentation targets 0.3.16; earlier release records remain unchanged.

## Verification and rollout

- Installer tests: 20 passed; shell syntax check passed. Locked Cargo metadata reports 0.3.16.
- Both packaged skills, all four offline guides, and the installer byte-match their canonical sources in a temporary release bundle.
- A fresh reference check correctly followed queued jobs, separated completion from Honcho readiness, treated Gmail backfill independently, and distinguished client timeouts from received HTTP status.
- Diagnostic regression tests cover safe 503 responses at each match read, MCP/authentication failures, generic machine routing, and preserved 409 source conflicts.
- The matched-evidence test advances from `no_evidence` to recommendations without invoking Lens refresh.
- Combined verification: 119 Rust tests, 176 frontend tests, 1,087 backend tests, TypeScript, and the Lens browser harness passed. Browser regressions cover progress polling, concurrent match searches, panel closure, and preservation of unrelated drafts.
- The compiled CLI passed against an isolated local Worker: immediate enqueue, active retry coalescing, rapid GET polling without postponing the alarm, completion with one attempt, and no invented Honcho synchronization. Existing source permissions, tenant isolation, revision conflicts, and revocation checks also passed.
- Independent review findings were resolved and rechecked, including pending-cleanup note retention and both browser polling/draft races.
- Published [peoplegraph-v0.3.16](https://github.com/kayacancode/obsidian-gmail-crm/releases/tag/peoplegraph-v0.3.16) from commit `c08e57602e07d918e839a891d8835a6628027dd2`. [Release workflow 41449238325](https://github.com/kayacancode/obsidian-gmail-crm/actions/runs/41449238325) passed verification and all three platform builds.
- All ten published asset checksums passed; both skills, four guides, and installer byte-match source. The published installer succeeded in an isolated folder; its installed macOS ARM64 binary reports 0.3.16 through `--version`, `version`, and `describe`.
- Worker deployed November 2, 2026 as `c04c877a-5fe7-40f7-84c4-18373c8475c0`. Both updated public modules byte-match the tested source. No additional migration was required.
- The observed transient 503 recovered; its underlying cause is not established by this change. John's live account has not been retested from his machine. Main has not been merged; changes are in PR #17.
