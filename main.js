var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/main.ts
var main_exports = {};
__export(main_exports, {
  default: () => GmailCrmPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian7 = require("obsidian");

// src/gmail-api.ts
var import_obsidian = require("obsidian");
var GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
var GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
var GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
var SCOPES = "https://www.googleapis.com/auth/gmail.metadata";
var REDIRECT_URI = "http://localhost:42813/callback";
var GmailApi = class {
  constructor(settings, onSettingsUpdate) {
    this.settings = settings;
    this.onSettingsUpdate = onSettingsUpdate;
  }
  updateSettings(settings) {
    this.settings = settings;
  }
  getAuthUrl() {
    const params = new URLSearchParams({
      client_id: this.settings.clientId,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      scope: SCOPES,
      access_type: "offline",
      prompt: "consent"
    });
    return `${GOOGLE_AUTH_URL}?${params.toString()}`;
  }
  async exchangeCode(code) {
    var _a;
    const resp = await (0, import_obsidian.requestUrl)({
      url: GOOGLE_TOKEN_URL,
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: this.settings.clientId,
        client_secret: this.settings.clientSecret,
        redirect_uri: REDIRECT_URI,
        grant_type: "authorization_code"
      }).toString()
    });
    const data = resp.json;
    await this.onSettingsUpdate({
      accessToken: data.access_token,
      refreshToken: (_a = data.refresh_token) != null ? _a : this.settings.refreshToken,
      tokenExpiry: Date.now() + data.expires_in * 1e3
    });
  }
  async refreshAccessToken() {
    const resp = await (0, import_obsidian.requestUrl)({
      url: GOOGLE_TOKEN_URL,
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.settings.clientId,
        client_secret: this.settings.clientSecret,
        refresh_token: this.settings.refreshToken,
        grant_type: "refresh_token"
      }).toString()
    });
    const data = resp.json;
    await this.onSettingsUpdate({
      accessToken: data.access_token,
      tokenExpiry: Date.now() + data.expires_in * 1e3
    });
  }
  async getHeaders() {
    if (Date.now() >= this.settings.tokenExpiry - 6e4) {
      await this.refreshAccessToken();
    }
    return { Authorization: `Bearer ${this.settings.accessToken}` };
  }
  async getUserEmail() {
    const headers = await this.getHeaders();
    const resp = await (0, import_obsidian.requestUrl)({
      url: `${GMAIL_API_BASE}/profile`,
      headers
    });
    return resp.json.emailAddress;
  }
  async fetchAllMessageIds(maxResults) {
    const headers = await this.getHeaders();
    const allMessages = [];
    let pageToken;
    while (allMessages.length < maxResults) {
      const params = new URLSearchParams({
        maxResults: String(Math.min(100, maxResults - allMessages.length))
      });
      if (pageToken) params.set("pageToken", pageToken);
      const resp = await (0, import_obsidian.requestUrl)({
        url: `${GMAIL_API_BASE}/messages?${params.toString()}`,
        headers
      });
      const data = resp.json;
      if (!data.messages) break;
      allMessages.push(...data.messages);
      pageToken = data.nextPageToken;
      if (!pageToken) break;
    }
    return allMessages;
  }
  async fetchMessageMetadata(messageId) {
    const headers = await this.getHeaders();
    const resp = await (0, import_obsidian.requestUrl)({
      url: `${GMAIL_API_BASE}/messages/${messageId}?format=METADATA&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`,
      headers
    });
    return resp.json;
  }
  async buildContactIndex(maxResults, onProgress) {
    const userEmail = await this.getUserEmail();
    const messageIds = await this.fetchAllMessageIds(maxResults);
    const contacts = {};
    const BATCH_SIZE = 10;
    for (let i = 0; i < messageIds.length; i += BATCH_SIZE) {
      const batch = messageIds.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(
        batch.map((m) => this.fetchMessageMetadata(m.id))
      );
      for (const msg of results) {
        this.processMessage(msg, userEmail, contacts);
      }
      onProgress == null ? void 0 : onProgress(Math.min(i + BATCH_SIZE, messageIds.length), messageIds.length);
    }
    return {
      lastSync: (/* @__PURE__ */ new Date()).toISOString(),
      userEmail,
      contacts
    };
  }
  processMessage(msg, userEmail, contacts) {
    var _a;
    const headers = msg.payload.headers;
    const from = this.getHeader(headers, "From");
    const to = this.getHeader(headers, "To");
    const subject = (_a = this.getHeader(headers, "Subject")) != null ? _a : "";
    const date = new Date(parseInt(msg.internalDate)).toISOString();
    const fromParsed = this.parseEmailAddress(from != null ? from : "");
    const toParsed = this.parseEmailAddress(to != null ? to : "");
    if (!fromParsed) return;
    const isSent = fromParsed.email.toLowerCase() === userEmail.toLowerCase();
    if (isSent && toParsed) {
      this.upsertContact(contacts, toParsed, date, subject, "sent");
    } else if (!isSent) {
      this.upsertContact(contacts, fromParsed, date, subject, "received");
    }
  }
  upsertContact(contacts, parsed, date, subject, direction) {
    var _a, _b;
    const key = parsed.email.toLowerCase();
    const domain = (_b = (_a = parsed.email.split("@")[1]) == null ? void 0 : _a.toLowerCase()) != null ? _b : "";
    if (!contacts[key]) {
      contacts[key] = {
        name: parsed.name || parsed.email,
        email: parsed.email,
        lastContact: date,
        firstContact: date,
        sentCount: 0,
        receivedCount: 0,
        totalExchanges: 0,
        subjects: [],
        lastSubject: "",
        domain
      };
    }
    const c = contacts[key];
    if (parsed.name && (!c.name || c.name === c.email)) {
      c.name = parsed.name;
    }
    if (date > c.lastContact) {
      c.lastContact = date;
      if (subject) c.lastSubject = subject;
    }
    if (date < c.firstContact) c.firstContact = date;
    if (direction === "sent") c.sentCount++;
    else c.receivedCount++;
    c.totalExchanges++;
    if (subject && c.subjects.length < 5) {
      c.subjects.push(subject);
    }
  }
  getHeader(headers, name) {
    var _a;
    return (_a = headers.find((h) => h.name.toLowerCase() === name.toLowerCase())) == null ? void 0 : _a.value;
  }
  parseEmailAddress(raw) {
    var _a;
    const match = raw.match(/^(?:"?([^"<]*)"?\s*)?<?([^>]+@[^>]+)>?$/);
    if (!match) return null;
    return {
      name: ((_a = match[1]) != null ? _a : "").trim(),
      email: match[2].trim()
    };
  }
};

