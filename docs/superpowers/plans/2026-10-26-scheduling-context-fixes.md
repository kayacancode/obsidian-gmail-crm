# Scheduling context fixes

The user approved three changes after the live judgment test: allow strong contacts to catch up, remove the premature model timeout, and ask for missing purpose instead of calling it a weak fit.

## Design

- Keep one assessment path across Booking, email, API and MCP. Add explicit `catch_up` and `needs_context` fit outcomes; reserve `uncertain` for failures or unverifiable assessments.
- An ordinary catch-up qualifies through an exact, fresh relationship meeting the existing returning-contact threshold (default 70), with the feature enabled. Claims in email never establish relationship strength. Specific mismatches still require review.
- Use the existing 60-second helper-model deadline. Verify late successful responses and providers that never settle, with bounded cleanup.
- Context requests expose only a short public question. No times are offered until reassessment or explicit owner approval. Preserve `requiresReview` for older clients and add `needsContext`/`contextQuestion` for clients that support clarification.
- A verified owner email kickoff can ask the fixed counterpart for context using a separate, expiring reply capability. Two questions maximum, then owner review. Replies are bounded, deduplicated and appended separately from original input so preparation idempotency remains valid.
- API/MCP clients can append context to the same request; the owner dashboard distinguishes waiting for context from a mismatch. Frozen participants, owner scheduling window, policy revision and Calendar checks remain authoritative.

## Implementation and verification

- [x] Add failing assessment/policy tests, then implement catch-up eligibility, explicit missing-context classification and deadline handling.
- [x] Add failing coordinator tests, then implement bounded context evidence, idempotent reassessment, freshness checks and public question projection.
- [x] Add failing email protocol tests, then implement questions, reply authentication, restart recovery and the two-round bound.
- [x] Update REST, MCP and owner UI with tests for the new state and context operation.
- [x] Run the complete app suite, typecheck, workerd integration, browser checks and isolated live-model scenarios. Test email and Calendar through fixtures only.
- [x] Independently review, deploy the Worker and verify the deployed application responds. Report remaining limits honestly.

## Review fixes

Valid second-day replies now refresh relationship evidence during reassessment. Received replies are saved before model or Calendar work, and interrupted assessments can resume without duplicating evidence. Owner approval supersedes retries; a decline cannot be reopened by a retry. Context questions rotate only on an explicit owner reassessment after expiry and remain bounded to two rounds.

## Verification evidence

- All seven isolated live-model scenarios and 35 relationship-policy cases passed against the saved meeting thesis; observed model latency was 2.27–7.22 seconds.
- Full application, workerd integration, owner/public Booking browser, scheduling browser, TypeScript and deployment-build checks pass. Provider fixtures prevent tests from sending real email or Calendar invitations.

Deployed Worker version `77eda68a-c8b2-436c-a46a-fba579875abf`. Final checks: 168 frontend tests, 958 backend tests, 41 workerd tests, both Booking browser suites, TypeScript, and dry-run build passed. Production `/booking` returns 200, served `booking.mjs` exactly matches the local artifact, and unauthenticated scheduling access remains 401.
