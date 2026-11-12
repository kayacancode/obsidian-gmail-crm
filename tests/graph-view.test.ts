import { test } from "node:test";
import assert from "node:assert/strict";
import { graphViewUrl } from "../src/graph-view";
import GmailCrmPlugin from "../src/main";
import { RelationshipEngine } from "../src/relationships";
import { TFile, TFolder } from "obsidian";

test("graph view falls back to the hosted app without a configured URL", () => {
  assert.equal(graphViewUrl(""), "https://people-graph.kayarjones901.workers.dev/");
});

test("graph view uses a configured deployment and preserves its path", () => {
  assert.equal(graphViewUrl(" https://people.example.com/network "), "https://people.example.com/network");
});

test("graph view rejects malformed and non-web URLs", () => {
  assert.equal(graphViewUrl("javascript:alert(1)"), null);
  assert.equal(graphViewUrl("not a URL"), null);
});

test("view command opens the hosted graph without a push token", () => {
	const plugin = Object.create(GmailCrmPlugin.prototype) as any;
	plugin.settings = { graphPushUrl: "", graphPushToken: "" };
	const previousWindow = (globalThis as any).window;
	let opened = "";
	(globalThis as any).window = { open: (url: string) => { opened = url; } };
	try {
		plugin.viewPeopleGraph();
	} finally {
		(globalThis as any).window = previousWindow;
	}
	assert.equal(opened, "https://people-graph.kayarjones901.workers.dev/");
});

test("contact sync maps relationships without AI after writing new pages and before scoring", async () => {
	const plugin = Object.create(GmailCrmPlugin.prototype) as any;
	const steps: string[] = [];
	plugin.settings = {
		refreshToken: "refresh",
		accessToken: "",
		createContactNotes: true,
		autoUpdateStaleness: true,
		enrichOnSync: false,
	};
	plugin.gmailApi = {
		buildContactIndex: async () => ({
			index: { schemaVersion: 1, userEmail: "me@example.com", lastSync: "", contacts: {}, edges: [] },
			cache: { processedIds: [], lastSync: "" },
		}),
	};
	plugin.saveContactIndex = async () => {};
	plugin.saveMessageCache = async () => {};
	plugin.saveSettings = async () => {};
	plugin.writeContactNotes = async () => { steps.push("pages"); };
	plugin.enrichAllPeople = async (skipAi: boolean) => { steps.push(skipAi ? "map" : "ai"); };
	plugin.updateStaleness = async () => { steps.push("score"); };
	plugin.refreshBaseView = async () => {};
	plugin.refreshQuadrantView = async () => {};
	await plugin.syncContacts();
	assert.deepEqual(steps, ["pages", "map", "score"]);
});

test("map-only pass saves relationship edges for People Intelligence", async () => {
	const originalLoad = RelationshipEngine.prototype.loadPeoplePages;
	const originalBuild = RelationshipEngine.prototype.buildGraph;
	const file = new TFile();
	const plugin = Object.create(GmailCrmPlugin.prototype) as any;
	const index = { contacts: { "a@example.com": { email: "a@example.com", connections: 0 } }, edges: [] as unknown[] };
	let saved = false;
	plugin.settings = { peopleFolder: "People" };
	plugin.contactIndex = index;
	plugin.app = { vault: {
		getAbstractFileByPath: () => file,
		read: async () => "# Ada\n",
		modify: async () => {},
	} };
	plugin.buildContactEdges = () => [{ sourceEmail: "a@example.com", targetEmail: "b@example.com" }];
	plugin.saveContactIndex = async () => { saved = true; };
	RelationshipEngine.prototype.loadPeoplePages = async () => ({ Ada: { path: "People/Ada.md", email: "a@example.com", emails: ["a@example.com"] } as any });
	RelationshipEngine.prototype.buildGraph = () => ({ Ada: [{ target: "Bea", type: "wiki_link", context: "Known" }] });
	try {
		await plugin.enrichAllPeople(true);
	} finally {
		RelationshipEngine.prototype.loadPeoplePages = originalLoad;
		RelationshipEngine.prototype.buildGraph = originalBuild;
	}
	assert.equal(index.edges.length, 1);
	assert.equal(index.contacts["a@example.com"].connections, 1);
	assert.equal(saved, true);
});

test("a previous generated relationship section does not become evidence on the next mapping pass", async () => {
	const ada = Object.assign(new TFile(), { basename: "p- Ada Lovelace", extension: "md", path: "People/p- Ada Lovelace.md" });
	const bea = Object.assign(new TFile(), { basename: "p- Bea Smith", extension: "md", path: "People/p- Bea Smith.md" });
	const folder = Object.assign(new TFolder(), { children: [ada, bea] });
	const vault = {
		getAbstractFileByPath: () => folder,
		read: async (file: TFile) => file === ada
			? "# Ada Lovelace\n\n## Relationships\n- [[p- Bea Smith]] — old generated link\n"
			: "# Bea Smith\n",
	};
	const engine = new RelationshipEngine(vault as any, "People");
	const pages = await engine.loadPeoplePages();
	const graph = engine.buildGraph(pages, null);
	assert.deepEqual(graph["Ada Lovelace"], []);
});

test("an unchanged mapping pass leaves people page modification times alone", async () => {
	const originalLoad = RelationshipEngine.prototype.loadPeoplePages;
	const originalBuild = RelationshipEngine.prototype.buildGraph;
	const file = new TFile();
	let writes = 0;
	const plugin = Object.create(GmailCrmPlugin.prototype) as any;
	plugin.settings = { peopleFolder: "People" };
	plugin.contactIndex = null;
	plugin.app = { vault: {
		getAbstractFileByPath: () => file,
		read: async () => "# Ada\n\n## Relationships\n- No mapped relationships yet.\n",
		modify: async () => { writes++; },
	} };
	RelationshipEngine.prototype.loadPeoplePages = async () => ({ Ada: { path: "People/Ada.md" } as any });
	RelationshipEngine.prototype.buildGraph = () => ({ Ada: [] });
	try {
		await plugin.enrichAllPeople(true);
	} finally {
		RelationshipEngine.prototype.loadPeoplePages = originalLoad;
		RelationshipEngine.prototype.buildGraph = originalBuild;
	}
	assert.equal(writes, 0);
});
