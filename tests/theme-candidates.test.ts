import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLocalThemeCandidates } from "../src/theme-candidates";
import { buildGraphPayload, type GraphContactInput, type GraphThemeInput } from "../src/graph-push";
import type { Interaction } from "../src/intelligence-model";
import type { ContactEdge, PersonPage } from "../src/types";
import GmailCrmPlugin from "../src/main";
import { RelationshipEngine } from "../src/relationships";
import { TFile } from "obsidian";
import { normalizePushedGraph } from "../apps/people-graph/src/relevance-routes";

const NOW = Date.parse("2026-09-14T12:00:00Z");

test("final wave producer limits preserve graph and pass the Worker validator", async () => {
	for (const distinct of [true, false]) {
		const people = Array.from({length: 450}, (_, i) => ({...contacts[0], email:`person-${i}@example.com`}));
		const inputs: GraphThemeInput[] = people.flatMap((p, i) => Array.from({length:12}, (_, j) => ({
			personEmail:p.email, canonicalName:distinct ? `Topic ${i}-${j}` : `Topic ${j}`, aliases:[],
			sourceType:'obsidian_note', visibility:'private', observedAt:'2026-09-12T00:00:00Z', confidence:.9,
			summary:'Local topic', evidenceRef:'obsidian:note', contentHash:`hash-${i}-${j}`,
		})));
		const edges:ContactEdge[]=people.slice(1).map((p,i)=>({sourceEmail:people[i].email,targetEmail:p.email,sourceName:'Person',targetName:'Person',type:'wiki_link',context:'Documented relationship',combinedScore:1}));
		const payload = await buildGraphPayload(people, edges, 'salt', inputs);
		assert.equal(payload.nodes.length,450);
		assert.equal(payload.edges.length,449);
		assert.ok(payload.themes.length<=200);
		assert.ok(payload.themeSignals.length<=5000);
		assert.ok(normalizePushedGraph(payload));
		assert.ok(payload.themes.every(t=>payload.themeSignals.some(s=>s.themeId===t.id)));
	}
});

function page(email: string, content: string, path: string, extra: Partial<PersonPage> = {}): PersonPage {
	return {
		name: "Ada Lovelace",
		path,
		content,
		wikiLinks: [],
		email,
		emails: [email],
		role: null,
		introducer: null,
		meetings: [],
		howKnown: null,
		keyContext: null,
		gmailStats: null,
		...extra,
	};
}

function meeting(email: string, title: string, date: string): Interaction {
	return {
		id: `meeting-${title}`,
		email,
		date,
		kind: "meeting",
		title,
		sourceId: "calendar-event",
	};
}

const contacts: GraphContactInput[] = [{
	email: "ada@example.com",
	name: "Ada Lovelace",
	company: null,
	lastContact: null,
	staleness: {
		score: 30,
		combinedScore: 40,
		strengthScore: 50,
		momentumScore: 20,
		quadrant: "nurture",
		label: "warm",
		relationshipDepth: 50,
		relationshipRecency: 50,
	},
}];

const edges: ContactEdge[] = [];

test("extracts permitted note sections and recent meeting titles with source provenance", async () => {
	const signals = await buildLocalThemeCandidates([
		page("ada@example.com", [
			"---",
			"updated: 2026-09-13",
			"---",
			"## Key Themes",
			"- [Agent memory](https://example.com/agent-memory)",
			"- Developer tools",
			"## Biography",
			"PRIVATE NOTE BODY must stay local",
		].join("\n"), "People/Ada.md"),
	], [meeting("ada@example.com", "Agent interfaces workshop", "2026-09-12")], NOW);

	assert.ok(signals.some((item) => item.canonicalName === "Agent memory" && item.sourceType === "obsidian_note"));
	assert.ok(signals.some((item) => item.canonicalName === "Agent interfaces workshop" && item.sourceType === "calendar"));
	assert.ok(signals.every((item) => !item.summary.includes("PRIVATE NOTE BODY")));
	assert.ok(signals.every((item) => item.evidenceRef.startsWith("obsidian:")));
});

