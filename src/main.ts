import {
	Plugin,
	Notice,
	TFile,
	TFolder,
	normalizePath,
} from "obsidian";
import { GmailApi } from "./gmail-api";
// Sidebar removed — using Obsidian Base view instead
import { GmailCrmSettingTab } from "./settings-tab";
import { startOAuthCallbackServer } from "./oauth-server";
import { RelationshipEngine } from "./relationships";
import { HarperSkill } from "./harper-skill";
import { computeStaleness } from "./staleness";
import type { StalenessScore } from "./staleness";
import { FrontmatterManager } from "./frontmatter";
import { createBaseView } from "./base-view";
import { writeQuadrantView } from "./quadrant-view";
import { ReconnectView, VIEW_TYPE_GMAIL_CRM_RECONNECT } from "./reconnect-view";
import type {
	GmailCrmSettings,
	ContactIndex,
	Contact,
	MessageCache,
	ContactEdge,
	PersonPage,
	RelationshipGraph,
} from "./types";
import { CONTACT_INDEX_SCHEMA_VERSION, DEFAULT_SETTINGS } from "./types";

type MergeQueue = {
	schemaVersion?: number;
	updatedAtUnix?: number;
	candidates?: MergeCandidate[];
};

type MergeCandidate = {
	aEmail: string;
	aName: string;
	bEmail: string;
	bName: string;
	status: string;
	proposedAtUnix: number;
	source: string;
	dismissedAtUnix?: number;
	dismissReason?: string;
};

export default class GmailCrmPlugin extends Plugin {
	settings: GmailCrmSettings = DEFAULT_SETTINGS;
	private gmailApi!: GmailApi;
	private contactIndex: ContactIndex | null = null;
	private messageCache: MessageCache | null = null;
	private syncInterval: number | null = null;

