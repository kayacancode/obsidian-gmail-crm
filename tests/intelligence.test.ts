import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mergeEvents,
  weeklyActivity,
  matchGoal,
  introductionPaths,
  attention,
  resolvePeople,
} from "../src/intelligence-model";
import type { Contact, ContactIndex } from "../src/types";
const now = Date.parse("2026-09-07T12:00:00Z");
const person = (email: string, extra = {}): Contact => ({
  name: email.split("@")[0],
  email,
  lastContact: "2026-09-01",
  firstContact: "2025-01-01",
  sentCount: 10,
  receivedCount: 10,
  totalExchanges: 20,
  subjects: [],
  lastSubject: "",
  domain: "example.com",
  ...extra,
});
const event = (id: string, date = "2026-09-01") => ({
  id,
  email: "a@example.com",
  date,
  kind: "email" as const,
  direction: "received" as const,
  title: "Hello",
  sourceId: id,
});
test("event retention is idempotent and ignores invalid dates", () => {
  assert.equal(
    mergeEvents([event("1")], [event("1"), event("2"), event("bad", "invalid")])
      .length,
    2,
  );
});
test("weekly history excludes future data and preserves event kinds", () => {
  const buckets = weeklyActivity(
    [
      event("1"),
      { ...event("2"), kind: "meeting" as const },
      event("future", "2027-01-01"),
    ],
    now,
    4,
  );
  assert.equal(
    buckets.reduce((n, b) => n + b.emails + b.meetings, 0),
    2,
  );
  assert.equal(
    buckets.reduce((n, b) => n + b.meetings, 0),
    1,
  );
});
test("goal relevance cites explicit notes and treats subjects as hints", () => {
  const p = {
    contact: person("a@example.com"),
    notes: [{ text: "Builds developer infrastructure", path: "People/A.md" }],
    events: [],
  };
  const match = matchGoal(p, {
    id: "g",
    title: "Partners",
    terms: ["developer infrastructure"],
  });
  assert.equal(match.evidence[0].source, "note");
  assert.equal(match.evidence[0].path, "People/A.md");
  const hint = matchGoal(
    {
      ...p,
      notes: [],
      contact: person("a@example.com", {
        subjects: ["developer infrastructure"],
      }),
    },
    { id: "g", title: "Partners", terms: ["developer infrastructure"] },
  );
  assert.equal(hint.evidence[0].source, "subject");
  assert.ok(hint.score < match.score);
  assert.equal(matchGoal(p, { id: "g", title: "AI", terms: ["AI"] }).score, 0);
});
test("resolve contacts by aliases and never invent identity from matching last names", () => {
  const index: ContactIndex = {
    schemaVersion: 1,
    lastSync: "",
    userEmail: "me@example.com",
    edges: [],
    contacts: {
      "a@example.com": person("a@example.com", {
        aliases: ["old@example.com"],
      }),
    },
  };
  const result = resolvePeople(
    index,
    [
      { email: "old@example.com", text: "Founder", path: "A.md" },
      { email: "unknown@example.com", text: "Wrong", path: "B.md" },
    ],
    [{ ...event("1"), email: "old@example.com" }],
  );
  assert.equal(result[0].notes.length, 1);
  assert.equal(result[0].events.length, 1);
});
test("introductions reject mentions and deduplicate reciprocal evidence", () => {
  const a = person("a@example.com");
  const b = person("b@example.com");
  const base = {
    sourceEmail: a.email,
    sourceName: a.name,
    targetEmail: b.email,
    targetName: b.name,
    context: "Introduced B",
    combinedScore: 50,
  };
  const people = [a, b].map((contact) => ({ contact, notes: [], events: [] }));
  assert.equal(
    introductionPaths(people, [{ ...base, type: "text_mention" }], b.email)
      .length,
    0,
  );
  assert.equal(
    introductionPaths(
      people,
      [
        { ...base, type: "introduced" },
        {
          ...base,
          type: "introduced_by",
          sourceEmail: b.email,
          targetEmail: a.email,
        },
      ],
      b.email,
    ).length,
    1,
  );
});
test("attention never describes acceleration from aggregate totals or incomplete coverage", () => {
  const p = {
    contact: person("a@example.com"),
    notes: [],
    events: [event("1")],
  };
  assert.equal(attention(p, now, undefined).kind, "history");
  assert.equal(attention(p, now, "2026-09-01").kind, "history");
});