test("uses valid note source times and only explicit local frontmatter opts into firm visibility", async () => {
	const [firm] = await buildLocalThemeCandidates([
		Object.assign(page("ada@example.com", [
			"---",
			"updated: 2026-09-12",
			"date: 2026-09-11",
			"created: 2026-09-10",
			"relationship_visibility: firm",
			"source: granola",
			"themes:",
			"  - Agent memory",
			"---",
		].join("\n"), "People/Ada.md"), { modifiedAt: "2026-09-13T00:00:00Z" }),
	], [], NOW);
	assert.equal(firm.observedAt, "2026-09-12T00:00:00.000Z");
	assert.equal(firm.visibility, "firm");
	assert.equal(firm.sourceType, "granola");

	const fallbackSignals = await buildLocalThemeCandidates([
		Object.assign(page("date@example.com", "---\nupdated: invalid\ndate: 2026-09-11\ncreated: 2026-09-10\nthemes: Date fallback\n---", "People/Date.md"), { modifiedAt: "2026-09-09T15:30:00Z" }),
		Object.assign(page("created@example.com", "---\nupdated: invalid\ndate: invalid\ncreated: 2026-09-10\nthemes: Created fallback\n---", "People/Created.md"), { modifiedAt: "2026-09-09T15:30:00Z" }),
		Object.assign(page("mtime@example.com", "---\nthemes: Mtime fallback\n---", "People/Mtime.md"), { modifiedAt: "2026-09-09T15:30:00Z" }),
	], [], NOW);
	assert.deepEqual(
		fallbackSignals.map((item) => [item.canonicalName, item.observedAt]),
		[
			["Date fallback", "2026-09-11T00:00:00.000Z"],
			["Created fallback", "2026-09-10T00:00:00.000Z"],
			["Mtime fallback", "2026-09-09T15:30:00.000Z"],
		],
	);
	assert.ok(fallbackSignals.every((item) => item.visibility === "private"));

	const missingTime = await buildLocalThemeCandidates([
		page("bea@example.com", "## Key Themes\n- Must not be emitted", "People/Bea.md"),
	], [], NOW);
	assert.deepEqual(missingTime, []);
});

test("hashes the bounded local source fragment with a stable full SHA-256 digest", async () => {
	const source = page("ada@example.com", "---\nupdated: 2026-09-12\nthemes: Agent memory\n---", "People/Ada.md");
	const [first] = await buildLocalThemeCandidates([source], [], NOW);
	const [second] = await buildLocalThemeCandidates([source], [], NOW);
	assert.equal(first.contentHash, "3b91cacdbde36ff48cc6234a6411a2ce71c8fb74126df5312e345e2d362d34ad");
	assert.equal(second.contentHash, first.contentHash);
	assert.match(first.contentHash, /^[a-f0-9]{64}$/);
});

test("legacy three-argument graph payload calls preserve graph output and add empty theme arrays", async () => {
	const secondContact = { ...contacts[0], email: "bea@example.com", name: "Bea Byte" };
	const legacyEdges: ContactEdge[] = [{
		sourceEmail: contacts[0].email,
		sourceName: contacts[0].name,
		targetEmail: secondContact.email,
		targetName: secondContact.name,
		type: "wiki_link",
		context: "Met through work",
		combinedScore: 10,
	}];
	const payload = await buildGraphPayload([...contacts, secondContact], legacyEdges, "vault-local-salt");
	assert.equal(payload.nodes.length, 2);
	assert.deepEqual(payload.edges.map((edge) => ({ weight: edge.weight, types: edge.types, contexts: edge.contexts })), [{
		weight: 1,
		types: ["wiki_link"],
		contexts: ["Met through work"],
	}]);
	assert.deepEqual(payload.themes, []);
	assert.deepEqual(payload.themeSignals, []);
});

