# Agentic People: guest ask, "search my network" (sub-project 7) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (native). Steps use checkbox (`- [ ]`) syntax.

**Goal:** An outsider (a founder, say) asks the owner's network a question without seeing the graph. The owner's agent drafts an answer from **work evidence only**, and the owner approves it. The answer describes people without naming them. A name is revealed only through an introduction: the guest requests it, the owner accepts as introducer, and the described person opts in.

**Architecture:**
- **Pure module `src/guest-ask.ts`:**
  - the `GuestAsk` type and its guest-facing view, `guestView()`;
  - `anonymous()`, a description validator that rejects any contact name, email, domain or company token;
  - limits: 3 asks per guest per day, questions of at most 500 characters, 7-day expiry.
- **Store:** `GuestAskStore`, an owner DO table `guest_asks`.
- **Owner side, MailSync RPCs:**
  - `submitGuestAsk(guest, question)` stores the ask and drafts an answer;
  - `listGuestAsks`, `answerGuestAsk(id, answer?)`, `declineGuestAsk(id)`, `setGuestAsk(enabled)`, `guestAsksFor(guest)`, `requestGuestIntroduction(guest, askId, ref)`.
- **Drafting:**
  - `searchPeople(question)` over work evidence only: theme signals, mail/Granola context and edge contexts. Never life signals, curiosity notes or peer answers.
  - The top 5 candidates get one model call for anonymous descriptions, validated by `anonymous()`.
  - Failed or missing descriptions fall back to a deterministic "Someone in your network who has worked on <theme keywords>".
- **Public routes** (`src/guest-ask-routes.ts`) under `/api/public/ask/<slug>`. The slug is the owner's booking slug, and guest identity reuses the booking Google visitor session for that (owner, slug).
  - `GET ''` returns the page.
  - `POST /sign-in` starts the booking sign-in with the return marker `guest-ask`.
  - `GET/POST /questions` lists or submits the guest's questions.
  - `POST /questions/<id>/introductions` requests an introduction with `{ref}`.
  - `POST /agent-token` mints a 7-day guest agent token, stored hashed.
  - `/mcp` is the public MCP endpoint with tools `ask_network` and `my_questions`. It authenticates with that token.
- **Pages:** `public/ask.html` and `public/ask.mjs`, served at `/ask/<slug>`.
- **Owner routes:**
  - `GET /api/people/guest-asks` (read);
  - `POST /api/people/guest-asks/answer`, `/decline` and `/settings` (write).
- **Owner MCP:** `list_guest_asks` (read); `answer_guest_ask` and `decline_guest_ask` (write).
- **CLI:** `crates/peoplegraph/src/guest.rs` with `guest pending|show|answer|decline|on|off`.

**Spec:** `docs/superpowers/specs/2026-11-20-agentic-people-design.md`, section "Sub-project 7".

## Global Constraints

- **Guest ask is off by default.** `setGuestAsk(true)` turns it on. While it is off, public submissions get 403 `guest_ask_disabled`, and the page says so.
- **Guest identity** is the booking visitor session for (owner, slug): email plus Google subject. A guest is keyed by `opaque('guest', subject)`.
  - Sign-in reuses `beginBookingSignIn` with `requestId: 'guest-ask'`.
  - `completeBookingSignIn` redirects that one marker to `/ask/<slug>`; every other `requestId` keeps the booking behaviour.
- **Limits:**
  - 3 questions per guest per UTC day, enforced in the owner DO; the 4th gets 429 `guest_rate_limited`.
  - Questions are 1–500 characters.
  - An ask expires 7 days after creation if not answered: `pending → expired` on read.
- **Draft privacy:** only `searchPeople` results and their own-owner work evidence feed the draft. Shared evidence counts toward relevance but never appears in text. Life signals, curiosity notes, moments and peer answers are never read.
- **What the guest sees.** `guestView` exposes:
  - `id`, `question`, `status` and `createdAt`;
  - when answered: `answer.text` and `answer.people[]` as `{ref, description}`, plus `name` only when that ref's introduction has reached `target_opted_in`, `made`, `met` or `not_met`.

  It never shows a `personId`, email, company or draft.