import { IntelligenceStore } from "../src/intelligence-store";
import { GmailApi } from "../src/gmail-api";
import { DEFAULT_SETTINGS } from "../src/types";
import { syncCalendarData } from "../src/calendar-sync";
const memoryAdapter = () => {
  const files = new Map<string, string>();
  return {
    files,
    exists: async (p: string) => files.has(p),
    read: async (p: string) => files.get(p)!,
    write: async (p: string, v: string) => {
      files.set(p, v);
    },
    rename: async (a: string, b: string) => {
      files.set(b, files.get(a)!);
      files.delete(a);
    },
  };
};
test("store persists goals, feedback and events across reloads with serialized saves", async () => {
  const adapter = memoryAdapter();
  const store = new IntelligenceStore(adapter, "state");
  store.state.goals = [{ id: "g", title: "Hiring", terms: ["engineer"] }];
  store.state.feedback = { "a@example.com": "important" };
  await Promise.all([store.record([event("1")]), store.record([event("2")])]);
  const reload = new IntelligenceStore(adapter, "state");
  await reload.load();
  assert.equal(reload.state.events.length, 2);
  assert.equal(reload.state.goals[0].title, "Hiring");
  assert.equal(reload.state.feedback["a@example.com"], "important");
  assert.equal(adapter.files.has("state.tmp"), false);
});
test("corrupt local state is rejected without overwriting it", async () => {
  const adapter = memoryAdapter();
  adapter.files.set("state", "invalid JSON");
  await assert.rejects(new IntelligenceStore(adapter, "state").load());
  assert.equal(adapter.files.get("state"), "invalid JSON");
});
test("calendar snapshot replaces cancelled meetings but preserves email history", async () => {
  const store = new IntelligenceStore(memoryAdapter(), "state");
  await store.record([
    event("mail"),
    { ...event("meeting", new Date().toISOString()), kind: "meeting" },
  ]);
  await store.replaceCalendar([]);
  assert.deepEqual(
    store.state.events.map((e) => e.id),
    ["mail"],
  );
});
test("Gmail sync persists dated accepted metadata before returning its processed cache", async () => {
  const api = new GmailApi({ ...DEFAULT_SETTINGS }, async () => {});
  api.getUserEmail = async () => "me@example.com";
  api.fetchAllMessageIds = async () => [{ id: "1", threadId: "thread" }];
  api.fetchMessageMetadata = async () => ({
    id: "1",
    threadId: "thread",
    internalDate: String(now),
    payload: {
      headers: [
        { name: "From", value: "Alice <alice@example.com>" },
        { name: "To", value: "me@example.com" },
        { name: "Subject", value: "A conversation" },
      ],
    },
  });
  let recorded: any[] = [];
  const result = await api.buildContactIndex(
    10,
    undefined,
    undefined,
    undefined,
    undefined,
    async (events) => {
      recorded = events;
    },
  );
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].direction, "received");
  assert.equal(recorded[0].sourceId, "thread");
  assert.equal(recorded[0].date, new Date(now).toISOString());
  assert.equal(result.cache.processedIds.length, 1);
  const again = await api.buildContactIndex(
    10,
    undefined,
    result.index,
    result.cache,
    undefined,
    async (events) => {
      assert.equal(events.length, 0);
    },
  );
  assert.equal(again.index.contacts["alice@example.com"].totalExchanges, 1);
});
test("Gmail journal failure rejects sync rather than advancing the cache", async () => {
  const api = new GmailApi({ ...DEFAULT_SETTINGS }, async () => {});
  api.getUserEmail = async () => "me@example.com";
  api.fetchAllMessageIds = async () => [];
  await assert.rejects(
    api.buildContactIndex(
      10,
      undefined,
      undefined,
      undefined,
      undefined,
      async () => {
        throw new Error("Disk full");
      },
    ),
    /Disk full/,
  );
});
test("calendar records only mutually accepted meetings and keeps event identity", async () => {
  (globalThis as any).requestHandler = () => ({
    status: 200,
    json: {
      items: [
        {
          id: "accepted",
          summary: "Work session",
          start: { dateTime: new Date(now).toISOString() },
          attendees: [
            { email: "me@example.com", self: true, responseStatus: "accepted" },
            { email: "a@example.com", responseStatus: "accepted" },
            { email: "b@example.com", responseStatus: "declined" },
          ],
        },
      ],
    },
  });
  let events: any[] = [];
  await syncCalendarData(
    { ...DEFAULT_SETTINGS, accessToken: "test" },
    {
      "a@example.com": person("a@example.com"),
      "b@example.com": person("b@example.com"),
    },
    "me@example.com",
    async (incoming) => {
      events = incoming;
    },
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].id, "accepted");
  assert.equal(events[0].email, "a@example.com");
  delete (globalThis as any).requestHandler;
});
test("failed calendar request leaves existing history untouched", async () => {
  (globalThis as any).requestHandler = () => ({
    status: 403,
    text: "Forbidden",
  });
  let called = false;
  await syncCalendarData(
    { ...DEFAULT_SETTINGS, accessToken: "test" },
    {},
    "me@example.com",
    async () => {
      called = true;
    },
  );
  assert.equal(called, false);
  delete (globalThis as any).requestHandler;
});
test("declined calendar invitations cannot hide a dormant relationship", () => {
  const p = {
    contact: person("a@example.com", {
      lastContact: "2026-01-01",
      calendarLastMeeting: "2026-09-06",
    }),
    notes: [],
    events: [],
  };
  assert.equal(attention(p, now).kind, "quiet");
});
test("ambiguous aliases never attach evidence or overwrite exact primary identities", () => {
  const a = person("a@example.com", {
    aliases: ["b@example.com", "shared@example.com"],
  });
  const b = person("b@example.com", { aliases: ["shared@example.com"] });
  const index: ContactIndex = {
    schemaVersion: 1,
    lastSync: "",
    userEmail: "me@example.com",
    contacts: { a, b },
    edges: [],
  };
  const people = resolvePeople(
    index,
    [{ email: "shared@example.com", text: "Ambiguous", path: "wrong.md" }],
    [{ ...event("1"), email: "b@example.com" }],
  );
  assert.equal(
    people.reduce((n, p) => n + p.notes.length, 0),
    0,
  );
  assert.equal(people[1].events.length, 1);
  const edge = {
    sourceEmail: a.email,
    sourceName: a.name,
    targetEmail: b.email,
    targetName: b.name,
    type: "introduced" as const,
    context: "Introduction",
    combinedScore: 50,
  };
  const paths = introductionPaths([...people].reverse(), [edge], b.email);
  assert.equal(paths.length, 1);
  assert.equal(paths[0].target.contact.email, b.email);
});
test("calendar journal errors surface to the caller rather than reporting sync success", async () => {
  (globalThis as any).requestHandler = () => ({
    status: 200,
    json: { items: [] },
  });
  try {
    await assert.rejects(
      syncCalendarData(
        { ...DEFAULT_SETTINGS, accessToken: "test" },
        {},
        "me@example.com",
        async () => {
          throw new Error("Disk full");
        },
      ),
      /Disk full/,
    );
  } finally {
    delete (globalThis as any).requestHandler;
  }
});
test("one merged person never double-counts the same event through two aliases", () => {
  const index: ContactIndex = {
    schemaVersion: 1,
    lastSync: "",
    userEmail: "me@example.com",
    edges: [],
    contacts: {
      "a@example.com": person("a@example.com", {
        aliases: ["old@example.com"],
      }),
    },
  };
  const p = resolvePeople(
    index,
    [],
    [event("1"), { ...event("1"), email: "old@example.com" }],
  )[0];
  assert.equal(p.events.length, 1);
});

