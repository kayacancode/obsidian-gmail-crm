import { requestUrl } from "obsidian";
import type {
	GmailCrmSettings,
	GmailTokenResponse,
	GmailMessageMetadata,
	GmailListResponse,
	Contact,
	ContactIndex,
} from "./types";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const SCOPES = "https://www.googleapis.com/auth/gmail.metadata";
const REDIRECT_URI = "http://localhost:42813/callback";

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
		const resp = await requestUrl({
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
		const resp = await requestUrl({
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

	private async getHeaders(): Promise<Record<string, string>> {
		if (Date.now() >= this.settings.tokenExpiry - 60_000) {
			await this.refreshAccessToken();
		}
		return { Authorization: `Bearer ${this.settings.accessToken}` };
	}

	async getUserEmail(): Promise<string> {
		const headers = await this.getHeaders();
		const resp = await requestUrl({
			url: `${GMAIL_API_BASE}/profile`,
			headers,
		});
		return resp.json.emailAddress;
	}

	async fetchAllMessageIds(
		maxResults: number
	): Promise<{ id: string; threadId: string }[]> {
		const headers = await this.getHeaders();
		const allMessages: { id: string; threadId: string }[] = [];
		let pageToken: string | undefined;

		while (allMessages.length < maxResults) {
			const params = new URLSearchParams({
				maxResults: String(Math.min(100, maxResults - allMessages.length)),
			});
			if (pageToken) params.set("pageToken", pageToken);

			const resp = await requestUrl({
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
		const resp = await requestUrl({
			url: `${GMAIL_API_BASE}/messages/${messageId}?format=METADATA&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`,
			headers,
		});
		return resp.json;
	}

	async buildContactIndex(
		maxResults: number,
		onProgress?: (done: number, total: number) => void
	): Promise<ContactIndex> {
		const userEmail = await this.getUserEmail();
		const messageIds = await this.fetchAllMessageIds(maxResults);
		const contacts: Record<string, Contact> = {};

		const BATCH_SIZE = 10;
		for (let i = 0; i < messageIds.length; i += BATCH_SIZE) {
			const batch = messageIds.slice(i, i + BATCH_SIZE);
			const results = await Promise.all(
				batch.map((m) => this.fetchMessageMetadata(m.id))
			);

			for (const msg of results) {
				this.processMessage(msg, userEmail, contacts);
			}

			onProgress?.(Math.min(i + BATCH_SIZE, messageIds.length), messageIds.length);
		}

		return {
			lastSync: new Date().toISOString(),
			userEmail,
			contacts,
		};
	}

	private processMessage(
		msg: GmailMessageMetadata,
		userEmail: string,
		contacts: Record<string, Contact>
	) {
		const headers = msg.payload.headers;
		const from = this.getHeader(headers, "From");
		const to = this.getHeader(headers, "To");
		const subject = this.getHeader(headers, "Subject") ?? "";
		const date = new Date(parseInt(msg.internalDate)).toISOString();

		const fromParsed = this.parseEmailAddress(from ?? "");
		const toParsed = this.parseEmailAddress(to ?? "");

		if (!fromParsed) return;

		const isSent = fromParsed.email.toLowerCase() === userEmail.toLowerCase();

		if (isSent && toParsed) {
			this.upsertContact(contacts, toParsed, date, subject, "sent");
		} else if (!isSent) {
			this.upsertContact(contacts, fromParsed, date, subject, "received");
		}
	}

	private upsertContact(
		contacts: Record<string, Contact>,
		parsed: { name: string; email: string },
		date: string,
		subject: string,
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
