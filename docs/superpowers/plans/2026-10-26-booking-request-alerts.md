# Booking request email alerts

**Goal:** Email the owner when a visitor completes a time request through their public booking link, with meeting context and a link to review it.

The user approved this feature. Use the existing scheduling sender and the existing authenticated Booking request controls. Requests for offered times and visitor-proposed alternatives both qualify. Questionnaire submission alone and automatically confirmed bookings do not need approval alerts. The email recipient comes only from the configured booking owner.

**Architecture:** Keep a separate SQLite notification outbox in the owner's BookingCoordinator. Persist the outgoing intent before saving a selection, and check the current request before sending. Use the existing alarm alongside Calendar reconciliation. Never replay the removed verification-email outbox. Known pre-delivery failures may retry; uncertain provider outcomes remain visible to the owner without automatic duplicate sends. Email links open `/booking?request=…`; approval and decline remain authenticated, same-origin POST actions.

## Work

- [x] Add a bounded text/HTML email template and deterministic selection keys, with tests for timezone formatting, private recipient and escaping.
- [x] Add durable notifications for selected and proposed times, deduplication, stale-request suppression, retries and diagnostics. Test persisted intent, restart, delivery uncertainty and Calendar coexistence.
- [x] Show notification destination/status in Booking. Verify the request link focuses the request and retains approval controls.
- [x] Run the application suite, workerd integration, browser checks and typecheck. Review, deploy, smoke-test read-only, and push the branch update.

## Review focus

Check duplicate selection and alarm deliveries; selected times changed before sending; requests approved before sending; provider acceptance with a lost response; and old verification outbox records. No real test email or Calendar invitation is sent.

## Verification

168 frontend tests, 975 backend tests, 43 workerd tests, Booking and scheduling browser suites, TypeScript and deployment dry run passed. Independent review approved after adding a prolonged D1-outage recovery test. Deployed Worker `ccf0a760-001b-4be4-8be1-056e51b1c1c0`; production booking pages respond successfully, assets match the tested version, public booking is available, and private requests reject unauthenticated reads. No real email or Calendar invitation was sent for testing.
