# People agent onboarding and coordinated release

The user approved completing agent access to People Lens, simplifying onboarding, and releasing the Rust CLI, skill and Obsidian plugin together. The everyday use case is asking an agent, “Given what I am focused on, who should I talk to, and why?”, then saving explicitly requested relationship context.

Use the existing hosted People service and Rust CLI. Reconcile the published 0.3.11 release branch with main so login, logout, local mode and hosted graph queries remain available. Add authenticated read tools for the confirmed saved lens, recommendations, person search, connection evidence, and selected-person suggestions. Reuse the web app's services and conflict checks; do not create another scoring or matching system.

Private lens and memory access uses the owner's existing scoped People integration credentials. Legacy device credentials retain their published graph-query scope. Inferred lens updates never become saved focus automatically. No agent read tool sends messages or books meetings. Scheduling remains separately authorized.

The Integrations panel explains setup and supplies a generic remote MCP configuration, CLI environment template and connection check without exposing keys in URLs or logs. The installer distributes a consistent binary, skill and referenced documentation, with explicit skill destinations and verified artifacts. Preserve existing local configuration and fail safely on invalid downloads.

Release the reconciled CLI as 0.3.12 and the already-versioned Obsidian plugin as 0.9.5 after tests, review, deployment and release asset checks. The plugin provides richer activity evidence; users repush their graph to update existing snapshots. Preserve released CLI behavior, private data boundaries, and reversible alias merges. No real outreach or scheduling is part of release verification.

Alternatives considered: a plugin-only update cannot expose the lens to agents; a separate agent backend would duplicate evidence rules. The coordinated update to existing services is the approach the user authorized. Exact tool names and packaging are implementation choices.
