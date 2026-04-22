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
import { FrontmatterManager } from "./frontmatter";
import { createBaseView } from "./base-view";
import type { GmailCrmSettings, ContactIndex, Contact, MessageCache } from "./types";
import { DEFAULT_SETTINGS } from "./types";

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
		}
	}

	onunload() {
		if (this.syncInterval !== null) {
			window.clearInterval(this.syncInterval);
		}
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
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) {
			const content = await this.app.vault.read(file);
			try {
				this.contactIndex = JSON.parse(content);
				} catch {
				// corrupt index, will re-sync
			}
		}
	}

	private async saveContactIndex() {
		if (!this.contactIndex) return;
		const path = this.getIndexPath();
		const content = JSON.stringify(this.contactIndex, null, 2);
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			await this.app.vault.modify(existing, content);
		} else {
			try {
				await this.app.vault.create(path, content);
			} catch {
				// File may exist but not be indexed yet — try adapter directly
				await this.app.vault.adapter.write(normalizePath(path), content);
			}
		}
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

	private async loadMessageCache() {
		const path = this.getCachePath();
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) {
			const content = await this.app.vault.read(file);
			try {
				this.messageCache = JSON.parse(content);
			} catch {
				// corrupt cache, will do full sync
			}
		}
	}

	private async saveMessageCache() {
		if (!this.messageCache) return;
		const path = this.getCachePath();
		const content = JSON.stringify(this.messageCache);
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			await this.app.vault.modify(existing, content);
		} else {
			try {
				await this.app.vault.create(path, content);
			} catch {
				await this.app.vault.adapter.write(normalizePath(path), content);
			}
		}
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

	async updateStaleness() {
		const engine = new RelationshipEngine(this.app.vault, this.settings.peopleFolder);
		const fm = new FrontmatterManager(this.app.vault, this.settings.companiesFolder);
		const notice = new Notice("Computing staleness scores...", 0);

		try {
			const pages = await engine.loadPeoplePages();
			const count = Object.keys(pages).length;
			const graph = engine.buildGraph(pages, this.contactIndex);

			let done = 0;
			let staleCount = 0;
			for (const [name, page] of Object.entries(pages)) {
				done++;
				const relationships = graph[name] ?? [];
				const staleness = computeStaleness(page, relationships);

				if (staleness.label === "stale" || staleness.label === "dormant") {
					staleCount++;
				}

				const file = this.app.vault.getAbstractFileByPath(page.path);
				if (file instanceof TFile) {
					await fm.updateFrontmatter(file, page, staleness, relationships);
				}

				if (done % 20 === 0) {
					notice.setMessage(`Scoring ${done}/${count}...`);
				}
			}

			notice.setMessage(`Scored ${count} contacts — ${staleCount} going stale`);
			setTimeout(() => notice.hide(), 4000);
		} catch (e: unknown) {
			notice.hide();
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(`Staleness update failed: ${msg}`);
		}
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
}
