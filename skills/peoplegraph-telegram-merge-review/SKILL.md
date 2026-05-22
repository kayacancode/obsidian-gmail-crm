---
name: peoplegraph-telegram-merge-review
description: Review PeopleGraph external contact merge suggestions in Telegram, then apply or dismiss approved merges through the PeopleGraph CLI.
---

# PeopleGraph Telegram Merge Review

Use this skill when John/Botwick's OpenClaw Telegram agent is asked to review, approve, reject, or apply PeopleGraph contact merges.

## Requirements

- `peoplegraph` CLI version `0.3.0` or newer.
- `PEOPLEGRAPH_CACHE` points to Botwick's source-of-truth `contact-index.json`.
- `TELEGRAM_BOT_TOKEN` is available to the Telegram runtime, if the agent sends messages directly.
- `TELEGRAM_REVIEW_CHAT_ID` points to the private review chat or trusted reviewer group.
- `PEOPLEGRAPH_APPROVER_TELEGRAM_IDS` contains the Telegram user IDs allowed to approve merges.
- `PEOPLEGRAPH_REVIEW_STATE` optionally points to a JSON state file. Default to `$HOME/.peoplegraph/merge-review-queue.json`.

## Core Rules

- Botwick's `PEOPLEGRAPH_CACHE` is the universal source of truth.
- External user caches must be staged with `import-cache`; do not copy their private notes into Botwick's core record.
- A merge approval may add objective identity data only: names, previous names, email aliases, phone numbers, company, role, and location history when available.
- Never merge subjective relationship notes, personal context, private commentary, email bodies, or source-specific scores into the shared core card.
- Never auto-apply a merge based only on confidence. A trusted human must approve first.
- Treat a rejection as `not_same_person` unless the reviewer gives a more specific reason.
- Write commands must run on the machine that has local write access to Botwick's `contact-index.json`.

## Bridge Script

This repo includes a dependency-free bridge script that John's OpenClaw Telegram runtime can call:

```bash
node scripts/peoplegraph-telegram-review.mjs help
```

The script owns the review queue, sends inline button messages, and handles Telegram `callback_query` payloads.

Useful environment:

```bash
export PEOPLEGRAPH_CACHE="/path/to/botwick/.obsidian/plugins/gmail-crm/contact-index.json"
export TELEGRAM_BOT_TOKEN="123456:telegram-token"
export TELEGRAM_REVIEW_CHAT_ID="123456789"
export PEOPLEGRAPH_APPROVER_TELEGRAM_IDS="111111111,222222222"
export PEOPLEGRAPH_REVIEW_STATE="$HOME/.peoplegraph/merge-review-queue.json"
```

## Stage Another User's Cache

When a user gives the agent another plugin user's local cache, import it as an external source:

```bash
peoplegraph --cache "$PEOPLEGRAPH_CACHE" import-cache --source "<source_id>" "<path/to/contact-index.json>"
```

Use a short stable source ID such as `kaya`, `john-laptop`, or `founder-a`.

## Build The Review Queue

Generate pending merge suggestions:

```bash
peoplegraph --cache "$PEOPLEGRAPH_CACHE" suggest-external-merges --source "<source_id>" --limit 25 --min-confidence 0.82
```

Or use the bridge script, which stores pending review items:

```bash
node scripts/peoplegraph-telegram-review.mjs queue --source "<source_id>" --limit 25 --min-confidence 0.82
```

For each suggestion, store a queue item in `PEOPLEGRAPH_REVIEW_STATE`:

```json
{
  "review_id": "m_001",
  "source": "kaya",
  "primary": "harper@2389.ai",
  "external": "harper@nata2.org",
  "confidence": 0.9,
  "reasons": ["same_name", "very_similar_name"],
  "status": "pending",
  "telegram_message_id": null,
  "telegram_poll_id": null
}
```

Use short review IDs because Telegram inline button `callback_data` has a small payload limit. Keep the full emails and command arguments in the queue state, not in the button payload.

## Render A Merge Review

Before asking for approval, show the reviewer a minimal card:

