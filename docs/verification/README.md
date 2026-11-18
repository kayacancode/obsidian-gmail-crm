# Live release verification

Uses the proving-it-works-with-a-movie workflow from prime-radiant-inc/proving-it-works, revision 0254aad1cba0beeda895a012bc630421a22e722a. See its docs/install/codex.md and skills/proving-it-works-with-a-movie/{SKILL.md,rendering-stills.md,assembling.md}.

The real Obsidian UI is driven through desktop controls. The native macOS window is captured with capture-obsidian-window.sh; screenshots are read back before assembly. No endpoint calls, injected app state, fake contacts or staged success states stand in for the UI test.

Private contact data and credentials must never be committed or attached to the public pull request. Raw frames and the finished evidence movie remain outside the repository under the local Codex artifacts directory. Only the reusable capture script, scene file, and sanitized test results belong in Git.

For a live full re-sync, preserve copies of the plugin’s existing contact-index.json, message-cache.json, and data.json before starting. The maintainer explicitly requested the real full sync; ordinary demo recording should use a disposable data copy.

Build the scene file with the skill’s bin/movie build command. Inspect the resulting movie-check/contact-sheet.png and run bin/movie check with --no-expect-audio and --no-expect-subtitles for a deliberately silent recording. The evidence must show final sync completion and both network selections before it can be called passed.

Capture these real states into the private artifact directory’s `window/` folder:

- `sync-progress.png`: full re-sync is visibly processing the mailbox.
- `sync-complete.png`: the completion notice is visible after all messages and post-sync work finish.
- `shared.png`: Betaworks is selected and the shared graph is populated.
- `personal-return.png`: switching back loads the personal graph.
- `shared-return.png`: returning to Betaworks and refreshing still loads shared records.

Then run:

```sh
node docs/verification/build-evidence.mjs /path/to/private/artifacts /path/to/proving-it-works/skills/proving-it-works-with-a-movie/bin/movie
```

This creates a silent movie, with explicit title cards rather than narration. Inspect every input PNG and the final generated contact sheet. No listening check is needed for intentionally silent evidence. Keep the completed artifact private because it includes real contact data.
