var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
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

// src/types.ts
var CONTACT_INDEX_SCHEMA_VERSION, DEFAULT_SETTINGS;
var init_types = __esm({
  "src/types.ts"() {
    CONTACT_INDEX_SCHEMA_VERSION = 1;
    DEFAULT_SETTINGS = {
      clientId: "",
      clientSecret: "",
      useCustomOAuth: false,
      accessToken: "",
      refreshToken: "",
      tokenExpiry: 0,
      syncIntervalMinutes: 60,
      maxResults: 500,
      createContactNotes: false,
      contactNotesFolder: "People pages",
      vaultOwnerName: "",
      peopleFolder: "People pages",
      companiesFolder: "Companies",
      anthropicApiKey: "",
      harperModel: "claude-sonnet-4-6",
      enrichOnSync: false,
      blockedDomains: "",
      autoUpdateStaleness: true,
      stalenessUpdateInterval: 0,
      // 0 = only after sync, not on its own timer
      excludeCategories: "promotions,social",
      // skip promo and social by default
      excludeLabels: "",
      // user-configured labels to skip
      betaworksOsUrl: "",
      betaworksPartnerEmail: "",
      betaworksSalienceKey: "",
      autoPushScores: true,
      graphPushUrl: "",
      graphPushToken: "",
      graphPushSalt: ""
      // generated on first push
    };
  }
});

