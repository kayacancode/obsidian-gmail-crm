# Plugin warning cleanup

Authorized scope: fix plugin warnings, separate hosted service checks, and submit a corrected release.

1. Update Obsidian API types, adopt searchable settings definitions/update, use owner-window timers and DOM helpers, and replace obsolete build dependencies. Run focused OAuth/workspace/settings tests and the release gate.
2. Preserve tracked apps and shared contracts in a public People Atlas services repository. Keep it pinned as a submodule for cross-boundary tests; remove hosted app source from plugin scan. Give services independent type/test CI without Obsidian browser rules. No deployment or user-data change.
3. Verify fresh recursive checkout, plugin package reproducibility and service checks. Review diff, PR checks and Obsidian branch preview before merge/release. Preserve plugin ID and storage.

Review focus: OAuth timer cleanup in Node tests and Electron, popout document ownership, settings save/refresh/search, graph payload contract compatibility, submodule availability in CI.
