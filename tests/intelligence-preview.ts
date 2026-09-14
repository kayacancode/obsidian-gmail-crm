import { PeopleWorkspace } from "../src/intelligence-workspace";
import { emptyIntelligence, type Interaction } from "../src/intelligence-model";
import type { Contact, ContactEdge } from "../src/types";
const daysAgo = (days: number) =>
  new Date(Date.now() - days * 86400000).toISOString();
const definitions = [
  ["Maya Chen", "Platform engineer", "Northstar", "developer infrastructure"],
  ["Alex Rivera", "Founder", "Fieldwork", "developer tools"],
  ["Sam Okafor", "Design partner", "Northstar", "product design"],
  ["Jordan Lee", "CTO", "Orbit", "platform engineering"],
  ["Taylor Brooks", "Community lead", "Fieldwork", "community"],
  ["Casey Patel", "Engineer", "Orbit", "developer infrastructure"],
  ["Robin Park", "Designer", "Studio One", "product design"],
  ["Jamie Morgan", "Advisor", "Independent", "hiring"],
];
const contacts: Record<string, Contact> = {};
const events: Interaction[] = [];
for (const [i, [name, role, company]] of definitions.entries()) {
  const email = `person${i}@example.com`;
  contacts[email] = {
    name,
    email,
    role,
    company,
    firstContact: daysAgo(500),
    lastContact: daysAgo(i === 0 ? 95 : i + 1),
    sentCount: 12 + i * 3,
    receivedCount: 10 + i * 2,
    totalExchanges: 22 + i * 5,
    subjects: i === 7 ? ["developer infrastructure catch-up"] : [],
    lastSubject: "A conversation",
    domain: "example.com",
    calendarAccepted: i + 1,
  };
  if (i !== 0)
    for (let j = 0; j < 16; j++) {
      const age = i === 1 ? j % 8 : (j * 5 + i) % 82;
      events.push({
        id: `${i}-${j}`,
        email,
        date: daysAgo(age),
        kind: j % 4 === 0 ? "meeting" : "email",
        direction: j % 2 ? "received" : "sent",
        title:
          j % 4 === 0
            ? "Product working session"
            : "Following up on our conversation",
        sourceId: `demo-${i}-${j}`,
      });
    }
}
const edges: ContactEdge[] = [
  {
    sourceEmail: "person1@example.com",
    sourceName: "Alex Rivera",
    targetEmail: "person0@example.com",
    targetName: "Maya Chen",
    type: "introduced",
    context: "Alex introduced Maya in a project note dated July 12",
    combinedScore: 60,
  },
  {
    sourceEmail: "person2@example.com",
    sourceName: "Sam Okafor",
    targetEmail: "person0@example.com",
    targetName: "Maya Chen",
    type: "shared_meeting",
    context: "Both listed at the platform roundtable, June 20",
    combinedScore: 50,
  },
  {
    sourceEmail: "person0@example.com",
    sourceName: "Maya Chen",
    targetEmail: "person3@example.com",
    targetName: "Jordan Lee",
    type: "wiki_link",
    context: "Linked in Maya’s notes",
    combinedScore: 30,
  },
];
const state = JSON.parse(localStorage.getItem("pi-demo") || "null") ?? {
  ...emptyIntelligence(),
  trackingSince: daysAgo(90),
  events,
  goals: [
    {
      id: "partners",
      title: "Design partners",
      terms: ["developer infrastructure", "developer tools"],
    },
    {
      id: "hiring",
      title: "Founding engineer",
      terms: ["engineer", "platform engineering"],
    },
    { id: "design", title: "Product design", terms: ["product design"] },
  ],
};
const data = {
  index: {
    schemaVersion: 1,
    lastSync: daysAgo(0),
    userEmail: "demo@example.com",
    contacts,
    edges,
  },
  notes: definitions.map(([name, role, company, topic], i) => ({
    email: `person${i}@example.com`,
    path: `People/${name}.md`,
    text: `# ${name}\n${role} at ${company}.\nWorks on ${topic}.\nNotes last reviewed August 20.`,
  })),
  state,
};
if (new URLSearchParams(location.search).has("empty")) {
  data.index.contacts = {};
  data.index.edges = [];
  data.state.events = [];
}
if (new URLSearchParams(location.search).has("calendarOnly")) delete data.state.trackingSince;
const root = document.querySelector<HTMLElement>("#app")!;
let workspace: PeopleWorkspace;
workspace = new PeopleWorkspace(root, data, {
  save: async () => {
    localStorage.setItem("pi-demo", JSON.stringify(data.state));
  },
  refresh: async () => workspace.update(data),
  openNote: (path) => {
    document.querySelector("#source-status")!.textContent =
      `Opened demo source: ${path}`;
  },
});
