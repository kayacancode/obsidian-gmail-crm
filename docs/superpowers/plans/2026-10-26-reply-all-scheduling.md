# Reply-all scheduling plan

**Goal:** Keep all group scheduling communication in one reply-all conversation, as explicitly requested by the user.

**Design:** Emit one options/status email to every frozen guest and copy the owner. Keep one offer-bound reply address and verify sender identity using the incoming message's complete, aligned DKIM signature, or cryptographically verified Google ARC evidence from the owner’s exact received Gmail copy. Maintain separate votes and monotonically ordered replies per guest. Continue accepting previously sent private capabilities for their exact guest and current offer; subsequent status messages use the shared thread. Preserve all-voter consensus, exact offer expiry, owner review and Calendar reconciliation.

**Approach:** Shared routing token plus independently authenticated sender replaces private per-guest tokens for new group messages. Do not trust claimed Authentication-Results headers or an unverified From field. Use a vetted DKIM implementation with bounded DNS-over-HTTPS lookup and full-body signature checks. Existing private messages continue without requiring recipients to restart. Sender verification retries preserve original arrival order; pending or failed identity checks block reuse of older consent until a newer authenticated reply resolves them. Raw retry payloads are deleted after verification or the three-attempt / fifteen-minute bound. A newer ambiguous reply clears that guest’s earlier vote.

- [x] Sender authentication: real signed-message tests; strict alignment, action header coverage, complete body, bounded DNS/time; workerd compatibility.
- [x] Coordinator: one options/status message, shared reply capability, authenticated participant replies and ancestry, legacy private reply migration and frozen votes.
- [x] Owner UI: explicit continuation control for an already approved group can publish one shared options email without changing the offer or booking.
- [x] Runtime: real signed raw email through Worker ingress; forgery/tamper tests, consensus, refresh, retry and legacy compatibility.
- [x] Full tests, typecheck, browser checks, independent review and deploy; verify live thread delivery only under the user's explicit reply-all request.

## Live observation

The Limma request had already booked for November 3, 2026, 12:30–1:00 PM Eastern while implementation was in progress. No additional options will be sent for that confirmed meeting. Shiv’s actual Google Workspace message uses a Google default signing domain, so direct aligned DKIM alone is insufficient; the received Gmail fallback must verify Google’s cryptographic ARC seal and aligned authentication results, not simply trust a header or mailbox presence.

## Verification before deployment

168 frontend and 1,031 backend tests passed, including ten signed authentication groups and canonical Gmail proof checks. Booking and scheduling browser suites, TypeScript, and deployment dry run passed. A local check of Shiv’s real Google-received message validated successfully with live DNS; a real workerd smoke also validated a two-link Google ARC chain and rejected body, MIME-header and authentication-result tampering. Final integration coverage includes raw retry persistence and same-offer legacy migration.

Final real workerd suite: 60 tests passed, including canonical received Gmail API retrieval with real Google ARC i=2 signatures, pending withdrawal protection through retry exhaustion, and both migration paths cancelling queued private copies. Shared replies reserve their arrival order before DNS checks, so slower verification cannot make older consent appear current.

Deployed Worker `77578fc8-c73a-43de-b7fe-774078aa5763`. Production booking JavaScript matches the validated source byte-for-byte; the protected booking API returns the expected unauthenticated 401. No new live guest emails or Calendar events were sent during this update.
