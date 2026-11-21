# PeopleGraph 0.3.18

PeopleGraph 0.3.18 makes People work for natural-language questions from agents. It is built on three questions: when you last spoke, why you know someone, and whether an introduction is worth making. It also surfaces people outside your usual circles, keeps private life context from catch-up conversations, and lets agents ask each other over a private tailnet.

## What is new

**Honest names and provenance (foundation)**
- Name matching no longer guesses. Ambiguous names return `ambiguous_person` with the candidates, empty results include hints, and the owner is never returned as their own contact.
- Single-person commands accept an email, an exact name or a person ID.
- Every response reports where its data came from.

**Life signals and the catch-up brief**
- `signals on|off|list|forget` keeps first-hand life signals from catch-up conversations: travel, moves, milestones, hobbies and sensitive categories.
- Signals are off by default. Their tiers and expiry are fixed, so the model never chooses them. Sensitive items are `tone_only` and never shared.
- `brief <person>` returns `when`, `why`, `whether` and both sides of what changed since you last spoke.
- `stints`, `job-moves` and `teammates` show company history derived from email domains plus your own corrections.

**`ask`: one natural-language entry point**
- `peoplegraph ask "<question>"` (MCP `ask`) returns its interpretation of the question beside the answer, so an agent can check what was understood.
- When the question is unclear, it asks which alternative you meant.

**Peer layer (tailnet)**
- `peer init|join|allow|add|serve|pending|approve|ask` lets two owners' agents ask each other `knows`, `catch_up` and `reason_to_meet` questions without uploading their networks.
- Peers are identified by Tailscale identity. Each kind of question has its own policy (`auto`, `approve` or `never`). Answers are ticketed, rate-limited and audited, and each person can opt out.

**Structure: why now, contrast, widen, bridges, atlas**
- `why-now`, `contrast`, `widen`, `bridges` and `atlas` (MCP `get_atlas`, schema `/schemas/v1/atlas.json`) cluster your network into circles.
- They surface fringe perspectives and people who should meet, and list kinds of community that seem to be missing.

**Curiosity notes and moments**
- `mind set|list|archive` stores up to three private notes: what's new in your head, why it interests you, the fringes, and who you want to talk to.
- `moments` turns those notes into a few evidenced reasons a day to reach out, within a small budget. Success is counted as moments you acted on.

**Three-party introductions**
- `intros list|show|propose|advance|outcome` (four MCP tools) records introductions with a double opt-in.
- Steps: proposed, asked the introducer, introducer accepted, the other person agreed, made, then met or not met.
- Limits: five proposals a day and five open asks per introducer. Made introductions appear as dotted connectors in the graph, and vouches stay private.

**Guest ask ("search my network")**
- Outsiders can ask your network a question at `/ask/<booking-handle>`, or from their own agent through the public MCP tool `ask_network`.
- Guest ask is off until you run `guest on`.
- Drafts use work evidence only, never life signals, notes or peer answers, and include only people you know first-hand and haven't set aside.
- Nothing reaches a guest until you approve it with `guest answer`. Answers describe people without naming them, and a name appears only after that person agrees to an introduction.
- Limits: three questions per guest per day and 30 a day in total.

## MCP

- The read tools are now 14; read plus write is 25.
- New read tools: `get_catch_up_brief`, `list_life_signals`, `ask`, `get_atlas`, `list_curiosity_notes`, `list_moments`, `list_introductions`, `list_guest_asks`.
- New write tools: `set_curiosity_note`, `archive_curiosity_note`, `update_moment`, `propose_introduction`, `advance_introduction`, `record_introduction_outcome`, `answer_guest_ask`, `decline_guest_ask`.

## Updating

Install the versioned CLI and reload the bundled agent skill, which now covers each of the areas above. Existing credentials keep their scopes.

No D1 migration is needed. New owner data lives in Durable Object storage, and the guest agent token table is created on first use.

Guest ask reuses the booking Google sign-in. It is therefore available only where booking sign-in is ready (today, the pilot owner).

## Verification

**Web:**
- 1,254 backend and 179 frontend tests passed, and TypeScript is clean.
- The booking runtime suite (Miniflare) passed 64 of 64, including the guest ask sign-in return.

**Rust:**
- 187 tests passed and formatting is clean.
- Clippy reports nothing introduced on this branch. Pre-existing items in `hosted.rs`, `people_client.rs` and older `main.rs` code are unchanged.

**Review:**
- Each sub-project had an independent whole-branch review. Every Critical and Important finding was fixed with a failing test first.
- Where a failing test couldn't be observed, a temporary mutation proved that the test catches the bug.

**Browser:**
- The introductions graph rendering was verified in Chrome.
- The guest ask page was verified at the DOM level against a mocked API: sign-in, questions, introduction requests, the name shown after opt-in, and agent tokens. Screenshots were unavailable in the verification environment.

**Live checks:**
- A Tailscale `whois` smoke test resolved a real tailnet identity and ignored a spoofed header.
