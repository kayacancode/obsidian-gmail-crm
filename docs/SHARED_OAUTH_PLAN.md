# Gmail CRM — Shared OAuth Setup Plan

## Goal
Users click "Connect" in plugin settings → browser opens Google sign-in → done.
No GCP project creation, no client ID/secret entry.

## What Kaya Needs To Do (GCP Console)

### 1. Create OAuth Client (if not already done)
- Go to: https://console.cloud.google.com/apis/credentials
- Project: use her existing kayacancode project
- Create OAuth 2.0 Client ID → **Web application** (not Desktop)
  - Name: "Gmail CRM for Obsidian"
  - Authorized redirect URIs: `http://127.0.0.1:42813/callback`
- Save the Client ID and Client Secret

### 2. Configure OAuth Consent Screen
- Go to: https://console.cloud.google.com/apis/credentials/consent
- User type: **External** (so any Google user can sign in)
- App name: "Gmail CRM for Obsidian"
- User support email: kayarjones901@gmail.com
- Developer contact: kayarjones901@gmail.com
- App homepage: https://github.com/kayacancode/obsidian-gmail-crm
- Privacy policy: https://github.com/kayacancode/obsidian-gmail-crm/blob/main/PRIVACY.md
- Logo: optional but helps with trust

### 3. Add Scopes
- `https://www.googleapis.com/auth/gmail.metadata` (restricted — triggers verification)
- `https://www.googleapis.com/auth/calendar.events.readonly` (sensitive)
- `https://www.googleapis.com/auth/userinfo.email` (basic)

### 4. Submit for Google Verification
Because gmail.metadata is a restricted scope, Google requires:
- Privacy policy URL (we'll create PRIVACY.md in the repo)
- Homepage URL (GitHub repo)
- A short video demonstrating what the app does with the data
  - Show: plugin settings, click Connect, sync runs, show People pages
  - Emphasize: only reads metadata (From/To/Date/Subject), no email body content
  - Duration: 1-3 minutes is fine
- Google review takes 1-4 weeks

### 5. While Waiting for Verification
- The app works for up to 100 "test users" added manually in the consent screen
- Current users (John, Kaya) should be added as test users
- Anyone else who wants early access: add their Gmail to the test users list

## Code Changes Needed

### 1. Embed the shared client ID in the plugin (NOT the secret for now)
For a "Web application" OAuth client, the client secret IS required for the token exchange.
But for an "Installed/Desktop" app type, Google's docs say the secret is not truly secret.

**Decision: Use "Desktop app" type** — this is the standard for desktop apps like Obsidian.
The client ID and secret are embedded in the plugin. Google explicitly allows this for
installed apps: "The process results in a client ID and, in some cases, a client secret,
which you embed in the source code of your application. (In this context, the client secret
is obviously not treated as a secret.)"

### 2. Plugin changes (src/settings-tab.ts + src/types.ts)
- Add a DEFAULT_CLIENT_ID and DEFAULT_CLIENT_SECRET constant
- Settings UI: show "Connect with Google" button by default (no client ID/secret fields)
- Add a toggle "Use custom OAuth credentials" for power users who want their own GCP project
- When custom is off, use the embedded credentials
- When custom is on, show the client ID/secret fields as today

### 3. Create PRIVACY.md in the repo
Required for Google verification. Should cover:
- What data is accessed (metadata only)
- Where it's stored (local vault only)
- No data transmitted to any server
- No analytics, no tracking
- How to revoke access