test("pushPeopleGraph resolves the vault TFile modification time for note candidates", async () => {
	const originalLoadPeoplePages = RelationshipEngine.prototype.loadPeoplePages;
	const source = page("ada@example.com", "## Key Themes\n- From filesystem time", "People/Ada.md");
	const file = Object.assign(new TFile(), { stat: { mtime: Date.parse("2026-09-08T12:34:56Z") } });
	const plugin = Object.create(GmailCrmPlugin.prototype) as any;
	let body = "";
	plugin.settings = { graphPushUrl: "https://graph.example", graphPushToken: "token", graphPushSalt: "vault-local-salt", peopleFolder: "People" };
	plugin.app = { vault: { getAbstractFileByPath: (path: string) => path === source.path ? file : null } };
	plugin.contactIndex = null;
	plugin.loadIntelligenceWorkspace = async () => ({ state: { events: [] } });
	RelationshipEngine.prototype.loadPeoplePages = async () => ({ Ada: source });
	(globalThis as any).requestHandler = (options: { body: string }) => {
		body = options.body;
		return { status: 200, text: "" };
	};
	try {
		await plugin.pushPeopleGraph();
	} finally {
		RelationshipEngine.prototype.loadPeoplePages = originalLoadPeoplePages;
		delete (globalThis as any).requestHandler;
	}
	const payload = JSON.parse(body);
	assert.equal(payload.themeSignals[0].observedAt, "2026-09-08T12:34:56.000Z");
});

test("reduces per-person theme candidates before pruning graph nodes for an oversized payload", async () => {
	const largeContacts: GraphContactInput[] = Array.from({ length: 400 }, (_, index) => ({
		...contacts[0],
		email: `person-${index}@example.com`,
		name: `Person ${index}`,
	}));
	const largeEdges: ContactEdge[] = largeContacts.slice(1).map((contact, index) => ({
		sourceEmail: largeContacts[index].email,
		sourceName: largeContacts[index].name,
		targetEmail: contact.email,
		targetName: contact.name,
		type: "wiki_link",
		context: "Documented relationship",
		combinedScore: 1,
	}));
	const largeThemes: GraphThemeInput[] = largeContacts.flatMap((contact, person) =>
		Array.from({ length: 12 }, (_, theme) => ({
			personEmail: contact.email,
			canonicalName: `Long theme ${person}-${theme} ${"x".repeat(48)}`,
			aliases: [],
			sourceType: "obsidian_note" as const,
			visibility: "private" as const,
			observedAt: "2026-09-12T00:00:00.000Z",
			confidence: 0.95,
			summary: "S".repeat(240),
			evidenceRef: `obsidian:${"a".repeat(24)}`,
			contentHash: "b".repeat(64),
		})),
	);
	const payload = await buildGraphPayload(largeContacts, largeEdges, "vault-local-salt", largeThemes);
	assert.equal(payload.nodes.length, largeContacts.length);
	assert.ok(payload.themeSignals.length < largeThemes.length);
});

test("graph payload maps local candidates to opaque node ids without raw emails or note bodies", async () => {
	const candidates = await buildLocalThemeCandidates([
		page("ada@example.com", [
			"---",
			"updated: 2026-09-13",
			"themes: Agent memory",
			"---",
			"PRIVATE NOTE BODY",
		].join("\n"), "People/Ada.md"),
	], [], NOW);
	const payload = await buildGraphPayload(contacts, edges, "vault-local-salt", candidates);
	const serialized = JSON.stringify(payload);
	assert.equal(payload.relevanceVersion, 1);
	assert.equal(payload.themes.length, 1);
	assert.equal(payload.themeSignals.length, 1);
	assert.ok(payload.themeSignals.every((item) => item.personId === payload.nodes[0].id));
	assert.ok(!serialized.includes("@"));
	assert.ok(!serialized.includes("PRIVATE NOTE BODY"));
});
