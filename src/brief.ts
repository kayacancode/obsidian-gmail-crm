/**
 * Pre-meeting brief: for each meeting in the next few days, who is in it (from the calendar
 * invite, never transcript speaker labels), when the owner last talked with them, their nudge,
 * and the open next steps from the owner's most recent Granola meeting with them.
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
  lastGranola?: { title: string; date: string; path: string; steps: NextStep[] } | null;
}

const DAY = 86_400_000;
export const BRIEF_DAYS = 7;
const MAX_STEPS = 3;

/** Meetings the owner hasn't declined that someone else attends, soonest first. */
export function upcomingMeetings(events: CalendarInvite[], ownerEmails: Set<string>): UpcomingMeeting[] {
  const meetings: UpcomingMeeting[] = [];
  for (const event of events) {
    const start = event.start?.dateTime ?? event.start?.date;
    if (!event.id || event.status === "cancelled" || !start) continue;
    const attendees = event.attendees ?? [];
    const self = attendees.find((a) => a.self || (a.email && ownerEmails.has(a.email.toLowerCase())));
    if (self?.responseStatus === "declined") continue;
    const others = [...new Set(attendees.flatMap((a) => {
      const email = a.email?.trim().toLowerCase();
      return email && !a.self && !ownerEmails.has(email) ? [email] : [];
    }))];
    if (!others.length) continue;
    meetings.push({ id: event.id, title: event.summary?.trim() || "Untitled meeting", start, attendees: others });
  }
  return meetings.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}

/**
 * Open items from a note's "Next Steps" section (any heading level, any case). The section ends
 * at the next heading of the same or higher level; deeper headings inside it (per-person groups)
 * are part of it. Items are top-level bullets: the bold title, plus the indented detail below it.
 */
export function openNextSteps(markdown: string): NextStep[] {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => /^#{1,6}\s+.*\bnext steps\b/i.test(line));
  if (start < 0) return [];
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
  return steps.filter((s) => !s.done && s.title).slice(0, MAX_STEPS).map(({ title, detail }) => ({ title, detail }));
}

/**
 * The most recent linked meeting that has open next steps (checking the newest five); if none
 * has any, the most recent meeting with no steps. `read` returns a note's markdown, or null.
 */
export async function latestWithSteps<M extends { date: string; path: string }>(
  meetings: M[],
  read: (path: string) => Promise<string | null>,
): Promise<{ meeting: M; steps: NextStep[] } | null> {
  const newest = [...meetings].sort((a, b) => b.date.localeCompare(a.date));
  for (const meeting of newest.slice(0, 5)) {
    const text = await read(meeting.path);
    const steps = text ? openNextSteps(text) : [];
    if (steps.length) return { meeting, steps };
  }
  return newest.length ? { meeting: newest[0], steps: [] } : null;
}

const when = (start: string) => (start.length > 10 ? `${start.slice(0, 10)} ${start.slice(11, 16)}` : `${start} (all day)`);
const link = (path: string, label: string) => `[[${path}|${label.replace(/[|\]]/g, " ")}]]`;

/** The brief note: one section per meeting, one entry per attendee. */
export function renderBrief(meetings: UpcomingMeeting[], people: Map<string, BriefPerson>, now: Date): string {
  const out = [
    "# Pre-meeting brief",
    "",
    `Updated ${now.toISOString().slice(0, 16).replace("T", " ")} UTC by People Data Sync. Rebuilt on every sync; edits here are overwritten.`,
    "",
  ];
  if (!meetings.length) out.push(`No meetings with other people in the next ${BRIEF_DAYS} days.`, "");
  for (const meeting of meetings) {
    out.push(`## ${when(meeting.start)} · ${meeting.title}`, "");
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
      const granola = person.lastGranola;
      if (granola) {
        out.push(`  - From your meeting ${link(granola.path, granola.title)} on ${granola.date}:`);
        if (granola.steps.length)
          for (const step of granola.steps) out.push(`    - [ ] ${step.title}${step.detail ? `: ${step.detail.slice(0, 200)}` : ""}`);
        else out.push("    - No open next steps.");
      }
    }
    out.push("");
  }
  return out.join("\n");
}