	async onload() {
		await this.loadSettings();

		this.gmailApi = new GmailApi(this.settings, async (patch) => {
			Object.assign(this.settings, patch);
			await this.saveSettings();
		});

		// Command: open CRM base
		this.addCommand({
			id: "open",
			name: "Open contact base",
			callback: () => { void this.createBase(); },
		});

		// Command: sync (incremental)
		this.addCommand({
			id: "sync",
			name: "Sync contacts",
			callback: () => { void this.syncContacts(); },
		});

		// Command: full re-sync (clears cache)
		this.addCommand({
			id: "full-sync",
			name: "Full re-sync (clear cache)",
			callback: () => { void this.fullResync(); },
		});

		// Command: enrich all people
		this.addCommand({
			id: "enrich-all-people",
			name: "Enrich all people",
			callback: () => { void this.enrichAllPeople(); },
		});

		// Command: enrich current person
		this.addCommand({
			id: "enrich-current-person",
			name: "Enrich current person",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || !file.path.startsWith(normalizePath(this.settings.peopleFolder))) {
					return false;
				}
				if (!checking) {
					const name = file.basename.replace(/^p-\s*/, "");
					void this.enrichSinglePerson(name);
				}
				return true;
			},
		});

		// Command: map relationships only (no AI)
		this.addCommand({
			id: "map-relationships",
			name: "Map relationships only (no AI)",
			callback: () => { void this.enrichAllPeople(true); },
		});

		// Command: update staleness scores
		this.addCommand({
			id: "update-staleness",
			name: "Update staleness scores",
			callback: () => { void this.updateStaleness(); },
		});

		// Command: review local merge queue
		this.addCommand({
			id: "review-merge-queue",
			name: "Review merge queue",
			callback: () => { void this.reviewMergeQueue(); },
		});

		// Command: create/update CRM base view
		this.addCommand({
			id: "create-base-view",
			name: "Create contact base view",
			callback: () => { void this.createBase(); },
		});

		// Reconnect surface: swipeable view over the re-engage quadrant
		this.registerView(
			VIEW_TYPE_GMAIL_CRM_RECONNECT,
			(leaf) => new ReconnectView(leaf, this)
		);

		this.addRibbonIcon("users", "Reconnect suggestions", () => {
			void this.activateReconnectView();
		});

		this.addCommand({
			id: "open-reconnect",
			name: "Open reconnect suggestions",
			callback: () => { void this.activateReconnectView(); },
		});

		// Settings tab
		this.addSettingTab(new GmailCrmSettingTab(this.app, this));

		// Load cached index and message cache
		await this.loadContactIndex();
		await this.loadMessageCache();

		// Start auto-sync if authenticated
		if (this.settings.refreshToken) {
			this.startAutoSync();
		}
	}

	onunload() {
		if (this.syncInterval !== null) {
			window.clearInterval(this.syncInterval);
		}
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_GMAIL_CRM_RECONNECT);
	}

	async activateReconnectView() {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(VIEW_TYPE_GMAIL_CRM_RECONNECT)[0];
		if (!leaf) {
			leaf = workspace.getLeaf(true);
			await leaf.setViewState({
				type: VIEW_TYPE_GMAIL_CRM_RECONNECT,
				active: true,
			});
		}
		void workspace.revealLeaf(leaf);
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.gmailApi?.updateSettings(this.settings);
	}

	async startOAuthFlow() {
		try {
			const authUrl = this.gmailApi.getAuthUrl();

			// Start local callback server
			const codePromise = startOAuthCallbackServer();

			// Open browser
			window.open(authUrl);
			new Notice("Opening browser for authorization...");

			const code = await codePromise;
			await this.gmailApi.exchangeCode(code);
			new Notice("Gmail connected successfully!");

			this.startAutoSync();
			await this.syncContacts();
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(`Gmail auth failed: ${msg}`);
		}
	}

	private startAutoSync() {
		if (this.syncInterval !== null) {
			window.clearInterval(this.syncInterval);
		}
		this.syncInterval = window.setInterval(
			() => { void this.syncContacts(); },
			this.settings.syncIntervalMinutes * 60_000
		);
		this.registerInterval(this.syncInterval);
	}

	async syncContacts() {
		if (!this.settings.refreshToken) {
			new Notice("Connect your account first in plugin settings");
			return;
		}

		const notice = new Notice("Syncing contacts...", 0);
		try {
			const isIncremental = !!(this.contactIndex && this.messageCache);
			const result = await this.gmailApi.buildContactIndex(
				this.settings.maxResults,
				(done, total) => {
					const prefix = isIncremental ? "Incremental sync" : "Full sync";
					notice.setMessage(`${prefix}... ${done}/${total} new messages`);
				},
				this.contactIndex,
				this.messageCache
			);

			this.contactIndex = result.index;
			this.messageCache = result.cache;

			await this.saveContactIndex();
			await this.saveMessageCache();

			if (this.settings.createContactNotes) {
				await this.writeContactNotes();
			}

			const contactCount = Object.keys(this.contactIndex.contacts).length;
			notice.setMessage(`Synced ${contactCount} contacts — updating scores...`);

			// Auto-update staleness scores and Base view after sync
			await this.updateStaleness();
			await this.refreshBaseView();
			await this.refreshQuadrantView();

			notice.setMessage(`Synced ${contactCount} contacts — scores updated`);
			setTimeout(() => notice.hide(), 3000);

			if (this.settings.enrichOnSync) {
				await this.enrichAllPeople();
			}
		} catch (e: unknown) {
			notice.hide();
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(`Sync failed: ${msg}`);
		}
	}

	async fullResync() {
		this.messageCache = null;
		this.contactIndex = null;
		new Notice("Cache cleared — running full re-sync...");
		await this.syncContacts();
	}

	private async loadContactIndex() {
		const path = this.getIndexPath();
		// Plugin data lives under .obsidian/plugins/... which is outside the vault
		// index — getAbstractFileByPath returns null. Use the adapter directly.
		try {
			if (!(await this.app.vault.adapter.exists(path))) return;
			const content = await this.app.vault.adapter.read(path);
			const parsed = JSON.parse(content) as ContactIndex;
			this.contactIndex = {
				...parsed,
				schemaVersion: parsed.schemaVersion ?? CONTACT_INDEX_SCHEMA_VERSION,
				contacts: parsed.contacts ?? {},
				edges: parsed.edges ?? [],
			};
		} catch {
			// missing or corrupt — will be rebuilt on next sync
		}
	}

	private async saveContactIndex() {
		if (!this.contactIndex) return;
		this.contactIndex.schemaVersion = CONTACT_INDEX_SCHEMA_VERSION;
		this.contactIndex.edges ??= [];
		const path = this.getIndexPath();
		const content = JSON.stringify(this.contactIndex, null, 2);
		await this.app.vault.adapter.write(normalizePath(path), content);
	}

	private getIndexPath(): string {
		return normalizePath(
			`${this.app.vault.configDir}/plugins/gmail-crm/contact-index.json`
		);
	}

	private getCachePath(): string {
		return normalizePath(
			`${this.app.vault.configDir}/plugins/gmail-crm/message-cache.json`
		);
	}

	private getMergeQueuePath(): string {
		return normalizePath(
			`${this.app.vault.configDir}/plugins/gmail-crm/merge-queue.json`
		);
	}

	private async loadMergeQueue(): Promise<MergeQueue> {
		const path = this.getMergeQueuePath();
		try {
			if (!(await this.app.vault.adapter.exists(path))) {
				return { schemaVersion: 1, candidates: [] };
			}
			const content = await this.app.vault.adapter.read(path);
			return JSON.parse(content) as MergeQueue;
		} catch {
			return { schemaVersion: 1, candidates: [] };
		}
	}

	private async loadMessageCache() {
		const path = this.getCachePath();
		try {
			if (!(await this.app.vault.adapter.exists(path))) return;
			const content = await this.app.vault.adapter.read(path);
			this.messageCache = JSON.parse(content);
		} catch {
			// missing or corrupt — will do a full sync
		}
	}

	private async saveMessageCache() {
		if (!this.messageCache) return;
		const path = this.getCachePath();
		const content = JSON.stringify(this.messageCache);
		await this.app.vault.adapter.write(normalizePath(path), content);
	}

	private async writeContactNotes() {
		if (!this.contactIndex) return;

		const folder = normalizePath(this.settings.contactNotesFolder);
		if (!this.app.vault.getAbstractFileByPath(folder)) {
			try {
				await this.app.vault.createFolder(folder);
			} catch {
				// folder already exists
			}
		}

		// Build lookup of existing people pages by name (case-insensitive)
		const existingPages = new Map<string, TFile>();
		const folderObj = this.app.vault.getAbstractFileByPath(folder);
		if (folderObj instanceof TFolder) {
			for (const child of folderObj.children) {
				if (child instanceof TFile && child.extension === "md") {
					const pageName = child.basename.replace(/^p-\s*/, "").toLowerCase();
					existingPages.set(pageName, child);
				}
			}
		}

		for (const contact of Object.values(this.contactIndex.contacts)) {
			const safeName = contact.name.replace(/[\\/:*?"<>|]/g, "_");
			const notePath = normalizePath(`${folder}/p- ${safeName}.md`);

			// Check if a page already exists for this person
			const existingFile = existingPages.get(contact.name.toLowerCase());

			const fmLines = [
				"---",
				`email: "${contact.email}"`,
				`last_contact: ${contact.lastContact.split("T")[0]}`,
			];
			// Only record first_contact when we observed a real span — a single
			// message in the synced window leaves first === last, which isn't a
			// meaningful "first contact" (see frontmatter.ts updateFrontmatter).
			if (contact.firstContact && contact.firstContact !== contact.lastContact) {
				fmLines.push(`first_contact: ${contact.firstContact.split("T")[0]}`);
			}
			fmLines.push(
				`total_exchanges: ${contact.totalExchanges}`,
				`sent: ${contact.sentCount}`,
				`received: ${contact.receivedCount}`,
				"---",
			);
			const frontmatter = fmLines.join("\n");

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

			const content = `${frontmatter}\n\n${body}`;

			if (existingFile) {
				// Page exists — don't overwrite, just skip
				// Harper skill enrichment handles merging Gmail data
				continue;
			}

			// Check for p- prefixed path too
			const noteFile = this.app.vault.getAbstractFileByPath(notePath);
			if (noteFile instanceof TFile) {
				continue;
			}

			// Create new page with p- prefix
			try {
				await this.app.vault.create(notePath, content);
			} catch {
				// File already exists (case-insensitive match or race condition)
			}
		}
	}

	private extractUserNotes(content: string): string {
		const marker = "## Notes";
		const idx = content.indexOf(marker);
		if (idx === -1) return "";
		const afterMarker = content.slice(idx + marker.length);
		return afterMarker.trimStart();
	}

	private async openContactNote(contact: Contact) {
		const safeName = contact.name.replace(/[\\/:*?"<>|]/g, "_");
		const notePath = normalizePath(
			`${this.settings.contactNotesFolder}/${safeName}.md`
		);
		const file = this.app.vault.getAbstractFileByPath(notePath);
		if (file instanceof TFile) {
			await this.app.workspace.getLeaf().openFile(file);
		} else {
			new Notice(`No note found for ${contact.name}. Run sync first.`);
		}
	}

	async enrichAllPeople(skipAi = false) {
		const engine = new RelationshipEngine(this.app.vault, this.settings.peopleFolder);
		const notice = new Notice("Loading people pages...", 0);

		try {
			const pages = await engine.loadPeoplePages();
			const count = Object.keys(pages).length;
			notice.setMessage(`Found ${count} people. Building relationship graph...`);

			const graph = engine.buildGraph(pages, this.contactIndex);
			const connected = Object.values(graph).filter((edges) => edges.length > 0).length;
			notice.setMessage(`Graph: ${connected}/${count} connected. Enriching...`);

			let harper: HarperSkill | null = null;
			if (!skipAi) {
				if (!this.settings.anthropicApiKey) {
					notice.hide();
					new Notice("Set your API key in plugin settings first.");
					return;
				}
				harper = new HarperSkill(
					this.settings.anthropicApiKey,
					this.settings.harperModel,
					this.settings.vaultOwnerName
				);
			}

			let done = 0;
			for (const [name, page] of Object.entries(pages)) {
				done++;
				notice.setMessage(`Enriching ${done}/${count}: ${name}...`);

				const relationships = graph[name] ?? [];
				const file = this.app.vault.getAbstractFileByPath(page.path);
				if (!(file instanceof TFile)) continue;

				if (harper) {
					try {
						const rewritten = await harper.rewritePersonPage(name, page, relationships, pages);
						await this.app.vault.modify(file, rewritten);
					} catch (e: unknown) {
						const msg = e instanceof Error ? e.message : String(e);
						console.error(`Harper skill failed for ${name}: ${msg}`);
						new Notice(`Failed on ${name}: ${msg}`);
					}
				} else {
					// Map-only mode: append relationship links without rewriting
					const relLines = relationships.map(
						(r) => `- [[p- ${r.target}]] — ${r.type.replace(/_/g, " ")}: ${r.context}`
					);
					const relSection = relLines.length > 0 ? relLines.join("\n") : "- No mapped relationships yet.";
					let content = await this.app.vault.read(file);
					// Strip old relationship section
					content = content.replace(
						/\n## Relationships\n[\s\S]*?(?=\n## |\s*$)/,
						""
					);
					content = content.trimEnd() + `\n\n## Relationships\n${relSection}\n`;
					await this.app.vault.modify(file, content);
				}
			}

			notice.setMessage(`Enriched ${count} people pages!`);
			setTimeout(() => notice.hide(), 3000);
		} catch (e: unknown) {
			notice.hide();
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(`Enrichment failed: ${msg}`);
		}
	}

	async enrichSinglePerson(name: string) {
		const engine = new RelationshipEngine(this.app.vault, this.settings.peopleFolder);
		const notice = new Notice(`Enriching ${name}...`, 0);

		try {
			const pages = await engine.loadPeoplePages();
			if (!pages[name]) {
				notice.hide();
				new Notice(`Person "${name}" not found in people pages.`);
				return;
			}

			const graph = engine.buildGraph(pages, this.contactIndex);
			const relationships = graph[name] ?? [];

			if (!this.settings.anthropicApiKey) {
				notice.hide();
				new Notice("Set your API key in plugin settings first.");
				return;
			}

			const harper = new HarperSkill(
				this.settings.anthropicApiKey,
				this.settings.harperModel,
				this.settings.vaultOwnerName
			);
			const rewritten = await harper.rewritePersonPage(name, pages[name], relationships, pages);

			const file = this.app.vault.getAbstractFileByPath(pages[name].path);
			if (file instanceof TFile) {
				await this.app.vault.modify(file, rewritten);
			}

			notice.setMessage(`Enriched ${name}!`);
			setTimeout(() => notice.hide(), 3000);
		} catch (e: unknown) {
			notice.hide();
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(`Enrichment failed: ${msg}`);
		}
	}

	async updateStaleness() {
		const engine = new RelationshipEngine(this.app.vault, this.settings.peopleFolder);
		const fm = new FrontmatterManager(this.app.vault, this.settings.companiesFolder);
		const notice = new Notice("Computing staleness scores...", 0);

		try {
			const pages = await engine.loadPeoplePages();
			const count = Object.keys(pages).length;
			const graph = engine.buildGraph(pages, this.contactIndex);
			const scoreUpdatedAt = new Date().toISOString();

			let done = 0;
			let staleCount = 0;
			for (const [name, page] of Object.entries(pages)) {
				done++;
				const relationships = graph[name] ?? [];
				const staleness = computeStaleness(page, relationships);
				this.updateContactScore(page, staleness, scoreUpdatedAt);

				if (staleness.label === "stale" || staleness.label === "dormant") {
					staleCount++;
				}

				const file = this.app.vault.getAbstractFileByPath(page.path);
				if (file instanceof TFile) {
					await fm.updateFrontmatter(file, page, staleness, relationships);
					const contact = this.getContactForPage(page);
					if (contact?.canonicalId) {
						await fm.setCanonicalLink(file, {
							canonicalId: contact.canonicalId,
							aliases: contact.aliases,
							syncedAt: contact.lastCanonicalSync,
						});
					}
				}

				if (done % 20 === 0) {
					notice.setMessage(`Scoring ${done}/${count}...`);
				}
			}

			if (this.contactIndex) {
				this.contactIndex.edges = this.buildContactEdges(pages, graph);
				await this.saveContactIndex();
			}

			notice.setMessage(`Scored ${count} contacts — ${staleCount} going stale`);
			setTimeout(() => notice.hide(), 4000);
		} catch (e: unknown) {
			notice.hide();
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(`Staleness update failed: ${msg}`);
		}
	}

	private updateContactScore(
		page: PersonPage,
		staleness: StalenessScore,
		updatedAt: string
	): void {
		const contact = this.getContactForPage(page);
		if (!contact) return;

		const roleCompany = this.parseRoleCompany(page.role);
		if (roleCompany.role) contact.role = roleCompany.role;
		if (roleCompany.company) {
			contact.company = roleCompany.company;
		} else if (!contact.company) {
			const inferred = this.inferCompanyFromDomain(contact.domain);
			if (inferred) contact.company = inferred;
		}

		contact.score = {
			depth: staleness.relationshipDepth,
			recency: staleness.relationshipRecency,
			combined: staleness.combinedScore,
			quadrant: staleness.quadrant,
			strength: staleness.strengthScore,
			momentum: staleness.momentumScore,
			staleness: staleness.score,
			label: staleness.label,
			updatedAt,
		};
		// Keep flat score fields for simpler consumers and backward-compatible CLI reads.
		contact.relationshipDepth = staleness.relationshipDepth;
		contact.relationshipRecency = staleness.relationshipRecency;
		contact.combinedScore = staleness.combinedScore;
		contact.quadrant = staleness.quadrant;
	}

	private buildContactEdges(
		pages: Record<string, PersonPage>,
		graph: RelationshipGraph
	): ContactEdge[] {
		const edges = new Map<string, ContactEdge>();

		for (const [sourceName, relationships] of Object.entries(graph)) {
			const sourcePage = pages[sourceName];
			if (!sourcePage) continue;
			const sourceEmail = this.getEmailForPage(sourcePage);
			if (!sourceEmail) continue;

			for (const relationship of relationships) {
				const targetPage = pages[relationship.target];
				if (!targetPage) continue;
				const targetEmail = this.getEmailForPage(targetPage);
				if (!targetEmail || targetEmail === sourceEmail) continue;

				const sourceScore = this.getContactByEmail(sourceEmail)?.score?.combined;
				const targetScore = this.getContactByEmail(targetEmail)?.score?.combined;
				const scoreParts = [sourceScore, targetScore].filter(
					(score): score is number => typeof score === "number"
				);
				const combinedScore = scoreParts.length > 0
					? Math.round(scoreParts.reduce((sum, score) => sum + score, 0) / scoreParts.length)
					: 0;
				const key = `${sourceEmail}->${targetEmail}:${relationship.type}:${relationship.context}`;
				edges.set(key, {
					sourceEmail,
					sourceName,
					targetEmail,
					targetName: relationship.target,
					type: relationship.type,
					context: relationship.context,
					combinedScore,
					sourceScore,
					targetScore,
				});
			}
		}

		return Array.from(edges.values()).sort((a, b) => {
			if (b.combinedScore !== a.combinedScore) {
				return b.combinedScore - a.combinedScore;
			}
			return `${a.sourceName}:${a.targetName}`.localeCompare(`${b.sourceName}:${b.targetName}`);
		});
	}

	private getContactForPage(page: PersonPage): Contact | null {
		const email = this.getEmailForPage(page);
		if (!email) return null;
		return this.getContactByEmail(email);
	}

	private getEmailForPage(page: PersonPage): string | null {
		const candidates = [...page.emails];
		if (page.email && !candidates.includes(page.email)) {
			candidates.unshift(page.email);
		}

		for (const email of candidates) {
			const contact = this.getContactByEmail(email);
			if (contact) return contact.email.toLowerCase();
		}

		const fallback = candidates.find((email) => email.includes("@"));
		return fallback ? fallback.toLowerCase() : null;
	}

	private getContactByEmail(email: string): Contact | null {
		if (!this.contactIndex) return null;
		const lower = email.toLowerCase();
		const direct = this.contactIndex.contacts[lower];
		if (direct) return direct;

		for (const contact of Object.values(this.contactIndex.contacts)) {
			if (contact.email.toLowerCase() === lower) return contact;
			if (contact.aliases?.some((alias) => alias.toLowerCase() === lower)) {
				return contact;
			}
		}
		return null;
	}

	private parseRoleCompany(role: string | null): { role: string | null; company: string | null } {
		if (!role) return { role: null, company: null };
		const roleParts = role.split(/\s+at\s+|\s+@\s+/i);
		if (roleParts.length === 2) {
			return {
				role: roleParts[0].trim() || null,
				company: roleParts[1].trim() || null,
			};
		}
		const ofMatch = role.match(/^(founder|co[-\s]?founder|owner|principal|partner|managing partner|ceo|cto|cpo|coo|president)\s+of\s+(.+)$/i);
		if (ofMatch) {
			return {
				role: ofMatch[1].trim() || null,
				company: ofMatch[2].trim() || null,
			};
		}
		return { role: role.trim() || null, company: null };
	}

	private inferCompanyFromDomain(domain: string): string | null {
		if (!domain) return null;
		const generic = new Set([
			"gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "icloud.com",
			"aol.com", "protonmail.com", "me.com", "live.com", "mail.com",
		]);
		if (generic.has(domain)) return null;
		const raw = domain.split(".")[0];
		if (!raw) return null;
		return raw.charAt(0).toUpperCase() + raw.slice(1);
	}

	async reviewMergeQueue() {
		const queue = await this.loadMergeQueue();
		const candidates = queue.candidates ?? [];
		const pending = candidates.filter((candidate) => candidate.status === "pending");
		const applied = candidates.filter((candidate) => candidate.status === "applied");
		const dismissed = candidates.filter((candidate) => candidate.status === "dismissed");
		const lines = [
			"---",
			"title: Merge Queue",
			"type: crm_merge_queue",
			`queue_size: ${candidates.length}`,
			`pending: ${pending.length}`,
			`applied: ${applied.length}`,
			`dismissed: ${dismissed.length}`,
			`updated: ${new Date().toISOString()}`,
			"---",
			"",
			"# Merge Queue",
			"",
			`Queue size: **${candidates.length}**`,
			`Pending: **${pending.length}**`,
			`Applied: **${applied.length}**`,
			`Dismissed: **${dismissed.length}**`,
			"",
			"## Pending",
			"",
			...this.renderMergeCandidates(pending),
			"",
			"## Applied",
			"",
			...this.renderMergeCandidates(applied),
			"",
			"## Dismissed",
			"",
			...this.renderMergeCandidates(dismissed),
			"",
			"## Source",
			"",
			`Cache: \`${this.getIndexPath()}\``,
			`Queue: \`${this.getMergeQueuePath()}\``,
			"",
		];

		const folder = normalizePath(this.settings.peopleFolder);
		if (!this.app.vault.getAbstractFileByPath(folder)) {
			try {
				await this.app.vault.createFolder(folder);
			} catch {
				// folder already exists
			}
		}

		const path = normalizePath(`${folder}/_Merge Queue.md`);
		const content = lines.join("\n");
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) {
			await this.app.vault.modify(file, content);
			await this.app.workspace.getLeaf().openFile(file);
		} else {
			await this.app.vault.create(path, content);
			const created = this.app.vault.getAbstractFileByPath(path);
			if (created instanceof TFile) {
				await this.app.workspace.getLeaf().openFile(created);
			}
		}
		new Notice(`Merge queue: ${pending.length} pending, ${applied.length} applied, ${dismissed.length} dismissed`);
	}

	private renderMergeCandidates(candidates: MergeCandidate[]): string[] {
		if (candidates.length === 0) return ["No merge candidates."];

		const rows = [
			"| Status | Primary | Merged | Canonical ID | Action | Source |",
			"| --- | --- | --- | --- | --- | --- |",
		];

		for (const candidate of candidates) {
			const primary = this.getContactByEmail(candidate.aEmail);
			const merged = this.getContactByEmail(candidate.bEmail);
			const canonicalId = primary?.canonicalId ?? merged?.canonicalId ?? "";
			rows.push([
				this.escapeTableCell(candidate.status),
				this.mergeCandidateCell(candidate.aName, candidate.aEmail),
				this.mergeCandidateCell(candidate.bName, candidate.bEmail),
				canonicalId ? `\`${this.escapeTableCell(canonicalId)}\`` : "",
				this.mergeCandidateActionCell(candidate),
				this.escapeTableCell(candidate.source),
			].join(" | ").replace(/^/, "| ").replace(/$/, " |"));
		}

		return rows;
	}

	private mergeCandidateCell(name: string, email: string): string {
		const contact = this.getContactByEmail(email);
		const aliases = contact?.aliases?.length
			? `<br>Aliases: ${contact.aliases.map((alias) => this.escapeTableCell(alias)).join(", ")}`
			: "";
		return `${this.escapeTableCell(name || contact?.name || email)}<br><code>${this.escapeTableCell(email)}</code>${aliases}`;
	}

	private mergeCandidateActionCell(candidate: MergeCandidate): string {
		const a = this.escapeTableCell(candidate.aEmail);
		const b = this.escapeTableCell(candidate.bEmail);
		if (candidate.status === "pending") {
			return [
				`Apply: <code>bin/peoplegraph apply-merge ${a} ${b}</code>`,
				`Dismiss: <code>bin/peoplegraph dismiss-merge ${a} ${b} --reason not_duplicate</code>`,
			].join("<br>");
		}
		if (candidate.status === "dismissed") {
			const reason = candidate.dismissReason
				? `<br>Reason: ${this.escapeTableCell(candidate.dismissReason)}`
				: "";
			return `Reopen: <code>bin/peoplegraph propose-merge ${a} ${b}</code>${reason}`;
		}
		return "";
	}

	private escapeTableCell(value: string): string {
		return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
	}

	async createBase() {
		try {
			const basePath = await createBaseView(this.app.vault, this.settings.peopleFolder);
			new Notice(`CRM Base created at ${basePath}`);
			// Open it
			const file = this.app.vault.getAbstractFileByPath(basePath);
			if (file instanceof TFile) {
				await this.app.workspace.getLeaf().openFile(file);
			}
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(`Failed to create Base: ${msg}`);
		}
	}

	private async refreshBaseView() {
		try {
			await createBaseView(this.app.vault, this.settings.peopleFolder);
		} catch {
			// Non-critical — Base file may not exist yet
		}
	}

	private async refreshQuadrantView() {
		try {
			await writeQuadrantView(this.app.vault, this.settings.peopleFolder);
		} catch (e) {
			console.warn("[Gmail CRM] Quadrant view write failed", e);
		}
	}

	async createQuadrantView() {
		try {
			const path = await writeQuadrantView(this.app.vault, this.settings.peopleFolder);
			new Notice(`Quadrant view written to ${path}`);
			const file = this.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile) {
				await this.app.workspace.getLeaf().openFile(file);
			}
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(`Failed to write quadrant view: ${msg}`);
		}
	}
}
