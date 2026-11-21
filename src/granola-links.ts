import { normalizeEmail, type Interaction, type Person } from "./intelligence-model";
import type { Contact } from "./types";

/**
 * Links Granola meeting notes to people pages. Granola Sync writes the facts into each note's
 * frontmatter; this plugin does all the linking. The only thing it writes into a Granola note is
 * the `people:` frontmatter key (see `withPeopleFrontmatter`).
 *
 * Who attended comes from this plugin's Calendar events (same start and title), because Granola's
 * own attendee list usually names only the owner. Without a calendar match, the note's
 * `attendee_emails` are used. Display names (`attendees`) are never matched.
 */
export interface GranolaNote {
  path: string;
  granolaId: string;
  title: string;
  created: string | null;
  calendarStart: string | null;
  calendarTitle: string | null;
  attendeeEmails: string[];
}
export interface GranolaMeeting {
  date: string;
  line: string;
  /** The note's vault path (with `.md`) and title, for the pre-meeting brief. */
  path: string;
  title: string;
}
export interface Attendee {
  email: string;
  /** Display name from the calendar invite, when it gave one. */
  name?: string;
}
export interface GranolaLinks {
  /** Meetings per person, keyed by the person's primary email. */
  meetings: Map<string, GranolaMeeting[]>;
  /** Every attendee of each note (by path), known or not: the owner, rooms and automated senders left out. */
  attendees: Map<string, Attendee[]>;
  /** Interaction events, for email-fallback notes only (a joined note is the calendar meeting). */
  events: Interaction[];
  stats: { notes: number; calendar: number; email: number; unlinked: number };
}

/** Calendar rooms and group calendars appear as attendees but are not people. */
export const NOT_A_PERSON = /@(group|resource)\.calendar\.google\.com$/;
/** Mailboxes that send on a system's behalf rather than a person's. */
export const isAutomatedAddress = (email: string) =>
  /^(no-?reply|do-?not-?reply|notifications?|calendar-notification|mailer-daemon|bounces?)([+._-][^@]*)?@/i.test(email);

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);

/** Lowercase, every run of non-letters/digits becomes one space, trimmed. */
export const normalizeEventTitle = (value: string) =>
  value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

const normalizeName = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");
/**
 * The owner's addresses: the account and push emails with their aliases, plus every contact whose
 * name is the vault owner's name (other addresses of theirs that mail and meetings brought in).
 */
export function ownerEmails(contacts: Record<string, Contact>, emails: string[], ownerName: string): Set<string> {
  const owner = new Set<string>();
  for (const raw of emails) {
    if (!raw?.trim()) continue;
    const email = normalizeEmail(raw);
    owner.add(email);
    for (const alias of contacts[email]?.aliases ?? []) owner.add(normalizeEmail(alias));
  }
  const name = ownerName ? normalizeName(ownerName) : "";
  if (name)
    for (const contact of Object.values(contacts))
      if (normalizeName(contact.name) === name) {
        owner.add(normalizeEmail(contact.email));
        for (const alias of contact.aliases ?? []) owner.add(normalizeEmail(alias));
      }
  return owner;
}

/** A Granola note from its frontmatter, or null for transcripts and other files. */
export function granolaNote(path: string, frontmatter: Record<string, unknown> | undefined): GranolaNote | null {
  const granolaId = text(frontmatter?.granola_id);
  const type = text(frontmatter?.type);
  if (!frontmatter || !granolaId || (type !== "note" && type !== "combined")) return null;
  const emails = Array.isArray(frontmatter.attendee_emails) ? frontmatter.attendee_emails : [];
  const basename = path.split("/").pop()?.replace(/\.md$/, "") ?? path;
  return {
    path,
    granolaId,
    title: text(frontmatter.title) ?? basename,
    created: text(frontmatter.created),
    calendarStart: text(frontmatter.calendar_start),
    calendarTitle: text(frontmatter.calendar_event_title),
    attendeeEmails: [...new Set(emails.flatMap((e) => (typeof e === "string" && e.includes("@") ? [normalizeEmail(e)] : [])))],
  };
}