```text
PeopleGraph merge review m_001

Confidence: 90%
Why flagged: same_name, very_similar_name

Botwick source of truth:
Harper Reed
Email: harper@2389.ai
Company: 2389
Location: if available

External source: kaya
Harper Reed
Email: harper@nata2.org
Company: Nata2
Location: if available

If approved, PeopleGraph will add the external objective identity fields to the Botwick core record.
Private relationship context will stay source-specific.
```

If the reviewer asks for more detail, run:

```bash
peoplegraph --cache "$PEOPLEGRAPH_CACHE" contact-card "<primary_or_name>"
```

## Preferred Telegram UX: Inline Buttons

Prefer Telegram inline buttons over a native poll for actual approval. Inline buttons provide exact callback data, which is better for a command-like workflow.

To send the next pending review:

```bash
node scripts/peoplegraph-telegram-review.mjs send-next --source "<source_id>"
```

Send a Telegram message with an inline keyboard like:

```json
{
  "inline_keyboard": [
    [
      { "text": "Merge", "callback_data": "pgm:m_001:approve" },
      { "text": "Reject", "callback_data": "pgm:m_001:reject" }
    ],
    [
      { "text": "Details", "callback_data": "pgm:m_001:details" }
    ]
  ]
}
```

When the agent receives a callback, pass the Telegram update JSON to the bridge script:

```bash
node scripts/peoplegraph-telegram-review.mjs handle-callback -
```

The script will:

1. Parse `callback_data` as `pgm:<review_id>:<action>`.
2. Verify `callback_query.from.id` is in `PEOPLEGRAPH_APPROVER_TELEGRAM_IDS`.
3. Call Telegram `answerCallbackQuery` so the button press finishes in the Telegram client.
4. Load the queue item by `review_id`.
5. Confirm the item is still `pending`.
6. Run the appropriate PeopleGraph command.
7. Mark the item `approved`, `rejected`, or `failed`.
8. Edit the Telegram review message with the final result and a short command summary.

Approve:

```bash
peoplegraph --cache "$PEOPLEGRAPH_CACHE" apply-external-merge --source "<source_id>" --primary "<primary_email>" --external "<external_email>"
```

Reject:

```bash
peoplegraph --cache "$PEOPLEGRAPH_CACHE" dismiss-external-merge --source "<source_id>" --primary "<primary_email>" --external "<external_email>" --reason not_same_person
```

## Native Telegram Poll Fallback

A native Telegram yes/no poll is possible, but use it only if the Telegram runtime cannot receive inline button callbacks.

Poll shape:

```json
{
  "question": "Merge Harper Reed: harper@2389.ai + harper@nata2.org?",
  "options": ["Merge", "Reject"],
  "is_anonymous": false,
  "allows_multiple_answers": false
}
```

If using polls:

- Store `poll_id -> review_id` in `PEOPLEGRAPH_REVIEW_STATE`.
- Act only on `poll_answer` updates from authorized reviewer IDs.
- Close the poll immediately after the first authorized vote.
- Ignore votes from unauthorized users.
- If conflicting authorized votes arrive before the poll closes, mark the item `needs_manual_review` and do not apply a merge.

Inline buttons are still preferred because a poll answer is just a vote; it does not naturally carry the exact command action the way button callback data does.

## Failure Handling

- If `peoplegraph` exits with `ok: false`, do not retry blindly. Send the error kind and message to Telegram.
- If the queue item is already approved or rejected, answer the callback and edit the message to say the review is already closed.
- If the reviewer is unauthorized, answer the callback with a short denial and do not reveal extra contact data.
- If `PEOPLEGRAPH_CACHE` is missing, ask the operator to set it before running merge commands.
- If the external source has not been imported, run `import-cache` first or ask for the source cache path.

## Reviewer Commands

Support these natural-language requests in Telegram:

- `show merge queue for kaya`
- `review next peoplegraph merge`
- `details m_001`
- `approve m_001`
- `reject m_001`
- `skip m_001`

For typed approvals, use the same command path as button approvals and still verify the Telegram user ID.

## Audit Trail

After each approval or rejection, keep the queue state with:

- reviewer Telegram user ID
- reviewed timestamp
- source ID
- primary email
- external email
- command run
- PeopleGraph JSON result

Do not store Telegram bot tokens, Google credentials, or private email bodies in the audit file.
