import { test } from "node:test";
import assert from "node:assert/strict";
import { granolaNote, linkGranolaMeetings, withPeopleFrontmatter, pagesToCreate, isAutomatedAddress } from "../src/granola-links";
import { identityMap, type Interaction, type Person } from "../src/intelligence-model";
import type { Contact } from "../src/types";

const NOTE = [
  "---",
  "granola_id: not_1",
  "title: Hybraen <> Betaworks",
  "type: note",
  "attendees:",
  "  - Kaya",
  "  - Likhon",
  "web_url: https://notes.granola.ai/d/x",
  "attendee_emails: ",
  "  - likhon@hybraen.test",
  "calendar_start: 2026-11-19T13:30:00-05:00",
  "---",
  "",
  "# Hybraen <> Betaworks",
  "",
  "people: this line is body text and must never change",
  "",
].join("\n");
const block = (...names: string[]) => ["people:", ...names.map((n) => `  - "[[${n}]]"`)].join("\n");

test("people frontmatter: inserted right after attendees, sorted, everything else byte-identical", () => {
  const out = withPeopleFrontmatter(NOTE, ["p- Zed Lee", "p- Likhon Roy"]);
  assert.equal(out, NOTE.replace("  - Likhon\n", `  - Likhon\n${block("p- Likhon Roy", "p- Zed Lee")}\n`));
  assert.equal(out.split("\n---\n")[1], NOTE.split("\n---\n")[1], "the body is untouched");
});

test("people frontmatter: replaced in place, removed when empty, and a no-op when unchanged", () => {
  const once = withPeopleFrontmatter(NOTE, ["p- Likhon Roy"]);
  assert.equal(withPeopleFrontmatter(once, ["p- Likhon Roy"]), once, "same list: identical text, so no write");
  const changed = withPeopleFrontmatter(once, ["p- Ada Lane", "p- Likhon Roy"]);
  assert.equal(changed, NOTE.replace("  - Likhon\n", `  - Likhon\n${block("p- Ada Lane", "p- Likhon Roy")}\n`));
  assert.equal(withPeopleFrontmatter(changed, []), NOTE, "no people: the key goes and nothing else changes");
  assert.equal(withPeopleFrontmatter(NOTE, []), NOTE);
});

test("people frontmatter: Granola Sync's rewrite drops the key and the next run restores it exactly", () => {
  const linked = withPeopleFrontmatter(NOTE, ["p- Likhon Roy"]);
  const rewritten = NOTE; // Granola Sync writes the note afresh, without `people:`
  assert.equal(withPeopleFrontmatter(rewritten, ["p- Likhon Roy"]), linked);
});

test("people frontmatter: without attendees it goes at the end of the frontmatter; names with quotes are escaped", () => {
  const plain = "---\ngranola_id: x\ntype: note\n---\nBody\n";
  assert.equal(withPeopleFrontmatter(plain, ['p- Ann "Annie" Ma']), `---\ngranola_id: x\ntype: note\npeople:\n  - "[[p- Ann \\"Annie\\" Ma]]"\n---\nBody\n`);
  assert.equal(withPeopleFrontmatter("No frontmatter\n", ["p- A"]), "No frontmatter\n", "never adds frontmatter to a file without it");
});

test("people frontmatter: attendees without a page are listed by email after the page links", () => {
  const out = withPeopleFrontmatter(NOTE, ["p- Likhon Roy"], ["zed@x.test", "abe@x.test"]);
  assert.equal(out, NOTE.replace("  - Likhon\n", '  - Likhon\npeople:\n  - "[[p- Likhon Roy]]"\n  - "abe@x.test"\n  - "zed@x.test"\n'));
  assert.equal(withPeopleFrontmatter(out, ["p- Likhon Roy"], ["abe@x.test", "zed@x.test"]), out, "same entries in any order: no write");
  assert.equal(withPeopleFrontmatter(out, [], []), NOTE);
  assert.equal(withPeopleFrontmatter(NOTE, [], ["abe@x.test"]), NOTE.replace("  - Likhon\n", '  - Likhon\npeople:\n  - "abe@x.test"\n'), "emails alone still make the list");
});

