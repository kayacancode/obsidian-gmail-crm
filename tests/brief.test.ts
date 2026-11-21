import { test } from "node:test";
import assert from "node:assert/strict";
import { upcomingMeetings, findNextSteps, relatedNextSteps, renderBrief, type BriefPerson, type GranolaCandidate } from "../src/brief";

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

test("brief: calendar group and resource addresses are not attendees", () => {
  const owner = new Set(["kaya@betaworks.test"]);
  const rooms = [
    { email: "kaya@betaworks.test", self: true, responseStatus: "accepted" },
    { email: "betaworks.test_abc123@group.calendar.google.com", responseStatus: "accepted" },
    { email: "c_188xyz@resource.calendar.google.com", responseStatus: "accepted" },
  ];
  assert.deepEqual(upcomingMeetings([event({ attendees: [...rooms, { email: "jb@betaworks.test", responseStatus: "accepted" }] })], owner)[0].attendees, ["jb@betaworks.test"]);
  assert.deepEqual(upcomingMeetings([event({ id: "room-only", attendees: rooms })], owner), [], "a room is not someone else attending");
});

test("brief: next steps keep the bold title and detail; the section ends at a same-or-higher heading", () => {
  const note = [
    "---", "granola_id: x", "---", "## Summary", "# Product", "- not a next step", "",
    "### Next Steps", "", "- **Share product deck**", "", "  Hybraen to send the PDF deck", "  plus an investor update.",
    "#### Kaya", "- [x] Already done", "- [ ] Book the follow-up", "* Intro to the design lead", "- A fourth step",
    "### Attachments", "- not a step either",
  ].join("\n");
  assert.deepEqual(findNextSteps(note, "Kaya Jones"), [
    { title: "Share product deck", detail: "Hybraen to send the PDF deck plus an investor update." },
    { title: "Book the follow-up", detail: "" },
    { title: "Intro to the design lead", detail: "" },
  ]);
  assert.deepEqual(findNextSteps("# Next steps\n- One\n## Under it\n- Two\n# Other\n- Three", "")?.map((s) => s.title), ["One", "Two"]);
  assert.equal(findNextSteps("# Notes\n- nothing here", ""), null, "no section");
  assert.deepEqual(findNextSteps("# Next Steps\n", ""), [], "a section with nothing open");
  assert.deepEqual(findNextSteps("# Fundraise and Next Steps\n- Raised $2M\n# Next Steps\n- **Send the deck**", "")?.map((s) => s.title), ["Send the deck"]);
  assert.equal(findNextSteps("### Technical Issues & Next Steps\n- Not a step", ""), null);
});

test("brief: steps assigned to someone else are dropped; the owner's and unnamed steps stay", () => {
  const note = "# Next Steps\n- **Send the deck (Kaya)**\n- **Intro to design lead (Kaya Jones)**\n- **Share pricing (Ada)**\n- **Book follow-up**\n- **Draft memo (kaya)**";
  assert.deepEqual(findNextSteps(note, "Kaya Jones")?.map((s) => s.title), ["Send the deck (Kaya)", "Intro to design lead (Kaya Jones)", "Book follow-up"]);
  assert.deepEqual(findNextSteps("# Next Steps\n- **A (Ada)**\n- **B (Bo)**", "Kaya Jones"), [], "nothing left for the owner");
});

const candidate = (over: Partial<GranolaCandidate>): GranolaCandidate => ({ path: "n.md", title: "Note", date: "2026-11-10T10:00:00-05:00", calendarTitle: null, attendees: [], ...over });
const upcoming = { title: "Stasht intro <> Betaworks", start: "2026-11-23T10:00:00-05:00", attendees: ["jordan@stasht.test"] };
const read = (texts: Record<string, string>) => async (path: string) => texts[path] ?? null;

