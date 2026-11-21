import { test } from "node:test";
import assert from "node:assert/strict";
import {
  granolaNote,
  linkGranolaMeetings,
  normalizeEventTitle,
  ownerEmails,
  granolaSection,
} from "../src/granola-links";
import { identityMap, type Interaction, type Person } from "../src/intelligence-model";
import { IntelligenceStore } from "../src/intelligence-store";
import type { Contact } from "../src/types";

const contact = (email: string, aliases: string[] = []): Contact => ({
  name: email.split("@")[0],
  email,
  aliases,
  lastContact: "2026-11-01",
  firstContact: "2025-01-01",
  sentCount: 1,
  receivedCount: 1,
  totalExchanges: 2,
  subjects: [],
  lastSubject: "",
  domain: email.split("@")[1],
});
const people: Person[] = ["ada@acme.test", "bo@acme.test", "cy@other.test"].map((email) => ({
  contact: contact(email, email === "ada@acme.test" ? ["ada.alt@acme.test"] : []),
  notes: [],
  events: [],
}));
const calendar = (id: string, email: string, date: string, title: string): Interaction => ({
  id,
  email,
  date,
  kind: "meeting",
  title,
  sourceId: id,
});
const events = [
  calendar("ev1", "ada@acme.test", "2026-11-19T18:30:00.000Z", "Hybraen <> Betaworks"),
  calendar("ev1", "bo@acme.test", "2026-11-19T18:30:00.000Z", "Hybraen <> Betaworks"),
  calendar("ev2", "cy@other.test", "2026-11-19T18:30:00.000Z", "Different meeting"),
];
const note = (fm: Record<string, unknown>, path = "Granola notes/2026-11-19, Hybraen __ Betaworks.md") =>
  granolaNote(path, { granola_id: "not_1", type: "note", title: "Hybraen <> Betaworks", created: "2026-11-19T18:40:00Z", ...fm });
const owner = new Set(["kaya@betaworks.test", "kaya.personal@gmail.test"]);
const link = (notes: ReturnType<typeof note>[]) =>
  linkGranolaMeetings(notes.flatMap((n) => (n ? [n] : [])), events, identityMap(people), owner);

test("granola: only note/combined files with a granola_id are Granola notes", () => {
  assert.equal(granolaNote("a.md", { granola_id: "x", type: "transcript" }), null);
  assert.equal(granolaNote("a.md", { type: "note" }), null);
  assert.equal(granolaNote("a.md", { granola_id: "x", type: "combined", title: "T" })?.granolaId, "x");
  assert.equal(normalizeEventTitle("  Hybraen <> Betaworks!! "), "hybraen betaworks");
});

test("granola: the calendar join uses start time and normalized title, and links every attendee", () => {
  const result = link([note({ calendar_start: "2026-11-19T13:30:00-05:00", calendar_event_title: "Hybraen / Betaworks", attendee_emails: ["kaya@betaworks.test"] })]);
  assert.deepEqual(result.meetings.get("ada@acme.test")?.map((m) => m.line), [
    "- 2026-11-19 · [[Granola notes/2026-11-19, Hybraen __ Betaworks|Hybraen <> Betaworks]]",
  ]);
  assert.ok(result.meetings.has("bo@acme.test"));
  assert.ok(!result.meetings.has("cy@other.test"), "same start, different title: not this meeting");
  // A joined note is the calendar meeting: no new interaction events.
  assert.deepEqual(result.events, []);
  assert.deepEqual(result.stats, { notes: 1, calendar: 1, email: 0, unlinked: 0 });
});