// src/gmail-api.ts
var gmail_api_exports = {};
__export(gmail_api_exports, {
  GmailApi: () => GmailApi,
  SHARED_CLIENT_ID: () => SHARED_CLIENT_ID,
  SHARED_CLIENT_SECRET: () => SHARED_CLIENT_SECRET
});
var import_obsidian, GOOGLE_AUTH_URL, GOOGLE_TOKEN_URL, GMAIL_API_BASE, SCOPES, REDIRECT_URI, SHARED_CLIENT_ID, SHARED_CLIENT_SECRET, RSVP_SUBJECT_PATTERN, AUTOMATED_EMAIL_PATTERN, AUTOMATED_DOMAINS, GmailApi;
var init_gmail_api = __esm({
  "src/gmail-api.ts"() {
    import_obsidian = require("obsidian");
    init_types();
    GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
    GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
    GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
    SCOPES = "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.events.readonly";
    REDIRECT_URI = "http://127.0.0.1:42813/callback";
    SHARED_CLIENT_ID = "726397126192-kuv4nprnrumuekateh37t3abne2r5893.apps.googleusercontent.com";
    SHARED_CLIENT_SECRET = "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";
    RSVP_SUBJECT_PATTERN = /\b(invitation|invited|rsvp|calendar invite|meeting invite|you're invited|save the date|event)\b/i;
    AUTOMATED_EMAIL_PATTERN = /^(noreply|no-reply|donotreply|do-not-reply|notifications?|updates?|support|info|hello|team|news|newsletter|mailer|digest|alerts?|billing|receipts?|feedback|marketing|sales|admin|system|automated|bounce|postmaster|webmaster)@/i;
    AUTOMATED_DOMAINS = /* @__PURE__ */ new Set([
      // Cloud / SaaS
      "dropbox.com",
      "dropboxmail.com",
      "google.com",
      "accounts.google.com",
      "docs.google.com",
      "amazonses.com",
      "amazonaws.com",
      "aws.amazon.com",
      "microsoft.com",
      "sharepointonline.com",
      // Dev tools
      "github.com",
      "gitlab.com",
      "bitbucket.org",
      "vercel.com",
      "netlify.com",
      "heroku.com",
      "circleci.com",
      "travis-ci.com",
      // Newsletters / content
      "substack.com",
      "substackmail.com",
      "readwise.io",
      "medium.com",
      "mailchimp.com",
      "sendgrid.net",
      "sendgrid.com",
      "mailgun.org",
      "mandrillapp.com",
      "constantcontact.com",
      "hubspot.com",
      "hubspotmail.com",
      // Productivity / signing
      "dropboxsign.com",
      "hellosign.com",
      "docusign.net",
      "docusign.com",
      "pandadoc.com",
      "adobesign.com",
      // Social
      "facebookmail.com",
      "linkedin.com",
      "twitter.com",
      "x.com",
      "instagrammail.com",
      "tiktok.com",
      // Payments / commerce
      "paypal.com",
      "stripe.com",
      "squareup.com",
      "shopify.com",
      "intuit.com",
      "quickbooks.intuit.com",
      // Scheduling / calendar
      "calendly.com",
      "savvycal.com",
      "cal.com",
      // Project management
      "notion.so",
      "asana.com",
      "trello.com",
      "monday.com",
      "clickup.com",
      "jira.atlassian.com",
      "atlassian.com",
      "atlassian.net",
      // Design
      "figma.com",
      "canva.com",
      // Other common services
      "zoom.us",
      "loom.com",
      "slack.com",
      "slackbot.com",
      "intercom.io",
      "intercom-mail.com",
      "zendesk.com",
      "eventbrite.com",
      "meetup.com"
    ]);
    GmailApi = class {
      // lock to prevent parallel refreshes
      constructor(settings, onSettingsUpdate) {
        this.refreshPromise = null;
        this.settings = settings;
        this.onSettingsUpdate = onSettingsUpdate;
      }
      updateSettings(settings) {
        this.settings = settings;
      }
      effectiveClientId() {
        if (this.settings.useCustomOAuth && this.settings.clientId) {
          return this.settings.clientId;
        }
        return SHARED_CLIENT_ID;
      }
      effectiveClientSecret() {
        if (this.settings.useCustomOAuth && this.settings.clientSecret) {
          return this.settings.clientSecret;
        }
        return SHARED_CLIENT_SECRET;
      }
      getAuthUrl() {
        const params = new URLSearchParams({
          client_id: this.effectiveClientId(),
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
        const resp = await this.apiRequest({
          url: GOOGLE_TOKEN_URL,
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            code,
            client_id: this.effectiveClientId(),
            client_secret: this.effectiveClientSecret(),
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
        const resp = await this.apiRequest({
          url: GOOGLE_TOKEN_URL,
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: this.effectiveClientId(),
            client_secret: this.effectiveClientSecret(),
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async apiRequest(options, retries = 5) {
        var _a, _b, _c, _d, _e, _f, _g, _h, _i;
        const url = typeof options === "string" ? options : options.url;
        const reqOptions = typeof options === "string" ? { url: options, throw: false } : { ...options, throw: false };
        let resp;
        try {
          resp = await (0, import_obsidian.requestUrl)(reqOptions);
        } catch (e) {
          const err = e;
          console.error(`[Gmail CRM] Network error`, { url, error: err });
          throw new Error((_a = err == null ? void 0 : err.message) != null ? _a : "Network request failed");
        }
        if (resp.status >= 200 && resp.status < 300) {
          return resp;
        }
        const isRateLimit = resp.status === 429 || resp.status === 403 && ((_b = resp.text) != null ? _b : "").includes("rateLimitExceeded");
        if (isRateLimit && retries > 0) {
          const attempt = 6 - retries;
          const backoff = Math.min(attempt * 15e3, 6e4);
          console.warn(`[Gmail CRM] Rate limited, retrying in ${backoff / 1e3}s (${retries} retries left)`);
          await this.sleep(backoff);
          return this.apiRequest(options, retries - 1);
        }
        if (resp.status === 401 && retries > 0) {
          console.warn(`[Gmail CRM] Token expired, refreshing and retrying...`);
          try {
            if (!this.refreshPromise) {
              this.refreshPromise = this.refreshAccessToken().finally(() => {
                this.refreshPromise = null;
              });
            }
            await this.refreshPromise;
            if (typeof options !== "string" && options.headers) {
              options.headers["Authorization"] = `Bearer ${this.settings.accessToken}`;
            }
            return this.apiRequest(options, retries - 1);
          } catch (refreshErr) {
            console.error(`[Gmail CRM] Token refresh failed`, refreshErr);
          }
        }
        if ((resp.status === 500 || resp.status === 503) && retries > 0) {
          const backoff = Math.min((6 - retries) * 5e3, 3e4);
          console.warn(`[Gmail CRM] Server error ${resp.status}, retrying in ${backoff / 1e3}s (${retries} retries left)`);
          await this.sleep(backoff);
          return this.apiRequest(options, retries - 1);
        }
        const status = resp.status;
        const rawBody = (_c = resp.text) != null ? _c : "";
        console.error(`[Gmail CRM] API request failed`, {
          url,
          status,
          body: rawBody,
          headers: resp.headers
        });
        let detail = "";
        if (rawBody) {
          try {
            const parsed = JSON.parse(rawBody);
            detail = (_h = (_g = (_e = (_d = parsed == null ? void 0 : parsed.error) == null ? void 0 : _d.message) != null ? _e : parsed == null ? void 0 : parsed.error_description) != null ? _g : (_f = parsed == null ? void 0 : parsed.error) == null ? void 0 : _f.status) != null ? _h : JSON.stringify(parsed).slice(0, 300);
          } catch (e) {
            detail = rawBody.slice(0, 300);
          }
        }
        if (!detail) {
          const hints = {
            401: "Token expired or invalid. Try disconnecting and reconnecting.",
            403: "Access denied. Check that: (1) Gmail API is enabled in Google Cloud Console, (2) your OAuth consent screen has your email as a test user, (3) the gmail.metadata scope is approved.",
            404: "Endpoint not found. The Gmail API may not be enabled.",
            429: "Rate limited by Google. Wait a few minutes and try again."
          };
          detail = (_i = hints[status]) != null ? _i : `HTTP ${status}`;
        }
        throw new Error(`HTTP ${status}: ${detail}`);
      }
      sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
      }
      async getHeaders() {
        if (Date.now() >= this.settings.tokenExpiry - 6e4) {
          if (!this.refreshPromise) {
            this.refreshPromise = this.refreshAccessToken().finally(() => {
              this.refreshPromise = null;
            });
          }
          await this.refreshPromise;
        }
        return { Authorization: `Bearer ${this.settings.accessToken}` };
      }
      async getUserEmail() {
        const headers = await this.getHeaders();
        const resp = await this.apiRequest({
          url: `${GMAIL_API_BASE}/profile`,
          headers
        });
        return resp.json.emailAddress;
      }
      async fetchAllMessageIds(maxResults, afterDate) {
        var _a, _b;
        const headers = await this.getHeaders();
        const allMessages = [];
        let pageToken;
        const unlimited = maxResults <= 0;
        if (afterDate) {
          console.info(
            "[Gmail CRM] Incremental sync uses local message-cache filtering because gmail.metadata does not support server-side q=after filters.",
            { afterDate }
          );
        }
        while (unlimited || allMessages.length < maxResults) {
          const remaining = unlimited ? 100 : maxResults - allMessages.length;
          const params = new URLSearchParams({
            maxResults: String(Math.min(100, remaining))
          });
          if (pageToken) params.set("pageToken", pageToken);
          const excludes = [];
          const cats = ((_a = this.settings.excludeCategories) != null ? _a : "").split(",").map((c) => c.trim().toLowerCase()).filter(Boolean);
          for (const cat of cats) {
            excludes.push(`-category:${cat}`);
          }
          const labels = ((_b = this.settings.excludeLabels) != null ? _b : "").split(",").map((l) => l.trim()).filter(Boolean);
          for (const label of labels) {
            excludes.push(`-label:${label}`);
          }
          for (const domain of this.blockedDomains) {
            excludes.push(`-from:${domain}`);
          }
          const q = excludes.join(" ");
          if (q) params.set("q", q);
          const resp = await this.apiRequest({
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
        const resp = await this.apiRequest({
          url: `${GMAIL_API_BASE}/messages/${messageId}?format=METADATA&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`,
          headers
        });
        return resp.json;
      }
      async buildContactIndex(maxResults, onProgress, existingIndex, messageCache, onCheckpoint) {
        var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j;
        const userEmail = await this.getUserEmail();
        const afterDate = (_a = messageCache == null ? void 0 : messageCache.lastSync) != null ? _a : void 0;
        const cachedIds = new Set((_b = messageCache == null ? void 0 : messageCache.processedIds) != null ? _b : []);
        const allMessageIds = await this.fetchAllMessageIds(maxResults, afterDate);
        const newMessageIds = allMessageIds.filter((m) => !cachedIds.has(m.id));
        const contacts = existingIndex ? JSON.parse(JSON.stringify(existingIndex.contacts)) : {};
        const edges = (_c = existingIndex == null ? void 0 : existingIndex.edges) != null ? _c : [];
        const threadStates = /* @__PURE__ */ new Map();
        if (existingIndex && newMessageIds.length > 0) {
          for (const [key, c] of Object.entries(contacts)) {
            threadStates.set(key, /* @__PURE__ */ new Map());
          }
        }
        const BATCH_SIZE = 10;
        const BATCH_DELAY_MS = 100;
        const CHECKPOINT_INTERVAL = 2e3;
        const processedIds = new Set((_d = messageCache == null ? void 0 : messageCache.processedIds) != null ? _d : []);
        let lastCheckpoint = 0;
        for (let i = 0; i < newMessageIds.length; i += BATCH_SIZE) {
          const batch = newMessageIds.slice(i, i + BATCH_SIZE);
          const results = await Promise.all(
            batch.map((m) => this.fetchMessageMetadata(m.id))
          );
          for (const msg of results) {
            this.processMessage(msg, userEmail, contacts, threadStates);
          }
          for (const m of batch) processedIds.add(m.id);
          const done = Math.min(i + BATCH_SIZE, newMessageIds.length);
          onProgress == null ? void 0 : onProgress(done, newMessageIds.length);
          if (onCheckpoint && done - lastCheckpoint >= CHECKPOINT_INTERVAL) {
            lastCheckpoint = done;
            this.finalizeContactMetrics(contacts, threadStates);
            const checkpointIndex = {
              schemaVersion: 1,
              lastSync: (/* @__PURE__ */ new Date()).toISOString(),
              userEmail,
              contacts,
              edges: (_e = existingIndex == null ? void 0 : existingIndex.edges) != null ? _e : []
            };
            const checkpointCache = {
              lastSync: (/* @__PURE__ */ new Date()).toISOString(),
              processedIds: [...processedIds]
            };
            await onCheckpoint(checkpointIndex, checkpointCache);
          }
          if (i + BATCH_SIZE < newMessageIds.length) {
            await this.sleep(BATCH_DELAY_MS);
          }
        }
        if (newMessageIds.length > 0) {
          this.finalizeContactMetrics(contacts, threadStates);
        }
        console.log(`[Gmail CRM] Sync complete`, {
          mode: afterDate ? "incremental" : "full",
          afterDate: afterDate != null ? afterDate : "n/a",
          totalListed: allMessageIds.length,
          alreadyCached: allMessageIds.length - newMessageIds.length,
          newProcessed: newMessageIds.length,
          totalContacts: Object.keys(contacts).length
        });
        const sorted = Object.values(contacts).sort((a, b) => b.totalExchanges - a.totalExchanges);
        for (const c of sorted.slice(0, 20)) {
          console.log(`[Gmail CRM] Contact: ${c.name} <${c.email}>`, {
            exchanges: c.totalExchanges,
            sent: c.sentCount,
            received: c.receivedCount,
            threads: (_f = c.threadCount) != null ? _f : 0,
            backAndForth: (_g = c.backAndForthThreads) != null ? _g : 0,
            maxDepth: (_h = c.maxThreadDepth) != null ? _h : 0,
            lastDepth: (_i = c.lastThreadDepth) != null ? _i : 0,
            rsvpOnly: (_j = c.rsvpOnlyThreads) != null ? _j : 0,
            firstContact: c.firstContact,
            lastContact: c.lastContact,
            domain: c.domain
          });
        }
        for (const m of allMessageIds) {
          cachedIds.add(m.id);
        }
        const updatedCache = {
          processedIds: Array.from(cachedIds),
          lastSync: (/* @__PURE__ */ new Date()).toISOString()
        };
        return {
          index: {
            schemaVersion: CONTACT_INDEX_SCHEMA_VERSION,
            lastSync: (/* @__PURE__ */ new Date()).toISOString(),
            userEmail,
            contacts,
            edges
          },
          cache: updatedCache
        };
      }
      processMessage(msg, userEmail, contacts, threadStates) {
        var _a;
        const headers = msg.payload.headers;
        const from = this.getHeader(headers, "From");
        const to = this.getHeader(headers, "To");
        const subject = (_a = this.getHeader(headers, "Subject")) != null ? _a : "";
        const date = new Date(parseInt(msg.internalDate)).toISOString();
        const threadId = msg.threadId;
        const fromParsed = this.parseEmailAddress(from != null ? from : "");
        const toParsed = this.parseEmailAddress(to != null ? to : "");
        if (!fromParsed) return;
        const isSent = fromParsed.email.toLowerCase() === userEmail.toLowerCase();
        if (isSent && toParsed) {
          if (this.isFiltered(toParsed.email)) {
            console.debug(`[Gmail CRM] Filtered out: ${toParsed.email}`);
            return;
          }
          this.upsertContact(contacts, threadStates, toParsed, date, subject, threadId, "sent");
        } else if (!isSent) {
          if (this.isFiltered(fromParsed.email)) {
            console.debug(`[Gmail CRM] Filtered out: ${fromParsed.email}`);
            return;
          }
          this.upsertContact(contacts, threadStates, fromParsed, date, subject, threadId, "received");
        }
      }
      isFiltered(email) {
        var _a;
        const lower = email.toLowerCase();
        const domain = (_a = lower.split("@")[1]) != null ? _a : "";
        if (AUTOMATED_EMAIL_PATTERN.test(lower)) return true;
        if (AUTOMATED_DOMAINS.has(domain)) return true;
        if (this.blockedDomains.has(domain)) return true;
        return false;
      }
      get blockedDomains() {
        var _a;
        const raw = (_a = this.settings.blockedDomains) != null ? _a : "";
        return new Set(
          raw.split(",").map((d) => d.trim().toLowerCase()).filter(Boolean)
        );
      }
      upsertContact(contacts, threadStates, parsed, date, subject, threadId, direction) {
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
        if (subject && c.subjects.length < 10) {
          c.subjects.push(subject);
        }
        let contactThreads = threadStates.get(key);
        if (!contactThreads) {
          contactThreads = /* @__PURE__ */ new Map();
          threadStates.set(key, contactThreads);
        }
        let thread = contactThreads.get(threadId);
        if (!thread) {
          thread = { sent: 0, received: 0, subject, lastDate: date };
          contactThreads.set(threadId, thread);
        }
        if (direction === "sent") thread.sent++;
        else thread.received++;
        if (date > thread.lastDate) {
          thread.lastDate = date;
          if (subject) thread.subject = subject;
        }
      }
      // Finalize metadata pattern signals (thread count, back-and-forth, RSVP-only)
      // into the persisted Contact records. See task #4 — metadata heuristics per
      // John Borthwick's feedback: focus on patterns, not email content.
      finalizeContactMetrics(contacts, threadStates) {
        for (const [key, threads] of threadStates) {
          const contact = contacts[key];
          if (!contact) continue;
          let maxDepth = 0;
          let backAndForth = 0;
          let rsvpOnly = 0;
          let lastThreadDepth = 0;
          let latestDate = "";
          for (const state of threads.values()) {
            const depth = state.sent + state.received;
            if (depth > maxDepth) maxDepth = depth;
            if (state.sent > 0 && state.received > 0 && depth >= 3) {
              backAndForth++;
            }
            if (depth === 1 && RSVP_SUBJECT_PATTERN.test(state.subject)) {
              rsvpOnly++;
            }
            if (state.lastDate > latestDate) {
              latestDate = state.lastDate;
              lastThreadDepth = depth;
            }
          }
          contact.threadCount = threads.size;
          contact.maxThreadDepth = maxDepth;
          contact.backAndForthThreads = backAndForth;
          contact.rsvpOnlyThreads = rsvpOnly;
          contact.lastThreadDepth = lastThreadDepth;
        }
      }
      getHeader(headers, name) {
        var _a;
        return (_a = headers.find((h) => h.name.toLowerCase() === name.toLowerCase())) == null ? void 0 : _a.value;
      }
      parseEmailAddress(raw) {
        var _a;
        const trimmed = raw.trim();
        const bareEmail = trimmed.match(/^([^@\s<>"]+@[^@\s<>"]+)$/);
        if (bareEmail) {
          return {
            name: "",
            email: bareEmail[1].trim()
          };
        }
        const angleMatch = trimmed.match(/^(?:"?([^"<]*)"?\s*)<([^<>\s]+@[^<>\s]+)>$/);
        const match = angleMatch != null ? angleMatch : trimmed.match(/^"?([^"<]*)"?\s+([^@\s<>"]+@[^@\s<>"]+)$/);
        if (!match) return null;
        return {
          name: ((_a = match[1]) != null ? _a : "").trim(),
          email: match[2].trim()
        };
      }
    };
  }
});

// src/main.ts
var main_exports = {};
__export(main_exports, {
  default: () => GmailCrmPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian11 = require("obsidian");
init_gmail_api();

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
    const isAuthenticated = !!this.plugin.settings.refreshToken;
    if (!isAuthenticated) {
      containerEl.createEl("p", {
        text: "Connect your Google account to start syncing Gmail contacts.",
        cls: "setting-item-description"
      });
    }
    new import_obsidian2.Setting(containerEl).setName("Connection status").setDesc(isAuthenticated ? "Connected" : "Not connected").addButton(
      (btn) => btn.setButtonText(isAuthenticated ? "Reconnect" : "Connect with Google").setCta().onClick(async () => {
        const clientId = this.plugin.getEffectiveClientId();
        const clientSecret = this.plugin.getEffectiveClientSecret();
        if (!clientId || !clientSecret) {
          new import_obsidian2.Notice("Please enter client ID and client secret in advanced OAuth settings, or wait for shared credentials to be configured.");
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
    new import_obsidian2.Setting(containerEl).setName("Use custom OAuth credentials").setDesc("For advanced users who want to use their own Google Cloud project instead of the shared credentials").addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.useCustomOAuth).onChange(async (value) => {
        this.plugin.settings.useCustomOAuth = value;
        await this.plugin.saveSettings();
        this.display();
      })
    );
    if (this.plugin.settings.useCustomOAuth) {
      new import_obsidian2.Setting(containerEl).setName("Client ID").setDesc("From your Google Cloud Console API credentials").addText(
        (text) => text.setPlaceholder("Your client ID").setValue(this.plugin.settings.clientId).onChange(async (value) => {
          this.plugin.settings.clientId = value;
          await this.plugin.saveSettings();
        })
      );
      new import_obsidian2.Setting(containerEl).setName("Client secret").setDesc("From your Google Cloud Console API credentials").addText((text) => {
        text.setPlaceholder("Your client secret").setValue(this.plugin.settings.clientSecret).onChange(async (value) => {
          this.plugin.settings.clientSecret = value;
          await this.plugin.saveSettings();
        });
        text.inputEl.type = "password";
      });
    }
    new import_obsidian2.Setting(containerEl).setName("Filtering").setHeading();
    new import_obsidian2.Setting(containerEl).setName("Blocked domains").setDesc("Comma-separated domains to exclude (e.g. substack.com, readwise.io). Common services like noreply senders are auto-filtered.").addTextArea(
      (text) => text.setPlaceholder("substack.com, readwise.io, beehiiv.com").setValue(this.plugin.settings.blockedDomains).onChange(async (value) => {
        this.plugin.settings.blockedDomains = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian2.Setting(containerEl).setName("Exclude Gmail categories").setDesc("Comma-separated Gmail categories to skip during sync. Options: promotions, social, updates, forums. Leave empty to sync all.").addText(
      (text) => text.setPlaceholder("promotions, social").setValue(this.plugin.settings.excludeCategories).onChange(async (value) => {
        this.plugin.settings.excludeCategories = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian2.Setting(containerEl).setName("Exclude Gmail labels").setDesc("Comma-separated Gmail labels to skip during sync (e.g. shop@, service@). These are custom labels in your Gmail.").addText(
      (text) => text.setPlaceholder("shop@, service@").setValue(this.plugin.settings.excludeLabels).onChange(async (value) => {
        this.plugin.settings.excludeLabels = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian2.Setting(containerEl).setName("Sync").setHeading();
    new import_obsidian2.Setting(containerEl).setName("Sync interval").setDesc("How often to re-sync metadata (minutes)").addSlider(
      (slider) => slider.setLimits(15, 480, 15).setValue(this.plugin.settings.syncIntervalMinutes).setDynamicTooltip().onChange(async (value) => {
        this.plugin.settings.syncIntervalMinutes = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian2.Setting(containerEl).setName("Max messages to scan").setDesc('Number of recent messages to pull metadata from. "All" pulls your entire mailbox \u2014 slow on first run, but incremental syncs after that only fetch new messages.').addDropdown((dd) => {
      for (const n of [100, 250, 500, 1e3, 2e3, 5e3, 1e4, 25e3, 5e4]) {
        dd.addOption(String(n), String(n));
      }
      dd.addOption("0", "All messages");
      dd.setValue(String(this.plugin.settings.maxResults));
      dd.onChange(async (value) => {
        this.plugin.settings.maxResults = parseInt(value);
        await this.plugin.saveSettings();
      });
    });
    new import_obsidian2.Setting(containerEl).setName("Sync now").setDesc("Incremental sync \u2014 only fetches new messages since last sync").addButton(
      (btn) => btn.setButtonText("Sync").setCta().onClick(async () => {
        await this.plugin.syncContacts();
      })
    );
    new import_obsidian2.Setting(containerEl).setName("Full re-sync").setDesc("Clear local cache and re-fetch all messages from Gmail").addButton(
      (btn) => btn.setButtonText("Full re-sync").setWarning().onClick(async () => {
        await this.plugin.fullResync();
      })
    );
    new import_obsidian2.Setting(containerEl).setName("betaworks os").setHeading();
    new import_obsidian2.Setting(containerEl).setName("betaworks os URL").setDesc("Deployment to push relationship scores to. Empty disables pushing.").addText(
      (text) => text.setValue(this.plugin.settings.betaworksOsUrl).onChange(async (value) => {
        this.plugin.settings.betaworksOsUrl = value.trim();
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian2.Setting(containerEl).setName("Partner email").setDesc("Your betaworks identity, e.g. john@betaworks.com.").addText(
      (text) => text.setValue(this.plugin.settings.betaworksPartnerEmail).onChange(async (value) => {
        this.plugin.settings.betaworksPartnerEmail = value.trim();
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian2.Setting(containerEl).setName("Salience API key").setDesc("Authenticates the push (same key you use in betaworks os).").addText((text) => {
      text.inputEl.type = "password";
      text.setValue(this.plugin.settings.betaworksSalienceKey).onChange(async (value) => {
        this.plugin.settings.betaworksSalienceKey = value.trim();
        await this.plugin.saveSettings();
      });
    });
    new import_obsidian2.Setting(containerEl).setName("Auto-push after scoring").setDesc("Push scores to betaworks os whenever staleness scores update.").addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.autoPushScores).onChange(async (value) => {
        this.plugin.settings.autoPushScores = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian2.Setting(containerEl).setName("People graph web view").setHeading();
    new import_obsidian2.Setting(containerEl).setName("Graph URL").setDesc("Deployment to push your people graph to. Empty disables pushing.").addText(
      (text) => text.setValue(this.plugin.settings.graphPushUrl).onChange(async (value) => {
        this.plugin.settings.graphPushUrl = value.trim();
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian2.Setting(containerEl).setName("Graph push token").setDesc("Mint it on the graph page after signing in \u2014 pushes are tied to your account.").addText((text) => {
      text.inputEl.type = "password";
      text.setValue(this.plugin.settings.graphPushToken).onChange(async (value) => {
        this.plugin.settings.graphPushToken = value.trim();
        await this.plugin.saveSettings();
      });
    });
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
    new import_obsidian2.Setting(containerEl).setName("Your name").setDesc("How you should be referred to on enriched people pages (e.g., 'How Alex knows them'). Leave blank to use 'the vault owner'.").addText(
      (text) => text.setPlaceholder("Your full name").setValue(this.plugin.settings.vaultOwnerName).onChange(async (value) => {
        this.plugin.settings.vaultOwnerName = value;
        await this.plugin.saveSettings();
      })
    );
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
    new import_obsidian2.Setting(containerEl).setName("Auto-update staleness after sync").setDesc("Automatically recompute scores and update people pages after each Gmail sync").addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.autoUpdateStaleness).onChange(async (value) => {
        this.plugin.settings.autoUpdateStaleness = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian2.Setting(containerEl).setName("Staleness update schedule").setDesc("Run staleness updates on a timer (in addition to after-sync). Set to 0 to only update after syncs.").addDropdown(
      (drop) => drop.addOption("0", "Only after sync").addOption("6", "Every 6 hours").addOption("12", "Every 12 hours").addOption("24", "Every day").addOption("48", "Every 2 days").addOption("168", "Every week").setValue(String(this.plugin.settings.stalenessUpdateInterval)).onChange(async (value) => {
        this.plugin.settings.stalenessUpdateInterval = parseInt(value);
        await this.plugin.saveSettings();
        this.plugin.resetStalenessTimer();
      })
    );
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
    new import_obsidian2.Setting(containerEl).setName("Create quadrant view").setDesc("Generate a 2\xD72 quadrant map (Quadrants.md) showing all contacts grouped by nurture / re-engage / developing / deprioritize").addButton(
      (btn) => btn.setButtonText("Create quadrants").setCta().onClick(async () => {
        await this.plugin.createQuadrantView();
      })
    );
  }
};

// src/oauth-server.ts
var import_http = __toESM(require("http"));
var PORT = 42813;
var HOST = "127.0.0.1";
function startOAuthCallbackServer() {
  return new Promise((resolve, reject) => {
    let settled = false;
    const server = import_http.default.createServer((req, res) => {
      var _a;
      const url = new URL((_a = req.url) != null ? _a : "/", `http://${HOST}:${PORT}`);
      if (url.pathname === "/callback") {
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");
        res.writeHead(200, { "Content-Type": "text/html" });
        if (code) {
          res.end(
            "<html><body><h2>Gmail CRM connected!</h2><p>You can close this tab and return to Obsidian.</p></body></html>"
          );
          settled = true;
          server.close();
          resolve(code);
        } else {
          res.end(
            `<html><body><h2>Authorization failed</h2><p>${error != null ? error : "Unknown error"}</p></body></html>`
          );
          settled = true;
          server.close();
          reject(new Error(error != null ? error : "OAuth callback error"));
        }
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    server.once("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    server.listen(PORT, HOST);
    setTimeout(() => {
      if (!settled) {
        settled = true;
        server.close();
        reject(new Error("OAuth callback timed out"));
      }
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
      if (child.basename === "_Quadrants" || child.basename === "Quadrants") continue;
      const content = await this.vault.read(child);
      const name = child.basename.replace(/^p-\s*/, "");
      const wikiLinks = [];
      const linkRegex = /\[\[p-\s*([^\]|]+?)(?:\|[^\]]*?)?\]\]/g;
      let match;
      while ((match = linkRegex.exec(content)) !== null) {
        wikiLinks.push(match[1].trim());
      }
      const emailMatch = content.match(/\*\*Email:\*\*\s*(.+)/);
      const emails = [];
      const addEmail = (value) => {
        const cleaned = value.replace(/[<>]/g, "").replace(/^["']|["']$/g, "").trim().toLowerCase();
        if (cleaned.includes("@") && !emails.includes(cleaned)) emails.push(cleaned);
      };
      if (emailMatch) {
        const raw = emailMatch[1].trim();
        for (const token of raw.split(/[,\s|]+/)) {
          addEmail(token);
        }
      }
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (fmMatch) {
        for (const field of ["emails", "aliases"]) {
          const yamlList = fmMatch[1].match(new RegExp(`${field}:\\s*\\n((?:\\s+-\\s+\\S+@\\S+\\n?)+)`));
          if (yamlList) {
            for (const line of yamlList[1].split("\n")) {
              addEmail(line.replace(/^\s*-\s*/, ""));
            }
          }
        }
        const yamlEmailScalar = fmMatch[1].match(/^email:\s*(.+?)\s*$/m);
        if (yamlEmailScalar) {
          addEmail(yamlEmailScalar[1]);
        }
      }
      const roleMatch = content.match(/\*\*Role\/Company:\*\*\s*(.+)/);
      const introMatch = content.match(
        /(?:introduced by|via|through)\s+(?:\[\[p-\s*)?([A-Z][a-z]+ [A-Z][a-z]+)/i
      );
      const meetings = [];
      const meetingRegex = /###\s+(\d{4}-\d{2}-\d{2})\s*[—–-]\s*(.+)/g;
      while ((match = meetingRegex.exec(content)) !== null) {
        meetings.push({ date: match[1], title: match[2].trim() });
      }
      const howMatch = content.match(/\*\*How .+? knows them:\*\*\s*(.+)/);
      const ctxMatch = content.match(/\*\*Key context:\*\*\s*(.+)/);
      pages[name] = {
        name,
        path: child.path,
        content,
        wikiLinks,
        email: emails.length > 0 ? emails[0] : null,
        emails,
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
    var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k, _l, _m, _n, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x;
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
        for (const em of page.emails) {
          emailToName[em] = name;
        }
        if (page.emails.length === 0 && page.email) {
          emailToName[page.email.toLowerCase()] = name;
        }
      }
      const nameToPage = {};
      const lastNameToPage = {};
      for (const name of Object.keys(pages)) {
        const normalized = this.normalizeName(name);
        nameToPage[normalized] = name;
        const parts = normalized.split(/\s+/);
        if (parts.length >= 2) {
          const last = parts[parts.length - 1];
          ((_a = lastNameToPage[last]) != null ? _a : lastNameToPage[last] = []).push(name);
        }
      }
      let matched = 0;
      let attempted = 0;
      const unmatchedSamples = [];
      for (const [email, contact] of Object.entries(contactIndex.contacts)) {
        attempted++;
        let pageName = emailToName[email];
        if (!pageName && contact.name) {
          pageName = nameToPage[this.normalizeName(contact.name)];
        }
        if (!pageName && contact.name) {
          const parts = this.normalizeName(contact.name).split(/\s+/);
          if (parts.length >= 2) {
            const last = parts[parts.length - 1];
            const candidates = lastNameToPage[last];
            if (candidates && candidates.length === 1) {
              pageName = candidates[0];
            }
          }
        }
        if (!pageName) {
          const local = (_b = email.split("@")[0]) == null ? void 0 : _b.replace(/[._-]+/g, " ").trim();
          if (local) {
            const candidate = nameToPage[this.normalizeName(local)];
            if (candidate) pageName = candidate;
          }
        }
        if (!pageName || !pages[pageName]) {
          if (unmatchedSamples.length < 5) {
            unmatchedSamples.push(`${contact.name || "(no name)"} <${email}>`);
          }
          continue;
        }
        matched++;
        const profileEmail = this.contactEmail(email, contact);
        const preferredProfileSource = this.isPreferredProfileContact(pages[pageName], email, contact);
        if (!pages[pageName].emails.includes(profileEmail)) {
          pages[pageName].emails.push(profileEmail);
        }
        if (!pages[pageName].email || preferredProfileSource) {
          pages[pageName].email = profileEmail;
        }
        const existing = pages[pageName].gmailStats;
        if (existing) {
          existing.totalExchanges += contact.totalExchanges;
          existing.sentCount += contact.sentCount;
          existing.receivedCount += contact.receivedCount;
          if (contact.lastContact > existing.lastContact) {
            existing.lastContact = contact.lastContact;
            if (contact.lastSubject) existing.lastSubject = contact.lastSubject;
          }
          if (contact.firstContact && (!existing.firstContact || contact.firstContact < existing.firstContact)) {
            existing.firstContact = contact.firstContact;
          }
          for (const s of (_c = contact.subjects) != null ? _c : []) {
            if (existing.subjects.length < 10 && !existing.subjects.includes(s)) {
              existing.subjects.push(s);
            }
          }
          existing.threadCount = ((_d = existing.threadCount) != null ? _d : 0) + ((_e = contact.threadCount) != null ? _e : 0);
          existing.maxThreadDepth = Math.max((_f = existing.maxThreadDepth) != null ? _f : 0, (_g = contact.maxThreadDepth) != null ? _g : 0);
          existing.backAndForthThreads = ((_h = existing.backAndForthThreads) != null ? _h : 0) + ((_i = contact.backAndForthThreads) != null ? _i : 0);
          existing.rsvpOnlyThreads = ((_j = existing.rsvpOnlyThreads) != null ? _j : 0) + ((_k = contact.rsvpOnlyThreads) != null ? _k : 0);
          if (contact.lastThreadDepth !== void 0) {
            existing.lastThreadDepth = Math.max((_l = existing.lastThreadDepth) != null ? _l : 0, contact.lastThreadDepth);
          }
          existing.calendarMeetings = ((_m = existing.calendarMeetings) != null ? _m : 0) + ((_n = contact.calendarMeetings) != null ? _n : 0);
          existing.calendarAccepted = ((_o = existing.calendarAccepted) != null ? _o : 0) + ((_p = contact.calendarAccepted) != null ? _p : 0);
          existing.calendarOrganizedByThem = ((_q = existing.calendarOrganizedByThem) != null ? _q : 0) + ((_r = contact.calendarOrganizedByThem) != null ? _r : 0);
          existing.calendarMeetingsLast90d = ((_s = existing.calendarMeetingsLast90d) != null ? _s : 0) + ((_t = contact.calendarMeetingsLast90d) != null ? _t : 0);
          if (contact.calendarLastMeeting && (!existing.calendarLastMeeting || contact.calendarLastMeeting > existing.calendarLastMeeting)) {
            existing.calendarLastMeeting = contact.calendarLastMeeting;
          }
          if (preferredProfileSource && !existing.profileSourcePreferred) {
            existing.domain = (_u = contact.domain) != null ? _u : existing.domain;
            existing.profileEmail = profileEmail;
            existing.profileSourcePreferred = true;
          } else if (!existing.domain && contact.domain) {
            existing.domain = contact.domain;
            existing.profileEmail = profileEmail;
          }
        } else {
          pages[pageName].gmailStats = {
            totalExchanges: contact.totalExchanges,
            sentCount: contact.sentCount,
            receivedCount: contact.receivedCount,
            lastContact: contact.lastContact,
            firstContact: contact.firstContact,
            subjects: (_v = contact.subjects) != null ? _v : [],
            lastSubject: (_w = contact.lastSubject) != null ? _w : "",
            domain: (_x = contact.domain) != null ? _x : "",
            threadCount: contact.threadCount,
            maxThreadDepth: contact.maxThreadDepth,
            backAndForthThreads: contact.backAndForthThreads,
            rsvpOnlyThreads: contact.rsvpOnlyThreads,
            lastThreadDepth: contact.lastThreadDepth,
            profileEmail,
            profileSourcePreferred: preferredProfileSource,
            calendarMeetings: contact.calendarMeetings,
            calendarAccepted: contact.calendarAccepted,
            calendarLastMeeting: contact.calendarLastMeeting,
            calendarOrganizedByThem: contact.calendarOrganizedByThem,
            calendarMeetingsLast90d: contact.calendarMeetingsLast90d,
            openCount: contact.openCount,
            lastOpenAt: contact.lastOpenAt,
            openEngagement: contact.openEngagement
          };
        }
      }
      console.log(`[Gmail CRM] Page-to-contact match: ${matched}/${attempted}`, {
        totalPages: Object.keys(pages).length,
        unmatchedSample: unmatchedSamples
      });
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
  contactEmail(key, contact) {
    return (contact.email || key).trim().toLowerCase();
  }
  isPreferredProfileContact(page, key, contact) {
    var _a, _b;
    const email = this.contactEmail(key, contact);
    const pageEmail = (_a = page.email) == null ? void 0 : _a.trim().toLowerCase();
    if (pageEmail && email === pageEmail) return true;
    const canonicalEmail = (_b = contact.canonicalId) == null ? void 0 : _b.trim().toLowerCase().replace(/^local:/, "");
    return !!canonicalEmail && email === canonicalEmail;
  }
  /**
   * Normalize a name for fuzzy matching: lowercased, common nicknames mapped,
   * so "Jonathan Chin" and "Jon Chin" produce the same key.
   */
  normalizeName(name) {
    var _a;
    const NICKNAMES = {
      jon: "jonathan",
      john: "jonathan",
      johnny: "jonathan",
      mike: "michael",
      mikey: "michael",
      rob: "robert",
      bob: "robert",
      bobby: "robert",
      will: "william",
      bill: "william",
      billy: "william",
      dan: "daniel",
      danny: "daniel",
      dave: "david",
      chris: "christopher",
      matt: "matthew",
      tom: "thomas",
      tommy: "thomas",
      jim: "james",
      jimmy: "james",
      jamie: "james",
      joe: "joseph",
      joey: "joseph",
      ben: "benjamin",
      benny: "benjamin",
      sam: "samuel",
      sammy: "samuel",
      alex: "alexander",
      nick: "nicholas",
      rick: "richard",
      dick: "richard",
      rich: "richard",
      steve: "steven",
      stephen: "steven",
      ed: "edward",
      eddie: "edward",
      tony: "anthony",
      charlie: "charles",
      chuck: "charles",
      pat: "patrick",
      greg: "gregory",
      jeff: "jeffrey",
      kate: "katherine",
      kathy: "katherine",
      kat: "katherine",
      liz: "elizabeth",
      beth: "elizabeth",
      betty: "elizabeth",
      jen: "jennifer",
      jenny: "jennifer",
      meg: "margaret",
      maggie: "margaret",
      peggy: "margaret",
      sue: "susan",
      susie: "susan"
    };
    const parts = name.toLowerCase().trim().split(/\s+/);
    if (parts.length > 0) {
      parts[0] = (_a = NICKNAMES[parts[0]]) != null ? _a : parts[0];
    }
    return parts.join(" ");
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
  constructor(apiKey, model, ownerName) {
    this.apiKey = apiKey;
    this.model = model;
    this.ownerName = ownerName;
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
    const owner = this.ownerName.trim() || "the vault owner";
    const ownerPossessive = this.ownerName.trim() ? `${this.ownerName.trim()}'s` : "the vault owner's";
    const ownerPossessiveUpper = ownerPossessive.toUpperCase();
    const prompt = `You are Harper Skill \u2014 an AI relationship intelligence analyst. You are rewriting a people page in ${ownerPossessive} Obsidian vault.

Your job: take ALL the existing information about this person and produce a comprehensive, well-structured people page. Preserve every fact, meeting, action item, and detail from the original \u2014 lose nothing. Then enrich it with relationship mapping, strategic analysis, and suggested actions.

## Person: ${name}

## EXISTING PAGE CONTENT (preserve all facts, meetings, action items):
${page.content}

## MAPPED RELATIONSHIPS (from graph analysis):
${relText}

## CONNECTED PEOPLE IN ${ownerPossessiveUpper} NETWORK:
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
- **Connection:** how they connect to ${ownerPossessive} network
- **How ${owner} knows them:** ...
- **Key context:** ...

## Background
A 2-3 sentence bio synthesized from all available information.

## Relationship Map
For each key connection in ${ownerPossessive} network:
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
1-3 specific, concrete next steps for ${owner}.

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
  var _a, _b, _c, _d, _e, _f, _g, _h, _i;
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
  const relationshipRecency = computeRecency(daysSinceContact);
  const relationshipDepth = computeDepth(gmail, totalExchanges, relationships.length);
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
  const strengthScore = computeStrengthScore(gmail, totalExchanges, relationships.length);
  const momentumScore = computeMomentumScore(gmail, daysSinceContact);
  const quadrant = assignQuadrant(strengthScore, momentumScore, gmail);
  const combinedScore = Math.round((strengthScore + momentumScore) / 2);
  console.log(`[Gmail CRM] Scoring: ${page.name}`, {
    // Raw inputs
    totalExchanges,
    sent: (_a = gmail == null ? void 0 : gmail.sentCount) != null ? _a : 0,
    received: (_b = gmail == null ? void 0 : gmail.receivedCount) != null ? _b : 0,
    daysSinceContact,
    edgeCount: relationships.length,
    // Metadata signals
    threadCount: (_c = gmail == null ? void 0 : gmail.threadCount) != null ? _c : 0,
    backAndForthThreads: (_d = gmail == null ? void 0 : gmail.backAndForthThreads) != null ? _d : 0,
    maxThreadDepth: (_e = gmail == null ? void 0 : gmail.maxThreadDepth) != null ? _e : 0,
    lastThreadDepth: (_f = gmail == null ? void 0 : gmail.lastThreadDepth) != null ? _f : 0,
    rsvpOnlyThreads: (_g = gmail == null ? void 0 : gmail.rsvpOnlyThreads) != null ? _g : 0,
    firstContact: (_h = gmail == null ? void 0 : gmail.firstContact) != null ? _h : "n/a",
    lastContact: (_i = gmail == null ? void 0 : gmail.lastContact) != null ? _i : "n/a",
    // Computed scores
    staleness: score,
    label,
    depth: relationshipDepth,
    recency: relationshipRecency,
    strengthScore,
    momentumScore,
    combinedScore,
    quadrant
  });
  return {
    score,
    label,
    daysSinceContact,
    relationshipStrength,
    relationshipDepth,
    relationshipRecency,
    nudge,
    strengthScore,
    momentumScore,
    combinedScore,
    quadrant
  };
}
function computeRecency(daysSinceContact) {
  if (daysSinceContact === null) return 1;
  if (daysSinceContact <= 2) return 10;
  if (daysSinceContact <= 7) return 9;
  if (daysSinceContact <= 14) return 8;
  if (daysSinceContact <= 21) return 7;
  if (daysSinceContact <= 30) return 6;
  if (daysSinceContact <= 60) return 5;
  if (daysSinceContact <= 90) return 4;
  if (daysSinceContact <= 120) return 3;
  if (daysSinceContact <= 180) return 2;
  return 1;
}
function computeDepth(gmail, totalExchanges, edgeCount) {
  var _a, _b, _c, _d;
  if (!gmail) {
    if (edgeCount >= 5) return 3;
    if (edgeCount >= 2) return 2;
    return 1;
  }
  const backAndForth = (_a = gmail.backAndForthThreads) != null ? _a : 0;
  const maxThread = (_b = gmail.maxThreadDepth) != null ? _b : 0;
  const rsvpOnly = (_c = gmail.rsvpOnlyThreads) != null ? _c : 0;
  const threadCount = (_d = gmail.threadCount) != null ? _d : 0;
  if (threadCount === 0 && totalExchanges > 0) {
    if (totalExchanges >= 20) return 4;
    if (totalExchanges >= 8) return 3;
    if (totalExchanges >= 3) return 2;
    return 1;
  }
  if (backAndForth >= 3 && totalExchanges >= 20 && maxThread >= 5) return 5;
  if (backAndForth >= 1 && totalExchanges >= 8) return 4;
  if (totalExchanges >= 8 && maxThread >= 3) return 3;
  if (totalExchanges >= 3) {
    if (rsvpOnly > 0 && rsvpOnly >= threadCount / 2) return 1;
    return 2;
  }
  return 1;
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
function computeStrengthScore(gmail, totalExchanges, edgeCount) {
  var _a, _b, _c, _d;
  if (!gmail && totalExchanges === 0) return 0;
  const volumeScore = Math.min(25, Math.log2(totalExchanges + 1) * 4);
  let depthScore = 0;
  if (gmail) {
    const baf = (_a = gmail.backAndForthThreads) != null ? _a : 0;
    const maxThread = (_b = gmail.maxThreadDepth) != null ? _b : 0;
    depthScore = Math.min(20, baf * 5) + Math.min(10, maxThread * 2);
  } else {
    depthScore = Math.min(10, edgeCount * 2);
  }
  let initiationScore = 5;
  if (gmail && totalExchanges > 0) {
    const ratio = Math.min(gmail.sentCount, gmail.receivedCount) / Math.max(gmail.sentCount, gmail.receivedCount, 1);
    initiationScore = 5 + ratio * 20;
  }
  let spanScore = 0;
  if (gmail && gmail.firstContact) {
    const first = new Date(gmail.firstContact).getTime();
    const last = new Date(gmail.lastContact).getTime();
    const spanDays = Math.max(0, (last - first) / 864e5);
    spanScore = Math.min(15, spanDays / 365 * 7.5);
  }
  let calScore = 0;
  if (gmail) {
    const meetings90d = (_c = gmail.calendarMeetingsLast90d) != null ? _c : 0;
    const acceptedTotal = (_d = gmail.calendarAccepted) != null ? _d : 0;
    if (meetings90d >= 5) calScore = 20;
    else if (meetings90d >= 3) calScore = 16;
    else if (meetings90d >= 1) calScore = 12;
    else if (acceptedTotal >= 3) calScore = 8;
    else if (acceptedTotal >= 1) calScore = 4;
  }
  return Math.round(Math.min(100, volumeScore + depthScore + initiationScore + spanScore + calScore));
}
function computeMomentumScore(gmail, daysSinceContact) {
  var _a, _b;
  if (daysSinceContact === null) return 0;
  const lambda = 0.02;
  const decayScore = Math.exp(-lambda * daysSinceContact) * 80;
  let trendScore = 0;
  if (gmail) {
    const lastDepth = (_a = gmail.lastThreadDepth) != null ? _a : 0;
    trendScore += Math.min(10, lastDepth * 2);
    const baf = (_b = gmail.backAndForthThreads) != null ? _b : 0;
    trendScore += Math.min(10, baf * 2);
  }
  return Math.round(Math.min(100, decayScore + trendScore));
}
function assignQuadrant(strengthScore, momentumScore, gmail) {
  var _a, _b, _c;
  const strongThreshold = 40;
  const activeThreshold = 30;
  let isStrong = strengthScore >= strongThreshold;
  const isActive = momentumScore >= activeThreshold;
  if (!isStrong && gmail) {
    const baf = (_a = gmail.backAndForthThreads) != null ? _a : 0;
    const sent = (_b = gmail.sentCount) != null ? _b : 0;
    if (baf >= 1 && sent >= 2) {
      isStrong = true;
    }
  }
  if (!isStrong && gmail) {
    const calAccepted = (_c = gmail.calendarAccepted) != null ? _c : 0;
    if (calAccepted >= 2) {
      isStrong = true;
    }
  }
  if (isStrong && isActive) return "nurture";
  if (isStrong && !isActive) return "re-engage";
  if (!isStrong && isActive) return "developing";
  return "deprioritize";
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

// src/betaworks-push.ts
var import_obsidian5 = require("obsidian");
async function pushScoresToBetaworks(config, scored) {
  const contacts = scored.filter(({ page }) => page.email || page.emails.length > 0).map(({ page, staleness }) => {
    var _a, _b, _c;
    return {
      email: (_a = page.email) != null ? _a : page.emails[0],
      emails: page.emails,
      name: page.name,
      strengthScore: staleness.strengthScore,
      momentumScore: staleness.momentumScore,
      combinedScore: staleness.combinedScore,
      quadrant: staleness.quadrant,
      lastContact: (_c = (_b = page.gmailStats) == null ? void 0 : _b.lastContact) != null ? _c : null
    };
  });
  const res = await (0, import_obsidian5.requestUrl)({
    url: `${config.url.replace(/\/$/, "")}/api/scores/push`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": config.salienceKey
    },
    body: JSON.stringify({
      partner: config.partnerEmail,
      pushedAt: (/* @__PURE__ */ new Date()).toISOString(),
      contacts
    }),
    throw: false
  });
  if (res.status !== 200) {
    throw new Error(`betaworks os push failed (${res.status}): ${res.text}`);
  }
  return contacts.length;
}

// src/graph-push.ts
var import_obsidian6 = require("obsidian");
var MAX_EDGE_CONTEXTS = 5;
var MAX_CONTEXT_CHARS = 120;
async function buildGraphPayload(contacts, edges, salt) {
  const idByEmail = /* @__PURE__ */ new Map();
  const nodes = [];
  for (const c of contacts) {
    const email = c.email.toLowerCase();
    if (idByEmail.has(email)) continue;
    const id = await opaqueId(salt, email);
    idByEmail.set(email, id);
    nodes.push({
      id,
      name: c.name,
      company: c.company,
      quadrant: c.staleness.quadrant,
      combined: c.staleness.combinedScore,
      strength: c.staleness.strengthScore,
      momentum: c.staleness.momentumScore,
      label: c.staleness.label,
      lastContact: c.lastContact
    });
  }
  const merged = /* @__PURE__ */ new Map();
  for (const e of edges) {
    const source = idByEmail.get(e.sourceEmail.toLowerCase());
    const target = idByEmail.get(e.targetEmail.toLowerCase());
    if (!source || !target || source === target) continue;
    const [a, b] = source < target ? [source, target] : [target, source];
    const key = `${a}|${b}`;
    let entry = merged.get(key);
    if (!entry) {
      entry = { source: a, target: b, weight: 0, types: [], contexts: [], contextSet: /* @__PURE__ */ new Set(), typeSet: /* @__PURE__ */ new Set() };
      merged.set(key, entry);
    }
    entry.weight += 1;
    entry.typeSet.add(e.type);
    if (e.context) entry.contextSet.add(e.context.slice(0, MAX_CONTEXT_CHARS));
  }
  const edgesOut = [...merged.values()].map((e) => ({
    source: e.source,
    target: e.target,
    weight: e.weight,
    types: [...e.typeSet].sort(),
    contexts: [...e.contextSet].slice(0, MAX_EDGE_CONTEXTS)
  }));
  return { pushedAt: (/* @__PURE__ */ new Date()).toISOString(), nodes, edges: edgesOut };
}
async function pushGraphToWeb(config, payload) {
  const res = await (0, import_obsidian6.requestUrl)({
    url: `${config.url.replace(/\/$/, "")}/api/push`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.token}`
    },
    body: JSON.stringify(payload),
    throw: false
  });
  if (res.status !== 200) {
    throw new Error(`people graph push failed (${res.status}): ${res.text}`);
  }
  return { nodes: payload.nodes.length, edges: payload.edges.length };
}
function generateGraphSalt() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return hex(bytes);
}
async function opaqueId(salt, email) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}:${email}`));
  return hex(new Uint8Array(digest)).slice(0, 16);
}
function hex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// src/calendar-sync.ts
var import_obsidian7 = require("obsidian");
var CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3";
async function syncCalendarData(settings, contacts, userEmail) {
  if (!settings.accessToken) {
    console.warn("[Gmail CRM] Calendar sync skipped \u2014 no access token");
    return;
  }
  try {
    const ownerEmail = (userEmail != null ? userEmail : "").toLowerCase();
    const stats = await fetchCalendarStats(settings, ownerEmail);
    mergeCalendarStats(contacts, stats);
    console.log(`[Gmail CRM] Calendar sync complete \u2014 updated ${stats.size} contacts`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[Gmail CRM] Calendar sync failed (non-fatal): ${msg}`);
  }
}
async function getHeaders(settings) {
  return { Authorization: `Bearer ${settings.accessToken}` };
}
async function fetchCalendarStats(settings, ownerEmail) {
  var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k, _l;
  const headers = await getHeaders(settings);
  const now = /* @__PURE__ */ new Date();
  const yearAgo = new Date(now.getTime() - 365 * 864e5);
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 864e5);
  const timeMin = yearAgo.toISOString();
  const timeMax = now.toISOString();
  const statsMap = /* @__PURE__ */ new Map();
  let pageToken;
  do {
    const params = new URLSearchParams({
      timeMin,
      timeMax,
      maxResults: "2500",
      singleEvents: "true",
      fields: "items(summary,start,end,attendees,organizer,status),nextPageToken"
    });
    if (pageToken) params.set("pageToken", pageToken);
    const url = `${CALENDAR_API_BASE}/calendars/primary/events?${params.toString()}`;
    const resp = await (0, import_obsidian7.requestUrl)({ url, headers, throw: false });
    if (resp.status === 401 || resp.status === 403) {
      throw new Error(
        `Calendar API returned ${resp.status}. You may need to re-authenticate to grant the calendar.events.readonly scope.`
      );
    }
    if (resp.status < 200 || resp.status >= 300) {
      throw new Error(`Calendar API HTTP ${resp.status}: ${((_a = resp.text) != null ? _a : "").slice(0, 300)}`);
    }
    const data = resp.json;
    const events = (_b = data.items) != null ? _b : [];
    for (const event of events) {
      if (event.status === "cancelled") continue;
      if (!event.attendees || event.attendees.length === 0) continue;
      const eventStart = (_f = (_e = (_c = event.start) == null ? void 0 : _c.dateTime) != null ? _e : (_d = event.start) == null ? void 0 : _d.date) != null ? _f : "";
      if (!eventStart) continue;
      const eventDate = new Date(eventStart);
      const isLast90d = eventDate >= ninetyDaysAgo;
      const ownerAttendee = event.attendees.find(
        (a) => {
          var _a2;
          return a.self || ((_a2 = a.email) == null ? void 0 : _a2.toLowerCase()) === ownerEmail;
        }
      );
      const ownerAccepted = (ownerAttendee == null ? void 0 : ownerAttendee.responseStatus) === "accepted";
      const organizerEmail = (_i = (_h = (_g = event.organizer) == null ? void 0 : _g.email) == null ? void 0 : _h.toLowerCase()) != null ? _i : "";
      const organizerIsSelf = (_k = (_j = event.organizer) == null ? void 0 : _j.self) != null ? _k : false;
      for (const attendee of event.attendees) {
        if (attendee.self) continue;
        const email = (_l = attendee.email) == null ? void 0 : _l.toLowerCase();
        if (!email) continue;
        if (email === ownerEmail) continue;
        let stat = statsMap.get(email);
        if (!stat) {
          stat = {
            meetings: 0,
            accepted: 0,
            organizedByThem: 0,
            meetingsLast90d: 0,
            lastMeeting: null
          };
          statsMap.set(email, stat);
        }
        stat.meetings++;
        if (ownerAccepted && attendee.responseStatus === "accepted") {
          stat.accepted++;
        }
        if (!organizerIsSelf && organizerEmail === email) {
          stat.organizedByThem++;
        }
        if (isLast90d) {
          stat.meetingsLast90d++;
        }
        const eventIso = eventDate.toISOString();
        if (!stat.lastMeeting || eventIso > stat.lastMeeting) {
          stat.lastMeeting = eventIso;
        }
      }
    }
    pageToken = data.nextPageToken;
  } while (pageToken);
  return statsMap;
}
function mergeCalendarStats(contacts, stats) {
  for (const [email, stat] of stats) {
    const contact = contacts[email];
    if (!contact) continue;
    contact.calendarMeetings = stat.meetings;
    contact.calendarAccepted = stat.accepted;
    contact.calendarOrganizedByThem = stat.organizedByThem;
    contact.calendarMeetingsLast90d = stat.meetingsLast90d;
    if (stat.lastMeeting) {
      contact.calendarLastMeeting = stat.lastMeeting;
    }
  }
}

// src/frontmatter.ts
var import_obsidian8 = require("obsidian");
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
      (0, import_obsidian8.normalizePath)(this.companiesFolder)
    );
    if (folder instanceof import_obsidian8.TFolder) {
      for (const child of folder.children) {
        if (child instanceof import_obsidian8.TFile && child.extension === "md") {
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
    const stripped = lower.replace(/[,\s]*(inc\.?|llc|corp\.?|co\.?|ltd\.?)$/i, "").trim();
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
    const stubPath = (0, import_obsidian8.normalizePath)(`${this.companiesFolder}/${safeName}.md`);
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
          (0, import_obsidian8.normalizePath)(this.companiesFolder)
        );
        if (!folder) {
          await this.vault.createFolder((0, import_obsidian8.normalizePath)(this.companiesFolder));
        }
        await this.vault.create(stubPath, content);
      } catch (e) {
      }
      this.loadCompanyIndex().set(safeName.toLowerCase(), safeName);
    }
    return `"[[${this.companiesFolder}/${safeName}|${safeName}]]"`;
  }
  async updateFrontmatter(file, page, staleness, relationships) {
    var _a, _b;
    const content = await this.vault.read(file);
    const crm = {
      staleness_score: staleness.score,
      staleness_label: staleness.label,
      relationship_strength: staleness.relationshipStrength,
      relationship_depth: staleness.relationshipDepth,
      relationship_recency: staleness.relationshipRecency,
      strength_score: staleness.strengthScore,
      momentum_score: staleness.momentumScore,
      combined_score: staleness.combinedScore,
      quadrant: staleness.quadrant,
      connections: relationships.length
    };
    if (page.email) crm.email = page.email;
    let rawCompany = null;
    if (page.role) {
      const parsed = this.parseRoleCompany(page.role);
      crm.role = parsed.role;
      rawCompany = parsed.company;
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
      crm.first_contact = page.gmailStats.firstContact.split("T")[0];
      crm.total_exchanges = page.gmailStats.totalExchanges;
      crm.sent = page.gmailStats.sentCount;
      crm.received = page.gmailStats.receivedCount;
      if (page.gmailStats.lastSubject) {
        crm.last_subject = page.gmailStats.lastSubject;
      }
      if (page.gmailStats.subjects && page.gmailStats.subjects.length > 0) {
        crm.recent_subjects = page.gmailStats.subjects;
      }
      if (page.gmailStats.domain) {
        crm.domain = page.gmailStats.domain;
      }
      if (page.gmailStats.maxThreadDepth !== void 0) {
        crm.max_thread_depth = page.gmailStats.maxThreadDepth;
      }
      if (page.gmailStats.backAndForthThreads !== void 0) {
        crm.back_and_forth_threads = page.gmailStats.backAndForthThreads;
      }
      if (page.gmailStats.lastThreadDepth !== void 0) {
        crm.last_thread_depth = page.gmailStats.lastThreadDepth;
      }
      if (page.gmailStats.openCount !== void 0 && page.gmailStats.openCount > 0) {
        crm.open_count = page.gmailStats.openCount;
        const eng = (_b = page.gmailStats.openEngagement) != null ? _b : "none";
        const label = eng === "replied" ? "\u{1F4AC} Replied" : eng === "multi_opened" ? "\u{1F4EC} Opened multiple times" : eng === "opened" ? "\u{1F4EC} Opened" : eng === "sent_no_open" ? "\u{1F4ED} No opens" : "\u{1F4ED} No opens";
        crm.open_engagement = label;
      }
    }
    if (staleness.daysSinceContact !== null) {
      crm.days_since_contact = staleness.daysSinceContact;
    }
    if (staleness.nudge) {
      crm.nudge = staleness.nudge;
    } else {
      crm.nudge = "";
    }
    const updated = this.mergeFrontmatter(content, crm);
    const withStatus = this.updateRelationshipStatus(updated, page, staleness, relationships);
    if (withStatus !== content) {
      await this.vault.modify(file, withStatus);
    }
  }
  updateRelationshipStatus(content, page, staleness, relationships) {
    var _a, _b, _c, _d, _e, _f, _g, _h;
    const lines = [];
    const quadrantEmoji = {
      "nurture": "\u{1F7E2}",
      "re-engage": "\u{1F7E1}",
      "developing": "\u{1F535}",
      "deprioritize": "\u26AA"
    };
    const emoji = (_a = quadrantEmoji[staleness.quadrant]) != null ? _a : "\u26AA";
    lines.push(`${emoji} **${staleness.quadrant.charAt(0).toUpperCase() + staleness.quadrant.slice(1)}** \xB7 ${staleness.label}`);
    lines.push("");
    lines.push(`| Metric | Score |`);
    lines.push(`|--------|-------|`);
    lines.push(`| Strength | ${staleness.strengthScore}/100 ${this.scoreBar(staleness.strengthScore)} |`);
    lines.push(`| Momentum | ${staleness.momentumScore}/100 ${this.scoreBar(staleness.momentumScore)} |`);
    lines.push(`| Combined | ${staleness.combinedScore}/100 ${this.scoreBar(staleness.combinedScore)} |`);
    lines.push(`| Depth | ${staleness.relationshipDepth}/5 |`);
    lines.push(`| Recency | ${staleness.relationshipRecency}/10 |`);
    lines.push("");
    if (page.gmailStats) {
      const g = page.gmailStats;
      const sent = (_b = g.sentCount) != null ? _b : 0;
      const received = (_c = g.receivedCount) != null ? _c : 0;
      const total = (_d = g.totalExchanges) != null ? _d : 0;
      const threads = (_e = g.threadCount) != null ? _e : 0;
      const baf = (_f = g.backAndForthThreads) != null ? _f : 0;
      lines.push(`**${total} emails** (${sent} sent \xB7 ${received} received) across ${threads} threads \xB7 ${baf} back-and-forth`);
      if (g.firstContact && g.lastContact) {
        const first = g.firstContact.split("T")[0];
        const last = g.lastContact.split("T")[0];
        if (first === last) {
          lines.push(`Only contact: ${last}`);
        } else {
          lines.push(`First contact: ${first} \xB7 Last contact: ${last}`);
        }
      }
      const meetings90d = (_g = g.calendarMeetingsLast90d) != null ? _g : 0;
      const meetingsTotal = (_h = g.calendarMeetings) != null ? _h : 0;
      if (meetingsTotal > 0) {
        lines.push(`\u{1F4C5} ${meetingsTotal} calendar meetings (${meetings90d} in last 90 days)`);
      }
      lines.push("");
    }
    if (relationships.length > 0) {
      const names = relationships.slice(0, 5).map((r) => `[[${r.target}]]`).join(", ");
      const suffix = relationships.length > 5 ? ` + ${relationships.length - 5} more` : "";
      lines.push(`**${relationships.length} connections:** ${names}${suffix}`);
      lines.push("");
    }
    if (staleness.nudge) {
      lines.push(`> [!tip] Nudge`);
      lines.push(`> ${staleness.nudge}`);
      lines.push("");
    }
    const section = `## Relationship Status

${lines.join("\n")}`;
    const sectionRegex = /## Relationship Status\n[\s\S]*?(?=\n## (?!Relationship Status)|\n---\n|$)/;
    if (sectionRegex.test(content)) {
      return content.replace(sectionRegex, section);
    } else {
      const fmEnd = content.indexOf("---", content.indexOf("---") + 3);
      if (fmEnd !== -1) {
        const insertPos = fmEnd + 3;
        const before = content.slice(0, insertPos);
        const after = content.slice(insertPos);
        return `${before}

${section}
${after}`;
      }
      return `${section}

${content}`;
    }
  }
  scoreBar(score) {
    const filled = Math.round(score / 10);
    return "\u2588".repeat(filled) + "\u2591".repeat(10 - filled);
  }
  parseRoleCompany(role) {
    const roleParts = role.split(/\s+at\s+|\s+@\s+/i);
    if (roleParts.length === 2) {
      return {
        role: roleParts[0].trim(),
        company: roleParts[1].trim()
      };
    }
    const ofMatch = role.match(/^(founder|co[-\s]?founder|owner|principal|partner|managing partner|ceo|cto|cpo|coo|president)\s+of\s+(.+)$/i);
    if (ofMatch) {
      return {
        role: ofMatch[1].trim(),
        company: ofMatch[2].trim()
      };
    }
    return { role, company: null };
  }
  async setCanonicalLink(file, link) {
    var _a;
    const content = await this.vault.read(file);
    const fields = {
      canonical_id: link.canonicalId,
      last_canonical_sync: (_a = link.syncedAt) != null ? _a : (/* @__PURE__ */ new Date()).toISOString()
    };
    if (link.aliases && link.aliases.length > 0) fields.aliases = link.aliases;
    const updated = this.mergeFrontmatter(content, fields);
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
      let skipContinuation = false;
      for (const line of existingLines) {
        const keyMatch = line.match(/^(\w[\w_-]*):/);
        if (keyMatch) {
          skipContinuation = false;
          const key = keyMatch[1];
          existingKeys.add(key);
          if (key in fields) {
            const val = fields[key];
            if (val !== void 0 && val !== "") {
              updatedLines.push(this.formatField(key, val));
              if (Array.isArray(val)) {
                skipContinuation = true;
              }
            } else if (val === "") {
              skipContinuation = true;
            } else {
              updatedLines.push(line);
            }
          } else {
            updatedLines.push(line);
          }
        } else if (skipContinuation && (line.match(/^\s+-\s/) || line.match(/^\s+/))) {
          continue;
        } else {
          skipContinuation = false;
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
    if (Array.isArray(val)) {
      if (val.length === 0) return `${key}: []`;
      const items = val.map((v) => `  - "${v.replace(/"/g, '\\"')}"`);
      return `${key}:
${items.join("\n")}`;
    }
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
var import_obsidian9 = require("obsidian");
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
  note.canonical_id:
    displayName: Canonical ID
  note.aliases:
    displayName: Aliases
  note.last_canonical_sync:
    displayName: Canonical Sync
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
  note.relationship_depth:
    displayName: Depth
  note.relationship_recency:
    displayName: Recency
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
  note.recent_subjects:
    displayName: Recent Subjects
  note.last_thread_depth:
    displayName: Thread Msgs
  note.max_thread_depth:
    displayName: Deepest Thread
  note.back_and_forth_threads:
    displayName: Conversations
  note.domain:
    displayName: Domain
  note.strength_score:
    displayName: Strength
  note.momentum_score:
    displayName: Momentum
  note.quadrant:
    displayName: Quadrant
  note.combined_score:
    displayName: Score
  note.open_engagement:
    displayName: Opens
  note.override:
    displayName: Swipe
  note.override_at:
    displayName: Swiped On
views:
  - type: table
    name: CRM
    order:
      - file.name
      - company
      - canonical_id
      - aliases
      - last_contact
      - recent_subjects
      - last_thread_depth
      - total_exchanges
      - relationship_depth
      - relationship_recency
      - staleness_label
      - quadrant
      - combined_score
      - open_engagement
      - override
      - nudge
    filters:
      and:
        - override != suppress
        - override != delete
    sort:
      - property: combined_score
        direction: DESC
    columns:
      - file.name
      - company
      - canonical_id
      - aliases
      - last_contact
      - recent_subjects
      - last_thread_depth
      - total_exchanges
      - strength_score
      - momentum_score
      - quadrant
      - combined_score
      - override
      - nudge
    columnSize:
      file.name: 200
      company: 160
      canonical_id: 220
      aliases: 260
      recent_subjects: 350
      nudge: 300
    summaries:
      total_exchanges: Sum
  - type: table
    name: Boosted
    order:
      - file.name
      - company
      - last_contact
      - total_exchanges
      - strength_score
      - momentum_score
      - quadrant
      - combined_score
      - override_at
      - nudge
    filters:
      and:
        - override = boost
    sort:
      - property: combined_score
        direction: DESC
    columns:
      - file.name
      - company
      - last_contact
      - total_exchanges
      - strength_score
      - momentum_score
      - quadrant
      - combined_score
      - override_at
      - nudge
    columnSize:
      file.name: 200
      company: 160
      nudge: 350
  - type: table
    name: Re-engage
    order:
      - file.name
      - company
      - recent_subjects
      - days_since_contact
      - strength_score
      - momentum_score
      - combined_score
      - back_and_forth_threads
      - total_exchanges
      - nudge
    filters:
      and:
        - quadrant = re-engage
    sort:
      - property: combined_score
        direction: DESC
    columns:
      - file.name
      - company
      - recent_subjects
      - days_since_contact
      - strength_score
      - momentum_score
      - combined_score
      - back_and_forth_threads
      - total_exchanges
      - nudge
    columnSize:
      file.name: 200
      company: 160
      recent_subjects: 350
      nudge: 350
  - type: table
    name: By Company
    order:
      - company
      - file.name
      - staleness_label
      - last_contact
      - total_exchanges
      - relationship_depth
    sort:
      - property: company
        direction: ASC
      - property: relationship_depth
        direction: DESC
    columns:
      - company
      - file.name
      - staleness_label
      - last_contact
      - total_exchanges
      - relationship_depth
    columnSize:
      file.name: 200
      company: 180
  - type: table
    name: Nurture
    order:
      - file.name
      - company
      - role
      - last_contact
      - total_exchanges
      - strength_score
      - momentum_score
      - combined_score
      - back_and_forth_threads
    filters:
      and:
        - quadrant = nurture
    sort:
      - property: combined_score
        direction: DESC
    columns:
      - file.name
      - company
      - role
      - last_contact
      - total_exchanges
      - strength_score
      - momentum_score
      - combined_score
      - back_and_forth_threads
    columnSize:
      file.name: 200
      company: 160
  - type: table
    name: Developing
    order:
      - file.name
      - company
      - last_contact
      - total_exchanges
      - strength_score
      - momentum_score
      - combined_score
      - quadrant
    filters:
      and:
        - quadrant = developing
    sort:
      - property: combined_score
        direction: DESC
    columns:
      - file.name
      - company
      - last_contact
      - total_exchanges
      - strength_score
      - momentum_score
      - combined_score
    columnSize:
      file.name: 200
      company: 160
  - type: table
    name: Quadrants
    order:
      - quadrant
      - file.name
      - company
      - combined_score
      - strength_score
      - momentum_score
      - last_contact
      - back_and_forth_threads
    sort:
      - property: quadrant
        direction: ASC
      - property: combined_score
        direction: DESC
    columns:
      - quadrant
      - file.name
      - company
      - combined_score
      - strength_score
      - momentum_score
      - last_contact
      - back_and_forth_threads
    columnSize:
      file.name: 200
      company: 160
      quadrant: 130
`;
async function createBaseView(vault, peopleFolder) {
  const basePath = (0, import_obsidian9.normalizePath)(`${peopleFolder}/CRM.base`);
  const existing = vault.getAbstractFileByPath(basePath);
  if (existing instanceof import_obsidian9.TFile) {
    await vault.modify(existing, BASE_CONTENT);
  } else {
    try {
      await vault.create(basePath, BASE_CONTENT);
    } catch (e) {
      await vault.adapter.write(basePath, BASE_CONTENT);
    }
  }
  return basePath;
}

// src/quadrant-view.ts
var import_obsidian10 = require("obsidian");
var QUADRANT_ORDER = ["nurture", "re-engage", "developing", "deprioritize", "suppressed"];
var QUADRANT_LABELS = {
  nurture: { title: "NURTURE", subtitle: "strong + active" },
  "re-engage": { title: "RE-ENGAGE", subtitle: "strong + dormant" },
  developing: { title: "DEVELOPING", subtitle: "weak + active" },
  deprioritize: { title: "DEPRIORITIZE", subtitle: "weak + dormant" },
  suppressed: { title: "SUPPRESSED", subtitle: "human-overridden (suppress / delete)" }
};
async function writeQuadrantView(vault, peopleFolder) {
  var _a, _b, _c;
  const folder = vault.getAbstractFileByPath((0, import_obsidian10.normalizePath)(peopleFolder));
  if (!(folder instanceof import_obsidian10.TFolder)) {
    throw new Error(`People folder not found: ${peopleFolder}`);
  }
  const buckets = {
    nurture: [],
    "re-engage": [],
    developing: [],
    deprioritize: [],
    suppressed: []
  };
  for (const child of folder.children) {
    if (!(child instanceof import_obsidian10.TFile) || child.extension !== "md") continue;
    const content = await vault.read(child);
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) continue;
    const yaml = fmMatch[1];
    const quadrant = readField(yaml, "quadrant");
    const override = readField(yaml, "override");
    const row = {
      name: child.basename,
      combinedScore: (_a = readNumber(yaml, "combined_score")) != null ? _a : 0,
      strengthScore: (_b = readNumber(yaml, "strength_score")) != null ? _b : 0,
      momentumScore: (_c = readNumber(yaml, "momentum_score")) != null ? _c : 0,
      quadrant: quadrant != null ? quadrant : "",
      boosted: override === "boost"
    };
    if (override === "suppress" || override === "delete") {
      buckets.suppressed.push({ ...row, quadrant: "suppressed" });
      continue;
    }
    if (!quadrant || !buckets[quadrant]) continue;
    buckets[quadrant].push(row);
  }
  for (const q of QUADRANT_ORDER) {
    buckets[q].sort((a, b) => {
      if (a.boosted !== b.boosted) return a.boosted ? -1 : 1;
      return b.combinedScore - a.combinedScore;
    });
  }
  const html = renderGrid(buckets, peopleFolder);
  const path = (0, import_obsidian10.normalizePath)(`${peopleFolder}/_Quadrants.md`);
  const existing = vault.getAbstractFileByPath(path);
  if (existing instanceof import_obsidian10.TFile) {
    await vault.modify(existing, html);
  } else {
    try {
      await vault.create(path, html);
    } catch (e) {
      await vault.adapter.write(path, html);
    }
  }
  const legacyPath = (0, import_obsidian10.normalizePath)(`${peopleFolder}/Quadrants.md`);
  const legacy = vault.getAbstractFileByPath(legacyPath);
  if (legacy instanceof import_obsidian10.TFile) {
    try {
      await vault.delete(legacy);
    } catch (e) {
    }
  }
  return path;
}
function readField(yaml, key) {
  const re = new RegExp(`^${key}:\\s*(.+?)\\s*$`, "m");
  const m = yaml.match(re);
  if (!m) return null;
  return m[1].replace(/^["']|["']$/g, "").trim();
}
function readNumber(yaml, key) {
  const v = readField(yaml, key);
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function renderGrid(buckets, peopleFolder) {
  const cell = (q) => {
    const rows = buckets[q];
    const items = rows.slice(0, 50).map(
      (r) => `<li><a class="internal-link" href="${escapeHtml(peopleFolder)}/${escapeHtml(r.name)}.md" data-href="${escapeHtml(peopleFolder)}/${escapeHtml(r.name)}.md">${escapeHtml(r.name)}</a> <span class="gmail-crm-q-score">${r.combinedScore}</span>${r.boosted ? ' <span class="gmail-crm-q-boost">\u2605</span>' : ""}</li>`
    ).join("");
    const overflow = rows.length > 50 ? `<div class="gmail-crm-q-overflow">+${rows.length - 50} more</div>` : "";
    const label = QUADRANT_LABELS[q];
    return `<div class="gmail-crm-q gmail-crm-q-${q}">
  <div class="gmail-crm-q-header">
    <h3>${label.title}</h3>
    <span class="gmail-crm-q-sub">${label.subtitle}</span>
    <span class="gmail-crm-q-count">${rows.length}</span>
  </div>
  <ul class="gmail-crm-q-list">${items}</ul>
  ${overflow}
</div>`;
  };
  return `# Quadrants

<div class="gmail-crm-q-grid">
  <div class="gmail-crm-q-axis-y-top">ACTIVE</div>
  <div class="gmail-crm-q-axis-y-bottom">DORMANT</div>
  <div class="gmail-crm-q-axis-x-left">STRONG</div>
  <div class="gmail-crm-q-axis-x-right">WEAK</div>
${cell("nurture")}
${cell("developing")}
${cell("re-engage")}
${cell("deprioritize")}
</div>

${buckets.suppressed.length > 0 ? `
<details><summary>Suppressed \u2014 ${buckets.suppressed.length} (human override)</summary>

${cell("suppressed")}
</details>
` : ""}

> Sorted by combined score within each quadrant. Top 50 per cell. \u2605 = boosted by swipe.
`;
}
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// src/main.ts
init_types();
var GmailCrmPlugin = class extends import_obsidian11.Plugin {
  constructor() {
    super(...arguments);
    this.settings = DEFAULT_SETTINGS;
    this.contactIndex = null;
    this.messageCache = null;
    this.syncInterval = null;
    this.stalenessInterval = null;
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
      id: "full-sync",
      name: "Full re-sync (clear cache)",
      callback: () => {
        void this.fullResync();
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
        if (!file || !file.path.startsWith((0, import_obsidian11.normalizePath)(this.settings.peopleFolder))) {
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
      id: "sync-calendar",
      name: "Sync calendar meeting data",
      callback: () => {
        void this.syncCalendar();
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
      id: "push-betaworks-scores",
      name: "Push scores to betaworks os",
      callback: () => {
        void this.pushBetaworksScores();
      }
    });
    this.addCommand({
      id: "push-people-graph",
      name: "Push people graph to web",
      callback: () => {
        void this.pushPeopleGraph();
      }
    });
    this.addCommand({
      id: "review-merge-queue",
      name: "Review merge queue",
      callback: () => {
        void this.reviewMergeQueue();
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
    await this.loadMessageCache();
    if (this.settings.refreshToken) {
      this.startAutoSync();
      this.resetStalenessTimer();
    }
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
  }
  async saveSettings() {
    var _a;
    await this.saveData(this.settings);
    (_a = this.gmailApi) == null ? void 0 : _a.updateSettings(this.settings);
  }
  getEffectiveClientId() {
    if (this.settings.useCustomOAuth && this.settings.clientId) {
      return this.settings.clientId;
    }
    const { SHARED_CLIENT_ID: SHARED_CLIENT_ID2 } = (init_gmail_api(), __toCommonJS(gmail_api_exports));
    return SHARED_CLIENT_ID2;
  }
  getEffectiveClientSecret() {
    if (this.settings.useCustomOAuth && this.settings.clientSecret) {
      return this.settings.clientSecret;
    }
    const { SHARED_CLIENT_SECRET: SHARED_CLIENT_SECRET2 } = (init_gmail_api(), __toCommonJS(gmail_api_exports));
    return SHARED_CLIENT_SECRET2;
  }
  async startOAuthFlow() {
    try {
      const authUrl = this.gmailApi.getAuthUrl();
      const codePromise = startOAuthCallbackServer();
      window.open(authUrl);
      new import_obsidian11.Notice("Opening browser for authorization...");
      const code = await codePromise;
      await this.gmailApi.exchangeCode(code);
      new import_obsidian11.Notice("Gmail connected successfully!");
      this.startAutoSync();
      await this.syncContacts();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      new import_obsidian11.Notice(`Gmail auth failed: ${msg}`);
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
  resetStalenessTimer() {
    if (this.stalenessInterval !== null) {
      window.clearInterval(this.stalenessInterval);
      this.stalenessInterval = null;
    }
    const hours = this.settings.stalenessUpdateInterval;
    if (hours > 0) {
      this.stalenessInterval = window.setInterval(
        () => {
          void this.updateStaleness();
        },
        hours * 36e5
      );
      this.registerInterval(this.stalenessInterval);
    }
  }
  async syncContacts() {
    if (!this.settings.refreshToken) {
      new import_obsidian11.Notice("Connect your account first in plugin settings");
      return;
    }
    const notice = new import_obsidian11.Notice("Syncing contacts...", 0);
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
        // Progressive checkpoint: flush to disk + score + create pages every 2000 messages
        async (checkpointIndex, checkpointCache) => {
          this.contactIndex = checkpointIndex;
          this.messageCache = checkpointCache;
          await this.saveContactIndex();
          await this.saveMessageCache();
          if (this.settings.createContactNotes) {
            await this.writeContactNotes();
          }
          if (this.settings.autoUpdateStaleness) {
            await this.updateStaleness();
          }
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
      notice.setMessage(`Synced ${contactCount} contacts \u2014 syncing calendar...`);
      try {
        await syncCalendarData(
          this.settings,
          this.contactIndex.contacts,
          this.contactIndex.userEmail
        );
        await this.saveContactIndex();
      } catch (e) {
        const calMsg = e instanceof Error ? e.message : String(e);
        if (calMsg.includes("401") || calMsg.includes("403")) {
          new import_obsidian11.Notice("Calendar sync needs re-authentication. Disconnect and reconnect in settings to grant calendar access.");
        } else {
          console.warn(`[Gmail CRM] Calendar sync skipped: ${calMsg}`);
        }
      }
      notice.setMessage(`Synced ${contactCount} contacts \u2014 updating scores...`);
      if (this.settings.autoUpdateStaleness) {
        await this.updateStaleness();
        await this.refreshBaseView();
        await this.refreshQuadrantView();
        notice.setMessage(`Synced ${contactCount} contacts \u2014 scores updated`);
      } else {
        notice.setMessage(`Synced ${contactCount} contacts`);
      }
      setTimeout(() => notice.hide(), 3e3);
      if (this.settings.enrichOnSync) {
        await this.enrichAllPeople();
      }
    } catch (e) {
      notice.hide();
      const msg = e instanceof Error ? e.message : String(e);
      new import_obsidian11.Notice(`Sync failed: ${msg}`);
    }
  }
  async fullResync() {
    this.messageCache = null;
    this.contactIndex = null;
    new import_obsidian11.Notice("Cache cleared \u2014 running full re-sync...");
    await this.syncContacts();
  }
  async syncCalendar() {
    if (!this.settings.refreshToken) {
      new import_obsidian11.Notice("Connect your account first in plugin settings");
      return;
    }
    if (!this.contactIndex) {
      new import_obsidian11.Notice("No contact index found. Run a contact sync first.");
      return;
    }
    const notice = new import_obsidian11.Notice("Syncing calendar meeting data...", 0);
    try {
      await syncCalendarData(
        this.settings,
        this.contactIndex.contacts,
        this.contactIndex.userEmail
      );
      await this.saveContactIndex();
      const withCal = Object.values(this.contactIndex.contacts).filter((c) => {
        var _a;
        return ((_a = c.calendarMeetings) != null ? _a : 0) > 0;
      }).length;
      notice.setMessage(`Calendar sync complete \u2014 ${withCal} contacts have meeting data`);
      setTimeout(() => notice.hide(), 3e3);
    } catch (e) {
      notice.hide();
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("401") || msg.includes("403")) {
        new import_obsidian11.Notice("Calendar sync needs re-authentication. Disconnect and reconnect in settings to grant calendar access.");
      } else {
        new import_obsidian11.Notice(`Calendar sync failed: ${msg}`);
      }
    }
  }
  async loadContactIndex() {
    var _a, _b, _c;
    const path = this.getIndexPath();
    try {
      if (!await this.app.vault.adapter.exists(path)) return;
      const content = await this.app.vault.adapter.read(path);
      const parsed = JSON.parse(content);
      this.contactIndex = {
        ...parsed,
        schemaVersion: (_a = parsed.schemaVersion) != null ? _a : CONTACT_INDEX_SCHEMA_VERSION,
        contacts: (_b = parsed.contacts) != null ? _b : {},
        edges: (_c = parsed.edges) != null ? _c : []
      };
    } catch (e) {
    }
  }
  async saveContactIndex() {
    var _a, _b;
    if (!this.contactIndex) return;
    this.contactIndex.schemaVersion = CONTACT_INDEX_SCHEMA_VERSION;
    (_b = (_a = this.contactIndex).edges) != null ? _b : _a.edges = [];
    const path = this.getIndexPath();
    const content = JSON.stringify(this.contactIndex, null, 2);
    await this.app.vault.adapter.write((0, import_obsidian11.normalizePath)(path), content);
  }
  getIndexPath() {
    return (0, import_obsidian11.normalizePath)(
      `${this.app.vault.configDir}/plugins/gmail-crm/contact-index.json`
    );
  }
  getCachePath() {
    return (0, import_obsidian11.normalizePath)(
      `${this.app.vault.configDir}/plugins/gmail-crm/message-cache.json`
    );
  }
  getMergeQueuePath() {
    return (0, import_obsidian11.normalizePath)(
      `${this.app.vault.configDir}/plugins/gmail-crm/merge-queue.json`
    );
  }
  async loadMergeQueue() {
    const path = this.getMergeQueuePath();
    try {
      if (!await this.app.vault.adapter.exists(path)) {
        return { schemaVersion: 1, candidates: [] };
      }
      const content = await this.app.vault.adapter.read(path);
      return JSON.parse(content);
    } catch (e) {
      return { schemaVersion: 1, candidates: [] };
    }
  }
  async loadMessageCache() {
    const path = this.getCachePath();
    try {
      if (!await this.app.vault.adapter.exists(path)) return;
      const content = await this.app.vault.adapter.read(path);
      this.messageCache = JSON.parse(content);
    } catch (e) {
    }
  }
  async saveMessageCache() {
    if (!this.messageCache) return;
    const path = this.getCachePath();
    const content = JSON.stringify(this.messageCache);
    await this.app.vault.adapter.write((0, import_obsidian11.normalizePath)(path), content);
  }
  async writeContactNotes() {
    if (!this.contactIndex) return;
    const folder = (0, import_obsidian11.normalizePath)(this.settings.contactNotesFolder);
    if (!this.app.vault.getAbstractFileByPath(folder)) {
      try {
        await this.app.vault.createFolder(folder);
      } catch (e) {
      }
    }
    const existingPages = /* @__PURE__ */ new Map();
    const folderObj = this.app.vault.getAbstractFileByPath(folder);
    if (folderObj instanceof import_obsidian11.TFolder) {
      for (const child of folderObj.children) {
        if (child instanceof import_obsidian11.TFile && child.extension === "md") {
          const pageName = child.basename.replace(/^p-\s*/, "").toLowerCase();
          existingPages.set(pageName, child);
        }
      }
    }
    for (const contact of Object.values(this.contactIndex.contacts)) {
      const safeName = contact.name.replace(/[\\/:*?"<>|]/g, "_");
      const notePath = (0, import_obsidian11.normalizePath)(`${folder}/p- ${safeName}.md`);
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
      if (noteFile instanceof import_obsidian11.TFile) {
        continue;
      }
      try {
        await this.app.vault.create(notePath, content);
      } catch (e) {
      }
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
    const notePath = (0, import_obsidian11.normalizePath)(
      `${this.settings.contactNotesFolder}/${safeName}.md`
    );
    const file = this.app.vault.getAbstractFileByPath(notePath);
    if (file instanceof import_obsidian11.TFile) {
      await this.app.workspace.getLeaf().openFile(file);
    } else {
      new import_obsidian11.Notice(`No note found for ${contact.name}. Run sync first.`);
    }
  }
  async enrichAllPeople(skipAi = false) {
    var _a;
    const engine = new RelationshipEngine(this.app.vault, this.settings.peopleFolder);
    const notice = new import_obsidian11.Notice("Loading people pages...", 0);
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
          new import_obsidian11.Notice("Set your API key in plugin settings first.");
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
        const relationships = (_a = graph[name]) != null ? _a : [];
        const file = this.app.vault.getAbstractFileByPath(page.path);
        if (!(file instanceof import_obsidian11.TFile)) continue;
        if (harper) {
          try {
            const rewritten = await harper.rewritePersonPage(name, page, relationships, pages);
            await this.app.vault.modify(file, rewritten);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error(`Harper skill failed for ${name}: ${msg}`);
            new import_obsidian11.Notice(`Failed on ${name}: ${msg}`);
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
      new import_obsidian11.Notice(`Enrichment failed: ${msg}`);
    }
  }
  async enrichSinglePerson(name) {
    var _a;
    const engine = new RelationshipEngine(this.app.vault, this.settings.peopleFolder);
    const notice = new import_obsidian11.Notice(`Enriching ${name}...`, 0);
    try {
      const pages = await engine.loadPeoplePages();
      if (!pages[name]) {
        notice.hide();
        new import_obsidian11.Notice(`Person "${name}" not found in people pages.`);
        return;
      }
      const graph = engine.buildGraph(pages, this.contactIndex);
      const relationships = (_a = graph[name]) != null ? _a : [];
      if (!this.settings.anthropicApiKey) {
        notice.hide();
        new import_obsidian11.Notice("Set your API key in plugin settings first.");
        return;
      }
      const harper = new HarperSkill(
        this.settings.anthropicApiKey,
        this.settings.harperModel,
        this.settings.vaultOwnerName
      );
      const rewritten = await harper.rewritePersonPage(name, pages[name], relationships, pages);
      const file = this.app.vault.getAbstractFileByPath(pages[name].path);
      if (file instanceof import_obsidian11.TFile) {
        await this.app.vault.modify(file, rewritten);
      }
      notice.setMessage(`Enriched ${name}!`);
      setTimeout(() => notice.hide(), 3e3);
    } catch (e) {
      notice.hide();
      const msg = e instanceof Error ? e.message : String(e);
      new import_obsidian11.Notice(`Enrichment failed: ${msg}`);
    }
  }
  async updateStaleness() {
    var _a;
    const engine = new RelationshipEngine(this.app.vault, this.settings.peopleFolder);
    const fm = new FrontmatterManager(this.app.vault, this.settings.companiesFolder);
    const notice = new import_obsidian11.Notice("Computing staleness scores...", 0);
    try {
      const pages = await engine.loadPeoplePages();
      const count = Object.keys(pages).length;
      const graph = engine.buildGraph(pages, this.contactIndex);
      const scoreUpdatedAt = (/* @__PURE__ */ new Date()).toISOString();
      let done = 0;
      let staleCount = 0;
      const scoredPages = [];
      for (const [name, page] of Object.entries(pages)) {
        done++;
        const relationships = (_a = graph[name]) != null ? _a : [];
        const staleness = computeStaleness(page, relationships);
        scoredPages.push({ page, staleness });
        this.updateContactScore(page, staleness, scoreUpdatedAt);
        if (staleness.label === "stale" || staleness.label === "dormant") {
          staleCount++;
        }
        const file = this.app.vault.getAbstractFileByPath(page.path);
        if (file instanceof import_obsidian11.TFile) {
          await fm.updateFrontmatter(file, page, staleness, relationships);
          const contact = this.getContactForPage(page);
          if (contact == null ? void 0 : contact.canonicalId) {
            await fm.setCanonicalLink(file, {
              canonicalId: contact.canonicalId,
              aliases: contact.aliases,
              syncedAt: contact.lastCanonicalSync
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
      notice.setMessage(`Scored ${count} contacts \u2014 ${staleCount} going stale`);
      if (this.settings.autoPushScores && this.settings.betaworksOsUrl && this.settings.betaworksPartnerEmail && this.settings.betaworksSalienceKey) {
        try {
          const pushed = await pushScoresToBetaworks(
            {
              url: this.settings.betaworksOsUrl,
              partnerEmail: this.settings.betaworksPartnerEmail,
              salienceKey: this.settings.betaworksSalienceKey
            },
            scoredPages
          );
          notice.setMessage(`Scored ${count} contacts \u2014 pushed ${pushed} to betaworks os`);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error("[Gmail CRM] betaworks os push failed", e);
          new import_obsidian11.Notice(`betaworks os push failed: ${msg}`);
        }
      }
      setTimeout(() => notice.hide(), 4e3);
    } catch (e) {
      notice.hide();
      const msg = e instanceof Error ? e.message : String(e);
      new import_obsidian11.Notice(`Staleness update failed: ${msg}`);
    }
  }
  async pushBetaworksScores() {
    if (!this.settings.betaworksOsUrl || !this.settings.betaworksPartnerEmail || !this.settings.betaworksSalienceKey) {
      new import_obsidian11.Notice("Set the betaworks os URL, partner email, and Salience key in settings first");
      return;
    }
    const notice = new import_obsidian11.Notice("Pushing scores to betaworks os...", 0);
    try {
      const engine = new RelationshipEngine(this.app.vault, this.settings.peopleFolder);
      const pages = await engine.loadPeoplePages();
      const graph = engine.buildGraph(pages, this.contactIndex);
      const scoredPages = Object.entries(pages).map(([name, page]) => {
        var _a;
        return {
          page,
          staleness: computeStaleness(page, (_a = graph[name]) != null ? _a : [])
        };
      });
      const pushed = await pushScoresToBetaworks(
        {
          url: this.settings.betaworksOsUrl,
          partnerEmail: this.settings.betaworksPartnerEmail,
          salienceKey: this.settings.betaworksSalienceKey
        },
        scoredPages
      );
      notice.setMessage(`Pushed ${pushed} contacts to betaworks os`);
      setTimeout(() => notice.hide(), 4e3);
    } catch (e) {
      notice.hide();
      const msg = e instanceof Error ? e.message : String(e);
      new import_obsidian11.Notice(`betaworks os push failed: ${msg}`);
    }
  }
  async pushPeopleGraph() {
    var _a, _b, _c, _d, _e;
    if (!this.settings.graphPushUrl || !this.settings.graphPushToken) {
      new import_obsidian11.Notice("Set the graph URL and push token in settings first (mint the token on the graph page)");
      return;
    }
    if (!this.settings.graphPushSalt) {
      this.settings.graphPushSalt = generateGraphSalt();
      await this.saveSettings();
    }
    const notice = new import_obsidian11.Notice("Pushing people graph...", 0);
    try {
      const engine = new RelationshipEngine(this.app.vault, this.settings.peopleFolder);
      const pages = await engine.loadPeoplePages();
      const graph = engine.buildGraph(pages, this.contactIndex);
      const contacts = [];
      for (const [name, page] of Object.entries(pages)) {
        const email = this.getEmailForPage(page);
        if (!email) continue;
        contacts.push({
          email,
          name,
          company: (_b = (_a = this.getContactByEmail(email)) == null ? void 0 : _a.company) != null ? _b : null,
          lastContact: (_d = (_c = page.gmailStats) == null ? void 0 : _c.lastContact) != null ? _d : null,
          staleness: computeStaleness(page, (_e = graph[name]) != null ? _e : [])
        });
      }
      const edges = this.buildContactEdges(pages, graph);
      const payload = await buildGraphPayload(contacts, edges, this.settings.graphPushSalt);
      const pushed = await pushGraphToWeb(
        { url: this.settings.graphPushUrl, token: this.settings.graphPushToken },
        payload
      );
      notice.setMessage(`Pushed ${pushed.nodes} people, ${pushed.edges} connections \u2014 open ${this.settings.graphPushUrl} to view`);
      setTimeout(() => notice.hide(), 6e3);
    } catch (e) {
      notice.hide();
      const msg = e instanceof Error ? e.message : String(e);
      new import_obsidian11.Notice(`People graph push failed: ${msg}`);
    }
  }
  updateContactScore(page, staleness, updatedAt) {
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
      updatedAt
    };
    contact.relationshipDepth = staleness.relationshipDepth;
    contact.relationshipRecency = staleness.relationshipRecency;
    contact.combinedScore = staleness.combinedScore;
    contact.quadrant = staleness.quadrant;
  }
  buildContactEdges(pages, graph) {
    var _a, _b, _c, _d;
    const edges = /* @__PURE__ */ new Map();
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
        const sourceScore = (_b = (_a = this.getContactByEmail(sourceEmail)) == null ? void 0 : _a.score) == null ? void 0 : _b.combined;
        const targetScore = (_d = (_c = this.getContactByEmail(targetEmail)) == null ? void 0 : _c.score) == null ? void 0 : _d.combined;
        const scoreParts = [sourceScore, targetScore].filter(
          (score) => typeof score === "number"
        );
        const combinedScore = scoreParts.length > 0 ? Math.round(scoreParts.reduce((sum, score) => sum + score, 0) / scoreParts.length) : 0;
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
          targetScore
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
  getContactForPage(page) {
    const email = this.getEmailForPage(page);
    if (!email) return null;
    return this.getContactByEmail(email);
  }
  getEmailForPage(page) {
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
  getContactByEmail(email) {
    var _a;
    if (!this.contactIndex) return null;
    const lower = email.toLowerCase();
    const direct = this.contactIndex.contacts[lower];
    if (direct) return direct;
    for (const contact of Object.values(this.contactIndex.contacts)) {
      if (contact.email.toLowerCase() === lower) return contact;
      if ((_a = contact.aliases) == null ? void 0 : _a.some((alias) => alias.toLowerCase() === lower)) {
        return contact;
      }
    }
    return null;
  }
  parseRoleCompany(role) {
    if (!role) return { role: null, company: null };
    const roleParts = role.split(/\s+at\s+|\s+@\s+/i);
    if (roleParts.length === 2) {
      return {
        role: roleParts[0].trim() || null,
        company: roleParts[1].trim() || null
      };
    }
    const ofMatch = role.match(/^(founder|co[-\s]?founder|owner|principal|partner|managing partner|ceo|cto|cpo|coo|president)\s+of\s+(.+)$/i);
    if (ofMatch) {
      return {
        role: ofMatch[1].trim() || null,
        company: ofMatch[2].trim() || null
      };
    }
    return { role: role.trim() || null, company: null };
  }
  inferCompanyFromDomain(domain) {
    if (!domain) return null;
    const generic = /* @__PURE__ */ new Set([
      "gmail.com",
      "yahoo.com",
      "hotmail.com",
      "outlook.com",
      "icloud.com",
      "aol.com",
      "protonmail.com",
      "me.com",
      "live.com",
      "mail.com"
    ]);
    if (generic.has(domain)) return null;
    const raw = domain.split(".")[0];
    if (!raw) return null;
    return raw.charAt(0).toUpperCase() + raw.slice(1);
  }
  async reviewMergeQueue() {
    var _a;
    const queue = await this.loadMergeQueue();
    const candidates = (_a = queue.candidates) != null ? _a : [];
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
      `updated: ${(/* @__PURE__ */ new Date()).toISOString()}`,
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
      ""
    ];
    const folder = (0, import_obsidian11.normalizePath)(this.settings.peopleFolder);
    if (!this.app.vault.getAbstractFileByPath(folder)) {
      try {
        await this.app.vault.createFolder(folder);
      } catch (e) {
      }
    }
    const path = (0, import_obsidian11.normalizePath)(`${folder}/_Merge Queue.md`);
    const content = lines.join("\n");
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof import_obsidian11.TFile) {
      await this.app.vault.modify(file, content);
      await this.app.workspace.getLeaf().openFile(file);
    } else {
      await this.app.vault.create(path, content);
      const created = this.app.vault.getAbstractFileByPath(path);
      if (created instanceof import_obsidian11.TFile) {
        await this.app.workspace.getLeaf().openFile(created);
      }
    }
    new import_obsidian11.Notice(`Merge queue: ${pending.length} pending, ${applied.length} applied, ${dismissed.length} dismissed`);
  }
  renderMergeCandidates(candidates) {
    var _a, _b;
    if (candidates.length === 0) return ["No merge candidates."];
    const rows = [
      "| Status | Primary | Merged | Canonical ID | Action | Source |",
      "| --- | --- | --- | --- | --- | --- |"
    ];
    for (const candidate of candidates) {
      const primary = this.getContactByEmail(candidate.aEmail);
      const merged = this.getContactByEmail(candidate.bEmail);
      const canonicalId = (_b = (_a = primary == null ? void 0 : primary.canonicalId) != null ? _a : merged == null ? void 0 : merged.canonicalId) != null ? _b : "";
      rows.push([
        this.escapeTableCell(candidate.status),
        this.mergeCandidateCell(candidate.aName, candidate.aEmail),
        this.mergeCandidateCell(candidate.bName, candidate.bEmail),
        canonicalId ? `\`${this.escapeTableCell(canonicalId)}\`` : "",
        this.mergeCandidateActionCell(candidate),
        this.escapeTableCell(candidate.source)
      ].join(" | ").replace(/^/, "| ").replace(/$/, " |"));
    }
    return rows;
  }
  mergeCandidateCell(name, email) {
    var _a;
    const contact = this.getContactByEmail(email);
    const aliases = ((_a = contact == null ? void 0 : contact.aliases) == null ? void 0 : _a.length) ? `<br>Aliases: ${contact.aliases.map((alias) => this.escapeTableCell(alias)).join(", ")}` : "";
    return `${this.escapeTableCell(name || (contact == null ? void 0 : contact.name) || email)}<br><code>${this.escapeTableCell(email)}</code>${aliases}`;
  }
  mergeCandidateActionCell(candidate) {
    const a = this.escapeTableCell(candidate.aEmail);
    const b = this.escapeTableCell(candidate.bEmail);
    if (candidate.status === "pending") {
      return [
        `Apply: <code>bin/peoplegraph apply-merge ${a} ${b}</code>`,
        `Dismiss: <code>bin/peoplegraph dismiss-merge ${a} ${b} --reason not_duplicate</code>`
      ].join("<br>");
    }
    if (candidate.status === "dismissed") {
      const reason = candidate.dismissReason ? `<br>Reason: ${this.escapeTableCell(candidate.dismissReason)}` : "";
      return `Reopen: <code>bin/peoplegraph propose-merge ${a} ${b}</code>${reason}`;
    }
    return "";
  }
  escapeTableCell(value) {
    return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
  }
  async createBase() {
    try {
      const basePath = await createBaseView(this.app.vault, this.settings.peopleFolder);
      new import_obsidian11.Notice(`CRM Base created at ${basePath}`);
      const file = this.app.vault.getAbstractFileByPath(basePath);
      if (file instanceof import_obsidian11.TFile) {
        await this.app.workspace.getLeaf().openFile(file);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      new import_obsidian11.Notice(`Failed to create Base: ${msg}`);
    }
  }
  async refreshBaseView() {
    try {
      await createBaseView(this.app.vault, this.settings.peopleFolder);
    } catch (e) {
    }
  }
  async refreshQuadrantView() {
    try {
      await writeQuadrantView(this.app.vault, this.settings.peopleFolder);
    } catch (e) {
      console.warn("[Gmail CRM] Quadrant view write failed", e);
    }
  }
  async createQuadrantView() {
    try {
      const path = await writeQuadrantView(this.app.vault, this.settings.peopleFolder);
      new import_obsidian11.Notice(`Quadrant view written to ${path}`);
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof import_obsidian11.TFile) {
        await this.app.workspace.getLeaf().openFile(file);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      new import_obsidian11.Notice(`Failed to write quadrant view: ${msg}`);
    }
  }
};
