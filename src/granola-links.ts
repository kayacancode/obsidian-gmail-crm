import { normalizeEmail, type Interaction, type Person } from "./intelligence-model";
import type { Contact } from "./types";

/**
 * Links Granola meeting notes to people pages. Granola Sync writes the facts into each note's
 * frontmatter; this plugin does all the linking and never writes into Granola notes.
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
export interface GranolaLinks {
  /** Meetings per person, keyed by the person's primary email. */
  meetings: Map<string, GranolaMeeting[]>;
  /** Interaction events, for email-fallback notes only (a joined note is the calendar meeting). */
  events: Interaction[];
  stats: { notes: number; calendar: number; email: number; unlinked: number };
}

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
  const result: GranolaLinks = { meetings: new Map(), events: [], stats: { notes: notes.length, calendar: 0, email: 0, unlinked: 0 } };
  for (const note of notes) {
    const start = note.calendarStart ? Date.parse(note.calendarStart) : NaN;
    const title = note.calendarTitle ? normalizeEventTitle(note.calendarTitle) : "";
    const joined = Number.isFinite(start) && title
      ? (byStart.get(start) ?? []).filter((e) => normalizeEventTitle(e.title) === title)
      : [];
    const method = joined.length ? "calendar" : "email";
    const candidates = joined.length ? joined.map((e) => normalizeEmail(e.email)) : note.attendeeEmails;
    // Each attendee email resolves to one person; the owner and unknown addresses are dropped.
    const people = new Set<string>();
    for (const email of candidates) {
      if (owner.has(email)) continue;
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