- **`anonymous(text, forbidden)`:**
  - rejects text containing any forbidden token as a whole word, case-insensitive: contact names, email local parts and domains, company names;
  - rejects `@` or any URL;
  - caps text at 200 characters.

  The forbidden set is built from every graph node's name and company, plus the ask's candidates' email domains.
- **Owner answer:** `answerGuestAsk(id, answer?)` approves the draft as is, or an edited `{text ≤ 1,000, people:[{ref, description}]}`. Every description and the text pass `anonymous()`; a failure gives 400 `answer_not_anonymous`. `ref`s must come from the draft. Only pending asks can be answered or declined.
- **Introductions:** `requestGuestIntroduction` creates an Introduction (from sub-project 6) with:
  - `introducer: 'owner'`, `parties: ['guest:<key>', personId]`;
  - `startedBy: 'guest'` (new value), so it counts against the owner's budget of 5 open introductions not started by the owner;
  - `reason` set to the guest's question.

  Only one introduction is allowed per (ask, ref). The owner then advances it as usual: `introducer_accepted` → `target_opted_in` → `made`.
- **Agent token:** 43 characters of base64url, stored only as `opaque('guest-agent', token)`, bound to owner, slug, email and subject, and expiring after 7 days. Up to 5 live tokens per guest. The MCP endpoint takes `Authorization: Bearer`.
- **Public responses** carry `cache-control: no-store` and `referrer-policy: no-referrer`. All public POSTs check `Origin`, except MCP, which uses the bearer token.

## Review Focus

- No path reveals a name, email, company or `personId` before the described person has opted in. That covers the guest view, the MCP tools and errors.
- The draft never reads life signals, curiosity notes or peer data.
- Rate limits and the on/off switch hold on both the web and MCP paths.
- The sign-in return marker can't be used to redirect to arbitrary URLs.

### Task 1: Guest model, anonymity and store (pure + store)

- [ ] **Step 1: Failing tests:**
  - `anonymous` rejects names, companies, domains, emails and URLs; allows clean text.
  - `guestView` hides the draft and `personId`, and shows a name only for an opted-in introduction.
  - Expiry after 7 days.
  - The per-guest daily limit.
  - Answering or declining a non-pending ask gives `guest_ask_state_invalid`.
- [ ] **Steps 2–5:** commit `feat(people): guest ask model and anonymity checks`.

### Task 2: Owner side (draft, answer, decline, settings, MCP, CLI)

- [ ] **Step 1: Failing tests:**
  - With the feature off, submitting is refused.
  - Submitting stores a pending ask with a draft whose people carry anonymous descriptions. It uses a mocked model; a bad model output falls back to the deterministic description.
  - The draft never contains a life-signal summary or curiosity-note text, even when the guest's question matches them.
  - Approve as is, approve edited, and an edit that names someone fails.
  - Decline.
  - Owner routes with scopes; MCP counts become read 14 and read+write 24.
  - Rust request shapes for `guest pending|show|answer|decline|on|off`.
- [ ] **Steps 2–5:** commit `feat(people): owner review of guest asks`.

### Task 3: Public routes, page and introductions

- [ ] **Step 1: Failing tests:**
  - **Page data:** disabled vs enabled.
  - **Sign-in redirect:** `completeBookingSignIn` returns to `/ask/<slug>` for the marker. A test hits the DB row directly; the existing booking callback tests stay green.
  - **Submit and list:** 3 per day; a 4th gets 429.
  - **Introductions:** requesting one creates an Introduction counted in the owner budget. The name is revealed only after `target_opted_in`.
  - **Bad input:** a foreign ref or a second request for the same ref is refused.
- [ ] **Step 2:** Verify in a browser on a static fixture, with the API mocked.
- [ ] **Steps 3–5:** commit `feat(web): public guest ask page and introductions`.

### Task 4: Guest agent access (public MCP)

- [ ] **Step 1: Failing tests:**
  - Minting a token needs a visitor session.
  - MCP `ask_network` submits under the same limits and on/off switch.
  - `my_questions` returns guest views.
  - An expired or revoked token gets 401.
  - At most 5 tokens.
- [ ] **Steps 2–5:** commit `feat(people): ask_network for guests' agents`.

### Task 5: Docs and skill

- [ ] Add a skill section: never answer a guest without the owner's approval; work evidence only; names only through introductions. Add a parity doc section.
