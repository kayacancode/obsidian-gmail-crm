# Approve public booking requests by email

Reply to a time-request notification with Approve, Approve 2 when choosing among alternatives, or Decline. Keep the dashboard review link as a fallback. Only an exact recent message in the owner's connected Gmail Sent folder can authorize a change; use its canonical content, never the incoming SMTP body.

Each notification receives a random reply address bound to its request and selection revision. The existing scheduling address supports subaddress routing. Replies are persisted before processing; ambiguous replies request clarification. Changed selections and expired capabilities cannot book. The Booking coordinator serializes these actions with dashboard mutations, rechecks availability, and uses its existing idempotent Calendar writes and reconciliation.

Persist confirmation email intent and avoid automatic resend after an uncertain delivery. Verify parser, canonical Gmail authority, duplicates, altered proposals, expiry, competing actions, busy calendars, restarts and real Worker ingress using provider fixtures. Deploy and send the existing controlled test request's updated notification to Kaya; leave approval to the user.
