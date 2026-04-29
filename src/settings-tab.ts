import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type GmailCrmPlugin from "./main";

export class GmailCrmSettingTab extends PluginSettingTab {
	plugin: GmailCrmPlugin;

	constructor(app: App, plugin: GmailCrmPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// No general heading — first section starts directly

		// Auth section
		new Setting(containerEl).setName("Authentication").setHeading();
		containerEl.createEl("p", {
			text: "See the plugin readme for setup instructions.",
			cls: "setting-item-description",
		});

		new Setting(containerEl)
			.setName("Client ID")
			.setDesc("From your API credentials")
			.addText((text) =>
				text
					.setPlaceholder("Your client ID")
					.setValue(this.plugin.settings.clientId)
					.onChange(async (value) => {
						this.plugin.settings.clientId = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Client secret")
			.setDesc("From your API credentials")
			.addText((text) => {
				text
					.setPlaceholder("Your client secret")
					.setValue(this.plugin.settings.clientSecret)
					.onChange(async (value) => {
						this.plugin.settings.clientSecret = value;
						await this.plugin.saveSettings();
					});
				text.inputEl.type = "password";
			});

		const isAuthenticated = !!this.plugin.settings.refreshToken;

		new Setting(containerEl)
			.setName("Connection status")
			.setDesc(isAuthenticated ? "Connected" : "Not connected")
			.addButton((btn) =>
				btn
					.setButtonText(isAuthenticated ? "Reconnect" : "Connect")
					.setCta()
					.onClick(async () => {
						if (!this.plugin.settings.clientId || !this.plugin.settings.clientSecret) {
							new Notice("Please enter client ID and client secret first.");
							return;
						}
						await this.plugin.startOAuthFlow();
					})
			);

		if (isAuthenticated) {
			new Setting(containerEl).setName("Disconnect").addButton((btn) =>
				btn
					.setButtonText("Disconnect")
					.setWarning()
					.onClick(async () => {
						this.plugin.settings.accessToken = "";
						this.plugin.settings.refreshToken = "";
						this.plugin.settings.tokenExpiry = 0;
						await this.plugin.saveSettings();
						new Notice("Disconnected");
						this.display();
					})
			);
		}

		// Filtering section
		new Setting(containerEl).setName("Filtering").setHeading();

		new Setting(containerEl)
			.setName("Blocked domains")
			.setDesc("Comma-separated domains to exclude (e.g. substack.com, readwise.io). Common services like noreply senders are auto-filtered.")
			.addTextArea((text) =>
				text
					.setPlaceholder("substack.com, readwise.io, beehiiv.com")
					.setValue(this.plugin.settings.blockedDomains)
					.onChange(async (value) => {
						this.plugin.settings.blockedDomains = value;
						await this.plugin.saveSettings();
					})
			);

		// Sync section
		new Setting(containerEl).setName("Sync").setHeading();

		new Setting(containerEl)
			.setName("Sync interval")
			.setDesc("How often to re-sync metadata (minutes)")
			.addSlider((slider) =>
				slider
					.setLimits(15, 480, 15)
					.setValue(this.plugin.settings.syncIntervalMinutes)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.syncIntervalMinutes = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Max messages to scan")
			.setDesc("Number of recent messages to pull metadata from. \"All\" pulls your entire mailbox — slow on first run, but incremental syncs after that only fetch new messages.")
			.addDropdown((dd) => {
				for (const n of [100, 250, 500, 1000, 2000, 5000, 10000, 25000, 50000]) {
					dd.addOption(String(n), String(n));
				}
				dd.addOption("0", "All messages");
				dd.setValue(String(this.plugin.settings.maxResults));
				dd.onChange(async (value) => {
					this.plugin.settings.maxResults = parseInt(value);
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Sync now")
			.setDesc("Incremental sync — only fetches new messages since last sync")
			.addButton((btn) =>
				btn
					.setButtonText("Sync")
					.setCta()
					.onClick(async () => {
						await this.plugin.syncContacts();
					})
			);

		new Setting(containerEl)
			.setName("Full re-sync")
			.setDesc("Clear local cache and re-fetch all messages from Gmail")
			.addButton((btn) =>
				btn
					.setButtonText("Full re-sync")
					.setWarning()
					.onClick(async () => {
						await this.plugin.fullResync();
					})
			);

		// Notes section
		new Setting(containerEl).setName("Contact notes").setHeading();

		new Setting(containerEl)
			.setName("Create contact notes")
			.setDesc("Auto-create a vault note for each contact in a people/ folder")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.createContactNotes)
					.onChange(async (value) => {
						this.plugin.settings.createContactNotes = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Contact notes folder")
			.setDesc("Vault folder for contact notes")
			.addText((text) =>
				text
					.setValue(this.plugin.settings.contactNotesFolder)
					.onChange(async (value) => {
						this.plugin.settings.contactNotesFolder = value;
						await this.plugin.saveSettings();
					})
			);

		// Harper skill section
		new Setting(containerEl).setName("Enrichment").setHeading();
		containerEl.createEl("p", {
			text: "Relationship mapping and AI-powered people enrichment. Scans your people pages and builds a relationship graph.",
			cls: "setting-item-description",
		});

		new Setting(containerEl)
			.setName("Your name")
			.setDesc("How you should be referred to on enriched people pages (e.g., 'How Alex knows them'). Leave blank to use 'the vault owner'.")
			.addText((text) =>
				text
					.setPlaceholder("Your full name")
					.setValue(this.plugin.settings.vaultOwnerName)
					.onChange(async (value) => {
						this.plugin.settings.vaultOwnerName = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("People pages folder")
			.setDesc("Vault folder containing your people notes (e.g., 'people pages')")
			.addText((text) =>
				text
					.setValue(this.plugin.settings.peopleFolder)
					.onChange(async (value) => {
						this.plugin.settings.peopleFolder = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Companies folder")
			.setDesc("Vault folder for company pages. New companies are auto-created here.")
			.addText((text) =>
				text
					.setValue(this.plugin.settings.companiesFolder)
					.onChange(async (value) => {
						this.plugin.settings.companiesFolder = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("API key")
			.setDesc("Required for AI analysis. Relationship mapping works without it.")
			.addText((text) => {
				text
					.setPlaceholder("Your API key")
					.setValue(this.plugin.settings.anthropicApiKey)
					.onChange(async (value) => {
						this.plugin.settings.anthropicApiKey = value;
						await this.plugin.saveSettings();
					});
				text.inputEl.type = "password";
			});

		new Setting(containerEl)
			.setName("Model")
			.setDesc("Model for analysis")
			.addDropdown((dd) => {
				dd.addOption("claude-sonnet-4-6", "Sonnet 4.6 (fast)");
				dd.addOption("claude-opus-4-6", "Opus 4.6 (thorough)");
				dd.addOption("claude-haiku-4-5-20251001", "Haiku 4.5 (cheap)");
				dd.setValue(this.plugin.settings.harperModel);
				dd.onChange(async (value) => {
					this.plugin.settings.harperModel = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Enrich on sync")
			.setDesc("Automatically run enrichment after sync")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enrichOnSync)
					.onChange(async (value) => {
						this.plugin.settings.enrichOnSync = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Enrich all people")
			.setDesc("Run relationship mapping and AI enrichment on all people pages")
			.addButton((btn) =>
				btn
					.setButtonText("Enrich all")
					.setCta()
					.onClick(async () => {
						await this.plugin.enrichAllPeople();
					})
			);

		new Setting(containerEl)
			.setName("Map relationships only")
			.setDesc("Build relationship graph without AI analysis (free, instant)")
			.addButton((btn) =>
				btn
					.setButtonText("Map only")
					.onClick(async () => {
						await this.plugin.enrichAllPeople(true);
					})
			);

		// Staleness & Base section
		new Setting(containerEl).setName("Base view").setHeading();
		containerEl.createEl("p", {
			text: "Staleness scoring tracks relationship freshness. The base view gives you a sortable table of all your contacts with status indicators.",
			cls: "setting-item-description",
		});

		new Setting(containerEl)
			.setName("Update staleness scores")
			.setDesc("Compute freshness scores and write to frontmatter on all people pages")
			.addButton((btn) =>
				btn
					.setButtonText("Score all")
					.setCta()
					.onClick(async () => {
						await this.plugin.updateStaleness();
					})
			);

		new Setting(containerEl)
			.setName("Create base")
			.setDesc("Generate an Obsidian base file with contact table views sorted by staleness")
			.addButton((btn) =>
				btn
					.setButtonText("Create base")
					.setCta()
					.onClick(async () => {
						await this.plugin.createBase();
					})
			);

		new Setting(containerEl)
			.setName("Create quadrant view")
			.setDesc("Generate a 2×2 quadrant map (Quadrants.md) showing all contacts grouped by nurture / re-engage / developing / deprioritize")
			.addButton((btn) =>
				btn
					.setButtonText("Create quadrants")
					.setCta()
					.onClick(async () => {
						await this.plugin.createQuadrantView();
					})
			);
	}
}
