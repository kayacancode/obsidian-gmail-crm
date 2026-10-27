# README screenshots

These images show the actual People web UI with fictional people, notes, relationship evidence, and booking requests. They were captured on October 27, 2026. No production accounts, mailbox content, meeting notes, or credentials were used.

## Run the sample UI

From the repository root:

```bash
node apps/people-graph/scripts/readme-preview.mjs
```

Open `http://127.0.0.1:4318`. If that port is occupied:

```bash
PORT=4328 node apps/people-graph/scripts/readme-preview.mjs
```

The preview serves the checked-in `apps/people-graph/public/` files. API responses come from `scripts/readme-fixtures.mjs`; edits and simulated actions stay in process memory and reset when the server restarts. It binds only to the loopback address, needs no credentials or dependencies, and blocks external scripts and API requests with a local Content Security Policy.

This is a screenshot fixture, not a complete backend or an AI quality test. Suggestions and assessments are authored examples. It does not connect to Google, Granola, or Honcho, send email, or create Calendar events. Source links are fictional placeholders. Peripheral pages and actions outside this tour may be unavailable. Use the normal application tests to validate production behavior.

## Capture guide

Use a browser screenshot of each rendered state. Keep the UI unmodified; crop only to make the relevant controls readable. Check each image before replacing the file.

| Image | Route and steps |
| --- | --- |
| [`network-profile.jpg`](network-profile.jpg) | Open `/?person=maya`. Show Maya’s profile, “Introduced by Sam Rivera,” and labeled graph connections. A full-page capture includes the beginning of her saved private context. |
| [`people-lens.jpg`](people-lens.jpg) | Open `/`, select **Your lens**, then **Find people for me**. Scroll the drawer to its beginning and capture the saved fields plus Maya’s sample match. |
| [`shared-network.jpg`](shared-network.jpg) | Open `/?workspace=studio` and select **Avery Kim**. Capture the shared graph and Sam’s latest shared context in the detail panel. |
| [`booking-calendar.jpg`](booking-calendar.jpg) | Open `/book/alex` as the already signed-in fictional returning visitor. Select **Choose a time**. If the first month has few available days, go to the next month. Capture the host, month grid, daily times, and alternative-time action. |
| [`booking-requests.jpg`](booking-requests.jpg) | Open `/booking?request=request-maya` and expand Maya’s **Supporting context**. Capture the request tabs, meeting purpose, private reasoning, and approval controls. The checked-in image is cropped to this section. |

Dates are generated relative to server startup, so future captures stay useful. The checked-in images reflect the date above. Initials are the application's normal fallback for contacts without approved photos.

Use `.jpg` for JPEG captures, keep file sizes reasonable, and update the [root README](../../README.md) if a screenshot or UI label changes. Never replace these with live account screenshots containing someone else’s private context.
