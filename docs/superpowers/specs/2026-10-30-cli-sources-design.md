# CLI source setup and truthful Lens refresh status

John's agent can now edit a Lens, but cannot discover how to connect source evidence or distinguish an idle Lens from a queued Honcho sync. Finish that setup flow without changing the existing permission boundary.

## Approach

Keep `login --write` as `people:read` plus `people:write`. Request `sources:manage` explicitly for source setup. This already works in 0.3.14; dedicated commands will call the same registered source handlers used by the web app. Automatically expanding write access would grant unrelated source control, while documenting only the generic API would leave the usability problem in place.

Add `sources status`, `sources connect gmail|granola`, `sources sync gmail|granola`, and Gmail automatic-context controls. Granola keys enter via bounded stdin and never appear in output or command arguments. Gmail connect returns a validated browser handoff and clearly says consent is still required; it must never report that an account was connected merely because a link was returned. Gmail sync selects an exact connected account.

Expose truthful Lens refresh diagnostics. Enabling learning does not queue a projection; an explicit refresh collects permitted context and asks Honcho for suggestions. Existing persisted pending state must not imply work is running. Preserve the separation between confirmed Lens fields, proposed edits, owner evidence, and candidate evidence used by matches. Do not add automatic provider uploads or fabricate matches from contact dates.

## Success checks

- A source-scoped credential connects Granola and triggers source sync through the CLI.
- Missing permission gives the exact login command required, without changing grants.
- Secret input, invalid account selection, and hostile handoff URLs fail safely.
- An idle or empty Lens clearly names the next action; a genuine provider response remains distinguishable.
- Documentation describes Gmail browser consent honestly and explains why `considered: 0` is independent of Honcho.
