# Suggested booking times

Visitors whose schedules do not fit the offered calendar can suggest up to three precise meeting starts, with their timezone prefilled. This implements the fallback discussed and approved in chat. Keep the calendar primary and the form behind “None of these times work? Suggest a time”; expose it when no openings exist too.

Use structured dates/times instead of a free-text note so the owner can approve a specific instant. A calendar-connection flow would add permissions and setup that this fallback does not need. Implementation choices: 1–3 local date/time inputs, server-side timezone conversion, ordinary JSON request fields, and existing approval/reservation machinery.

Suggestions are preferences with no hold or automatic booking. Save them on the existing authenticated request and show them to both its visitor and owner. Owner chooses one or asks for different times. An explicit approval may accept times outside configured weekdays/hours, but still respects current minimum notice, review delay, horizon, duration, buffers, calendar conflicts and daily/weekly capacity. No visitor bypasses priority decisions or closed-request state.

Validation rejects invalid dates, nonexistent/ambiguous daylight-saving local times, duplicates, excessive counts and invalid zones. Only the verified Google identity owning the request may suggest/edit times. Each saved proposal set has a revision; approving a stale set fails rather than silently booking a replaced suggestion. Selecting an offered slot clears alternatives. Existing Calendar reconciliation/idempotency remains in use. Request status recovery shows saved proposals rather than reopening intake. Failure leaves visitor edits intact; expired sessions require sign-in and owner data remains private.

No migrations, custom email, additional Google scopes, automatic invitations during testing, or merge into main. Deploy and push to existing PR12 after meaningful tests and review.
