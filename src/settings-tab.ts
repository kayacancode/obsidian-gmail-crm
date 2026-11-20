import { App, PluginSettingTab, Notice, type SettingDefinitionItem, type SettingDefinitionGroup, type SettingDefinition } from "obsidian";
import type GmailCrmPlugin from "./main";
export class GmailCrmSettingTab extends PluginSettingTab {
    plugin: GmailCrmPlugin;
    constructor(app: App, plugin: GmailCrmPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }
    getSettingDefinitions(): SettingDefinitionItem[] {
        const definitions: SettingDefinitionItem[] = [];
        let group: SettingDefinitionGroup & {
            items: SettingDefinition[];
        } = { type: "group", heading: "People Atlas", items: [] };
        group = { type: "group", heading: "Authentication", items: [] };
        definitions.push(group);
        const isAuthenticated = !!this.plugin.settings.refreshToken;
        group.items.push({ name: "Connection status", desc: isAuthenticated ? "Connected" : "Not connected", render: (setting) => {
                setting
                    .setName("Connection status")
                    .setDesc(isAuthenticated ? "Connected" : "Not connected")
                    .addButton((btn) => btn
                    .setButtonText(isAuthenticated ? "Reconnect" : "Connect with Google")
                    .setCta()
                    .onClick(async () => {
                    const clientId = this.plugin.getEffectiveClientId();
                    const clientSecret = this.plugin.getEffectiveClientSecret();
                    if (!clientId || !clientSecret) {
                        new Notice("Enter your client ID and client secret in the advanced Google sign-in settings.");
                        return;
                    }
                    await this.plugin.startOAuthFlow();
                }));
            } });
        if (isAuthenticated) {
            group.items.push({ name: "Disconnect", render: (setting) => {
                    setting.setName("Disconnect").addButton((btn) => btn
                        .setButtonText("Disconnect")
                        .setDestructive()
                        .onClick(async () => {
                        this.plugin.settings.accessToken = "";
                        this.plugin.settings.refreshToken = "";
                        this.plugin.settings.tokenExpiry = 0;
                        await this.plugin.saveSettings();
                        new Notice("Disconnected");
                        this.update();
                    }));
                } });
        }
        group.items.push({ name: "Use custom Google credentials", desc: "For advanced users who want to use their own Google Cloud project instead of the shared credentials", render: (setting) => {
                setting
                    .setName("Use custom Google credentials")
                    .setDesc("For advanced users who want to use their own Google Cloud project instead of the shared credentials")
                    .addToggle((toggle) => toggle
                    .setValue(this.plugin.settings.useCustomOAuth)
                    .onChange(async (value) => {
                    this.plugin.settings.useCustomOAuth = value;
                    await this.plugin.saveSettings();
                    this.update(); // re-render to show/hide fields
                }));
            } });
        if (this.plugin.settings.useCustomOAuth) {
            group.items.push({ name: "Client ID", desc: "From your Google Cloud Console API credentials", render: (setting) => {
                    setting
                        .setName("Client ID")
                        .setDesc("From your Google Cloud Console API credentials")
                        .addText((text) => text
                        .setPlaceholder("Your client ID")
                        .setValue(this.plugin.settings.clientId)
                        .onChange(async (value) => {
                        this.plugin.settings.clientId = value;
                        await this.plugin.saveSettings();
                    }));
                } });
            group.items.push({ name: "Client secret", desc: "From your Google Cloud Console API credentials", render: (setting) => {
                    setting
                        .setName("Client secret")
                        .setDesc("From your Google Cloud Console API credentials")
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
                } });
        }
        group = { type: "group", heading: "Filtering", items: [] };
        definitions.push(group);
        group.items.push({ name: "Blocked domains", desc: "Domains to skip during sync, separated by commas. Automated senders are also filtered.", render: (setting) => {
                setting
                    .setName("Blocked domains")
                    .setDesc("Domains to skip during sync, separated by commas. Automated senders are also filtered.")
                    .addTextArea((text) => text
                    .setPlaceholder("Enter newsletter domains")
                    .setValue(this.plugin.settings.blockedDomains)
                    .onChange(async (value) => {
                    this.plugin.settings.blockedDomains = value;
                    await this.plugin.saveSettings();
                }));
            } });
        group.items.push({ name: "Exclude Gmail categories", desc: "Comma-separated Gmail categories to skip during sync. Options: promotions, social, updates, forums. Leave empty to sync all.", render: (setting) => {
                setting
                    .setName("Exclude Gmail categories")
                    .setDesc("Comma-separated Gmail categories to skip during sync. Options: promotions, social, updates, forums. Leave empty to sync all.")
                    .addText((text) => text
                    .setPlaceholder("Example: promotions, social")
                    .setValue(this.plugin.settings.excludeCategories)
                    .onChange(async (value) => {
                    this.plugin.settings.excludeCategories = value;
                    await this.plugin.saveSettings();
                }));
            } });
        group.items.push({ name: "Exclude Gmail labels", desc: "Comma-separated Gmail labels to skip during sync (for example: shop@, service@). These are custom labels in your Gmail.", render: (setting) => {
                setting
                    .setName("Exclude Gmail labels")
                    .setDesc("Comma-separated Gmail labels to skip during sync (for example: shop@, service@). These are custom labels in your Gmail.")
                    .addText((text) => text
                    .setPlaceholder("Example: shop@, service@")
                    .setValue(this.plugin.settings.excludeLabels)
                    .onChange(async (value) => {
                    this.plugin.settings.excludeLabels = value;
                    await this.plugin.saveSettings();
                }));
            } });
        group = { type: "group", heading: "Sync", items: [] };
        definitions.push(group);
        group.items.push({ name: "Sync interval", desc: "How often to re-sync metadata. If a sync is overdue when Obsidian starts, it runs a minute after launch — so a long interval still happens on a machine that gets restarted. On daily or weekly, raise \"max messages to scan\" above the volume you receive in that window, or older messages fall outside it and are never scanned.", render: (setting) => {
                setting
                    .setName("Sync interval")
                    .setDesc("How often to re-sync metadata. If a sync is overdue when Obsidian starts, it runs a minute after launch — so a long interval still happens on a machine that gets restarted. On daily or weekly, raise \"max messages to scan\" above the volume you receive in that window, or older messages fall outside it and are never scanned.")
                    .addDropdown((dd) => {
                    const choices: [
                        number,
                        string
                    ][] = [
                        [15, "Every 15 minutes"],
                        [30, "Every 30 minutes"],
                        [60, "Hourly"],
                        [240, "Every 4 hours"],
                        [480, "Every 8 hours"],
                        [1440, "Daily"],
                        [10080, "Weekly"],
                    ];
                    for (const [minutes, label] of choices) {
                        dd.addOption(String(minutes), label);
                    }
                    // Preserve a previously-set slider value that isn't one of the presets.
                    const current = this.plugin.settings.syncIntervalMinutes;
                    if (!choices.some(([minutes]) => minutes === current)) {
                        dd.addOption(String(current), `Every ${current} minutes`);
                    }
                    dd.setValue(String(current));
                    dd.onChange(async (value) => {
                        this.plugin.settings.syncIntervalMinutes = Number(value);
                        await this.plugin.saveSettings();
                        // Restart the timer, otherwise the new cadence only takes effect
                        // after Obsidian is reloaded.
                        this.plugin.startAutoSync();
                    });
                });
            } });
        group.items.push({ name: "Max messages to scan", desc: "Number of recent messages to pull metadata from. \"all\" pulls your entire mailbox — slow on first run, but incremental syncs after that only fetch new messages.", render: (setting) => {
                setting
                    .setName("Max messages to scan")
                    .setDesc("Number of recent messages to pull metadata from. \"all\" pulls your entire mailbox — slow on first run, but incremental syncs after that only fetch new messages.")
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
            } });
        group.items.push({ name: "Sync now", desc: "Incremental sync — only fetches new messages since last sync", render: (setting) => {
                setting
                    .setName("Sync now")
                    .setDesc("Incremental sync — only fetches new messages since last sync")
                    .addButton((btn) => btn
                    .setButtonText("Sync")
                    .setCta()
                    .onClick(async () => {
                    await this.plugin.syncContacts();
                }));
            } });
        group.items.push({ name: "Full re-sync", desc: "Clear local cache and re-fetch all messages from Gmail", render: (setting) => {
                setting
                    .setName("Full re-sync")
                    .setDesc("Clear local cache and re-fetch all messages from Gmail")
                    .addButton((btn) => btn
                    .setButtonText("Full re-sync")
                    .setDestructive()
                    .onClick(async () => {
                    await this.plugin.fullResync();
                }));
            } });
        group.items.push({ name: "Fetch contact photos", desc: "After each sync, pull profile photos and job titles from Google Contacts. Adds a photo field to people pages and a logo to company pages. Needs a one-time reconnect to grant contacts access.", render: (setting) => {
                setting
                    .setName("Fetch contact photos")
                    .setDesc("After each sync, pull profile photos and job titles from Google Contacts. Adds a photo field to people pages and a logo to company pages. Needs a one-time reconnect to grant contacts access.")
                    .addToggle((toggle) => toggle
                    .setValue(this.plugin.settings.fetchContactPhotos)
                    .onChange(async (value) => {
                    this.plugin.settings.fetchContactPhotos = value;
                    await this.plugin.saveSettings();
                }));
            } });
        group = { type: "group", heading: "Score push", items: [] };
        definitions.push(group);
        group.items.push({ name: "Endpoint URL", desc: "Server that receives relationship scores. Leave empty to disable uploads.", render: (setting) => {
                setting
                    .setName("Endpoint URL")
                    .setDesc("Server that receives relationship scores. Leave empty to disable uploads.")
                    .addText((text) => text
                    .setValue(this.plugin.settings.scorePushUrl)
                    .onChange(async (value) => {
                    this.plugin.settings.scorePushUrl = value.trim();
                    await this.plugin.saveSettings();
                }));
            } });
        group.items.push({ name: "Your email", desc: "Identity sent with each push, for example: you@example.com.", render: (setting) => {
                setting
                    .setName("Your email")
                    .setDesc("Identity sent with each push, for example: you@example.com.")
                    .addText((text) => text
                    .setValue(this.plugin.settings.scorePushEmail)
                    .onChange(async (value) => {
                    this.plugin.settings.scorePushEmail = value.trim();
                    await this.plugin.saveSettings();
                }));
            } });
        group.items.push({ name: "API key", desc: "Sent as the X-Api-Key header to authenticate the push.", render: (setting) => {
                setting
                    .setName("API key")
                    .setDesc("Sent as the X-Api-Key header to authenticate the push.")
                    .addText((text) => {
                    text.inputEl.type = "password";
                    text
                        .setValue(this.plugin.settings.scorePushApiKey)
                        .onChange(async (value) => {
                        this.plugin.settings.scorePushApiKey = value.trim();
                        await this.plugin.saveSettings();
                    });
                });
            } });
        group.items.push({ name: "Auto-push after scoring", desc: "Push scores to the endpoint whenever staleness scores update.", render: (setting) => {
                setting
                    .setName("Auto-push after scoring")
                    .setDesc("Push scores to the endpoint whenever staleness scores update.")
                    .addToggle((toggle) => toggle
                    .setValue(this.plugin.settings.autoPushScores)
                    .onChange(async (value) => {
                    this.plugin.settings.autoPushScores = value;
                    await this.plugin.saveSettings();
                }));
            } });
        group = { type: "group", heading: "People graph web view", items: [] };
        definitions.push(group);
        group.items.push({ name: "Graph URL", desc: "Deployment to push your people graph to and open with the graph command. Empty opens the hosted graph and disables pushing.", render: (setting) => {
                setting
                    .setName("Graph URL")
                    .setDesc("Deployment to push your people graph to and open with the graph command. Empty opens the hosted graph and disables pushing.")
                    .addText((text) => text
                    .setValue(this.plugin.settings.graphPushUrl)
                    .onChange(async (value) => {
                    this.plugin.settings.graphPushUrl = value.trim();
                    await this.plugin.saveSettings();
                }));
            } });
        group.items.push({ name: "Graph push token", desc: "Mint it on the graph page after signing in — pushes are tied to your account.", render: (setting) => {
                setting
                    .setName("Graph push token")
                    .setDesc("Mint it on the graph page after signing in — pushes are tied to your account.")
                    .addText((text) => {
                    text.inputEl.type = "password";
                    text
                        .setValue(this.plugin.settings.graphPushToken)
                        .onChange(async (value) => {
                        this.plugin.settings.graphPushToken = value.trim();
                        await this.plugin.saveSettings();
                    });
                });
            } });
        group.items.push({ name: "Push people graph to web", desc: "Upload your current people and connections to the graph URL above, then refresh the web page.", render: (setting) => {
                setting
                    .setName("Push people graph to web")
                    .setDesc("Upload your current people and connections to the graph URL above, then refresh the web page.")
                    .addButton((button) => button
                    .setButtonText("Push graph")
                    .setCta()
                    .onClick(async () => {
                    button.setDisabled(true).setButtonText("Pushing…");
                    try {
                        await this.plugin.pushPeopleGraph();
                    }
                    finally {
                        button.setDisabled(false).setButtonText("Push graph");
                    }
                }));
            } });
        group = { type: "group", heading: "Contact notes", items: [] };
        definitions.push(group);
        group.items.push({ name: "Create contact notes", desc: "Auto-create a vault note for each contact in a people/ folder", render: (setting) => {
                setting
                    .setName("Create contact notes")
                    .setDesc("Auto-create a vault note for each contact in a people/ folder")
                    .addToggle((toggle) => toggle
                    .setValue(this.plugin.settings.createContactNotes)
                    .onChange(async (value) => {
                    this.plugin.settings.createContactNotes = value;
                    await this.plugin.saveSettings();
                }));
            } });
        group.items.push({ name: "Contact notes folder", desc: "Vault folder for contact notes", render: (setting) => {
                setting
                    .setName("Contact notes folder")
                    .setDesc("Vault folder for contact notes")
                    .addText((text) => text
                    .setValue(this.plugin.settings.contactNotesFolder)
                    .onChange(async (value) => {
                    this.plugin.settings.contactNotesFolder = value;
                    await this.plugin.saveSettings();
                }));
            } });
        group = { type: "group", heading: "Enrichment", items: [] };
        definitions.push(group);
        group.items.push({ name: "Relationship mapping and AI-powered people enrichment. Scans your people pages and builds a relationship graph." });
        group.items.push({ name: "Your name", desc: "Your name on enriched people pages. Leave blank to refer to you as the vault owner.", render: (setting) => {
                setting
                    .setName("Your name")
                    .setDesc("Your name on enriched people pages. Leave blank to refer to you as the vault owner.")
                    .addText((text) => text
                    .setPlaceholder("Your full name")
                    .setValue(this.plugin.settings.vaultOwnerName)
                    .onChange(async (value) => {
                    this.plugin.settings.vaultOwnerName = value;
                    await this.plugin.saveSettings();
                }));
            } });
        group.items.push({ name: "People pages folder", desc: "Vault folder containing your people notes (for example, 'people pages')", render: (setting) => {
                setting
                    .setName("People pages folder")
                    .setDesc("Vault folder containing your people notes (for example, 'people pages')")
                    .addText((text) => text
                    .setValue(this.plugin.settings.peopleFolder)
                    .onChange(async (value) => {
                    this.plugin.settings.peopleFolder = value;
                    await this.plugin.saveSettings();
                }));
            } });
        group.items.push({ name: "Companies folder", desc: "Vault folder for company pages. New companies are auto-created here.", render: (setting) => {
                setting
                    .setName("Companies folder")
                    .setDesc("Vault folder for company pages. New companies are auto-created here.")
                    .addText((text) => text
                    .setValue(this.plugin.settings.companiesFolder)
                    .onChange(async (value) => {
                    this.plugin.settings.companiesFolder = value;
                    await this.plugin.saveSettings();
                }));
            } });
        group.items.push({ name: "API key", desc: "Required for AI analysis. Relationship mapping works without it.", render: (setting) => {
                setting
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
            } });
        group.items.push({ name: "Model", desc: "Model for analysis", render: (setting) => {
                setting
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
            } });
        group.items.push({ name: "AI enrichment on sync", desc: "Optional AI rewrite after sync. Local relationship mapping runs automatically without AI.", render: (setting) => {
                setting
                    .setName("AI enrichment on sync")
                    .setDesc("Optional AI rewrite after sync. Local relationship mapping runs automatically without AI.")
                    .addToggle((toggle) => toggle
                    .setValue(this.plugin.settings.enrichOnSync)
                    .onChange(async (value) => {
                    this.plugin.settings.enrichOnSync = value;
                    await this.plugin.saveSettings();
                }));
            } });
        group.items.push({ name: "Enrich all people", desc: "Run relationship mapping and AI enrichment on all people pages", render: (setting) => {
                setting
                    .setName("Enrich all people")
                    .setDesc("Run relationship mapping and AI enrichment on all people pages")
                    .addButton((btn) => btn
                    .setButtonText("Enrich all")
                    .setCta()
                    .onClick(async () => {
                    await this.plugin.enrichAllPeople();
                }));
            } });
        group.items.push({ name: "Map relationships only", desc: "Build relationship graph without AI analysis (free, instant)", render: (setting) => {
                setting
                    .setName("Map relationships only")
                    .setDesc("Build relationship graph without AI analysis (free, instant)")
                    .addButton((btn) => btn
                    .setButtonText("Map only")
                    .onClick(async () => {
                    await this.plugin.enrichAllPeople(true);
                }));
            } });
        group = { type: "group", heading: "Base view", items: [] };
        definitions.push(group);
        group.items.push({ name: "Staleness scoring tracks relationship freshness. The base view gives you a sortable table of all your contacts with status indicators." });
        group.items.push({ name: "Auto-update staleness after sync", desc: "Automatically recompute scores and update people pages after each Gmail sync", render: (setting) => {
                setting
                    .setName("Auto-update staleness after sync")
                    .setDesc("Automatically recompute scores and update people pages after each Gmail sync")
                    .addToggle((toggle) => toggle
                    .setValue(this.plugin.settings.autoUpdateStaleness)
                    .onChange(async (value) => {
                    this.plugin.settings.autoUpdateStaleness = value;
                    await this.plugin.saveSettings();
                }));
            } });
        group.items.push({ name: "Debug scoring", desc: "Log every contact's score inputs to the console. Useful for tuning; slow and memory-hungry on large vaults.", render: (setting) => {
                setting
                    .setName("Debug scoring")
                    .setDesc("Log every contact's score inputs to the console. Useful for tuning; slow and memory-hungry on large vaults.")
                    .addToggle((toggle) => toggle
                    .setValue(this.plugin.settings.debugScoring)
                    .onChange(async (value) => {
                    this.plugin.settings.debugScoring = value;
                    await this.plugin.saveSettings();
                }));
            } });
        group.items.push({ name: "Staleness update schedule", desc: "Run staleness updates on a timer (in addition to after-sync). Set to 0 to only update after syncs.", render: (setting) => {
                setting
                    .setName("Staleness update schedule")
                    .setDesc("Run staleness updates on a timer (in addition to after-sync). Set to 0 to only update after syncs.")
                    .addDropdown((drop) => drop
                    .addOption("0", "Only after sync")
                    .addOption("6", "Every 6 hours")
                    .addOption("12", "Every 12 hours")
                    .addOption("24", "Every day")
                    .addOption("48", "Every 2 days")
                    .addOption("168", "Every week")
                    .setValue(String(this.plugin.settings.stalenessUpdateInterval))
                    .onChange(async (value) => {
                    this.plugin.settings.stalenessUpdateInterval = parseInt(value);
                    await this.plugin.saveSettings();
                    this.plugin.resetStalenessTimer();
                }));
            } });
        group.items.push({ name: "Update staleness scores", desc: "Compute freshness scores and write to frontmatter on all people pages", render: (setting) => {
                setting
                    .setName("Update staleness scores")
                    .setDesc("Compute freshness scores and write to frontmatter on all people pages")
                    .addButton((btn) => btn
                    .setButtonText("Score all")
                    .setCta()
                    .onClick(async () => {
                    await this.plugin.updateStaleness();
                }));
            } });
        group.items.push({ name: "Create base", desc: "Generate an Obsidian base file with contact table views sorted by staleness", render: (setting) => {
                setting
                    .setName("Create base")
                    .setDesc("Generate an Obsidian base file with contact table views sorted by staleness")
                    .addButton((btn) => btn
                    .setButtonText("Create base")
                    .setCta()
                    .onClick(async () => {
                    await this.plugin.createBase();
                }));
            } });
        group.items.push({ name: "Create quadrant view", desc: "Generate a 2×2 quadrant map showing all contacts grouped by nurture / re-engage / developing / deprioritize", render: (setting) => {
                setting
                    .setName("Create quadrant view")
                    .setDesc("Generate a 2×2 quadrant map showing all contacts grouped by nurture / re-engage / developing / deprioritize")
                    .addButton((btn) => btn
                    .setButtonText("Create quadrants")
                    .setCta()
                    .onClick(async () => {
                    await this.plugin.createQuadrantView();
                }));
            } });
        return definitions;
    }
}
