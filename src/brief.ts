import { normalizeEventTitle } from "./granola-links";

/**
 * Pre-meeting brief: for each meeting in the next few days, the open next steps from the last
 * related Granola meeting, then who is in it (from the calendar invite, never transcript speaker
 * labels) with their people page, last contact and nudge.
 */
export interface CalendarInvite {
  id?: string;
  summary?: string;
  status?: string;
  start?: { dateTime?: string; date?: string };
  attendees?: { email?: string; self?: boolean; responseStatus?: string }[];
}
export interface UpcomingMeeting {
  id: string;
  title: string;
  /** As the calendar gave it: local wall time with offset, or a date for all-day events. */
  start: string;
  /** Other attendees' emails, lowercased, from the invite. */
  attendees: string[];
  /** Invited through a shared (group or resource) calendar, which is why nobody may be listed. */
  sharedInvite: boolean;
}
export interface NextStep {
  title: string;
  /** The indented paragraph under the bullet, joined into one line. */
  detail: string;
}
export interface BriefPerson {
  name: string;
  /** Vault path of their people page, without `.md`. */
  page?: string;
  lastContact?: string | null;
  nudge?: string | null;
}
/** A Granola note the brief may take next steps from. */
export interface GranolaCandidate {
  path: string;
  title: string;
  /** `calendar_start`, else `created`. */
  date: string;
  calendarTitle: string | null;
  /** People linked to the note (primary emails, owner excluded), from the Granola join. */
  attendees: string[];
}
export interface MeetingSteps {
  title: string;
  date: string;
  /** Vault path without `.md`. */
  path: string;
  steps: NextStep[];
}

const DAY = 86_400_000;
export const BRIEF_DAYS = 7;
const MAX_STEPS = 3;
/** Calendar rooms and group calendars appear as attendees but are not people. */
const NOT_A_PERSON = /@(group|resource)\.calendar\.google\.com$/;

/** Meetings the owner hasn't declined that someone else attends, soonest first. */
export function upcomingMeetings(events: CalendarInvite[], ownerEmails: Set<string>): UpcomingMeeting[] {
  const meetings: UpcomingMeeting[] = [];
  for (const event of events) {
    const start = event.start?.dateTime ?? event.start?.date;
    if (!event.id || event.status === "cancelled" || !start) continue;
    const attendees = event.attendees ?? [];
    const self = attendees.find((a) => a.self || (a.email && ownerEmails.has(a.email.toLowerCase())));
    if (self?.responseStatus === "declined") continue;
    const emails = attendees.flatMap((a) => {
      const email = a.email?.trim().toLowerCase();
      return email && !a.self && !ownerEmails.has(email) ? [email] : [];
    });
    const others = [...new Set(emails.filter((email) => !NOT_A_PERSON.test(email)))];
    // Keep a meeting whose only other invitee is a shared calendar: the people are behind it.
    const sharedInvite = !others.length && emails.some((email) => NOT_A_PERSON.test(email));
    if (!others.length && !sharedInvite) continue;
    meetings.push({ id: event.id, title: event.summary?.trim() || "Untitled meeting", start, attendees: others, sharedInvite });
  }
  return meetings.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}

/** True when a step's title ends with "(Name)" naming someone other than the owner. */
function forSomeoneElse(title: string, ownerName: string): boolean {
  const named = /\(([^()]+)\)\s*$/.exec(title)?.[1]?.trim().toLowerCase();
  if (!named) return false;
  const owner = ownerName.trim().toLowerCase();
  return !owner || (named !== owner && named !== owner.split(/\s+/)[0]);
}

/**
 * Open items from a note's "Next Steps" section, or null when it has none. The heading must be
 * exactly "Next Steps" (any level or case); the section ends at the next heading of the same or
 * higher level. Items are top-level bullets: the bold title plus the indented detail below it.
 * Checked items and items assigned to someone other than the owner ("… (Name)") are dropped.
 */
