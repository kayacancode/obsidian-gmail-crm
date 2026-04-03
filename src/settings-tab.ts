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

		containerEl.createEl("h2", { text: "Gmail CRM Settings" });

		// Auth section
		containerEl.createEl("h3", { text: "Google OAuth" });
		containerEl.createEl("p", {
			text: "Create a Google Cloud project with Gmail API enabled. Add an OAuth2 client (Desktop app). Use redirect URI: http://localhost:42813/callback",
			cls: "setting-item-description",
		});

		new Setting(containerEl)
			.setName("Client ID")
			.setDesc("OAuth2 Client ID from Google Cloud Console")
			.addText((text) =>
				text
					.setPlaceholder("your-client-id.apps.googleusercontent.com")
					.setValue(this.plugin.settings.clientId)
					.onChange(async (value) => {
						this.plugin.settings.clientId = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Client Secret")
			.setDesc("OAuth2 Client Secret")
			.addText((text) => {
				text
					.setPlaceholder("GOCSPX-...")
					.setValue(this.plugin.settings.clientSecret)
					.onChange(async (value) => {
						this.plugin.settings.clientSecret = value;
						await this.plugin.saveSettings();
					});
				text.inputEl.type = "password";
			});

		const isAuthenticated = !!this.plugin.settings.refreshToken;

		new Setting(containerEl)
			.setName("Connection Status")
			.setDesc(isAuthenticated ? "Connected to Gmail" : "Not connected")
			.addButton((btn) =>
				btn
					.setButtonText(isAuthenticated ? "Reconnect" : "Connect Gmail")
					.setCta()
					.onClick(async () => {
						if (!this.plugin.settings.clientId || !this.plugin.settings.clientSecret) {
							new Notice("Please enter Client ID and Client Secret first.");
							return;
						}
						await this.plugin.startOAuthFlow();
					})
			);

		if (isAuthenticated) {
			new Setting(containerEl).setName("Disconnect").addButton((btn) =>
				btn
					.setButtonText("Disconnect Gmail")
					.setWarning()
					.onClick(async () => {
						this.plugin.settings.accessToken = "";
						this.plugin.settings.refreshToken = "";
						this.plugin.settings.tokenExpiry = 0;
						await this.plugin.saveSettings();
						new Notice("Disconnected from Gmail.");
						this.display();
					})
			);
		}

		// Sync section
		containerEl.createEl("h3", { text: "Sync" });

		new Setting(containerEl)
			.setName("Sync interval")
			.setDesc("How often to re-sync Gmail metadata (minutes)")
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
			.setDesc("Number of recent messages to pull metadata from")
			.addDropdown((dd) => {
				for (const n of [100, 250, 500, 1000, 2000]) {
					dd.addOption(String(n), String(n));
				}
				dd.setValue(String(this.plugin.settings.maxResults));
				dd.onChange(async (value) => {
					this.plugin.settings.maxResults = parseInt(value);
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Sync now")
			.setDesc("Manually trigger a full sync")
			.addButton((btn) =>
				btn
					.setButtonText("Sync")
					.setCta()
					.onClick(async () => {
						await this.plugin.syncContacts();
					})
			);

		// Notes section
		containerEl.createEl("h3", { text: "Contact Notes" });

		new Setting(containerEl)
			.setName("Create contact notes")
			.setDesc("Auto-create a vault note for each contact in a People/ folder")
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

		// Harper Skill section
		containerEl.createEl("h3", { text: "Harper Skill Analysis" });
		containerEl.createEl("p", {
			text: "Relationship mapping and AI-powered people enrichment. Scans your people pages, builds a relationship graph, and generates Harper Skill profiles using Claude.",
			cls: "setting-item-description",
		});

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
			.setName("Anthropic API key")
			.setDesc("Required for Harper Skill AI analysis. Relationship mapping works without it.")
			.addText((text) => {
				text
					.setPlaceholder("sk-ant-...")
					.setValue(this.plugin.settings.anthropicApiKey)
					.onChange(async (value) => {
						this.plugin.settings.anthropicApiKey = value;
						await this.plugin.saveSettings();
					});
				text.inputEl.type = "password";
			});

		new Setting(containerEl)
			.setName("Model")
			.setDesc("Claude model for analysis")
			.addDropdown((dd) => {
				dd.addOption("claude-sonnet-4-6", "Sonnet 4.6 (fast)");
				dd.addOption("claude-opus-4-6", "Opus 4.6 (thorough)");
				dd.addOption("claude-haiku-4-5-20251001", "Haiku 4.5 (cheapest)");
				dd.setValue(this.plugin.settings.harperModel);
				dd.onChange(async (value) => {
					this.plugin.settings.harperModel = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Enrich on sync")
			.setDesc("Automatically run Harper Skill after Gmail sync")
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
			.setDesc("Run relationship mapping + Harper Skill on all people pages")
			.addButton((btn) =>
				btn
					.setButtonText("Enrich All")
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
					.setButtonText("Map Only")
					.onClick(async () => {
						await this.plugin.enrichAllPeople(true);
					})
			);
	}
}
