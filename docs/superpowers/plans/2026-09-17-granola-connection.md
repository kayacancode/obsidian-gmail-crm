# Granola Connection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user enter their Granola API key in a visible Accounts tab and verify access by browsing folders and note titles.

**Architecture:** Add a stateless, authenticated Worker proxy for two official Granola read endpoints. A separate browser controller keeps the credential only in memory and renders metadata safely within the existing Accounts page. This is the connection slice of the larger import design, not its AI extraction or saved-batch functionality.

**Tech Stack:** Existing Cloudflare Worker, TypeScript, browser ES modules, Node tests and Playwright.

**Spec:** `docs/superpowers/specs/2026-09-16-granola-api-import-design.md` (credential, metadata browsing and UI boundaries only). User's immediate request on September 17: “just add it so i can add the API key.” The full five-note extraction/persistence design remains future work and must not be advertised as available by this delivery.

## Global Constraints

- The key is used only for the official `https://public-api.granola.ai` API. No arbitrary upstream URLs, credential forwarding on redirects, browser storage, saved settings, raw request logging, model prompts, error messages or public assets containing the key.
- The Google-authenticated app account owns the import. Do not require the Granola account email to equal the app login; the user may legitimately connect personal Granola access to a work graph.
- No background sync, AI invocation, note-body reads, graph changes, persistence, or Obsidian plugin release in this connection slice.
- Clear key and metadata on disconnect, account change, app sign-out, authentication error, tab switch away from Granola, and pagehide. Fence and abort late requests. Refresh begins disconnected.
- Fictional keys, folders and notes only in tests. Never ask for a live key in chat or inspect a live key field.
- Preserve the existing map and Gmail account functionality. UI must work at 320 px and desktop widths.

## API contract shared by both tasks

```ts
// All are same-origin POST requests with JSON and an authenticated app session.
type FolderRequest = {apiKey: string; cursor?: string};
type NotesRequest = {apiKey: string; folderId: string; cursor?: string};
type FolderPage = {folders: {id: string; name: string; parentFolderId: string | null}[]; hasMore: boolean; cursor: string | null};
type NotePage = {notes: {id: string; title: string; createdAt: string; updatedAt: string}[]; hasMore: boolean; cursor: string | null};
// POST /api/granola/folders => FolderPage
// POST /api/granola/notes => NotePage
// All errors: {error: stable_code, message: fixed_safe_text}; no upstream body.
// App-session failures: 401. Granola credential failures: 422 granola_unauthorized.
// Granola denied: 422 granola_forbidden. Rate limit: 429 granola_rate_limited.
// Timeout: 504 granola_timeout. Malformed/other upstream error: 502 granola_unavailable.
```

### Task 1: Safe authenticated Granola metadata proxy

**Files:** Create `apps/people-graph/src/granola-client.ts`, `src/granola-routes.ts`, `tests/granola.test.ts`; modify `src/index.ts` and `tests/run-mail.mjs` under that app.

**Interfaces:** Consume existing `requireGoogleUser` routing guard and `boundedJSON`. Export `granolaRoute(request: Request): Promise<Response>` from granola-routes and `listGranolaFolders(apiKey: string, cursor?: string): Promise<FolderPage>`, `listGranolaNotes(apiKey: string, folderId: string, cursor?: string): Promise<NotePage>` from granola-client. Type names are defined in the contract above and exported by granola-client.

- [ ] Write failing tests against the real Worker route and client using external-fetch fakes only. Example integration assertions:

```ts
const denied = await worker.fetch(new Request('https://people.test/api/granola/folders', {method:'POST'}), fixtureEnv);
assert.equal(denied.status, 401);
// With a signed app session and Origin https://people.test:
assert.deepEqual(await response.json(), {folders:[{id:'fol_1234567890abcd', name:'Pilot', parentFolderId:null}], hasMore:false, cursor:null});
assert.equal(response.headers.get('cache-control'), 'no-store');
assert.equal(JSON.stringify(await invalidKeyResponse.json()).includes(testKey), false);
```

- [ ] Register the tests in run-mail and run `TEST_NAME=Granola node tests/run-mail.mjs`; verify failures are missing routes/behavior.
- [ ] Implement the client with fixed paths `/v1/folders` and `/v1/notes`, `page_size=30`, encoded cursor and folder_id, `Authorization: Bearer` only upstream, `redirect:'error'`, Accept JSON and a 15-second deadline spanning response-body reading. Explicit timeout race must settle even if an external reader ignores cancellation. Cancel the reader on expiry and clean timers/listeners in finally. Use bounded JSON up to 256 KB upstream. Reject malformed responses, >30 entries, missing/invalid pagination, hasMore with empty/repeated cursor, wrong ID types, invalid dates, oversized string fields. Copy only allowlisted output fields; drop owner emails, summary/private notes/transcript and all unknown upstream fields. Null title becomes `Untitled meeting`. Do not log raw errors or accept full URLs.

```ts
const url = new URL('/v1/notes', 'https://public-api.granola.ai');
url.searchParams.set('folder_id', folderId);
url.searchParams.set('page_size', '30');
if (cursor) url.searchParams.set('cursor', cursor);
// fetch with a deadline + AbortController, boundedJSON, then validated field projection.
```

- [ ] Implement routes: POST only; exact allowed JSON fields; content-type application/json; Origin must equal request origin; request <=8 KB streamed bytes; reject query-string credential/input parameters, extra fields, whitespace/control in key, and invalid IDs. Key 8–512 ASCII non-whitespace characters with `grn_` prefix. Folder IDs match `^fol_[a-zA-Z0-9]{14}$`; note IDs match `^not_[a-zA-Z0-9]{14}$`; cursor nonempty <=2048 chars without controls. Route is reachable only after verified app session. Return no-store JSON errors. Unknown Granola paths return 404; read requests never touch D1, Durable Object storage, AI or graph routes.

