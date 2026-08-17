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
import { computeStaleness, setScoringDebug } from "./staleness";
import { pushScoresToBetaworks, type ScoredPage } from "./betaworks-push";
import {
	buildGraphPayload,
	generateGraphSalt,
	pushGraphToWeb,
	type GraphContactInput,
} from "./graph-push";
import { syncCalendarData } from "./calendar-sync";
import type { StalenessScore } from "./staleness";
import { FrontmatterManager } from "./frontmatter";
import { createBaseView } from "./base-view";
import { writeQuadrantView } from "./quadrant-view";
import type {
	GmailCrmSettings,
	ContactIndex,
	Contact,
	MessageCache,
	ContactEdge,
	PersonPage,
	Relationship,
	RelationshipGraph,
} from "./types";
import { CONTACT_INDEX_SCHEMA_VERSION, DEFAULT_SETTINGS } from "./types";

/** Grace period before a catch-up sync, so launch isn't competing with indexing. */
const STARTUP_SYNC_DELAY_MS = 60_000;

/** Pages scored between yields back to the UI thread. */
const SCORING_BATCH_SIZE = 50;

/**
 * Contacts scored between yields in the incremental pass. Much larger than the
 * full pass's batch because most iterations are pure arithmetic over the index
 * with no file I/O, so yielding every 50 would cost more than it buys.
 */
const INCREMENTAL_BATCH_SIZE = 500;