import GmailCrmPlugin from '../src/main';
import { TFile, TFolder } from 'obsidian';
test('incremental scoring carries photos and rewrites when only the photo changed',()=>{
 const plugin=Object.create(GmailCrmPlugin.prototype) as any;
 const c=person('a@example.com',{photoUrl:'https://example.com/photo.jpg',photoUpdatedAt:200});
 assert.equal(plugin.synthesizePage(c).gmailStats.photoUrl,c.photoUrl);
 const previous={label:'warm',quadrant:'nurture',staleness:50,combined:50,strength:50,momentum:50};
 const current={label:'warm',quadrant:'nurture',score:50,combinedScore:50,strengthScore:50,momentumScore:50};
 assert.equal(plugin.needsPageRewrite(previous,current,{stat:{mtime:0}},100,c.photoUpdatedAt),true);
 assert.equal(plugin.needsPageRewrite(previous,current,{stat:{mtime:0}},300,c.photoUpdatedAt),false);
});
test('automatic intelligence refresh reuses notes while manual refresh rereads them',async()=>{
 const file=Object.assign(new TFile(),{extension:'md',basename:'p- Person',path:'People/Person.md'});
 const folder=Object.assign(new TFolder(),{children:[file]});let reads=0;
 const plugin=Object.create(GmailCrmPlugin.prototype) as any;
 plugin.settings={...DEFAULT_SETTINGS,peopleFolder:'People'};plugin.intelligenceReady=true;plugin.intelligence={state:{version:1,events:[],goals:[],feedback:{}}};
 plugin.app={vault:{configDir:'.obsidian',getAbstractFileByPath:()=>folder,read:async()=>{reads++;return '---\nemail: a@example.com\n---\nFounder';},adapter:{exists:async()=>false}}};
 await plugin.loadIntelligenceWorkspace();assert.equal(reads,1);
 await plugin.loadIntelligenceWorkspace(false);assert.equal(reads,1);
 await plugin.loadIntelligenceWorkspace(true);assert.equal(reads,2);
});