export function findNextSteps(markdown: string, ownerName: string): NextStep[] | null {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => /^#{1,6}\s+next steps\s*$/i.test(line));
  if (start < 0) return null;
  const level = (/^#+/.exec(lines[start])?.[0] ?? "#").length;
  const steps: (NextStep & { done: boolean })[] = [];
  for (const line of lines.slice(start + 1)) {
    const heading = /^(#{1,6})\s/.exec(line);
    if (heading && heading[1].length <= level) break;
    if (heading) continue;
    const item = /^[-*]\s+(?:\[( |x|X)\]\s+)?(.+)$/.exec(line) ?? /^\d+[.)]\s+()(.+)$/.exec(line);
    if (item) {
      steps.push({ title: item[2].replace(/\*\*|__/g, "").trim(), detail: "", done: item[1]?.toLowerCase() === "x" });
      continue;
    }
    const last = steps[steps.length - 1];
    if (last && /^\s+\S/.test(line)) last.detail = `${last.detail} ${line.trim()}`.trim();
  }
  return steps
    .filter((s) => !s.done && s.title && !forSomeoneElse(s.title, ownerName))
    .slice(0, MAX_STEPS)
    .map(({ title, detail }) => ({ title, detail }));
}

const CADENCE: Record<string, true> = { weekly: true, biweekly: true, monthly: true, daily: true, recurring: true };
/**
 * A meeting series' name: the normalized title with "&", "and" and "+" treated alike and cadence
 * words dropped, so "Kaya + JB weekly", "Kaya & JB" and "Kaya and JB" are one series. Whole
 * words only; empty when nothing but cadence words is left.
 */
export function seriesTitle(title: string): string {
  const words = normalizeEventTitle(title).split(" ").filter(Boolean);
  const kept: string[] = [];
  for (let i = 0; i < words.length; i++) {
    if (words[i] === "bi" && words[i + 1] === "weekly") { i++; continue; }
    if (words[i] !== "and" && !CADENCE[words[i]]) kept.push(words[i]);
  }
  return kept.join(" ");
}

/**
 * Next steps for an upcoming meeting: from the most recent earlier Granola note related to it
 * that has a Next Steps section. Related means, in this order: the same calendar title, exactly
 * the same attendees, or the same meeting series (`seriesTitle`). Nothing else counts; no related
 * note means no steps.
 */
export async function relatedNextSteps(
  meeting: { title: string; start: string; attendees: string[] },
  notes: GranolaCandidate[],
  read: (path: string) => Promise<string | null>,
  ownerName: string,
): Promise<{ note: GranolaCandidate; steps: NextStep[] } | null> {
  const at = Date.parse(meeting.start);
  const earlier = notes.filter((n) => Date.parse(n.date) < at).sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
  const title = normalizeEventTitle(meeting.title);
  const series = seriesTitle(meeting.title);
  const people = [...new Set(meeting.attendees)].sort().join(",");
  const groups = [
    earlier.filter((n) => n.calendarTitle && normalizeEventTitle(n.calendarTitle) === title),
    // Needs someone: notes nobody is linked to must not match a meeting with no listed attendees.
    people ? earlier.filter((n) => [...new Set(n.attendees)].sort().join(",") === people) : [],
    series ? earlier.filter((n) => n.calendarTitle && seriesTitle(n.calendarTitle) === series) : [],
  ];
  for (const group of groups)
    for (const note of group) {
      const text = await read(note.path);
      const steps = text === null ? null : findNextSteps(text, ownerName);
      if (steps) return { note, steps };
    }
  return null;
}

/** The invite's own wall time, labelled with its zone so it never reads as the reader's time. */
const when = (start: string) => {
  if (start.length <= 10) return `${start} (all day)`;
  const zone = /(Z|[+-]\d{2}:\d{2})$/.exec(start)?.[1];
  return `${start.slice(0, 10)} ${start.slice(11, 16)}${zone ? ` (UTC${zone === "Z" ? "" : zone})` : ""}`;
};
const link = (path: string, label: string) => `[[${path}|${label.replace(/[|\]]/g, " ")}]]`;

/** The brief note: per meeting, its open next steps (if a related note has some), then attendees. */
export function renderBrief(entries: { meeting: UpcomingMeeting; steps: MeetingSteps | null }[], people: Map<string, BriefPerson>, now: Date): string {
  const out = [
    "# Pre-meeting brief",
    "",
    `Updated ${now.toISOString().slice(0, 16).replace("T", " ")} UTC by People Data Sync. Rebuilt on every sync; edits here are overwritten.`,
    "",
  ];
  if (!entries.length) out.push(`No meetings with other people in the next ${BRIEF_DAYS} days.`, "");
  for (const { meeting, steps } of entries) {
    out.push(`## ${when(meeting.start)} · ${meeting.title}`, "");
    if (steps) {
      out.push(`Open next steps, from ${link(steps.path, steps.title)} on ${steps.date}:`, "");
      if (steps.steps.length) for (const step of steps.steps) out.push(`- [ ] ${step.title}${step.detail ? `: ${step.detail.slice(0, 200)}` : ""}`);
      else out.push("No open next steps.");
      out.push("");
      if (meeting.attendees.length || !meeting.sharedInvite) out.push("Attendees:", "");
    }
    if (!meeting.attendees.length && meeting.sharedInvite) out.push("Attendees: from a shared calendar invite");
    for (const email of meeting.attendees) {
      const person = people.get(email);
      if (!person?.page) {
        out.push(`- ${email} · no people page`);
        continue;
      }
      const last = person.lastContact
        ? ` · last contact ${person.lastContact.slice(0, 10)} (${Math.max(0, Math.floor((now.getTime() - Date.parse(person.lastContact)) / DAY))} days ago)`
        : "";
      out.push(`- ${link(person.page, person.name)}${last}`);
      if (person.nudge) out.push(`  - Nudge: ${person.nudge}`);
    }
    out.push("");
  }
  return out.join("\n");
}