/** Joins each note to its attendees and groups the meetings by person. */
export function linkGranolaMeetings(
  notes: GranolaNote[],
  calendarEvents: Interaction[],
  identity: Map<string, Person>,
  ownerEmails: Set<string>,
): GranolaLinks {
  const byStart = new Map<number, Interaction[]>();
  for (const event of calendarEvents) {
    if (event.kind !== "meeting" || event.source === "granola") continue;
    const at = Date.parse(event.date);
    if (Number.isFinite(at)) byStart.set(at, [...(byStart.get(at) ?? []), event]);
  }
  const owner = new Set([...ownerEmails].map(normalizeEmail));
  const result: GranolaLinks = { meetings: new Map(), attendees: new Map(), events: [], stats: { notes: notes.length, calendar: 0, email: 0, unlinked: 0 } };
  for (const note of notes) {
    const start = note.calendarStart ? Date.parse(note.calendarStart) : NaN;
    const title = note.calendarTitle ? normalizeEventTitle(note.calendarTitle) : "";
    const joined = Number.isFinite(start) && title
      ? (byStart.get(start) ?? []).filter((e) => normalizeEventTitle(e.title) === title)
      : [];
    const method = joined.length ? "calendar" : "email";
    const candidates: Attendee[] = joined.length
      ? joined.map((e) => ({ email: normalizeEmail(e.email), ...(e.name?.trim() ? { name: e.name.trim() } : {}) }))
      : note.attendeeEmails.map((email) => ({ email }));
    // Attendees are people: not the owner, a room or group calendar, or an automated sender.
    const attendees = new Map<string, Attendee>();
    for (const a of candidates)
      if (!owner.has(a.email) && !NOT_A_PERSON.test(a.email) && !isAutomatedAddress(a.email) && !attendees.get(a.email)?.name)
        attendees.set(a.email, a);
    if (attendees.size) result.attendees.set(note.path, [...attendees.values()]);
    // Each attendee email resolves to one person; unknown addresses are not linked here.
    const people = new Set<string>();
    for (const { email } of attendees.values()) {
      const person = identity.get(email);
      const primary = person ? normalizeEmail(person.contact.email) : null;
      if (primary && !owner.has(primary)) people.add(primary);
    }
    if (!people.size) {
      result.stats.unlinked++;
      continue;
    }
    result.stats[method]++;
    const date = (note.calendarStart ?? note.created ?? "").slice(0, 10);
    const target = note.path.replace(/\.md$/, "");
    const line = `- ${date} · [[${target}|${note.title.replace(/[|\]]/g, " ")}]]`;
    for (const primary of people) {
      result.meetings.set(primary, [...(result.meetings.get(primary) ?? []), { date, line, path: note.path, title: note.title }]);
      const at = note.calendarStart ?? note.created;
      if (method === "email" && at)
        result.events.push({
          id: `granola:${note.granolaId}`,
          email: primary,
          date: at,
          kind: "meeting",
          title: note.title,
          sourceId: note.granolaId,
          source: "granola",
        });
    }
  }
  return result;
}

const SECTION = /\n## Granola meetings\n[\s\S]*?(?=\n## (?!Granola meetings)|\n---\n|$)/;

/**
 * The page with its plugin-managed `## Granola meetings` section rebuilt (newest first), added at
 * the end if missing, or removed when the person has no meetings. Nothing else changes.
 */
export function granolaSection(content: string, lines: string[]): string {
  const sorted = [...new Set(lines)].sort((a, b) => b.localeCompare(a));
  const section = sorted.length ? `\n## Granola meetings\n\n${sorted.join("\n")}\n` : "";
  if (SECTION.test(content)) return content.replace(SECTION, section);
  if (!section) return content;
  return (content.endsWith("\n") ? content : content + "\n") + section;
}

const yamlQuoted = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/**
 * The note with its `people:` frontmatter list set to wikilinks to these pages (sorted, placed
 * right after the `attendees` block, or at the end of the frontmatter), or removed when empty.
 * Text edit only: every other byte of the file is unchanged, and the same list returns the same
 * text, so callers can skip the write. Files without frontmatter are left alone.
 */
