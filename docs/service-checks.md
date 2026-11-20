# Plugin and hosted-service checks

The public hosted applications are maintained in https://github.com/kayacancode/people-atlas-services. The `services` git submodule pins the exact source used by plugin/server integration tests; the plugin build does not bundle or execute it. Obsidian reviews the plugin source in this repository. Server checks use each service package’s own Workers types and dependencies, rather than Obsidian DOM/network rules.

`npm run check:release` checks shared contract equality, current Obsidian lint rules, plugin tests, TypeScript, build, and packaging. Clone recursively or run `git submodule update --init --recursive` first.

The services repository’s `Hosted service checks` workflow installs each package’s lockfile and runs People Graph type checks and its full test suite, plus reconnect service type checks. `npm run check:services` runs the same checks locally after installing dependencies in both service directories.

For server development, work in the services repository and update its deployment independently. After reviewed server changes, update the submodule pin in a plugin PR and run graph-contract tests. If shared protocol files change, update both copies; the contract check rejects drift. Existing working copies of the former monorepo retain their files and are not silently migrated.

Extraction baseline: fd12efe1b6f026b0cdfb737894046f47311cc719. No deployment, account permission, OAuth client, plugin identifier, or saved vault data changed during the extraction.