/** Score movement, in points, below which a page rewrite isn't worth the I/O. */
const SCORE_DRIFT_THRESHOLD = 3;

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
	/** Address -> contact map for getContactByEmail; rebuilt when the index is replaced. */
	private contactLookup: Map<string, Contact> | null = null;
	private contactLookupSource: Record<string, Contact> | null = null;
	private syncInterval: number | null = null;
	private stalenessInterval: number | null = null;

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

		// Command: sync calendar meeting data
		this.addCommand({
			id: "sync-calendar",
			name: "Sync calendar meeting data",
			callback: () => { void this.syncCalendar(); },
		});

		// Command: update staleness scores
		this.addCommand({
			id: "update-staleness",
			name: "Update staleness scores",
			callback: () => { void this.updateStaleness(); },
		});

		// Command: push scores to betaworks os
		this.addCommand({
			id: "push-betaworks-scores",
			name: "Push scores to betaworks os",
			callback: () => { void this.pushBetaworksScores(); },
		});

		// Command: push people graph to the web viewer
		this.addCommand({
			id: "push-people-graph",
			name: "Push people graph to web",
			callback: () => { void this.pushPeopleGraph(); },
		});

		// Command: full rescore, including a rebuilt relationship graph
		this.addCommand({
			id: "rescore-all",
			name: "Rescore all contacts (full rebuild)",
			callback: () => { void this.rescoreAllContacts(); },
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

		// Settings tab
		this.addSettingTab(new GmailCrmSettingTab(this.app, this));

		// Load cached index and message cache
		await this.loadContactIndex();
		await this.loadMessageCache();

		// Start auto-sync if authenticated
		if (this.settings.refreshToken) {
			this.startAutoSync();
			this.resetStalenessTimer();
			this.scheduleOverdueSync();
		}
	}

	/**
	 * The interval timer only fires after a full interval of continuous uptime and
	 * restarts from zero on every load, so on a machine that is restarted — or
	 * where Obsidian is opened briefly — a long cadence never fires at all. Catch
	 * up on startup instead, using the persisted completion time.
	 */
	private scheduleOverdueSync() {
		const intervalMs = this.settings.syncIntervalMinutes * 60_000;
		const elapsed = Date.now() - this.settings.lastSyncAt;
		if (elapsed < intervalMs) return;
		// Delayed so a launch isn't competing with vault indexing.
		const timer = window.setTimeout(() => {
			void this.syncContacts();
		}, STARTUP_SYNC_DELAY_MS);
		this.registerInterval(timer);
	}

	onunload() {
		if (this.syncInterval !== null) {
			window.clearInterval(this.syncInterval);
		}
		if (this.stalenessInterval !== null) {
			window.clearInterval(this.stalenessInterval);
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		setScoringDebug(this.settings.debugScoring);
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.gmailApi?.updateSettings(this.settings);
		setScoringDebug(this.settings.debugScoring);
	}

	getEffectiveClientId(): string {
		if (this.settings.useCustomOAuth && this.settings.clientId) {
			return this.settings.clientId;
		}
		// Fall back to shared credentials
		const { SHARED_CLIENT_ID } = require("./gmail-api");
		return SHARED_CLIENT_ID;
	}

	getEffectiveClientSecret(): string {
		if (this.settings.useCustomOAuth && this.settings.clientSecret) {
			return this.settings.clientSecret;
		}
		const { SHARED_CLIENT_SECRET } = require("./gmail-api");
		return SHARED_CLIENT_SECRET;
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

	startAutoSync() {
		if (this.syncInterval !== null) {
			window.clearInterval(this.syncInterval);
		}
		this.syncInterval = window.setInterval(
			() => { void this.syncContacts(); },
			this.settings.syncIntervalMinutes * 60_000
		);
		this.registerInterval(this.syncInterval);
	}

	resetStalenessTimer() {
		if (this.stalenessInterval !== null) {
			window.clearInterval(this.stalenessInterval);
			this.stalenessInterval = null;
		}
		const hours = this.settings.stalenessUpdateInterval;
		if (hours > 0) {
			this.stalenessInterval = window.setInterval(
				() => { void this.updateStaleness(); },
				hours * 3_600_000
			);
			this.registerInterval(this.stalenessInterval);
		}
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
				this.messageCache,
				// Progressive checkpoint every 2000 messages: flush to disk only, so a
				// crash mid-sync doesn't lose progress. Page writing and scoring are
				// derived from the index and run once after the sync instead — doing
				// them per checkpoint meant a large mailbox triggered dozens of full
				// scoring passes over every contact.
				async (checkpointIndex, checkpointCache) => {
					this.contactIndex = checkpointIndex;
					this.messageCache = checkpointCache;
					await this.saveContactIndex();
					await this.saveMessageCache();
					const count = Object.keys(checkpointIndex.contacts).length;
					console.log(`[Gmail CRM] Checkpoint: ${count} contacts saved to disk`);
				}
			);

			this.contactIndex = result.index;
			this.messageCache = result.cache;

			await this.saveContactIndex();
			await this.saveMessageCache();

			if (this.settings.createContactNotes) {
				await this.writeContactNotes();
			}

			const contactCount = Object.keys(this.contactIndex.contacts).length;
			notice.setMessage(`Synced ${contactCount} contacts — syncing calendar...`);

			// Calendar sync: merge meeting data into contacts (non-fatal on failure)
			try {
				await syncCalendarData(
					this.settings,
					this.contactIndex.contacts,
					this.contactIndex.userEmail
				);
				await this.saveContactIndex();
			} catch (e: unknown) {
				const calMsg = e instanceof Error ? e.message : String(e);
				if (calMsg.includes("401") || calMsg.includes("403")) {
					new Notice("Calendar sync needs re-authentication. Disconnect and reconnect in settings to grant calendar access.");
				} else {
					console.warn(`[Gmail CRM] Calendar sync skipped: ${calMsg}`);
				}
			}

			// Recorded before scoring so a long scoring pass can't make the next
			// startup think the sync is still overdue and immediately redo it.
			this.settings.lastSyncAt = Date.now();
			await this.saveSettings();

			notice.setMessage(`Synced ${contactCount} contacts — updating scores...`);

			// Auto-update staleness scores and Base view after sync (if enabled)
			if (this.settings.autoUpdateStaleness) {
				await this.updateStaleness();
				await this.refreshBaseView();
				await this.refreshQuadrantView();
				notice.setMessage(`Synced ${contactCount} contacts — scores updated`);
			} else {
				notice.setMessage(`Synced ${contactCount} contacts`);
			}
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

	async syncCalendar() {
		if (!this.settings.refreshToken) {
			new Notice("Connect your account first in plugin settings");
			return;
		}
		if (!this.contactIndex) {
			new Notice("No contact index found. Run a contact sync first.");
			return;
		}

		const notice = new Notice("Syncing calendar meeting data...", 0);
		try {
			await syncCalendarData(
				this.settings,
				this.contactIndex.contacts,
				this.contactIndex.userEmail
			);
			await this.saveContactIndex();

			const withCal = Object.values(this.contactIndex.contacts)
				.filter((c) => (c.calendarMeetings ?? 0) > 0).length;
			notice.setMessage(`Calendar sync complete — ${withCal} contacts have meeting data`);
			setTimeout(() => notice.hide(), 3000);
		} catch (e: unknown) {
			notice.hide();
			const msg = e instanceof Error ? e.message : String(e);
			if (msg.includes("401") || msg.includes("403")) {
				new Notice("Calendar sync needs re-authentication. Disconnect and reconnect in settings to grant calendar access.");
			} else {
				new Notice(`Calendar sync failed: ${msg}`);
			}
		}
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
		// Not pretty-printed: indentation roughly doubles a 25MB+ index, and this
		// string is built synchronously on the main thread at every checkpoint.
		const content = JSON.stringify(this.contactIndex);
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

	/**
	 * Full pass: reads every people page, rebuilds the relationship graph, and
	 * rewrites every page's frontmatter. Correct but O(vault) in file reads, so
	 * it is a manual command rather than the post-sync default.
	 */
	async rescoreAllContacts() {
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
			const scoredPages: ScoredPage[] = [];
			for (const [name, page] of Object.entries(pages)) {
				done++;
				const relationships = graph[name] ?? [];
				const staleness = computeStaleness(page, relationships);
				scoredPages.push({ page, staleness });
				this.updateContactScore(page, staleness, scoreUpdatedAt, relationships);

				if (staleness.label === "stale" || staleness.label === "dormant") {
					staleCount++;
				}

				const file = this.app.vault.getAbstractFileByPath(page.path);
				if (file instanceof TFile) {
					// page.content came from loadPeoplePages; passing it through avoids
					// re-reading each file twice more. Both writers skip untouched files,
					// so an unchanged page now costs no I/O at all.
					const updated = await fm.updateFrontmatter(
						file,
						page,
						staleness,
						relationships,
						page.content
					);
					const contact = this.getContactForPage(page);
					if (contact?.canonicalId) {
						await fm.setCanonicalLink(
							file,
							{
								canonicalId: contact.canonicalId,
								aliases: contact.aliases,
								syncedAt: contact.lastCanonicalSync,
							},
							updated
						);
					}
				}

				if (done % SCORING_BATCH_SIZE === 0) {
					notice.setMessage(`Scoring ${done}/${count}...`);
					// Hand control back to Obsidian so it can repaint. Without this the
					// renderer is blocked for the whole pass and the window goes white.
					await new Promise((resolve) => window.setTimeout(resolve, 0));
				}
			}

			if (this.contactIndex) {
				this.contactIndex.edges = this.buildContactEdges(pages, graph);
				await this.saveContactIndex();
			}

			this.settings.lastScoredAt = Date.now();
			await this.saveSettings();

			notice.setMessage(`Scored ${count} contacts — ${staleCount} going stale`);

			if (
				this.settings.autoPushScores &&
				this.settings.betaworksOsUrl &&
				this.settings.betaworksPartnerEmail &&
				this.settings.betaworksSalienceKey
			) {
				try {
					const pushed = await pushScoresToBetaworks(
						{
							url: this.settings.betaworksOsUrl,
							partnerEmail: this.settings.betaworksPartnerEmail,
							salienceKey: this.settings.betaworksSalienceKey,
						},
						scoredPages
					);
					notice.setMessage(`Scored ${count} contacts — pushed ${pushed} to betaworks os`);
				} catch (e: unknown) {
					// Push failures never block scoring.
					const msg = e instanceof Error ? e.message : String(e);
					console.error("[Gmail CRM] betaworks os push failed", e);
					new Notice(`betaworks os push failed: ${msg}`);
				}
			}
			setTimeout(() => notice.hide(), 4000);
		} catch (e: unknown) {
			notice.hide();
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(`Staleness update failed: ${msg}`);
		}
	}

	async pushBetaworksScores() {
		if (
			!this.settings.betaworksOsUrl ||
			!this.settings.betaworksPartnerEmail ||
			!this.settings.betaworksSalienceKey
		) {
			new Notice("Set the betaworks os URL, partner email, and Salience key in settings first");
			return;
		}
		const notice = new Notice("Pushing scores to betaworks os...", 0);
		try {
			const engine = new RelationshipEngine(this.app.vault, this.settings.peopleFolder);
			const pages = await engine.loadPeoplePages();
			const graph = engine.buildGraph(pages, this.contactIndex);
			const scoredPages: ScoredPage[] = Object.entries(pages).map(([name, page]) => ({
				page,
				staleness: computeStaleness(page, graph[name] ?? []),
			}));
			const pushed = await pushScoresToBetaworks(
				{
					url: this.settings.betaworksOsUrl,
					partnerEmail: this.settings.betaworksPartnerEmail,
					salienceKey: this.settings.betaworksSalienceKey,
				},
				scoredPages
			);
			notice.setMessage(`Pushed ${pushed} contacts to betaworks os`);
			setTimeout(() => notice.hide(), 4000);
		} catch (e: unknown) {
			notice.hide();
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(`betaworks os push failed: ${msg}`);
		}
	}

	async pushPeopleGraph() {
		if (!this.settings.graphPushUrl || !this.settings.graphPushToken) {
			new Notice("Set the graph URL and push token in settings first (mint the token on the graph page)");
			return;
		}
		if (!this.settings.graphPushSalt) {
			this.settings.graphPushSalt = generateGraphSalt();
			await this.saveSettings();
		}
		const notice = new Notice("Pushing people graph...", 0);
		try {
			const engine = new RelationshipEngine(this.app.vault, this.settings.peopleFolder);
			const pages = await engine.loadPeoplePages();
			const graph = engine.buildGraph(pages, this.contactIndex);

			const contacts: GraphContactInput[] = [];
			for (const [name, page] of Object.entries(pages)) {
				const email = this.getEmailForPage(page);
				if (!email) continue;
				contacts.push({
					email,
					name,
					company: this.getContactByEmail(email)?.company ?? null,
					lastContact: page.gmailStats?.lastContact ?? null,
					staleness: computeStaleness(page, graph[name] ?? []),
				});
			}
			const edges = this.buildContactEdges(pages, graph);

			const payload = await buildGraphPayload(contacts, edges, this.settings.graphPushSalt);
			const pushed = await pushGraphToWeb(
				{ url: this.settings.graphPushUrl, token: this.settings.graphPushToken },
				payload
			);
			notice.setMessage(`Pushed ${pushed.nodes} people, ${pushed.edges} connections — open ${this.settings.graphPushUrl} to view`);
			setTimeout(() => notice.hide(), 6000);
		} catch (e: unknown) {
			notice.hide();
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(`People graph push failed: ${msg}`);
		}
	}

	/**
	 * Incremental pass. The swipe deck and CLI read contact-index.json, not the
	 * vault, so every contact is rescored and the index stays exact; what gets
	 * skipped is the page write, which is where the cost lives. Scoring runs off
	 * the index alone — no page reads, no graph rebuild — so a 23k-contact vault
	 * costs a few thousand file reads instead of 23k.
	 */
	async updateStaleness() {
		if (!this.contactIndex) {
			new Notice("No contact index yet — run a sync first.");
			return;
		}

		// The incremental pass trusts each contact's stored `connections` count. On
		// an index written before that field existed it would read as zero for
		// everyone, scoring the whole vault as having no relationships. Do one full
		// pass first to populate it; every run after this is incremental.
		if (this.settings.lastScoredAt === 0) {
			new Notice("First scoring run — doing a full rebuild, then incremental from here.");
			await this.rescoreAllContacts();
			return;
		}

		const fm = new FrontmatterManager(this.app.vault, this.settings.companiesFolder);
		const notice = new Notice("Computing staleness scores...", 0);

		try {
			const filesByName = this.buildPeoplePageMap();
			const contacts = Object.values(this.contactIndex.contacts);
			const count = contacts.length;
			const scoreUpdatedAt = new Date().toISOString();
			const lastScoredAt = this.settings.lastScoredAt;

			let done = 0;
			let rewritten = 0;
			for (const contact of contacts) {
				done++;

				const page = this.synthesizePage(contact);
				// Only `.length` is read off this array by computeStaleness, so the
				// persisted edge count stands in for the edges themselves.
				const relationships = new Array<Relationship>(contact.connections ?? 0);
				const previous = contact.score;
				const staleness = computeStaleness(page, relationships);
				this.updateContactScore(page, staleness, scoreUpdatedAt, relationships);

				const file = this.lookupPeoplePage(filesByName, contact);
				if (file && this.needsPageRewrite(previous, staleness, file, lastScoredAt)) {
					const content = await this.app.vault.read(file);
					const updated = await fm.updateFrontmatter(
						file,
						page,
						staleness,
						relationships,
						content
					);
					if (contact.canonicalId) {
						await fm.setCanonicalLink(
							file,
							{
								canonicalId: contact.canonicalId,
								aliases: contact.aliases,
								syncedAt: contact.lastCanonicalSync,
							},
							updated
						);
					}
					rewritten++;
				}

				if (done % INCREMENTAL_BATCH_SIZE === 0) {
					notice.setMessage(`Scoring ${done}/${count}...`);
					// Hand control back to Obsidian so it can repaint. Without this the
					// renderer is blocked for the whole pass and the window goes white.
					await new Promise((resolve) => window.setTimeout(resolve, 0));
				}
			}

			// Edges are only derivable from the relationship graph, which this pass
			// deliberately does not build — leave the last full pass's edges alone.
			await this.saveContactIndex();

			this.settings.lastScoredAt = Date.now();
			await this.saveSettings();

			notice.setMessage(
				`Scored ${count.toLocaleString()} contacts — ${rewritten.toLocaleString()} pages updated`
			);
			setTimeout(() => notice.hide(), 4000);
		} catch (e: unknown) {
			notice.hide();
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(`Staleness update failed: ${msg}`);
		}
	}

	/**
	 * Name -> file over the people folder, from Obsidian's in-memory file list.
	 * Deliberately does not read any file: reading 23k pages is the cost this
	 * whole path exists to avoid.
	 */
	private buildPeoplePageMap(): Map<string, TFile> {
		const files = new Map<string, TFile>();
		const folder = this.app.vault.getAbstractFileByPath(
			normalizePath(this.settings.peopleFolder)
		);
		if (!(folder instanceof TFolder)) return files;

		for (const child of folder.children) {
			if (!(child instanceof TFile) || child.extension !== "md") continue;
			// Plugin-generated dashboards are not people.
			if (child.basename === "_Quadrants" || child.basename === "Quadrants") continue;
			const name = child.basename.replace(/^p-\s*/, "").toLowerCase();
			if (!files.has(name)) files.set(name, child);
		}
		return files;
	}

	private lookupPeoplePage(files: Map<string, TFile>, contact: Contact): TFile | null {
		const name = contact.name?.trim().toLowerCase();
		if (!name) return null;
		const direct = files.get(name);
		if (direct) return direct;
		// Page creation sanitises filesystem-illegal characters out of the name, so
		// a contact like "Dr. X / Y" lives under the sanitised basename.
		const safe = name.replace(/[\\/:*?"<>|]/g, "_");
		return files.get(safe) ?? null;
	}

	/**
	 * Page frontmatter is only worth rewriting when a reader would see a
	 * different value, or when the user has edited the page since the scores in
	 * it were written and it may no longer agree with the index.
	 */
	private needsPageRewrite(
		previous: Contact["score"],
		staleness: StalenessScore,
		file: TFile,
		lastScoredAt: number
	): boolean {
		if (!previous) return true;
		if (previous.label !== staleness.label) return true;
		if (previous.quadrant !== staleness.quadrant) return true;
		if (file.stat.mtime > lastScoredAt) return true;

		const moved = (before: number, after: number) => Math.abs(after - before) >= SCORE_DRIFT_THRESHOLD;
		return (
			moved(previous.staleness, staleness.score) ||
			moved(previous.combined, staleness.combinedScore) ||
			moved(previous.strength, staleness.strengthScore) ||
			moved(previous.momentum, staleness.momentumScore)
		);
	}

	/**
	 * A PersonPage carrying just what scoring and frontmatter writing read off
	 * the index. Body-derived fields (wiki links, meetings, role, introducer)
	 * would require reading the file, so they stay empty; see the class comment
	 * on updateStaleness for why that trade is worth it.
	 */
	private synthesizePage(contact: Contact): PersonPage {
		return {
			name: contact.name,
			path: "",
			content: "",
			wikiLinks: [],
			email: contact.email,
			emails: contact.email ? [contact.email.toLowerCase()] : [],
			role: null,
			introducer: null,
			meetings: [],
			howKnown: null,
			keyContext: null,
			gmailStats: {
				totalExchanges: contact.totalExchanges,
				sentCount: contact.sentCount,
				receivedCount: contact.receivedCount,
				lastContact: contact.lastContact,
				firstContact: contact.firstContact,
				subjects: contact.subjects ?? [],
				lastSubject: contact.lastSubject ?? "",
				domain: contact.domain ?? "",
				threadCount: contact.threadCount,
				maxThreadDepth: contact.maxThreadDepth,
				backAndForthThreads: contact.backAndForthThreads,
				rsvpOnlyThreads: contact.rsvpOnlyThreads,
				lastThreadDepth: contact.lastThreadDepth,
				calendarMeetings: contact.calendarMeetings,
				calendarAccepted: contact.calendarAccepted,
				calendarLastMeeting: contact.calendarLastMeeting,
				calendarOrganizedByThem: contact.calendarOrganizedByThem,
				calendarMeetingsLast90d: contact.calendarMeetingsLast90d,
				openCount: contact.openCount,
				lastOpenAt: contact.lastOpenAt,
				openEngagement: contact.openEngagement,
			},
		};
	}

	private updateContactScore(
		page: PersonPage,
		staleness: StalenessScore,
		updatedAt: string,
		relationships: Relationship[]
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
		// Persisted so the incremental pass can reproduce the edge count without
		// rebuilding the relationship graph.
		contact.connections = relationships.length;
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

		// Fall back to a prebuilt address map. Scanning every contact here used to
		// allocate a fresh 23k-entry array per miss, and this runs once per page
		// plus twice per edge during scoring.
		// Keyed on the contacts object, not the index wrapper: sync allocates a new
		// wrapper per checkpoint while reusing (and appending to) the same contacts
		// object, so guarding on the wrapper would miss those additions.
		if (!this.contactLookup || this.contactLookupSource !== this.contactIndex.contacts) {
			this.rebuildContactLookup();
		}
		return this.contactLookup?.get(lower) ?? null;
	}

	/**
	 * Maps every known address (primary + aliases) to its contact. First writer
	 * wins, matching the original scan order so lookups resolve identically.
	 */
	private rebuildContactLookup() {
		const lookup = new Map<string, Contact>();
		for (const contact of Object.values(this.contactIndex?.contacts ?? {})) {
			const primary = contact.email?.toLowerCase();
			if (primary && !lookup.has(primary)) lookup.set(primary, contact);
			for (const alias of contact.aliases ?? []) {
				const key = alias?.toLowerCase();
				if (key && !lookup.has(key)) lookup.set(key, contact);
			}
		}
		this.contactLookup = lookup;
		this.contactLookupSource = this.contactIndex?.contacts ?? null;
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
