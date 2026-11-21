# People in ChatGPT

The owner approved using the existing hosted People MCP from ordinary ChatGPT. Keep the CLI and existing integration keys working; add browser OAuth approval and a portable plugin rather than requiring terminal access.

Implementation:

1. Use Cloudflare's maintained OAuth provider for discovery, registration, authorization codes, PKCE, refresh and token revocation. Support only private People read/write permissions and optional refresh access.
2. Bind browser approval to the signed-in owner, the browser transaction and the displayed permission set. Enforce an atomic consent claim in D1 and use existing owner-revocable credentials as an additional access/refresh fence.
3. Route authenticated MCP calls through the existing tools and owner stores. Never forward People OAuth credentials to Google; keep source, sharing and scheduling administration outside this connection.
4. Add a simple approval screen, ChatGPT-first Integrations instructions and a portable plugin skill for meeting preparation, network discovery and explicitly requested saves.
5. Exercise the full protocol with local synthetic accounts, browser consent and mobile layout; review security independently; deploy and verify public discovery. Push the branch without merging main. A real ChatGPT installation still requires that account's consent and supported plugin controls.

Verification covers scope/owner/audience isolation, PKCE, browser binding, replay, refresh downscoping, owner revocation, legacy credentials, safe clipboard contents and honest package/install documentation. Successful synthetic OAuth tests are not a claim that the user's ChatGPT account has connected or that a plugin has been directory-published.