const contact = (email: string, name: string, aliases: string[] = []): Contact => ({
  name, email, aliases, lastContact: "2026-11-01T10:00:00Z", firstContact: "2025-01-01T10:00:00Z",
  sentCount: 2, receivedCount: 3, totalExchanges: 5, subjects: ["Deck"], lastSubject: "Deck", domain: email.split("@")[1],
});
const meeting = (email: string, name?: string): Interaction => ({ id: "ev1", email, date: "2026-11-19T18:30:00.000Z", kind: "meeting", title: "Hybraen <> Betaworks", sourceId: "ev1", ...(name ? { name } : {}) });

test("attendees: rooms, group calendars and automated senders are not people; names come from the invite", () => {
  const note = granolaNote("Granola notes/h.md", { granola_id: "not_1", type: "note", title: "Hybraen <> Betaworks", calendar_start: "2026-11-19T13:30:00-05:00", calendar_event_title: "Hybraen <> Betaworks" })!;
  const events = [meeting("likhon@hybraen.test", "Likhon Roy"), meeting("betaworks.test_abc@group.calendar.google.com"), meeting("c_1@resource.calendar.google.com"), meeting("noreply@hybraen.test")];
  const links = linkGranolaMeetings([note], events, identityMap([]), new Set(["kaya@betaworks.test"]));
  assert.deepEqual(links.attendees.get(note.path), [{ email: "likhon@hybraen.test", name: "Likhon Roy" }]);
  for (const address of ["noreply@x.test", "no-reply@x.test", "notifications@x.test", "calendar-notification@google.com", "mailer-daemon@x.test", "do-not-reply@x.test"]) assert.ok(isAutomatedAddress(address), address);
  assert.ok(!isAutomatedAddress("nora@x.test"));
});

test("new pages: one per attendee nobody has a page for, deduplicated by email and alias, named from the invite", () => {
  const people: Person[] = [{ contact: contact("ada@acme.test", "Ada Lane", ["ada.alt@acme.test"]), notes: [], events: [] }, { contact: contact("bo@acme.test", "Bo Chen"), notes: [], events: [] }];
  const attendees = new Map([
    ["a.md", [{ email: "ada.alt@acme.test", name: "Ada" }, { email: "bo@acme.test", name: "Bo" }, { email: "likhon@hybraen.test", name: "Likhon Roy" }]],
    ["b.md", [{ email: "likhon@hybraen.test" }, { email: "x9@unknown.test" }]],
  ]);
  const plans = pagesToCreate(attendees, identityMap(people), new Set(["ada@acme.test"]), new Set(["People pages/p- Taken Name.md"]), "People pages");
  assert.deepEqual(plans.map((p) => [p.primary, p.path]), [
    ["bo@acme.test", "People pages/p- Bo Chen.md"],
    ["likhon@hybraen.test", "People pages/p- Likhon Roy.md"],
  ], "x9 has no known name, so no page");
  const bo = plans.find((p) => p.primary === "bo@acme.test")!.content;
  assert.match(bo, /^---\nemail: "bo@acme.test"\nlast_contact: 2026-11-01\n/, "a Gmail contact gets the same page as contact notes");
  const likhon = plans.find((p) => p.primary === "likhon@hybraen.test")!.content;
  assert.match(likhon, /^---\nemail: "likhon@hybraen.test"\n---\n\n# Likhon Roy\n/);
  const taken = pagesToCreate(new Map([["c.md", [{ email: "t@x.test", name: "Taken Name" }]]]), identityMap([]), new Set(), new Set(["People pages/p- Taken Name.md"]), "People pages");
  assert.deepEqual(taken, [], "never overwrites a page that already has that name");
});

test("new pages: only people with a real name get a page, never one named after an email", () => {
  const attendees = new Map([["a.md", [{ email: "likhon@hybraen.test", name: "Likhon Roy" }, { email: "x9@unknown.test" }]], ["b.md", [{ email: "bo@acme.test" }]]]);
  const people: Person[] = [{ contact: contact("bo@acme.test", "Bo Chen"), notes: [], events: [] }, { contact: contact("odd@acme.test", "odd@acme.test"), notes: [], events: [] }];
  const plans = pagesToCreate(new Map([...attendees, ["c.md", [{ email: "odd@acme.test" }]]]), identityMap(people), new Set(), new Set(), "People pages");
  assert.deepEqual(plans.map((p) => p.primary), ["bo@acme.test", "likhon@hybraen.test"], "a Gmail contact's name and an invite name count; a contact named by its email does not");
  assert.ok(plans.every((p) => !p.path.includes("@")));
});
