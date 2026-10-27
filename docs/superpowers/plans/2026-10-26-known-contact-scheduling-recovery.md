# Known-contact scheduling recovery

> Implementation plan for the reported James Montgomery request. Execute in the existing booking worktree.

**Goal:** Recognize verified existing relationships reliably and recover temporary lookup failures before emailing the owner for review.

**Constraints:** Exact email and owner identity, completed source freshness, configured returning threshold, group approval, and guest consent remain required. No partial sync data may grant booking priority. Public intake behavior remains unchanged. Never infer an introduction or meeting attendance from an email exchange.

## Work

- [x] Add failing contact-source tests for graph display caps, precise source failures, and unfinished syncs; use an exact database lookup and return bounded reason codes with retryability.
- [x] Add failing policy/coordinator tests: an owner-delegated request for an exact fresh strong contact can arrange a conversation without a questionnaire. Unknown contacts, stale data, disabled returning mode, uncertain classification, and substantive weak fits retain their existing behavior.
- [x] Propagate safe lookup diagnostics into the saved private decision. Retry temporary failures with durable bounded scheduling alarms before sending a review notification; preserve request identity, cancellation, idempotency and group consent.
- [x] Run targeted tests, the app suite, typecheck and real Worker runtime regressions; review the combined changes.
- [x] Deploy, reassess the affected request using its existing owner authorization, verify the resulting decision and any resulting offer. Commit and push the reviewed update.

## Evidence

James's current My Network profile has 4 sent / 7 received emails, last contact October 20, and score 70, matching the configured threshold of 70. The saved request read that thread but records only a generic unavailable relationship lookup. The original cause was not persisted. Diagnostics must establish it rather than label a hypothesis as proven.

## Validation

- 168 frontend tests passed.
- 1,051 backend tests passed, including bounded source diagnostics, contact lookup caps, policy eligibility, and durable retry regressions.
- 63 real workerd tests passed, including exact MailSync RPC, source-incomplete/recovery through scheduling, restart/idempotency, and confirmation revalidation.
- Typecheck, Worker dry run, and diff checks passed.
- Deployed Worker version: `dd89c400-9fc7-4c42-90fe-81f5325e4ddf`.

## Live verification

Reassessed the existing owner-delegated James request after deployment. The exact relationship score is 70/100, the decision is priority, and the UI now reads “Waiting for their choice.” Gmail confirms one offer in the original introduction thread to James, copied to Kaya, sent at 11:03 PM Eastern on October 26. The guest has not selected a time, and no event was created during this recovery.
