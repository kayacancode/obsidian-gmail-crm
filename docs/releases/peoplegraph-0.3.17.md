# PeopleGraph 0.3.17

PeopleGraph 0.3.17 clarifies source onboarding, the credential actually used by the CLI, and the difference between candidate evidence and Lens learning.

## What is new

- **Credential selection warnings:** login reports `activeCredentialSource` and `savedCredentialActive`. Login and status warn with `environment_credential_override` when `PEOPLEGRAPH_WEB_TOKEN` overrides a saved login. Unset the WEB token/URL pair when the saved login is intended, then verify live scopes with `peoplegraph status`. No key is printed and credential precedence is unchanged.
- **Explicit source setup:** the canonical six-step guide and both skills request `login --write --scope sources:manage`, verify the active scopes, finish Gmail browser connection, and obtain explicit permission before enabling conversation context. Login already rejects missing or extra grants; a new regression covers an omitted source grant without replacing the previous saved credential.
- **Evidence readiness:** matches and `lens inspect` include `matchingSources`, containing aggregate Gmail account counts and consent-aware hints for disabled context, syncing, or context errors. No account emails or secrets are included. `no_evidence` adds actionable `guidance`. Contact counts, photos, and owner goals alone do not create candidate conversation evidence.
- **Recommendation identity and counts:** results may include the authorized graph `name` for their stable `personId`, without adding emails. `available` counts eligible evidence-backed candidates before the cap; `considered` counts those included in the first pass. A call considers at most 60, shortlists at most 6, and returns up to 3 verified suggestions. Audits can reduce this further: 26 candidates and one result does not mean the API only supports one recommendation.
- **Visible Lens job waits:** queued jobs report `waitReason` (`cleanup` or `alarm`) and `nextAttemptAt` when another attempt is eligible before expiry. Running jobs report their attempt `deadlineAt`; all statuses expose overall `expiresAt`. Inspection retires expired active jobs as failed instead of leaving them visibly queued. These timestamps explain eligibility and limits; they do not guarantee when a worker starts.

## Separate source and Lens workflows

Gmail context opt-in starts its own recent-incoming-mail backfill. Matches use confirmed Lens fields and eligible person evidence, independently of Lens refresh or Honcho completion. Never enable content just because a diagnostic hint suggests it; the owner must authorize that choice.

Lens refresh remains an optional durable background job. Enqueue should return HTTP 202 promptly. Follow queued/running work with `lens inspect`, without submitting another refresh. A completed job is distinct from Honcho readiness; inspect `refresh.state`, `refresh.nextAction`, and `honcho.lastSync`. Idle without an active job is not ongoing work. A 30-second refresh timeout is not expected progress: inspect whether a job exists before retrying, and do not assume the request started work.

`web_request_timeout` remains a client deadline; `stats.httpStatus`, when present, is an actually received status. Actual server 503s retain safe codes such as `people_memory_failed`. The reported transient failures and queued wait are not assigned a root cause by these changes.

## Updating

Install the versioned CLI and reload the bundled agent skill using the [six-step onboarding guide](../people-agent-onboarding.md#six-steps-from-installation-to-matches). Existing credentials retain their original scopes. This release requires no additional D1 migration or Obsidian plugin release; deployments older than 0.3.15 still need the existing CLI scope migration.

The release workflow packages three platform binaries, both agent skills, the installer, four offline guides, and SHA-256 checksums. Current instructions target 0.3.17; earlier release records are unchanged.

## Verification and rollout

- Rust: 121 tests passed, including missing-source-scope refusal, saved-key preservation, live/offline environment override warnings, and no token disclosure.
- Installer: 20 tests passed; integrations panel: 5 tests passed. Shell syntax, Rust formatting, and diff checks passed. Locked Cargo metadata reports 0.3.17.
- Both packaged skills, all four offline guides, and the installer byte-match their canonical sources in a temporary release bundle.
- Independent auth review found no actionable correctness or secret-safety issue.
- Combined app verification: 176 frontend and 1,095 backend tests passed, plus TypeScript and the Lens browser harness. Job regressions cover cleanup waits, expiry without alarm delivery, and collection failures when Honcho is unconfigured.
- The compiled 0.3.17 CLI passed against an isolated local Worker, including scoped login, automatic config, source permissions, durable refresh enqueue/coalescing/alarm completion, new timing/diagnostic fields, Lens revision checks, owner isolation, and revocation.
- Installer checks: 20 tests passed, plus 5 integration-panel tests, shell syntax and Rust formatting checks. All seven packaged skill/guide/installer files byte-match their canonical sources. Worker deployment dry run passed.
- Independent review corrected a diagnostic that overstated extraction progress; it now describes a queued or in-progress source sync, including calendar work and retry waits. Final review found no remaining actionable issues.
- Publication and deployment are recorded after completion. John's live account has not been retested from his machine; his exact queued-job cause remains unconfirmed.