```ts
if (pathname.startsWith('/api/granola/')) {
  const user = await requireGoogleUser(request, env);
  if ('error' in user) return json({error:user.error},401);
  return granolaRoute(request);
}
```

- [ ] Test success plus origin/method/content type/query/size/schema validation; revoked/forbidden/rate-limit/upstream errors; no response echo; redirect option; timeout; malformed pagination; safe note projection. Run targeted suite, `npm test`, `npm run typecheck`, `git diff --check`.
- [ ] Commit only task files, self-review, and report commands plus RED/GREEN evidence to the assigned report file.

### Task 2: Visible Granola tab and memory-only connection UI

**Files:** Create `apps/people-graph/public/granola-connect.mjs` and `tests/granola-browser.mjs`; modify `public/accounts.html`, `public/accounts.mjs`, `public/accounts.css`, `public/index.html`, `package.json` in that app.

**Interfaces:** Consume the exact API contract above. Export `createGranolaConnection(root, {onUnauthorized})` from granola-connect returning `{setAccount(account: string | null), clear()}`. The controller owns its DOM, abort controller and generation; account module calls setAccount on authenticated render and clears before sign-out/pagehide, including failed sign-out. Controller fetch uses session cookies (`credentials:'same-origin'`) and `cache:'no-store'`, never the Google ID token or local storage. No requests before explicit user submission.

- [ ] Write a Playwright test before UI implementation. Existing local static-server/browser setup is in `tests/accounts-simple-browser.mjs`. Stub Google and the external `/api/*` boundary with fictional metadata; exercise real page/controller.

```js
await page.goto(origin + '/accounts?tab=granola');
await page.getByRole('tab', {name:'Granola', exact:true}).click();
await page.getByLabel('Granola API key', {exact:true}).fill('grn_fictional_test_key');
await page.getByRole('button', {name:'Connect Granola', exact:true}).click();
await page.getByText('Connected for this session', {exact:true}).waitFor();
assert.equal(await page.getByLabel('Granola API key', {exact:true}).inputValue(), '');
assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
```

- [ ] Run the browser test; verify missing-tab failure before implementing.
- [ ] Add an accessible Gmail/Granola tablist with keyboard navigation and aria-selected/panel associations to Accounts, preserving existing Gmail selectors and actions. Support `?tab=granola`; default Gmail. Header/copy identify sources rather than inboxes only. Add `Granola` link to the graph header using `/accounts?tab=granola`; no map layout changes. Keep tab visible when signed out with a sign-in prompt; key controls disabled until authenticated.
- [ ] Build the Granola panel using createElement/textContent, no HTML interpolation. Include password input, autocomplete off, spellcheck false, `Connect Granola`, official key help link, and clear disclosure: key goes through this app's backend to Granola, memory-only, re-enter after leaving/refresh; browsing only, no AI analysis or graph import yet. On successful first folder page erase input value, retain closure key for explicit pagination and folder requests, show `Connected for this session` and `Disconnect Granola`. Show scoped/empty/error cases with fixed safe messages; never display raw error bodies. Offer folder choice with no automatic selection, `More folders` only when needed, and `Browse notes` for selected folder. Note rows are safe text title + date, no invented note URLs, pagination `More notes`. Limit retained pages to 300 folders/300 notes, then give a clear limit message; disable duplicate submissions and repeated cursor loops. No checkboxes/import action implying AI is ready.
- [ ] Fence/abort requests and clear key, input, folder/note DOM on disconnect, app sign-out, app account change, app/Granola authentication errors, leaving tab, and pagehide. On failed connection clear input, retain no attempted key. A stale response must not restore anything. Folder switch clears notes/cursor before loading the next folder. Polling the same app account must not reset a healthy connection. If same-origin session changes during a request, account polling clears state.

```js
function clear() {
  generation++;
  pending?.abort();
  apiKey = '';
  input.value = '';
  folders = [];
  notes = [];
  // Reset cursors, busy/connected state and rendered private metadata.
}
```

- [ ] Expand browser tests: disconnected/connected states; empty/multiple pages; literal HTML note titles; API/auth errors; metadata/key absent after reload; tab switch; sign-out; owner change; deferred old response cannot restore content; 320/390 px overflow; pageerror absence. Register `test:granola-browser` in package scripts. Run it plus `test:accounts-browser`, `npm test`, `npm run typecheck`, and diff-check. Capture a fictional UI screenshot for visual QA.
- [ ] Commit only task files, self-review, and report RED/GREEN evidence and commands to assigned report file.

## Integration, review and deployment

- [ ] Review each task for spec compliance and code quality using isolated review agents. Resolve important findings before accepting a task; preserve existing unrelated changes.
- [ ] Run fresh full test/typecheck and both Accounts/Granola browser suites. Inspect the screenshot at desktop/mobile. Verify no graph-layout files changed.
- [ ] Run final review of the complete connection slice from starting commit `ab7f7ea`.
- [ ] Deploy the existing Worker using the project's normal `npm run deploy` after loading the wrangler skill. No secrets/config/account permissions changed. Open `/accounts?tab=granola` in the user's existing app tab, verify the tab and empty masked key field appear. Never read/screenshot a field after a user starts entering a live key.
- [ ] Report exactly what is live: key-entry and folder/note browsing. Live-key validation is pending the user entering their key; no AI extraction, saved import, or plugin release is claimed.