test("granola: without a calendar match, attendee emails link people and record one event each", () => {
  const result = link([note({ calendar_start: "2026-11-19T09:00:00-05:00", calendar_event_title: "Hybraen <> Betaworks", attendee_emails: ["kaya.personal@gmail.test", "ada.alt@acme.test", "stranger@nowhere.test"] })]);
  assert.deepEqual([...result.meetings.keys()], ["ada@acme.test"], "owner dropped, alias mapped, unknown ignored");
  assert.deepEqual(result.events, [
    { id: "granola:not_1", email: "ada@acme.test", date: "2026-11-19T09:00:00-05:00", kind: "meeting", title: "Hybraen <> Betaworks", sourceId: "not_1", source: "granola" },
  ]);
  const created = link([note({ attendee_emails: ["bo@acme.test"] })]).events[0];
  assert.equal(created.date, "2026-11-19T18:40:00Z", "no calendar_start: the note's created time");
});

test("granola: attendee display names alone link nobody", () => {
  const result = link([note({ attendees: ["Ada", "Bo"] })]);
  assert.equal(result.meetings.size, 0);
  assert.deepEqual(result.stats, { notes: 1, calendar: 0, email: 0, unlinked: 1 });
});

test("granola: the people-page section is rebuilt in place, newest first, and removed when empty", () => {
  const page = "---\nemail: ada@acme.test\n---\n\n## Relationship Status\n\nscores\n\n## Meeting History\n\n- hand written\n";
  const lines = ["- 2026-11-19 · [[b|B]]", "- 2026-11-20 · [[a|A]]"];
  const once = granolaSection(page, lines);
  assert.ok(once.includes("## Granola meetings\n\n- 2026-11-20 · [[a|A]]\n- 2026-11-19 · [[b|B]]\n"));
  assert.ok(once.includes("## Meeting History\n\n- hand written"));
  assert.equal(granolaSection(once, lines), once, "running twice changes nothing");
  const withOld = page.replace("## Meeting History", "## Granola meetings\n\n- old\n\n## Meeting History");
  const replaced = granolaSection(withOld, lines);
  assert.ok(!replaced.includes("- old") && replaced.split("## Granola meetings").length === 2, replaced);
  assert.ok(replaced.includes("- 2026-11-19 · [[b|B]]\n\n## Meeting History"), "the section stays where it was");
  assert.equal(granolaSection(once, []), page, "no meetings: the section goes");
  assert.equal(granolaSection(page, []), page);
});

test("granola: the owner is every own address, including other addresses under the owner's name", () => {
  const contacts = {
    "kaya@betaworks.test": contact("kaya@betaworks.test", ["k@betaworks.test"]),
    "kaya.personal@gmail.test": { ...contact("kaya.personal@gmail.test"), name: "Kaya Jones" },
    "kaya.alt@forever.test": { ...contact("kaya.alt@forever.test"), name: " kaya  jones " },
    "ada@acme.test": { ...contact("ada@acme.test"), name: "Ada Jones" },
  };
  assert.deepEqual(
    [...ownerEmails(contacts, ["kaya@betaworks.test", "", "Push@Betaworks.test"], "Kaya Jones")].sort(),
    ["k@betaworks.test", "kaya.alt@forever.test", "kaya.personal@gmail.test", "kaya@betaworks.test", "push@betaworks.test"],
  );
  assert.deepEqual([...ownerEmails(contacts, ["kaya@betaworks.test"], "")].sort(), ["k@betaworks.test", "kaya@betaworks.test"]);
});

test("granola: calendar sync keeps Granola events, and Granola linking replaces only its own", async () => {
  let saved = "";
  const store = new IntelligenceStore({ exists: async () => false, read: async () => saved, write: async (_p, d) => { saved = d; } }, "x.json");
  const granola: Interaction = { id: "granola:not_1", email: "ada@acme.test", date: new Date().toISOString(), kind: "meeting", title: "G", sourceId: "not_1", source: "granola" };
  await store.record([granola]);
  await store.replaceCalendar([calendar("ev9", "bo@acme.test", new Date().toISOString(), "C")]);
  assert.deepEqual(store.state.events.map((e) => e.id).sort(), ["ev9", "granola:not_1"]);
  await store.replaceGranola([]);
  assert.deepEqual(store.state.events.map((e) => e.id), ["ev9"]);
});
