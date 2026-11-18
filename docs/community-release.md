# Community release preparation

Candidate: **Gmail CRM 1.0.0**, desktop only, minimum Obsidian **1.15.0** (the version used for the confirmed graph sign-in).

## Completed

- Plugin-first README, installation instructions, support and MIT license links.
- Network/account disclosures for Google, Anthropic, People/Cloudflare and custom score endpoints.
- Corrected Gmail OAuth scopes and AI note-content disclosure.
- Browser-to-Obsidian People graph sign-in confirmed by the maintainer.
- Gmail OAuth state validation and PKCE; callback error text no longer interpolates remote HTML.
- Matching package/manifest/version-history candidate versions.
- Repeatable build, checks, release asset packaging and SHA-256 checksums.
- GitHub workflow verifies pull requests and builds artifacts for numeric version tags or manual runs. Tags create a draft release with attachments; it does not publish automatically.

## Before publication

- Recommended review lint now passes, and is enforced by `check:release`. Repeat the full release gate after any further changes.
- Real-account Gmail reconnect verified on November 17, 2026 in the installed 1.0.0 candidate on Obsidian 1.15.1: Google returned to the loopback callback, and Obsidian proceeded to contact/photo reading and people-page loading. Automated tests separately verify state rejection and PKCE binding. This was an existing vault, not a clean-vault test.
- Authenticated embedded personal graph verified in the same session: the Obsidian tab rendered 344 people. That initial smoke test did not assert shared-network switching or a complete sync; both were subsequently tested as described below.
- Verify first-run behavior, disconnect, refresh, shared network membership, and sign-out in a clean vault.
- Confirm the shared Google Desktop OAuth client is available to outside users; document custom credentials as the fallback.
- Capture screenshots using synthetic contacts or explicitly approved public data.
- Review and commit only plugin-related changes. The working checkout contains unrelated web/server work and earlier local changes.
- Ensure the repository's default branch contains the reviewed source, README, LICENSE and manifest.
- Create GitHub release tag **1.0.0** (no `v` prefix) with `dist/plugin/main.js`, `manifest.json` and `styles.css` as attachments.
- Sign in at https://community.obsidian.md, connect GitHub, and submit https://github.com/kayacancode/obsidian-gmail-crm for review.
- Address the directory's automated and human review feedback before announcing availability.

Obsidian's current submission process uses the Community directory, not the older community-plugins.json pull-request process.

## Local commands

```sh
npm ci
npm run lint
npm run check:release
```

`check:release` runs recommended review lint, the plugin tests, TypeScript, production build and asset validation.

References: https://docs.obsidian.md/Plugins/Releasing/Submit%20your%20plugin and https://docs.obsidian.md/community-directory/developer-policies

## November 18 live full-sync verification

The installed 1.0.0 candidate was tested using the real Obsidian controls and the proving-it-works movie workflow. Full re-sync processed 3,316 messages and finished with the visible notices “Synced 292 contacts — scores updated” and “Scored 292 contacts — 292 pages updated”. The native window capture of that final state is kept privately with the other verification artifacts. Calendar synchronization completed before scoring.

The sync cache and contact index were saved after the run; no raw mailbox contents, tokens or contact data are attached to the public repository.

Shared-network switching was then tested after refreshing the expired People session through the browser handoff. The authorized shared workspace loaded in the embedded tab; selecting the personal network loaded 353 people; selecting the shared workspace again and using the embedded app’s Menu → Refresh loaded the shared records again with contributor attribution. This tests the app’s refresh control; the plugin toolbar’s Refresh reloads the configured deployment URL.

The evidence uses real native window captures and the proving-it-works build/check pipeline. The silent movie and contact sheets are private because they contain real people data. The committed capture and assembly scripts contain no private frames or credentials.