test("brief: steps come from the latest earlier note with the same calendar title, else the exact same attendees", async () => {
  const texts = {
    "title-old.md": "# Next Steps\n- **Old title step**",
    "title-new.md": "# Next Steps\n- **New title step**",
    "title-later.md": "# Next Steps\n- **After the meeting**",
    "title-nosection.md": "# Notes",
    "people.md": "# Next Steps\n- **Same people step**",
  };
  const notes = [
    candidate({ path: "title-old.md", date: "2026-11-01T10:00:00-05:00", calendarTitle: "Stasht intro / Betaworks" }),
    candidate({ path: "title-new.md", date: "2026-11-15T10:00:00-05:00", calendarTitle: "stasht intro <> betaworks" }),
    candidate({ path: "title-nosection.md", date: "2026-11-20T10:00:00-05:00", calendarTitle: "Stasht intro <> Betaworks" }),
    candidate({ path: "title-later.md", date: "2026-11-24T10:00:00-05:00", calendarTitle: "Stasht intro <> Betaworks" }),
    candidate({ path: "people.md", date: "2026-11-22T10:00:00-05:00", attendees: ["jordan@stasht.test"] }),
  ];
  const byTitle = await relatedNextSteps(upcoming, notes, read(texts), "Kaya Jones");
  assert.deepEqual(byTitle && [byTitle.note.path, byTitle.steps.map((s) => s.title)], ["title-new.md", ["New title step"]]);
  const byPeople = await relatedNextSteps(upcoming, notes.filter((n) => n.calendarTitle === null), read(texts), "Kaya Jones");
  assert.deepEqual(byPeople && byPeople.note.path, "people.md");
});

test("brief: no related note means no steps, never steps from another meeting", async () => {
  const texts = { "nick.md": "# Next Steps\n- **Nick Ralph follow-up**", "bigger.md": "# Next Steps\n- **Group step**" };
  const notes = [
    candidate({ path: "nick.md", calendarTitle: "Nick Ralph <> Betaworks", attendees: ["jordan@stasht.test", "nick@other.test"] }),
    candidate({ path: "bigger.md", attendees: ["jordan@stasht.test", "ada@acme.test"] }),
  ];
  assert.equal(await relatedNextSteps(upcoming, notes, read(texts), "Kaya Jones"), null);
});

test("brief: one open next steps block per meeting, then attendee lines without per-person steps", () => {
  const people = new Map<string, BriefPerson>([
    ["ada@acme.test", { name: "Ada Lane", page: "People pages/p- Ada Lane", lastContact: "2026-11-01", nudge: "Follow up on the deck" }],
  ]);
  const meeting = { id: "e1", title: "Hybraen <> Betaworks", start: "2026-11-23T14:00:00-05:00", attendees: ["ada@acme.test", "bo@acme.test"] };
  const steps = { title: "Hybraen <> Betaworks", date: "2026-11-19", path: "Granola notes/2026-11-19, Hybraen __ Betaworks", steps: [{ title: "Share product deck", detail: "Hybraen to send the PDF deck." }] };
  const markdown = renderBrief([{ meeting, steps }], people, NOW);
  assert.match(markdown, /^## 2026-11-23 14:00 \(UTC-05:00\) · Hybraen <> Betaworks$/m);
  assert.match(markdown, /^Open next steps, from \[\[Granola notes\/2026-11-19, Hybraen __ Betaworks\|Hybraen <> Betaworks\]\] on 2026-11-19:$/m);
  assert.match(markdown, /^- \[ \] Share product deck: Hybraen to send the PDF deck\.$/m);
  assert.match(markdown, /^- \[\[People pages\/p- Ada Lane\|Ada Lane\]\] · last contact 2026-11-01 \(20 days ago\)$/m);
  assert.match(markdown, /^  - Nudge: Follow up on the deck$/m);
  assert.match(markdown, /^- bo@acme\.test · no people page$/m);
  assert.ok(markdown.indexOf("Open next steps") < markdown.indexOf("Ada Lane"), "steps come before the attendees");
  const without = renderBrief([{ meeting, steps: null }], people, NOW);
  assert.ok(!without.includes("next steps") && !without.includes("Share product deck"), "no related note: no steps block");
  assert.match(renderBrief([{ meeting, steps: { ...steps, steps: [] } }], people, NOW), /^No open next steps\.$/m);
  assert.match(renderBrief([{ meeting: { id: "z", title: "Standup", start: "2026-11-24T09:00:00Z", attendees: [] }, steps: null }, { meeting: { id: "d", title: "Offsite", start: "2026-11-25", attendees: [] }, steps: null }], people, NOW), /^## 2026-11-24 09:00 \(UTC\) · Standup$[\s\S]*^## 2026-11-25 \(all day\) · Offsite$/m);
  assert.match(renderBrief([], people, NOW), /No meetings with other people in the next 7 days\./);
});
