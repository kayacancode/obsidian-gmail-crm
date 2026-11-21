import { test } from "node:test";
import assert from "node:assert/strict";
import { upcomingMeetings, openNextSteps, latestWithSteps, renderBrief, type BriefPerson } from "../src/brief";

const NOW = new Date("2026-11-21T15:00:00Z");
const event = (over: Record<string, unknown>) => ({
  id: "e1",
  summary: "Hybraen <> Betaworks",
  status: "confirmed",
  start: { dateTime: "2026-11-23T14:00:00-05:00" },
  attendees: [
    { email: "kaya@betaworks.test", self: true, responseStatus: "accepted" },
    { email: "ada@acme.test", responseStatus: "accepted" },
    { email: "Bo@Acme.test", responseStatus: "needsAction" },
  ],
  ...over,
});

test("brief: upcoming meetings are the owner's, not declined, with someone else attending, soonest first", () => {
  const owner = new Set(["kaya@betaworks.test"]);
  const meetings = upcomingMeetings([
    event({ id: "later", start: { dateTime: "2026-11-25T10:00:00Z" } }),
    event({}),
    event({ id: "cancelled", status: "cancelled" }),
    event({ id: "declined", attendees: [{ email: "kaya@betaworks.test", self: true, responseStatus: "declined" }, { email: "ada@acme.test", responseStatus: "accepted" }] }),
    event({ id: "solo", attendees: [{ email: "kaya@betaworks.test", self: true, responseStatus: "accepted" }] }),
    event({ id: "no-start", start: {} }),
  ], owner);
  assert.deepEqual(meetings.map((m) => m.id), ["e1", "later"]);
  assert.deepEqual(meetings[0].attendees, ["ada@acme.test", "bo@acme.test"]);
  assert.equal(meetings[0].start, "2026-11-23T14:00:00-05:00");
});

test("brief: open next steps keep the bold title and its indented detail; the section ends at a same-or-higher heading", () => {
  const note = [
    "---", "granola_id: x", "---", "## Summary", "# Product", "- not a next step", "",
    "### Next Steps", "", "- **Share product deck**", "", "  Hybraen to send the PDF deck", "  plus an investor update.",
    "#### Kaya", "- [x] Already done", "- [ ] Book the follow-up", "* Intro to the design lead", "- A fourth step",
    "### Attachments", "- not a step either",
  ].join("\n");
  assert.deepEqual(openNextSteps(note), [
    { title: "Share product deck", detail: "Hybraen to send the PDF deck plus an investor update." },
    { title: "Book the follow-up", detail: "" },
    { title: "Intro to the design lead", detail: "" },
  ]);
  assert.deepEqual(openNextSteps("# Next steps\n- One\n## Under it\n- Two\n# Other\n- Three").map((s) => s.title), ["One", "Two"]);
  assert.deepEqual(openNextSteps("# Notes\n- nothing here"), []);
  // Only a heading that is exactly "Next Steps": "Fundraise and Next Steps" is not it.
  assert.deepEqual(openNextSteps("# Fundraise and Next Steps\n- Raised $2M\n# Next Steps\n- **Send the deck**").map((s) => s.title), ["Send the deck"]);
  assert.deepEqual(openNextSteps("### Technical Issues & Next Steps\n- Not a step"), []);
});

test("brief: when the latest linked meeting has no next steps, the next most recent one with steps is used", async () => {
  const notes: Record<string, string> = { "new.md": "# Notes\n- talk", "mid.md": "### Next Steps\n- **Send deck**", "old.md": "# Next Steps\n- **Old**" };
  const meetings = [{ date: "2026-11-01", path: "old.md", title: "Old" }, { date: "2026-11-19", path: "new.md", title: "New" }, { date: "2026-11-10", path: "mid.md", title: "Mid" }];
  const found = await latestWithSteps(meetings, async (path) => notes[path] ?? null);
  assert.deepEqual(found && { path: found.meeting.path, steps: found.steps.map((s) => s.title) }, { path: "mid.md", steps: ["Send deck"] });
  assert.deepEqual(await latestWithSteps([{ date: "2026-11-19", path: "new.md", title: "New" }], async (path) => notes[path] ?? null), { meeting: { date: "2026-11-19", path: "new.md", title: "New" }, steps: [] });
  assert.equal(await latestWithSteps([], async () => null), null);
});

test("brief: one section per meeting; each attendee with their page, last contact, nudge and last Granola next steps", () => {
  const people = new Map<string, BriefPerson>([
    ["ada@acme.test", { name: "Ada Lane", page: "People pages/p- Ada Lane", lastContact: "2026-11-01", nudge: "Follow up on the deck",
      lastGranola: { title: "Hybraen <> Betaworks", date: "2026-11-19", path: "Granola notes/2026-11-19, Hybraen __ Betaworks", steps: [{ title: "Share product deck", detail: "Hybraen to send the PDF deck." }] } }],
  ]);
  const markdown = renderBrief([{ id: "e1", title: "Hybraen <> Betaworks", start: "2026-11-23T14:00:00-05:00", attendees: ["ada@acme.test", "bo@acme.test"] }], people, NOW);
  assert.match(markdown, /^## 2026-11-23 14:00 \(UTC-05:00\) · Hybraen <> Betaworks$/m);
  assert.match(renderBrief([{ id: "z", title: "Standup", start: "2026-11-24T09:00:00Z", attendees: [] }, { id: "d", title: "Offsite", start: "2026-11-25", attendees: [] }], people, NOW), /^## 2026-11-24 09:00 \(UTC\) · Standup$[\s\S]*^## 2026-11-25 \(all day\) · Offsite$/m);
  assert.match(markdown, /^- \[\[People pages\/p- Ada Lane\|Ada Lane\]\] · last contact 2026-11-01 \(20 days ago\)$/m);
  assert.match(markdown, /^  - Nudge: Follow up on the deck$/m);
  assert.match(markdown, /^  - From your meeting \[\[Granola notes\/2026-11-19, Hybraen __ Betaworks\|Hybraen <> Betaworks\]\] on 2026-11-19:$/m);
  assert.match(markdown, /^    - \[ \] Share product deck: Hybraen to send the PDF deck\.$/m);
  assert.match(markdown, /^- bo@acme\.test · no people page$/m);
  assert.match(renderBrief([], people, NOW), /No meetings with other people in the next 7 days\./);
});