// src/settings-tab.ts
var import_obsidian2 = require("obsidian");
var GmailCrmSettingTab = class extends import_obsidian2.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    new import_obsidian2.Setting(containerEl).setName("Authentication").setHeading();
    containerEl.createEl("p", {
      text: "See the plugin readme for setup instructions.",
      cls: "setting-item-description"
    });
    new import_obsidian2.Setting(containerEl).setName("Client ID").setDesc("From your API credentials").addText(
      (text) => text.setPlaceholder("Your client ID").setValue(this.plugin.settings.clientId).onChange(async (value) => {
        this.plugin.settings.clientId = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian2.Setting(containerEl).setName("Client secret").setDesc("From your API credentials").addText((text) => {
      text.setPlaceholder("Your client secret").setValue(this.plugin.settings.clientSecret).onChange(async (value) => {
        this.plugin.settings.clientSecret = value;
        await this.plugin.saveSettings();
      });
      text.inputEl.type = "password";
    });
    const isAuthenticated = !!this.plugin.settings.refreshToken;
    new import_obsidian2.Setting(containerEl).setName("Connection status").setDesc(isAuthenticated ? "Connected" : "Not connected").addButton(
      (btn) => btn.setButtonText(isAuthenticated ? "Reconnect" : "Connect").setCta().onClick(async () => {
        if (!this.plugin.settings.clientId || !this.plugin.settings.clientSecret) {
          new import_obsidian2.Notice("Please enter client ID and client secret first.");
          return;
        }
        await this.plugin.startOAuthFlow();
      })
    );
    if (isAuthenticated) {
      new import_obsidian2.Setting(containerEl).setName("Disconnect").addButton(
        (btn) => btn.setButtonText("Disconnect").setWarning().onClick(async () => {
          this.plugin.settings.accessToken = "";
          this.plugin.settings.refreshToken = "";
          this.plugin.settings.tokenExpiry = 0;
          await this.plugin.saveSettings();
          new import_obsidian2.Notice("Disconnected");
          this.display();
        })
      );
    }
    new import_obsidian2.Setting(containerEl).setName("Sync").setHeading();
    new import_obsidian2.Setting(containerEl).setName("Sync interval").setDesc("How often to re-sync metadata (minutes)").addSlider(
      (slider) => slider.setLimits(15, 480, 15).setValue(this.plugin.settings.syncIntervalMinutes).setDynamicTooltip().onChange(async (value) => {
        this.plugin.settings.syncIntervalMinutes = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian2.Setting(containerEl).setName("Max messages to scan").setDesc("Number of recent messages to pull metadata from").addDropdown((dd) => {
      for (const n of [100, 250, 500, 1e3, 2e3]) {
        dd.addOption(String(n), String(n));
      }
      dd.setValue(String(this.plugin.settings.maxResults));
      dd.onChange(async (value) => {
        this.plugin.settings.maxResults = parseInt(value);
        await this.plugin.saveSettings();
      });
    });
    new import_obsidian2.Setting(containerEl).setName("Sync now").setDesc("Manually trigger a full sync").addButton(
      (btn) => btn.setButtonText("Sync").setCta().onClick(async () => {
        await this.plugin.syncContacts();
      })
    );
    new import_obsidian2.Setting(containerEl).setName("Contact notes").setHeading();
    new import_obsidian2.Setting(containerEl).setName("Create contact notes").setDesc("Auto-create a vault note for each contact in a people/ folder").addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.createContactNotes).onChange(async (value) => {
        this.plugin.settings.createContactNotes = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian2.Setting(containerEl).setName("Contact notes folder").setDesc("Vault folder for contact notes").addText(
      (text) => text.setValue(this.plugin.settings.contactNotesFolder).onChange(async (value) => {
        this.plugin.settings.contactNotesFolder = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian2.Setting(containerEl).setName("Enrichment").setHeading();
    containerEl.createEl("p", {
      text: "Relationship mapping and AI-powered people enrichment. Scans your people pages and builds a relationship graph.",
      cls: "setting-item-description"
    });
    new import_obsidian2.Setting(containerEl).setName("People pages folder").setDesc("Vault folder containing your people notes (e.g., 'people pages')").addText(
      (text) => text.setValue(this.plugin.settings.peopleFolder).onChange(async (value) => {
        this.plugin.settings.peopleFolder = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian2.Setting(containerEl).setName("Companies folder").setDesc("Vault folder for company pages. New companies are auto-created here.").addText(
      (text) => text.setValue(this.plugin.settings.companiesFolder).onChange(async (value) => {
        this.plugin.settings.companiesFolder = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian2.Setting(containerEl).setName("API key").setDesc("Required for AI analysis. Relationship mapping works without it.").addText((text) => {
      text.setPlaceholder("Your API key").setValue(this.plugin.settings.anthropicApiKey).onChange(async (value) => {
        this.plugin.settings.anthropicApiKey = value;
        await this.plugin.saveSettings();
      });
      text.inputEl.type = "password";
    });
    new import_obsidian2.Setting(containerEl).setName("Model").setDesc("Model for analysis").addDropdown((dd) => {
      dd.addOption("claude-sonnet-4-6", "Sonnet 4.6 (fast)");
      dd.addOption("claude-opus-4-6", "Opus 4.6 (thorough)");
      dd.addOption("claude-haiku-4-5-20251001", "Haiku 4.5 (cheap)");
      dd.setValue(this.plugin.settings.harperModel);
      dd.onChange(async (value) => {
        this.plugin.settings.harperModel = value;
        await this.plugin.saveSettings();
      });
    });
    new import_obsidian2.Setting(containerEl).setName("Enrich on sync").setDesc("Automatically run enrichment after sync").addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.enrichOnSync).onChange(async (value) => {
        this.plugin.settings.enrichOnSync = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian2.Setting(containerEl).setName("Enrich all people").setDesc("Run relationship mapping and AI enrichment on all people pages").addButton(
      (btn) => btn.setButtonText("Enrich all").setCta().onClick(async () => {
        await this.plugin.enrichAllPeople();
      })
    );
    new import_obsidian2.Setting(containerEl).setName("Map relationships only").setDesc("Build relationship graph without AI analysis (free, instant)").addButton(
      (btn) => btn.setButtonText("Map only").onClick(async () => {
        await this.plugin.enrichAllPeople(true);
      })
    );
    new import_obsidian2.Setting(containerEl).setName("Base view").setHeading();
    containerEl.createEl("p", {
      text: "Staleness scoring tracks relationship freshness. The base view gives you a sortable table of all your contacts with status indicators.",
      cls: "setting-item-description"
    });
    new import_obsidian2.Setting(containerEl).setName("Update staleness scores").setDesc("Compute freshness scores and write to frontmatter on all people pages").addButton(
      (btn) => btn.setButtonText("Score all").setCta().onClick(async () => {
        await this.plugin.updateStaleness();
      })
    );
    new import_obsidian2.Setting(containerEl).setName("Create base").setDesc("Generate an Obsidian base file with contact table views sorted by staleness").addButton(
      (btn) => btn.setButtonText("Create base").setCta().onClick(async () => {
        await this.plugin.createBase();
      })
    );
  }
};

// src/oauth-server.ts
var import_http = __toESM(require("http"));
var PORT = 42813;
function startOAuthCallbackServer() {
  return new Promise((resolve, reject) => {
    const server = import_http.default.createServer((req, res) => {
      var _a;
      const url = new URL((_a = req.url) != null ? _a : "/", `http://localhost:${PORT}`);
      if (url.pathname === "/callback") {
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");
        res.writeHead(200, { "Content-Type": "text/html" });
        if (code) {
          res.end(
            "<html><body><h2>Gmail CRM connected!</h2><p>You can close this tab and return to Obsidian.</p></body></html>"
          );
          server.close();
          resolve(code);
        } else {
          res.end(
            `<html><body><h2>Authorization failed</h2><p>${error != null ? error : "Unknown error"}</p></body></html>`
          );
          server.close();
          reject(new Error(error != null ? error : "OAuth callback error"));
        }
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    server.listen(PORT, "127.0.0.1");
    setTimeout(() => {
      server.close();
      reject(new Error("OAuth callback timed out"));
    }, 12e4);
  });
}

// src/relationships.ts
var import_obsidian3 = require("obsidian");
var RelationshipEngine = class {
  constructor(vault, peopleFolder) {
    this.vault = vault;
    this.peopleFolder = peopleFolder;
  }
  async loadPeoplePages() {
    const folder = this.vault.getAbstractFileByPath(
      (0, import_obsidian3.normalizePath)(this.peopleFolder)
    );
    if (!(folder instanceof import_obsidian3.TFolder)) return {};
    const pages = {};
    for (const child of folder.children) {
      if (!(child instanceof import_obsidian3.TFile) || child.extension !== "md") continue;
      const content = await this.vault.read(child);
      const name = child.basename.replace(/^p-\s*/, "");
      const wikiLinks = [];
      const linkRegex = /\[\[p-\s*([^\]|]+?)(?:\|[^\]]*?)?\]\]/g;
      let match;
      while ((match = linkRegex.exec(content)) !== null) {
        wikiLinks.push(match[1].trim());
      }
      const emailMatch = content.match(/\*\*Email:\*\*\s*(\S+@\S+)/);
      const roleMatch = content.match(/\*\*Role\/Company:\*\*\s*(.+)/);
      const introMatch = content.match(
        /(?:introduced by|via|through)\s+(?:\[\[p-\s*)?([A-Z][a-z]+ [A-Z][a-z]+)/i
      );
      const meetings = [];
      const meetingRegex = /###\s+(\d{4}-\d{2}-\d{2})\s*[—–-]\s*(.+)/g;
      while ((match = meetingRegex.exec(content)) !== null) {
        meetings.push({ date: match[1], title: match[2].trim() });
      }
      const howMatch = content.match(/\*\*How Kaya knows them:\*\*\s*(.+)/);
      const ctxMatch = content.match(/\*\*Key context:\*\*\s*(.+)/);
      pages[name] = {
        name,
        path: child.path,
        content,
        wikiLinks,
        email: emailMatch ? emailMatch[1] : null,
        role: roleMatch ? roleMatch[1].trim() : null,
        introducer: introMatch ? introMatch[1].trim() : null,
        meetings,
        howKnown: howMatch ? howMatch[1].trim() : null,
        keyContext: ctxMatch ? ctxMatch[1].trim() : null,
        gmailStats: null
      };
    }
    return pages;
  }
  buildGraph(pages, contactIndex) {
    var _a, _b, _c;
    const graph = {};
    const allNames = new Set(Object.keys(pages));
    for (const name of allNames) {
      graph[name] = [];
    }
    for (const [name, page] of Object.entries(pages)) {
      for (const link of page.wikiLinks) {
        if (allNames.has(link) && link !== name) {
          graph[name].push({
            target: link,
            type: "wiki_link",
            context: "Referenced in notes"
          });
        }
      }
      if (page.introducer) {
        const matched = this.fuzzyMatch(page.introducer, allNames);
        if (matched && matched !== name) {
          graph[name].push({
            target: matched,
            type: "introduced_by",
            context: `Introduced by ${matched}`
          });
          graph[matched].push({
            target: name,
            type: "introduced",
            context: `Introduced ${name}`
          });
        }
      }
      for (const otherName of allNames) {
        if (otherName === name) continue;
        if (page.wikiLinks.includes(otherName)) continue;
        if (otherName.includes(" ") && page.content.includes(otherName)) {
          graph[name].push({
            target: otherName,
            type: "text_mention",
            context: "Mentioned in notes"
          });
        }
      }
    }
    const meetingAttendees = {};
    for (const [name, page] of Object.entries(pages)) {
      for (const m of page.meetings) {
        const key = `${m.date}:${m.title}`;
        if (!meetingAttendees[key]) meetingAttendees[key] = /* @__PURE__ */ new Set();
        meetingAttendees[key].add(name);
      }
    }
    for (const [key, attendees] of Object.entries(meetingAttendees)) {
      if (attendees.size < 2) continue;
      const list = Array.from(attendees);
      const [date, title] = key.split(":", 2);
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          graph[list[i]].push({
            target: list[j],
            type: "shared_meeting",
            context: `Both at: ${title} (${date})`
          });
          graph[list[j]].push({
            target: list[i],
            type: "shared_meeting",
            context: `Both at: ${title} (${date})`
          });
        }
      }
    }
    if (contactIndex) {
      const emailToName = {};
      for (const [name, page] of Object.entries(pages)) {
        if (page.email) {
          emailToName[page.email.toLowerCase()] = name;
        }
      }
      for (const [email, contact] of Object.entries(contactIndex.contacts)) {
        const name = emailToName[email];
        if (name && pages[name]) {
          pages[name].gmailStats = {
            totalExchanges: contact.totalExchanges,
            sentCount: contact.sentCount,
            receivedCount: contact.receivedCount,
            lastContact: contact.lastContact,
            subjects: (_a = contact.subjects) != null ? _a : [],
            lastSubject: (_b = contact.lastSubject) != null ? _b : "",
            domain: (_c = contact.domain) != null ? _c : ""
          };
        }
      }
    }
    for (const name of Object.keys(graph)) {
      const seen = /* @__PURE__ */ new Set();
      graph[name] = graph[name].filter((edge) => {
        const key = `${edge.target}:${edge.type}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
    return graph;
  }
  fuzzyMatch(query, candidates) {
    const q = query.toLowerCase();
    for (const c of candidates) {
      if (c.toLowerCase() === q) return c;
    }
    for (const c of candidates) {
      if (q.includes(c.toLowerCase()) || c.toLowerCase().includes(q)) return c;
    }
    const qParts = q.split(/\s+/);
    if (qParts.length >= 2) {
      for (const c of candidates) {
        const cParts = c.toLowerCase().split(/\s+/);
        if (cParts.length >= 2 && cParts[cParts.length - 1] === qParts[qParts.length - 1]) {
          return c;
        }
      }
    }
    return null;
  }
};

// src/harper-skill.ts
var import_obsidian4 = require("obsidian");
var ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
var HarperSkill = class {
  constructor(apiKey, model) {
    this.apiKey = apiKey;
    this.model = model;
  }
  async rewritePersonPage(name, page, relationships, allPages) {
    var _a, _b, _c;
    const relLines = relationships.map(
      (r) => `- [[p- ${r.target}]] (${r.type.replace(/_/g, " ")}): ${r.context}`
    );
    const relText = relLines.length > 0 ? relLines.join("\n") : "No mapped relationships yet.";
    const seen = /* @__PURE__ */ new Set();
    const connected = [];
    for (const r of relationships.slice(0, 15)) {
      if (seen.has(r.target) || !allPages[r.target]) continue;
      seen.add(r.target);
      const p = allPages[r.target];
      connected.push(
        `**${r.target}** \u2014 ${(_a = p.role) != null ? _a : "Unknown role"}. ${(_b = p.howKnown) != null ? _b : ""} ${(_c = p.keyContext) != null ? _c : ""}`
      );
    }
    const connectedText = connected.length > 0 ? connected.join("\n") : "None";
    let gmailText = "No Gmail data linked.";
    if (page.gmailStats) {
      const g = page.gmailStats;
      gmailText = [
        `Total emails: ${g.totalExchanges} (sent: ${g.sentCount}, received: ${g.receivedCount})`,
        `Last contact: ${g.lastContact.split("T")[0]}`,
        `Recent subjects: ${g.subjects.slice(0, 5).join(", ")}`
      ].join("\n");
    }
    const today = (/* @__PURE__ */ new Date()).toISOString().split("T")[0];
    const prompt = `You are Harper Skill \u2014 an AI relationship intelligence analyst. You are rewriting a people page in Kaya Jones's Obsidian vault.

Your job: take ALL the existing information about this person and produce a comprehensive, well-structured people page. Preserve every fact, meeting, action item, and detail from the original \u2014 lose nothing. Then enrich it with relationship mapping, strategic analysis, and suggested actions.

## Person: ${name}

## EXISTING PAGE CONTENT (preserve all facts, meetings, action items):
${page.content}

## MAPPED RELATIONSHIPS (from graph analysis):
${relText}

## CONNECTED PEOPLE IN KAYA'S NETWORK:
${connectedText}

## GMAIL COMMUNICATION STATS:
${gmailText}

---

Rewrite the full people page in this exact structure. Use Obsidian wiki links like [[p- Name]] when referencing other people. Preserve ALL meeting history entries verbatim \u2014 do not summarize or remove any meetings. Keep all action items, decisions, and details from the original.

Output the complete page in markdown (no code fences). Start with the h1 heading. Use this structure:

# ${name}

## Overview
- **Role/Company:** ...
- **Email:** ...
- **Connection:** how they connect to Kaya's network
- **How Kaya knows them:** ...
- **Key context:** ...

## Background
A 2-3 sentence bio synthesized from all available information.

## Relationship Map
For each key connection in Kaya's network:
- [[p- Name]] \u2014 connection type, strength signal, thematic link

## Key Themes & Interests
3-5 bullets on what this person cares about.

## Strategic Context
1-2 sentences on why this person matters \u2014 opportunities, leverage, or risks.

## Communication Pattern
Email frequency, engagement level, responsiveness. Use Gmail stats if available.

## Meeting History
COPY ALL EXISTING MEETING ENTRIES EXACTLY AS THEY APPEAR. Do not summarize, merge, or remove any meeting. Each meeting should keep its original ### heading, summary, key topics, decisions, and action items.

## Suggested Actions
1-3 specific, concrete next steps for Kaya.

---
*Harper Skill enriched: ${today}*`;
    const resp = await (0, import_obsidian4.requestUrl)({
      url: ANTHROPIC_API_URL,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 8e3,
        messages: [{ role: "user", content: prompt }]
      })
    });
    const data = resp.json;
    return data.content[0].text;
  }
};

// src/staleness.ts
function computeStaleness(page, relationships) {
  const gmail = page.gmailStats;
  const now = Date.now();
  let daysSinceContact = null;
  let totalExchanges = 0;
  if (gmail) {
    const lastDate = new Date(gmail.lastContact).getTime();
    daysSinceContact = Math.floor((now - lastDate) / 864e5);
    totalExchanges = gmail.totalExchanges;
  } else {
    const meetingDates = page.meetings.map((m) => new Date(m.date).getTime()).filter((t) => !isNaN(t));
    if (meetingDates.length > 0) {
      const latest = Math.max(...meetingDates);
      daysSinceContact = Math.floor((now - latest) / 864e5);
    }
  }
  const relationshipStrength = computeStrength(totalExchanges, relationships.length);
  let score;
  if (daysSinceContact === null) {
    score = 0;
  } else if (daysSinceContact <= 7) {
    score = 100;
  } else if (daysSinceContact <= 30) {
    score = 90 - (daysSinceContact - 7) * (20 / 23);
  } else if (daysSinceContact <= 90) {
    score = 70 - (daysSinceContact - 30) * (30 / 60);
  } else if (daysSinceContact <= 180) {
    score = 40 - (daysSinceContact - 90) * (25 / 90);
  } else {
    score = Math.max(0, 15 - (daysSinceContact - 180) * (15 / 180));
  }
  if (totalExchanges > 50) score = Math.min(100, score + 10);
  else if (totalExchanges > 20) score = Math.min(100, score + 5);
  if (relationships.length > 5) score = Math.min(100, score + 5);
  score = Math.round(score);
  const label = scoreToLabel(score);
  let nudge = null;
  if (label === "stale" || label === "dormant") {
    if (relationshipStrength === "strong" || relationshipStrength === "moderate") {
      nudge = generateNudge(page, daysSinceContact, totalExchanges);
    } else if (label === "dormant") {
      nudge = "No recent contact \u2014 consider if re-engagement is worthwhile";
    }
  } else if (label === "cooling" && relationshipStrength === "strong") {
    nudge = generateNudge(page, daysSinceContact, totalExchanges);
  }
  return {
    score,
    label,
    daysSinceContact,
    relationshipStrength,
    nudge
  };
}
function computeStrength(totalExchanges, edgeCount) {
  if (totalExchanges === 0 && edgeCount === 0) return "unknown";
  if (totalExchanges === 0) {
    if (edgeCount >= 5) return "moderate";
    if (edgeCount >= 2) return "weak";
    return "unknown";
  }
  if (totalExchanges >= 20) return "strong";
  if (totalExchanges >= 8) return "moderate";
  return "weak";
}
function scoreToLabel(score) {
  if (score >= 70) return "active";
  if (score >= 50) return "warm";
  if (score >= 30) return "cooling";
  if (score >= 10) return "stale";
  return "dormant";
}
function generateNudge(page, days, exchanges) {
  const parts = [];
  if (days !== null) {
    if (days > 180) parts.push(`No contact in ${Math.floor(days / 30)} months`);
    else parts.push(`Last contact ${days} days ago`);
  }
  if (exchanges > 20) {
    parts.push(`previously active (${exchanges} emails)`);
  }
  if (page.keyContext) {
    parts.push(`context: ${page.keyContext}`);
  } else if (page.role) {
    parts.push(`role: ${page.role}`);
  }
  return parts.join(" \u2014 ") || "Consider re-engaging";
}

// src/frontmatter.ts
var import_obsidian5 = require("obsidian");
var FrontmatterManager = class {
  constructor(vault, companiesFolder = "Companies") {
    this.companyIndex = null;
    this.vault = vault;
    this.companiesFolder = companiesFolder;
  }
  loadCompanyIndex() {
    if (this.companyIndex) return this.companyIndex;
    this.companyIndex = /* @__PURE__ */ new Map();
    const folder = this.vault.getAbstractFileByPath(
      (0, import_obsidian5.normalizePath)(this.companiesFolder)
    );
    if (folder instanceof import_obsidian5.TFolder) {
      for (const child of folder.children) {
        if (child instanceof import_obsidian5.TFile && child.extension === "md") {
          this.companyIndex.set(child.basename.toLowerCase(), child.basename);
        }
      }
    }
    return this.companyIndex;
  }
  matchCompany(rawCompany) {
    const index = this.loadCompanyIndex();
    const lower = rawCompany.toLowerCase().trim();
    if (index.has(lower)) return index.get(lower);
    const stripped = lower.replace(/\s*(inc\.?|llc|corp\.?|co\.?|ltd\.?)$/i, "").trim();
    if (index.has(stripped)) return index.get(stripped);
    for (const [key, name] of index) {
      if (key.includes(stripped) || stripped.includes(key)) {
        return name;
      }
    }
    return null;
  }
  async resolveCompany(rawCompany) {
    const matched = this.matchCompany(rawCompany);
    if (matched) {
      return `"[[${this.companiesFolder}/${matched}|${matched}]]"`;
    }
    const safeName = rawCompany.replace(/[\\/:*?"<>|]/g, "_").trim();
    const stubPath = (0, import_obsidian5.normalizePath)(`${this.companiesFolder}/${safeName}.md`);
    const existing = this.vault.getAbstractFileByPath(stubPath);
    if (!existing) {
      const today = (/* @__PURE__ */ new Date()).toISOString().split("T")[0];
      const content = [
        "---",
        `title: "${safeName}"`,
        `date: ${today}`,
        "tags: [company]",
        "type: company",
        "status: active",
        "---",
        "",
        `# ${safeName}`,
        "",
        "## Company Overview",
        "",
        "## People",
        ""
      ].join("\n");
      try {
        const folder = this.vault.getAbstractFileByPath(
          (0, import_obsidian5.normalizePath)(this.companiesFolder)
        );
        if (!folder) {
          await this.vault.createFolder((0, import_obsidian5.normalizePath)(this.companiesFolder));
        }
        await this.vault.create(stubPath, content);
      } catch (e) {
      }
      this.loadCompanyIndex().set(safeName.toLowerCase(), safeName);
    }
    return `"[[${this.companiesFolder}/${safeName}|${safeName}]]"`;
  }
  async updateFrontmatter(file, page, staleness, relationships) {
    var _a;
    const content = await this.vault.read(file);
    const crm = {
      staleness_score: staleness.score,
      staleness_label: staleness.label,
      relationship_strength: staleness.relationshipStrength,
      connections: relationships.length
    };
    if (page.email) crm.email = page.email;
    let rawCompany = null;
    if (page.role) {
      const roleParts = page.role.split(/\s+at\s+|\s+@\s+/i);
      if (roleParts.length === 2) {
        crm.role = roleParts[0].trim();
        rawCompany = roleParts[1].trim();
      } else {
        crm.role = page.role;
      }
    }
    if (!rawCompany && ((_a = page.gmailStats) == null ? void 0 : _a.domain)) {
      const d = page.gmailStats.domain;
      const generic = /* @__PURE__ */ new Set(["gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "icloud.com", "aol.com", "protonmail.com", "me.com", "live.com", "mail.com"]);
      if (!generic.has(d)) {
        rawCompany = d.split(".")[0];
        rawCompany = rawCompany.charAt(0).toUpperCase() + rawCompany.slice(1);
      }
    }
    if (rawCompany) {
      crm.company = await this.resolveCompany(rawCompany);
    }
    if (page.gmailStats) {
      crm.last_contact = page.gmailStats.lastContact.split("T")[0];
      crm.total_exchanges = page.gmailStats.totalExchanges;
      crm.sent = page.gmailStats.sentCount;
      crm.received = page.gmailStats.receivedCount;
      if (page.gmailStats.lastSubject) {
        crm.last_subject = page.gmailStats.lastSubject;
      }
      if (page.gmailStats.domain) {
        crm.domain = page.gmailStats.domain;
      }
    }
    if (staleness.daysSinceContact !== null) {
      crm.days_since_contact = staleness.daysSinceContact;
    }
    if (staleness.nudge) {
      crm.nudge = staleness.nudge;
    }
    const updated = this.mergeFrontmatter(content, crm);
    if (updated !== content) {
      await this.vault.modify(file, updated);
    }
  }
  mergeFrontmatter(content, fields) {
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (fmMatch) {
      const existingLines = fmMatch[1].split("\n");
      const existingKeys = /* @__PURE__ */ new Set();
      const updatedLines = [];
      for (const line of existingLines) {
        const keyMatch = line.match(/^(\w[\w_-]*):/);
        if (keyMatch) {
          const key = keyMatch[1];
          existingKeys.add(key);
          if (key in fields) {
            const val = fields[key];
            if (val !== void 0) {
              updatedLines.push(this.formatField(key, val));
            } else {
              updatedLines.push(line);
            }
          } else {
            updatedLines.push(line);
          }
        } else {
          updatedLines.push(line);
        }
      }
      for (const [key, val] of Object.entries(fields)) {
        if (!existingKeys.has(key) && val !== void 0) {
          updatedLines.push(this.formatField(key, val));
        }
      }
      const newFm = `---
${updatedLines.join("\n")}
---`;
      return content.replace(/^---\n[\s\S]*?\n---/, newFm);
    } else {
      const lines = [];
      for (const [key, val] of Object.entries(fields)) {
        if (val !== void 0) {
          lines.push(this.formatField(key, val));
        }
      }
      return `---
${lines.join("\n")}
---

${content}`;
    }
  }
  formatField(key, val) {
    if (typeof val === "number" || typeof val === "boolean") {
      return `${key}: ${val}`;
    }
    if (val.startsWith('"') && val.endsWith('"')) {
      return `${key}: ${val}`;
    }
    if (val.includes(":") || val.includes("#") || val.includes("'") || val.includes('"') || val.includes("\n") || val.includes("[")) {
      return `${key}: "${val.replace(/"/g, '\\"')}"`;
    }
    return `${key}: ${val}`;
  }
};

// src/base-view.ts
var import_obsidian6 = require("obsidian");
var BASE_CONTENT = `filters:
  and:
    - staleness_label != null
properties:
  note.email:
    displayName: Email
  note.role:
    displayName: Role
  note.company:
    displayName: Company
  note.last_contact:
    displayName: Last Emailed
  note.total_exchanges:
    displayName: "# Emails"
  note.staleness_score:
    displayName: Freshness
  note.staleness_label:
    displayName: Status
  note.relationship_strength:
    displayName: Strength
  note.days_since_contact:
    displayName: Days Ago
  note.connections:
    displayName: Connections
  note.nudge:
    displayName: Nudge
  note.sent:
    displayName: Sent
  note.received:
    displayName: Received
  note.last_subject:
    displayName: Last Subject
  note.domain:
    displayName: Domain
views:
  - type: table
    name: CRM
    order:
      - file.name
      - company
      - last_contact
      - last_subject
      - total_exchanges
      - staleness_label
      - relationship_strength
      - days_since_contact
      - nudge
    sort:
      - property: days_since_contact
        direction: DESC
    columns:
      - file.name
      - company
      - last_contact
      - last_subject
      - total_exchanges
      - staleness_label
      - relationship_strength
      - days_since_contact
      - nudge
    columnSize:
      file.name: 200
      company: 160
      last_subject: 250
      nudge: 300
    summaries:
      total_exchanges: Sum
  - type: table
    name: Going Stale
    order:
      - file.name
      - company
      - last_subject
      - days_since_contact
      - total_exchanges
      - relationship_strength
      - nudge
    filters:
      and:
        - relationship_strength = "strong" OR relationship_strength = "moderate"
        - staleness_label = "stale" OR staleness_label = "dormant" OR staleness_label = "cooling"
    sort:
      - property: total_exchanges
        direction: DESC
    columns:
      - file.name
      - company
      - last_subject
      - days_since_contact
      - total_exchanges
      - relationship_strength
      - nudge
    columnSize:
      file.name: 200
      company: 160
      last_subject: 250
      nudge: 350
  - type: table
    name: By Company
    order:
      - company
      - file.name
      - staleness_label
      - last_contact
      - total_exchanges
      - relationship_strength
    sort:
      - property: company
        direction: ASC
      - property: total_exchanges
        direction: DESC
    columns:
      - company
      - file.name
      - staleness_label
      - last_contact
      - total_exchanges
      - relationship_strength
    columnSize:
      file.name: 200
      company: 180
  - type: table
    name: Active
    order:
      - file.name
      - company
      - role
      - last_contact
      - total_exchanges
      - sent
      - received
    filters:
      and:
        - staleness_label = "active" OR staleness_label = "warm"
    sort:
      - property: last_contact
        direction: DESC
    columns:
      - file.name
      - company
      - role
      - last_contact
      - total_exchanges
      - sent
      - received
    columnSize:
      file.name: 200
      company: 160
`;
async function createBaseView(vault, peopleFolder) {
  const basePath = (0, import_obsidian6.normalizePath)(`${peopleFolder}/CRM.base`);
  const existing = vault.getAbstractFileByPath(basePath);
  if (existing instanceof import_obsidian6.TFile) {
    await vault.modify(existing, BASE_CONTENT);
  } else {
    await vault.create(basePath, BASE_CONTENT);
  }
  return basePath;
}

// src/types.ts
var DEFAULT_SETTINGS = {
  clientId: "",
  clientSecret: "",
  accessToken: "",
  refreshToken: "",
  tokenExpiry: 0,
  syncIntervalMinutes: 60,
  maxResults: 500,
  createContactNotes: false,
  contactNotesFolder: "People pages",
  peopleFolder: "People pages",
  companiesFolder: "Companies",
  anthropicApiKey: "",
  harperModel: "claude-sonnet-4-6",
  enrichOnSync: false
};

// src/main.ts
var GmailCrmPlugin = class extends import_obsidian7.Plugin {
  constructor() {
    super(...arguments);
    this.settings = DEFAULT_SETTINGS;
    this.contactIndex = null;
    this.syncInterval = null;
  }
  async onload() {
    await this.loadSettings();
    this.gmailApi = new GmailApi(this.settings, async (patch) => {
      Object.assign(this.settings, patch);
      await this.saveSettings();
    });
    this.addCommand({
      id: "open",
      name: "Open contact base",
      callback: () => {
        void this.createBase();
      }
    });
    this.addCommand({
      id: "sync",
      name: "Sync contacts",
      callback: () => {
        void this.syncContacts();
      }
    });
    this.addCommand({
      id: "enrich-all-people",
      name: "Enrich all people",
      callback: () => {
        void this.enrichAllPeople();
      }
    });
    this.addCommand({
      id: "enrich-current-person",
      name: "Enrich current person",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !file.path.startsWith((0, import_obsidian7.normalizePath)(this.settings.peopleFolder))) {
          return false;
        }
        if (!checking) {
          const name = file.basename.replace(/^p-\s*/, "");
          void this.enrichSinglePerson(name);
        }
        return true;
      }
    });
    this.addCommand({
      id: "map-relationships",
      name: "Map relationships only (no AI)",
      callback: () => {
        void this.enrichAllPeople(true);
      }
    });
    this.addCommand({
      id: "update-staleness",
      name: "Update staleness scores",
      callback: () => {
        void this.updateStaleness();
      }
    });
    this.addCommand({
      id: "create-base-view",
      name: "Create contact base view",
      callback: () => {
        void this.createBase();
      }
    });
    this.addSettingTab(new GmailCrmSettingTab(this.app, this));
    await this.loadContactIndex();
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
    var _a;
    await this.saveData(this.settings);
    (_a = this.gmailApi) == null ? void 0 : _a.updateSettings(this.settings);
  }
  async startOAuthFlow() {
    try {
      const authUrl = this.gmailApi.getAuthUrl();
      const codePromise = startOAuthCallbackServer();
      window.open(authUrl);
      new import_obsidian7.Notice("Opening browser for authorization...");
      const code = await codePromise;
      await this.gmailApi.exchangeCode(code);
      new import_obsidian7.Notice("Gmail connected successfully!");
      this.startAutoSync();
      await this.syncContacts();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      new import_obsidian7.Notice(`Gmail auth failed: ${msg}`);
    }
  }
  startAutoSync() {
    if (this.syncInterval !== null) {
      window.clearInterval(this.syncInterval);
    }
    this.syncInterval = window.setInterval(
      () => {
        void this.syncContacts();
      },
      this.settings.syncIntervalMinutes * 6e4
    );
    this.registerInterval(this.syncInterval);
  }
  async syncContacts() {
    if (!this.settings.refreshToken) {
      new import_obsidian7.Notice("Connect your account first in plugin settings");
      return;
    }
    const notice = new import_obsidian7.Notice("Syncing contacts...", 0);
    try {
      this.contactIndex = await this.gmailApi.buildContactIndex(
        this.settings.maxResults,
        (done, total) => {
          notice.setMessage(`Syncing... ${done}/${total} messages`);
        }
      );
      await this.saveContactIndex();
      if (this.settings.createContactNotes) {
        await this.writeContactNotes();
      }
      notice.setMessage(
        `Synced ${Object.keys(this.contactIndex.contacts).length} contacts`
      );
      setTimeout(() => notice.hide(), 3e3);
      if (this.settings.enrichOnSync) {
        await this.enrichAllPeople();
      }
    } catch (e) {
      notice.hide();
      const msg = e instanceof Error ? e.message : String(e);
      new import_obsidian7.Notice(`Sync failed: ${msg}`);
    }
  }
  async loadContactIndex() {
    const path = this.getIndexPath();
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof import_obsidian7.TFile) {
      const content = await this.app.vault.read(file);
      try {
        this.contactIndex = JSON.parse(content);
      } catch (e) {
      }
    }
  }
  async saveContactIndex() {
    if (!this.contactIndex) return;
    const path = this.getIndexPath();
    const content = JSON.stringify(this.contactIndex, null, 2);
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof import_obsidian7.TFile) {
      await this.app.vault.modify(existing, content);
    } else {
      try {
        await this.app.vault.create(path, content);
      } catch (e) {
        await this.app.vault.adapter.write((0, import_obsidian7.normalizePath)(path), content);
      }
    }
  }
  getIndexPath() {
    return (0, import_obsidian7.normalizePath)(
      `${this.app.vault.configDir}/plugins/gmail-crm/contact-index.json`
    );
  }
  async writeContactNotes() {
    if (!this.contactIndex) return;
    const folder = (0, import_obsidian7.normalizePath)(this.settings.contactNotesFolder);
    if (!this.app.vault.getAbstractFileByPath(folder)) {
      try {
        await this.app.vault.createFolder(folder);
      } catch (e) {
      }
    }
    const existingPages = /* @__PURE__ */ new Map();
    const folderObj = this.app.vault.getAbstractFileByPath(folder);
    if (folderObj instanceof import_obsidian7.TFolder) {
      for (const child of folderObj.children) {
        if (child instanceof import_obsidian7.TFile && child.extension === "md") {
          const pageName = child.basename.replace(/^p-\s*/, "").toLowerCase();
          existingPages.set(pageName, child);
        }
      }
    }
    for (const contact of Object.values(this.contactIndex.contacts)) {
      const safeName = contact.name.replace(/[\\/:*?"<>|]/g, "_");
      const notePath = (0, import_obsidian7.normalizePath)(`${folder}/p- ${safeName}.md`);
      const existingFile = existingPages.get(contact.name.toLowerCase());
      const frontmatter = [
        "---",
        `email: "${contact.email}"`,
        `last_contact: ${contact.lastContact.split("T")[0]}`,
        `first_contact: ${contact.firstContact.split("T")[0]}`,
        `total_exchanges: ${contact.totalExchanges}`,
        `sent: ${contact.sentCount}`,
        `received: ${contact.receivedCount}`,
        "---"
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
        ""
      ].join("\n");
      const content = `${frontmatter}

${body}`;
      if (existingFile) {
        continue;
      }
      const noteFile = this.app.vault.getAbstractFileByPath(notePath);
      if (noteFile instanceof import_obsidian7.TFile) {
        continue;
      }
      await this.app.vault.create(notePath, content);
    }
  }
  extractUserNotes(content) {
    const marker = "## Notes";
    const idx = content.indexOf(marker);
    if (idx === -1) return "";
    const afterMarker = content.slice(idx + marker.length);
    return afterMarker.trimStart();
  }
  async openContactNote(contact) {
    const safeName = contact.name.replace(/[\\/:*?"<>|]/g, "_");
    const notePath = (0, import_obsidian7.normalizePath)(
      `${this.settings.contactNotesFolder}/${safeName}.md`
    );
    const file = this.app.vault.getAbstractFileByPath(notePath);
    if (file instanceof import_obsidian7.TFile) {
      await this.app.workspace.getLeaf().openFile(file);
    } else {
      new import_obsidian7.Notice(`No note found for ${contact.name}. Run sync first.`);
    }
  }
  async enrichAllPeople(skipAi = false) {
    var _a;
    const engine = new RelationshipEngine(this.app.vault, this.settings.peopleFolder);
    const notice = new import_obsidian7.Notice("Loading people pages...", 0);
    try {
      const pages = await engine.loadPeoplePages();
      const count = Object.keys(pages).length;
      notice.setMessage(`Found ${count} people. Building relationship graph...`);
      const graph = engine.buildGraph(pages, this.contactIndex);
      const connected = Object.values(graph).filter((edges) => edges.length > 0).length;
      notice.setMessage(`Graph: ${connected}/${count} connected. Enriching...`);
      let harper = null;
      if (!skipAi) {
        if (!this.settings.anthropicApiKey) {
          notice.hide();
          new import_obsidian7.Notice("Set your API key in plugin settings first.");
          return;
        }
        harper = new HarperSkill(this.settings.anthropicApiKey, this.settings.harperModel);
      }
      let done = 0;
      for (const [name, page] of Object.entries(pages)) {
        done++;
        notice.setMessage(`Enriching ${done}/${count}: ${name}...`);
        const relationships = (_a = graph[name]) != null ? _a : [];
        const file = this.app.vault.getAbstractFileByPath(page.path);
        if (!(file instanceof import_obsidian7.TFile)) continue;
        if (harper) {
          try {
            const rewritten = await harper.rewritePersonPage(name, page, relationships, pages);
            await this.app.vault.modify(file, rewritten);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error(`Harper skill failed for ${name}: ${msg}`);
            new import_obsidian7.Notice(`Failed on ${name}: ${msg}`);
          }
        } else {
          const relLines = relationships.map(
            (r) => `- [[p- ${r.target}]] \u2014 ${r.type.replace(/_/g, " ")}: ${r.context}`
          );
          const relSection = relLines.length > 0 ? relLines.join("\n") : "- No mapped relationships yet.";
          let content = await this.app.vault.read(file);
          content = content.replace(
            /\n## Relationships\n[\s\S]*?(?=\n## |\s*$)/,
            ""
          );
          content = content.trimEnd() + `

## Relationships
${relSection}
`;
          await this.app.vault.modify(file, content);
        }
      }
      notice.setMessage(`Enriched ${count} people pages!`);
      setTimeout(() => notice.hide(), 3e3);
    } catch (e) {
      notice.hide();
      const msg = e instanceof Error ? e.message : String(e);
      new import_obsidian7.Notice(`Enrichment failed: ${msg}`);
    }
  }
  async enrichSinglePerson(name) {
    var _a;
    const engine = new RelationshipEngine(this.app.vault, this.settings.peopleFolder);
    const notice = new import_obsidian7.Notice(`Enriching ${name}...`, 0);
    try {
      const pages = await engine.loadPeoplePages();
      if (!pages[name]) {
        notice.hide();
        new import_obsidian7.Notice(`Person "${name}" not found in people pages.`);
        return;
      }
      const graph = engine.buildGraph(pages, this.contactIndex);
      const relationships = (_a = graph[name]) != null ? _a : [];
      if (!this.settings.anthropicApiKey) {
        notice.hide();
        new import_obsidian7.Notice("Set your API key in plugin settings first.");
        return;
      }
      const harper = new HarperSkill(this.settings.anthropicApiKey, this.settings.harperModel);
      const rewritten = await harper.rewritePersonPage(name, pages[name], relationships, pages);
      const file = this.app.vault.getAbstractFileByPath(pages[name].path);
      if (file instanceof import_obsidian7.TFile) {
        await this.app.vault.modify(file, rewritten);
      }
      notice.setMessage(`Enriched ${name}!`);
      setTimeout(() => notice.hide(), 3e3);
    } catch (e) {
      notice.hide();
      const msg = e instanceof Error ? e.message : String(e);
      new import_obsidian7.Notice(`Enrichment failed: ${msg}`);
    }
  }
  async updateStaleness() {
    var _a;
    const engine = new RelationshipEngine(this.app.vault, this.settings.peopleFolder);
    const fm = new FrontmatterManager(this.app.vault, this.settings.companiesFolder);
    const notice = new import_obsidian7.Notice("Computing staleness scores...", 0);
    try {
      const pages = await engine.loadPeoplePages();
      const count = Object.keys(pages).length;
      const graph = engine.buildGraph(pages, this.contactIndex);
      let done = 0;
      let staleCount = 0;
      for (const [name, page] of Object.entries(pages)) {
        done++;
        const relationships = (_a = graph[name]) != null ? _a : [];
        const staleness = computeStaleness(page, relationships);
        if (staleness.label === "stale" || staleness.label === "dormant") {
          staleCount++;
        }
        const file = this.app.vault.getAbstractFileByPath(page.path);
        if (file instanceof import_obsidian7.TFile) {
          await fm.updateFrontmatter(file, page, staleness, relationships);
        }
        if (done % 20 === 0) {
          notice.setMessage(`Scoring ${done}/${count}...`);
        }
      }
      notice.setMessage(`Scored ${count} contacts \u2014 ${staleCount} going stale`);
      setTimeout(() => notice.hide(), 4e3);
    } catch (e) {
      notice.hide();
      const msg = e instanceof Error ? e.message : String(e);
      new import_obsidian7.Notice(`Staleness update failed: ${msg}`);
    }
  }
  async createBase() {
    try {
      const basePath = await createBaseView(this.app.vault, this.settings.peopleFolder);
      new import_obsidian7.Notice(`CRM Base created at ${basePath}`);
      const file = this.app.vault.getAbstractFileByPath(basePath);
      if (file instanceof import_obsidian7.TFile) {
        await this.app.workspace.getLeaf().openFile(file);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      new import_obsidian7.Notice(`Failed to create Base: ${msg}`);
    }
  }
};