export function withPeopleFrontmatter(content: string, pageNames: string[]): string {
  if (!content.startsWith("---\n")) return content;
  const end = content.indexOf("\n---", 3);
  if (end < 0) return content;
  const lines = end > 3 ? content.slice(4, end).split("\n") : [];
  const kept: string[] = [];
  // Drop the current block: the key line plus its indented (or "- ") list lines.
  for (let i = 0; i < lines.length; i++) {
    if (/^people:/.test(lines[i])) {
      while (i + 1 < lines.length && /^(\s+|-\s)/.test(lines[i + 1])) i++;
      continue;
    }
    kept.push(lines[i]);
  }
  const names = [...new Set(pageNames)].sort();
  if (names.length) {
    const block = ["people:", ...names.map((name) => `  - ${yamlQuoted(`[[${name}]]`)}`)];
    let at = kept.findIndex((line) => /^attendees:/.test(line));
    if (at >= 0) while (at + 1 < kept.length && /^(\s+|-\s)/.test(kept[at + 1])) at++;
    kept.splice(at >= 0 ? at + 1 : kept.length, 0, ...block);
  }
  const next = `---\n${kept.join("\n")}${content.slice(end)}`;
  return kept.length || end > 3 ? next : content;
}

/** A new people page for a Gmail contact: the same page the plugin's contact notes create. */
export function contactNoteContent(contact: Contact): string {
  const frontmatter = [
    "---",
    `email: "${contact.email}"`,
    `last_contact: ${contact.lastContact.split("T")[0]}`,
    `first_contact: ${contact.firstContact.split("T")[0]}`,
    `total_exchanges: ${contact.totalExchanges}`,
    `sent: ${contact.sentCount}`,
    `received: ${contact.receivedCount}`,
    "---",
  ].join("\n");
  const body = [
    `# ${contact.name}`,
    "",
    "## Overview",
    `- **Email:** ${contact.email}`,
    `- **Last contact:** ${contact.lastContact.split("T")[0]}`,
    `- **Total exchanges:** ${contact.totalExchanges} (${contact.sentCount} sent, ${contact.receivedCount} received)`,
    "",
    "## Recent Subjects",
    ...contact.subjects.map((s) => `- ${s}`),
    "",
    "## Notes",
    "",
  ].join("\n");
  return `${frontmatter}\n\n${body}`;
}

export interface PagePlan {
  /** The person's primary email (a Gmail contact's, else the attendee's). */
  primary: string;
  path: string;
  content: string;
}

/**
 * People pages to create for meeting attendees nobody has a page for. A person is matched by
 * email and alias first (`identity`), so an alias never gets a second page; a page whose file
 * name is already taken is never overwritten. Named from the Gmail contact, else the invite's
 * display name, else the email. With `waitForNames` (no calendar display names stored yet),
 * people with no name at all are left for a later run rather than given an email-named page,
 * because pages are never renamed.
 */
export function pagesToCreate(
  attendeesByNote: Map<string, Attendee[]>,
  identity: Map<string, Person>,
  primariesWithPages: Set<string>,
  existingPaths: Set<string>,
  folder: string,
  options: { waitForNames?: boolean } = {},
): PagePlan[] {
  const people = new Map<string, { email: string; name?: string; contact?: Contact }>();
  for (const attendees of attendeesByNote.values())
    for (const a of attendees) {
      const contact = identity.get(a.email)?.contact;
      const primary = contact ? normalizeEmail(contact.email) : a.email;
      if (primariesWithPages.has(primary)) continue;
      const known = people.get(primary);
      people.set(primary, { email: primary, ...(contact ? { contact } : {}), name: known?.name ?? a.name });
    }
  const taken = new Set([...existingPaths].map((p) => p.toLowerCase()));
  const dir = folder.replace(/\/+$/, "");
  const plans: PagePlan[] = [];
  for (const [primary, person] of [...people].sort(([a], [b]) => a.localeCompare(b))) {
    const contactName = person.contact?.name?.trim();
    const known = contactName && !contactName.includes("@") ? contactName : person.name?.trim();
    if (!known && options.waitForNames) continue;
    const name = known || primary;
    const path = `${dir ? `${dir}/` : ""}p- ${name.replace(/[\\/:*?"<>|]/g, "_")}.md`;
    if (taken.has(path.toLowerCase())) continue;
    taken.add(path.toLowerCase());
    const content = person.contact
      ? contactNoteContent({ ...person.contact, name })
      : `---\nemail: "${primary}"\n---\n\n# ${name}\n\n## Overview\n- **Email:** ${primary}\n\n## Notes\n`;
    plans.push({ primary, path, content });
  }
  return plans.sort((a, b) => a.path.localeCompare(b.path));
}
