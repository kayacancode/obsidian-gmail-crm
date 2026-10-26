# Use People with your agent

People can help an agent answer “Who do I know?”, find people relevant to your saved goals, explain a connection, and remember context you ask it to save. You do not need Obsidian for the hosted app or its agent connection.

## 1. Prepare your People account

Open [People](https://people-graph.kayarjones901.workers.dev/) or your own deployment. Sign in, connect the sources you want under **Accounts**, and let the import finish. Review your **People Lens** and save your focus, needs, and offers. Recommendations use those confirmed values; pending inferred suggestions do not become your instructions automatically.

## 2. Choose a connection

| Connection | What it can do | What you approve |
| --- | --- | --- |
| CLI browser login | Read the graph visible in your People account | `peoplegraph login`, then approve the displayed code in the browser |
| CLI with a People key | Read your saved Lens, recommendations, connections, and private memory; optionally save context | A named key in **Accounts → Integrations** |
| MCP with a People key | The same private People tools, from a compatible agent client | A named key plus a client that supports Streamable HTTP and a custom bearer header |
| Local Obsidian CLI | Read or maintain your plugin-generated contact index | An explicit local cache and the requested local action |

Browser login and People keys are separate credentials. A logged-in CLI does not gain access to private memory commands automatically. The Obsidian plugin is optional; updating it does not connect an agent or grant private web access.

## 3. Install the CLI and skill

The coordinated versions are **PeopleGraph 0.3.12** and **Obsidian plugin 0.9.5**. The CLI release contains macOS Apple Silicon, macOS Intel, and Linux x86_64 binaries. You do not need Rust to install a release.

Download the versioned installer, review it if desired, and choose your agent explicitly:

```bash
curl --proto '=https' --tlsv1.2 -fsSL \
  https://github.com/kayacancode/obsidian-gmail-crm/releases/download/peoplegraph-v0.3.12/install-peoplegraph.sh \
  -o install-peoplegraph.sh
bash install-peoplegraph.sh --skill codex
~/.local/bin/peoplegraph version
```

The installer verifies the release's SHA-256 checksums before replacing installed files. An unavailable release, missing guide, or checksum failure leaves existing files intact. It replaces the binary instead of overwriting a running macOS executable. The checksums detect damaged or mismatched assets; the download still trusts the GitHub release.

| Option | Skill destination |
| --- | --- |
| `--skill codex` | `$CODEX_HOME/skills/peoplegraph`, or `~/.codex/skills/peoplegraph` when unset |
| `--skill claude` | `~/.claude/skills/peoplegraph` |
| `--skill agents` | `~/.agents/skills/peoplegraph` for clients that discover this common directory |
| `--skill-dir /absolute/path/peoplegraph` | Your explicitly chosen directory containing `SKILL.md` |

Repeat `--skill` to install for more than one agent. Omit all skill options to install only the binary. `--bin-dir` changes its destination; `--version X.Y.Z` selects another CLI release that includes checksums. The installer does not inspect or edit agent configuration, shell profiles, or credentials. The skill includes offline guides in its `references/` directory. Reload your agent's skills after installation if needed.

If `peoplegraph` is not found, add `~/.local/bin` to your shell's `PATH`, or use the full path shown above. Run `peoplegraph version` and `peoplegraph describe` to verify which binary and commands your agent sees.

## 4. Connect the access you need

For graph questions, start with browser login:

```bash
peoplegraph login
peoplegraph find-person "Maya"
peoplegraph who-knows --company "Acme"
```

Approve the code only after checking the People account shown in the browser. Use `peoplegraph login --no-browser` if the agent cannot open a browser. See [browser login and local mode](https://github.com/kayacancode/obsidian-gmail-crm/blob/peoplegraph-v0.3.12/docs/peoplegraph-web-login.md) for expiry, revocation, and self-hosted deployments.

For private context, create a named People key in **Accounts → Integrations**. Leave it read-only for lookup and recommendations. Select **Save context updates** only if you want this client to save notes or edit private profiles. Store the key in your client's secret environment:

- `PEOPLEGRAPH_WEB_URL`: your People origin, such as `https://people-graph.kayarjones901.workers.dev`.
- `PEOPLEGRAPH_WEB_TOKEN`: the People key shown once when you create it.

Keep the key out of chat, notes, source control, and command-line arguments. Then try:

```bash
peoplegraph lens
peoplegraph matches
peoplegraph search "climate founders" --limit 5
```

A missing Lens or insufficient evidence can correctly produce no recommendations. Save or correct your Lens in People instead of asking the agent to invent goals. Keys expire after 90 days; revoke or replace one in Integrations. Graph login is revoked separately under **Accounts → Connected CLI devices**.

### MCP instead of the CLI

In your client's MCP settings, use the endpoint shown in Integrations: `<your-origin>/api/people-mcp`. Configure `Authorization: Bearer <People key>` through that client's secret storage. The endpoint supports Streamable HTTP with a custom bearer header. Client configuration varies; this is not a promise of OAuth or compatibility with every MCP client. If your client only offers OAuth connections, use the CLI or a client that accepts bearer headers.

Read tools are `get_people_lens`, `recommend_people`, `find_people`, `explain_connection`, `suggest_connections`, and `lookup_relationship_memory`. Write-enabled keys also expose `capture_relationship_context` and `save_relationship_memory`. REST clients use `<your-origin>/api/people-agent`. See the [API and MCP contract](https://github.com/kayacancode/obsidian-gmail-crm/blob/peoplegraph-v0.3.12/docs/people-memory-integration.md) for inputs and conflicts.

## 5. Try a conversation

- **“What have I saved as my current focus and needs?”** The agent reads the confirmed People Lens and distinguishes it from inferred suggestions.
- **“Who in my network could help with those needs, and why?”** It retrieves recommendations, shows the supporting source context, and says when evidence is missing.
- **“Find Maya at Acme.”** It searches first; if multiple people match, you choose the right person.
- **“What connects Maya and Sam?”** It resolves both identities and explains recorded connection types. A shared thread or meeting is not proof that one will introduce you.
- **“Remember for Maya, maya@example.com: she is looking for nurse design partners.”** With write access, it adds a dated private note using that exact email. This does not imply you have spoken before or change relationship scores.
- **“Change Maya's saved needs to nurse design partners.”** It reads the current profile, preserves other fields, and saves your explicit edit with revision checking.

People tools do not send email, make introductions, or create calendar events. An agent should draft or send outreach only when you ask and through a separately authorized tool. Scheduling is a separate opt-in integration at `/api/scheduling/mcp`, with its own credential; a People key does not enable it.
