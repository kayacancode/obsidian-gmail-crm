import { requestUrl } from "obsidian";
import type {
	GmailCrmSettings,
	GmailTokenResponse,
	GmailMessageMetadata,
	GmailListResponse,
	Contact,
	ContactIndex,
	MessageCache,
} from "./types";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const SCOPES = "https://www.googleapis.com/auth/gmail.metadata";
const REDIRECT_URI = "http://localhost:42813/callback";

// Subject-line pattern used to detect calendar invite / RSVP threads.
// John Borthwick: "single RSVP responses to event invites → weaker relationship"
const RSVP_SUBJECT_PATTERN =
	/\b(invitation|invited|rsvp|calendar invite|meeting invite|you're invited|save the date|event)\b/i;

// Auto-filter: email address patterns that indicate automated/service senders
const AUTOMATED_EMAIL_PATTERN =
	/^(noreply|no-reply|donotreply|do-not-reply|notifications?|updates?|support|info|hello|team|news|newsletter|mailer|digest|alerts?|billing|receipts?|feedback|marketing|sales|admin|system|automated|bounce|postmaster|webmaster)@/i;

// Auto-filter: domains known to be service/software/newsletter senders
const AUTOMATED_DOMAINS = new Set([
	// Cloud / SaaS
	"dropbox.com", "dropboxmail.com", "google.com", "accounts.google.com",
	"docs.google.com", "amazonses.com", "amazonaws.com", "aws.amazon.com",
	"microsoft.com", "sharepointonline.com",
	// Dev tools
	"github.com", "gitlab.com", "bitbucket.org", "vercel.com", "netlify.com",
	"heroku.com", "circleci.com", "travis-ci.com",
	// Newsletters / content
	"substack.com", "substackmail.com", "readwise.io", "medium.com",
	"mailchimp.com", "sendgrid.net", "sendgrid.com", "mailgun.org",
	"mandrillapp.com", "constantcontact.com", "hubspot.com", "hubspotmail.com",
	// Productivity / signing
	"dropboxsign.com", "hellosign.com", "docusign.net", "docusign.com",
	"pandadoc.com", "adobesign.com",
	// Social
	"facebookmail.com", "linkedin.com", "twitter.com", "x.com",
	"instagrammail.com", "tiktok.com",
	// Payments / commerce
	"paypal.com", "stripe.com", "squareup.com", "shopify.com",
	"intuit.com", "quickbooks.intuit.com",
	// Scheduling / calendar
	"calendly.com", "savvycal.com", "cal.com",
	// Project management
	"notion.so", "asana.com", "trello.com", "monday.com",
	"clickup.com", "jira.atlassian.com", "atlassian.com", "atlassian.net",
	// Design
	"figma.com", "canva.com",
	// Other common services
	"zoom.us", "loom.com", "slack.com", "slackbot.com",
	"intercom.io", "intercom-mail.com", "zendesk.com",
	"eventbrite.com", "meetup.com",
]);

// Per-thread state accumulated during index build, keyed by contactEmail -> threadId.
// Not persisted; finalized into Contact counters after all messages are processed.
type ThreadState = {
	sent: number;
	received: number;
	subject: string;
	lastDate: string;
};

export class GmailApi {
	private settings: GmailCrmSettings;
	private onSettingsUpdate: (patch: Partial<GmailCrmSettings>) => Promise<void>;

	constructor(
		settings: GmailCrmSettings,
		onSettingsUpdate: (patch: Partial<GmailCrmSettings>) => Promise<void>
	) {
		this.settings = settings;
		this.onSettingsUpdate = onSettingsUpdate;
	}

	updateSettings(settings: GmailCrmSettings) {
		this.settings = settings;
	}

	getAuthUrl(): string {
		const params = new URLSearchParams({
			client_id: this.settings.clientId,
			redirect_uri: REDIRECT_URI,
			response_type: "code",
			scope: SCOPES,
			access_type: "offline",
			prompt: "consent",
		});
		return `${GOOGLE_AUTH_URL}?${params.toString()}`;
	}

	async exchangeCode(code: string): Promise<void> {
		const resp = await this.apiRequest({
			url: GOOGLE_TOKEN_URL,
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				code,
				client_id: this.settings.clientId,
				client_secret: this.settings.clientSecret,
				redirect_uri: REDIRECT_URI,
				grant_type: "authorization_code",
			}).toString(),
		});

		const data: GmailTokenResponse = resp.json;
		await this.onSettingsUpdate({
			accessToken: data.access_token,
			refreshToken: data.refresh_token ?? this.settings.refreshToken,
			tokenExpiry: Date.now() + data.expires_in * 1000,
		});
	}

	private async refreshAccessToken(): Promise<void> {
		const resp = await this.apiRequest({
			url: GOOGLE_TOKEN_URL,
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				client_id: this.settings.clientId,
				client_secret: this.settings.clientSecret,
				refresh_token: this.settings.refreshToken,
				grant_type: "refresh_token",
			}).toString(),
		});

		const data: GmailTokenResponse = resp.json;
		await this.onSettingsUpdate({
			accessToken: data.access_token,
			tokenExpiry: Date.now() + data.expires_in * 1000,
		});
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private async apiRequest(options: Parameters<typeof requestUrl>[0]): Promise<any> {
		const url = typeof options === "string" ? options : options.url;
		// Pass throw: false so we can read the actual response body on errors.
		// Otherwise Obsidian throws a generic "Request failed, status N" with
		// no body, hiding the real error message from Google.
		const reqOptions = typeof options === "string"
			? { url: options, throw: false }
			: { ...options, throw: false };

		let resp: Awaited<ReturnType<typeof requestUrl>>;
		try {
			resp = await requestUrl(reqOptions);
		} catch (e: unknown) {
			const err = e as Record<string, any>;
			console.error(`[Gmail CRM] Network error`, { url, error: err });
			throw new Error(err?.message ?? "Network request failed");
		}

		if (resp.status >= 200 && resp.status < 300) {
			return resp;
		}

		// Non-2xx: extract the real error from Google's response body
		const status = resp.status;
		const rawBody = resp.text ?? "";
		console.error(`[Gmail CRM] API request failed`, {
			url, status, body: rawBody, headers: resp.headers,
		});

		let detail = "";
		if (rawBody) {
			try {
				const parsed = JSON.parse(rawBody);
				detail = parsed?.error?.message
					?? parsed?.error_description
					?? parsed?.error?.status
					?? JSON.stringify(parsed).slice(0, 300);
			} catch {
				detail = rawBody.slice(0, 300);
			}
		}

		if (!detail) {
			const hints: Record<number, string> = {
				401: "Token expired or invalid. Try disconnecting and reconnecting.",
				403: "Access denied. Check that: (1) Gmail API is enabled in Google Cloud Console, (2) your OAuth consent screen has your email as a test user, (3) the gmail.metadata scope is approved.",
				404: "Endpoint not found. The Gmail API may not be enabled.",
				429: "Rate limited by Google. Wait a few minutes and try again.",
			};
			detail = hints[status] ?? `HTTP ${status}`;
		}

		throw new Error(`HTTP ${status}: ${detail}`);
	}

	private async getHeaders(): Promise<Record<string, string>> {
		if (Date.now() >= this.settings.tokenExpiry - 60_000) {
			await this.refreshAccessToken();
		}
		return { Authorization: `Bearer ${this.settings.accessToken}` };
	}

	async getUserEmail(): Promise<string> {
		const headers = await this.getHeaders();
		const resp = await this.apiRequest({
			url: `${GMAIL_API_BASE}/profile`,
			headers,
		});
		return resp.json.emailAddress;
	}

	async fetchAllMessageIds(
		maxResults: number,
		afterDate?: string
	): Promise<{ id: string; threadId: string }[]> {
		const headers = await this.getHeaders();
		const allMessages: { id: string; threadId: string }[] = [];
		let pageToken: string | undefined;

		while (allMessages.length < maxResults) {
			const params = new URLSearchParams({
				maxResults: String(Math.min(100, maxResults - allMessages.length)),
			});
			if (afterDate) {
				// Gmail q=after: uses YYYY/MM/DD format
				const d = new Date(afterDate);
				const q = `after:${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
				params.set("q", q);
			}
			if (pageToken) params.set("pageToken", pageToken);

			const resp = await this.apiRequest({
				url: `${GMAIL_API_BASE}/messages?${params.toString()}`,
				headers,
			});

			const data: GmailListResponse = resp.json;
			if (!data.messages) break;

			allMessages.push(...data.messages);
			pageToken = data.nextPageToken;
			if (!pageToken) break;
		}

		return allMessages;
	}

	async fetchMessageMetadata(messageId: string): Promise<GmailMessageMetadata> {
		const headers = await this.getHeaders();
		const resp = await this.apiRequest({
			url: `${GMAIL_API_BASE}/messages/${messageId}?format=METADATA&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`,
			headers,
		});
		return resp.json;
	}

	async buildContactIndex(
		maxResults: number,
		onProgress?: (done: number, total: number) => void,
		existingIndex?: ContactIndex | null,
		messageCache?: MessageCache | null
	): Promise<{ index: ContactIndex; cache: MessageCache }> {
		const userEmail = await this.getUserEmail();

		// Incremental sync: if we have a cache, only list messages since last sync
		const afterDate = messageCache?.lastSync ?? undefined;
		const cachedIds = new Set(messageCache?.processedIds ?? []);

		const allMessageIds = await this.fetchAllMessageIds(maxResults, afterDate);

		// Filter out messages we've already processed
		const newMessageIds = allMessageIds.filter((m) => !cachedIds.has(m.id));

		// Start from existing contacts or empty
		const contacts: Record<string, Contact> = existingIndex
			? JSON.parse(JSON.stringify(existingIndex.contacts))
			: {};

		// Per-contact, per-thread state used to compute metadata pattern signals
		// (back-and-forth, thread depth, RSVP-only). Keyed by contactEmail -> threadId.
		const threadStates = new Map<string, Map<string, ThreadState>>();

		// Rebuild thread states from existing contacts so finalize works correctly
		// (thread-level metrics are recomputed from all messages each full sync,
		// but for incremental we need to carry forward existing metrics)
		if (existingIndex && newMessageIds.length > 0) {
			for (const [key, c] of Object.entries(contacts)) {
				// We can't fully reconstruct thread states from aggregate Contact data,
				// so on incremental syncs the thread-level metrics are approximate.
				// A full re-sync (clear cache) will recompute them exactly.
				threadStates.set(key, new Map());
			}
		}

		const BATCH_SIZE = 10;
		for (let i = 0; i < newMessageIds.length; i += BATCH_SIZE) {
			const batch = newMessageIds.slice(i, i + BATCH_SIZE);
			const results = await Promise.all(
				batch.map((m) => this.fetchMessageMetadata(m.id))
			);

			for (const msg of results) {
				this.processMessage(msg, userEmail, contacts, threadStates);
			}

			onProgress?.(Math.min(i + BATCH_SIZE, newMessageIds.length), newMessageIds.length);
		}

		// Only recompute thread metrics if we processed new messages
		if (newMessageIds.length > 0) {
			this.finalizeContactMetrics(contacts, threadStates);
		}

		console.log(`[Gmail CRM] Sync complete`, {
			mode: afterDate ? "incremental" : "full",
			afterDate: afterDate ?? "n/a",
			totalListed: allMessageIds.length,
			alreadyCached: allMessageIds.length - newMessageIds.length,
			newProcessed: newMessageIds.length,
			totalContacts: Object.keys(contacts).length,
		});

		// Log metadata summary for top contacts
		const sorted = Object.values(contacts).sort((a, b) => b.totalExchanges - a.totalExchanges);
		for (const c of sorted.slice(0, 20)) {
			console.log(`[Gmail CRM] Contact: ${c.name} <${c.email}>`, {
				exchanges: c.totalExchanges,
				sent: c.sentCount,
				received: c.receivedCount,
				threads: c.threadCount ?? 0,
				backAndForth: c.backAndForthThreads ?? 0,
				maxDepth: c.maxThreadDepth ?? 0,
				lastDepth: c.lastThreadDepth ?? 0,
				rsvpOnly: c.rsvpOnlyThreads ?? 0,
				firstContact: c.firstContact,
				lastContact: c.lastContact,
				domain: c.domain,
			});
		}

		// Update cache with all known IDs
		for (const m of allMessageIds) {
			cachedIds.add(m.id);
		}

		const updatedCache: MessageCache = {
			processedIds: Array.from(cachedIds),
			lastSync: new Date().toISOString(),
		};

		return {
			index: {
				lastSync: new Date().toISOString(),
				userEmail,
				contacts,
			},
			cache: updatedCache,
		};
	}

	private processMessage(
		msg: GmailMessageMetadata,
		userEmail: string,
		contacts: Record<string, Contact>,
		threadStates: Map<string, Map<string, ThreadState>>
	) {
		const headers = msg.payload.headers;
		const from = this.getHeader(headers, "From");
		const to = this.getHeader(headers, "To");
		const subject = this.getHeader(headers, "Subject") ?? "";
		const date = new Date(parseInt(msg.internalDate)).toISOString();
		const threadId = msg.threadId;

		const fromParsed = this.parseEmailAddress(from ?? "");
		const toParsed = this.parseEmailAddress(to ?? "");

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

	private isFiltered(email: string): boolean {
		const lower = email.toLowerCase();
		const domain = lower.split("@")[1] ?? "";

		// Auto-filter: noreply patterns
		if (AUTOMATED_EMAIL_PATTERN.test(lower)) return true;

		// Auto-filter: known service domains
		if (AUTOMATED_DOMAINS.has(domain)) return true;

		// User blocklist from settings
		if (this.blockedDomains.has(domain)) return true;

		return false;
	}

	private get blockedDomains(): Set<string> {
		const raw = this.settings.blockedDomains ?? "";
		return new Set(
			raw.split(",")
				.map((d) => d.trim().toLowerCase())
				.filter(Boolean)
		);
	}

	private upsertContact(
		contacts: Record<string, Contact>,
		threadStates: Map<string, Map<string, ThreadState>>,
		parsed: { name: string; email: string },
		date: string,
		subject: string,
		threadId: string,
		direction: "sent" | "received"
	) {
		const key = parsed.email.toLowerCase();
		const domain = parsed.email.split("@")[1]?.toLowerCase() ?? "";
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
				domain,
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

		// Track per-thread state for metadata signal computation
		let contactThreads = threadStates.get(key);
		if (!contactThreads) {
			contactThreads = new Map();
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
	private finalizeContactMetrics(
		contacts: Record<string, Contact>,
		threadStates: Map<string, Map<string, ThreadState>>
	) {
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

				// Real conversation loop: both sides participated AND >= 3 messages
				if (state.sent > 0 && state.received > 0 && depth >= 3) {
					backAndForth++;
				}

				// Single-message thread with an invite/RSVP subject
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

	private getHeader(
		headers: { name: string; value: string }[],
		name: string
	): string | undefined {
		return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
	}

	private parseEmailAddress(
		raw: string
	): { name: string; email: string } | null {
		const match = raw.match(/^(?:"?([^"<]*)"?\s*)?<?([^>]+@[^>]+)>?$/);
		if (!match) return null;
		return {
			name: (match[1] ?? "").trim(),
			email: match[2].trim(),
		};
	}
}
