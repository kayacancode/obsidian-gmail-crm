import type { Contact, ContactEdge, ContactIndex } from "./types";

export interface Interaction {
  id: string;
  email: string;
  date: string;
  kind: "email" | "meeting";
  direction?: "sent" | "received";
  title: string;
  sourceId: string;
}
export interface Goal {
  id: string;
  title: string;
  terms: string[];
}
export interface SourcedNote {
  email: string;
  text: string;
  path: string;
}
export interface Person {
  contact: Contact;
  notes: { text: string; path: string }[];
  events: Interaction[];
}
export interface Evidence {
  source: "note" | "profile" | "subject";
  text: string;
  path?: string;
}
export interface GoalMatch {
  score: number;
  evidence: Evidence[];
}
export interface IntelligenceState {
  version: 1;
  events: Interaction[];
  trackingSince?: string;
  goals: Goal[];
  feedback: Record<string, "important" | "later">;
}
export const emptyIntelligence = (): IntelligenceState => ({
  version: 1,
  events: [],
  goals: [],
  feedback: {},
});
const DAY = 86400000;
export const normalizeEmail = (s: string) => s.trim().toLowerCase();
export function mergeEvents(
  existing: Interaction[],
  incoming: Interaction[],
): Interaction[] {
  const map = new Map<string, Interaction>();
  for (const event of [...existing, ...incoming]) {
    if (!event.id || !event.email || !Number.isFinite(Date.parse(event.date)))
      continue;
    const email = normalizeEmail(event.email);
    map.set(`${event.kind}:${event.id}:${email}`, { ...event, email });
  }
  return [...map.values()].sort(
    (a, b) => Date.parse(a.date) - Date.parse(b.date),
  );
}
export function identityMap(people: Person[]): Map<string, Person> {
  const map = new Map<string, Person>();
  const aliases = new Map<string, Set<Person>>();
  for (const p of people) map.set(normalizeEmail(p.contact.email), p);
  for (const p of people)
    for (const raw of p.contact.aliases ?? []) {
      const alias = normalizeEmail(raw);
      const owners = aliases.get(alias) ?? new Set<Person>();
      owners.add(p);
      aliases.set(alias, owners);
    }
  for (const [alias, owners] of aliases)
    if (!map.has(alias) && owners.size === 1) map.set(alias, [...owners][0]);
  return map;
}
export function resolvePeople(
  index: ContactIndex,
  notes: SourcedNote[],
  events: Interaction[],
): Person[] {
  const people: Person[] = [];
  let byEmail = new Map<string, Person>();
  // Exact primary addresses win over ambiguous aliases. Never guess by name.
  for (const [key, contact] of Object.entries(index.contacts)) {
    const person = {
      contact: { ...contact, email: contact.email || key },
      notes: [],
      events: [],
    } as Person;
    people.push(person);
    byEmail.set(normalizeEmail(key), person);
    byEmail.set(normalizeEmail(person.contact.email), person);
  }
  const primaries = byEmail;
  byEmail = identityMap(people);
  for (const [email, p] of primaries) byEmail.set(email, p);
  for (const note of notes) {
    const p = byEmail.get(normalizeEmail(note.email));
    if (p && !p.notes.some((n) => n.path === note.path))
      p.notes.push({ text: note.text, path: note.path });
  }
  for (const event of mergeEvents([], events))
    byEmail.get(event.email)?.events.push(event);
  for (const p of people) {
    const unique = new Map<string, Interaction>();
    for (const e of p.events) unique.set(`${e.kind}:${e.id}`, e);
    p.events = [...unique.values()];
  }
  return people;
}
export interface Week {
  start: string;
  emails: number;
  meetings: number;
  events: Interaction[];
}
export function weeklyActivity(
  events: Interaction[],
  now = Date.now(),
  weeks = 12,
): Week[] {
  const today = new Date(now);
  today.setUTCHours(0, 0, 0, 0);
  const monday = today.getTime() - ((today.getUTCDay() + 6) % 7) * DAY;
  const start = monday - (weeks - 1) * 7 * DAY;
  const buckets: Week[] = Array.from({ length: weeks }, (_, i) => ({
    start: new Date(start + i * 7 * DAY).toISOString().slice(0, 10),
    emails: 0,
    meetings: 0,
    events: [],
  }));
  for (const event of events) {
    const date = Date.parse(event.date);
    const slot = Math.floor((date - start) / (7 * DAY));
    if (date > now || slot < 0 || slot >= weeks || !Number.isFinite(date))
      continue;
    buckets[slot].events.push(event);
    if (event.kind === "email") buckets[slot].emails++;
    else buckets[slot].meetings++;
  }
  return buckets;
}
function containsTerm(text: string, term: string): boolean {
  const escaped = term
    .trim()
    .toLowerCase()
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    !!escaped &&
    new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, "iu").test(
      text,
    )
  );
}
export function matchGoal(person: Person, goal: Goal): GoalMatch {
  const terms = [...new Set(goal.terms.map((t) => t.trim()).filter(Boolean))];
  if (!terms.length) return { score: 0, evidence: [] };
  const evidence: Evidence[] = [];
  const profile = [
    person.contact.role,
    person.contact.company,
    person.contact.orgTitle,
    person.contact.orgName,
  ]
    .filter(Boolean)
    .join(" · ");
  if (terms.some((t) => containsTerm(profile, t)))
    evidence.push({ source: "profile", text: profile });
  for (const note of person.notes) {
    // Exact excerpts remain attributed statements, not AI-established facts.
    const lines = note.text
      .split("\n")
      .filter((line) => terms.some((t) => containsTerm(line, t)));
    for (const text of lines.slice(0, 3))
      evidence.push({
        source: "note",
        text: text.trim().slice(0, 500),
        path: note.path,
      });
  }
  for (const subject of person.contact.subjects ?? [])
    if (terms.some((t) => containsTerm(subject, t)))
      evidence.push({ source: "subject", text: subject });
  const score = evidence.some((e) => e.source !== "subject")
    ? Math.min(
        100,
        60 + evidence.filter((e) => e.source !== "subject").length * 10,
      )
    : evidence.length
      ? 20
      : 0;
  return { score, evidence: evidence.slice(0, 8) };
}
export function lastInteraction(
  person: Person,
  now = Date.now(),
): number | null {
  const dates = [
    person.contact.lastContact,
    ...person.events.map((e) => e.date),
  ]
    .filter((s): s is string => !!s)
    .map(Date.parse)
    .filter((n) => Number.isFinite(n) && n <= now);
  return dates.length ? Math.max(...dates) : null;
}
export function attention(
  person: Person,
  now = Date.now(),
  trackingSince?: string,
): { kind: string; label: string; reason: string; priority: number } {
  const last = lastInteraction(person, now);
  const days = last === null ? null : Math.floor((now - last) / DAY);
  const strong =
    (person.contact.sentCount >= 2 && person.contact.receivedCount >= 2) ||
    (person.contact.calendarAccepted ?? 0) >= 2;
  if (days !== null && days >= 60 && strong)
    return {
      kind: "quiet",
      label: "Worth reconnecting",
      reason: `${days} days since recorded contact; ${person.contact.sentCount} sent, ${person.contact.receivedCount} received, ${person.contact.calendarAccepted ?? 0} mutually accepted meetings.`,
      priority: 80,
    };
  const since = trackingSince ? Date.parse(trackingSince) : NaN;
  if (!Number.isFinite(since) || now - since < 56 * DAY)
    return {
      kind: "history",
      label: "Building history",
      reason:
        days === null
          ? "No dated contact recorded."
          : `Last recorded contact ${days} days ago. More tracked history is needed to compare activity.`,
      priority: strong ? 40 : 20,
    };
  const count = (min: number, max: number) =>
    person.events.filter((e) => {
      const age = now - Date.parse(e.date);
      return age >= min * DAY && age < max * DAY;
    }).length;
  const recent = count(0, 28),
    previous = count(28, 56);
  if (recent >= 3 && recent >= previous * 2)
    return {
      kind: "growing",
      label: "Activity increasing",
      reason: `${recent} recorded events in 28 days, compared with ${previous} in the previous 28.`,
      priority: 70,
    };
  if (previous >= 3 && recent <= previous / 2)
    return {
      kind: "slowing",
      label: "Activity slowing",
      reason: `${recent} recorded events in 28 days, compared with ${previous} in the previous 28.`,
      priority: 60,
    };
  return {
    kind: "steady",
    label: "Steady",
    reason: `${recent} recorded events in 28 days; ${previous} in the previous 28.`,
    priority: 30,
  };
}
export function edgeLabel(edge: ContactEdge): string {
  return {
    introduced: "Documented introduction",
    introduced_by: "Documented introduction",
    shared_meeting: "Shared meeting",
    wiki_link: "Linked in notes",
    text_mention: "Mentioned in notes",
  }[edge.type];
}
export interface IntroPath {
  connector: Person;
  target: Person;
  edge: ContactEdge;
  reason: string;
}
export function introductionPaths(
  people: Person[],
  edges: ContactEdge[],
  targetEmail: string,
): IntroPath[] {
  const lookup = identityMap(people);
  const target = lookup.get(normalizeEmail(targetEmail));
  if (!target) return [];
  const paths = new Map<string, IntroPath>();
  for (const edge of edges) {
    if (!["introduced", "introduced_by", "shared_meeting"].includes(edge.type))
      continue;
    const source = lookup.get(normalizeEmail(edge.sourceEmail)),
      dest = lookup.get(normalizeEmail(edge.targetEmail));
    const connector: Person | undefined =
      source === target ? dest : dest === target ? source : undefined;
    if (
      !connector ||
      connector === target ||
      connector.contact.sentCount < 2 ||
      connector.contact.receivedCount < 2
    )
      continue;
    const old = paths.get(connector.contact.email);
    if (old && old.edge.type !== "shared_meeting") continue;
    paths.set(connector.contact.email, {
      connector,
      target,
      edge,
      reason: `You have exchanged messages in both directions with ${connector.contact.name}. ${edge.context}. Confirm they can make an introduction.`,
    });
  }
  return [...paths.values()].sort(
    (a, b) =>
      (a.edge.type === "shared_meeting" ? 1 : 0) -
        (b.edge.type === "shared_meeting" ? 1 : 0) ||
      b.connector.contact.totalExchanges - a.connector.contact.totalExchanges,
  );
}
