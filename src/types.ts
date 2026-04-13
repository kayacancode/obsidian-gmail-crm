export interface GmailCrmSettings {
	clientId: string;
	clientSecret: string;
	accessToken: string;
	refreshToken: string;
	tokenExpiry: number;
	syncIntervalMinutes: number;
	maxResults: number;
	createContactNotes: boolean;
	contactNotesFolder: string;
	// Harper Skill / Relationship mapping
	vaultOwnerName: string;
	peopleFolder: string;
	companiesFolder: string;
	anthropicApiKey: string;
	harperModel: string;
	enrichOnSync: boolean;
	blockedDomains: string; // comma-separated domains to exclude
}

export const DEFAULT_SETTINGS: GmailCrmSettings = {
	clientId: "",
	clientSecret: "",
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
};

export interface Contact {
	name: string;
	email: string;
	lastContact: string; // ISO date
	firstContact: string; // ISO date
	sentCount: number;
	receivedCount: number;
	totalExchanges: number;
	subjects: string[]; // last N subject lines
	lastSubject: string; // most recent subject line
	domain: string; // email domain (company signal)
	// Metadata pattern signals (optional for backward compat with older cached indexes)
	threadCount?: number; // distinct threads with this contact
	maxThreadDepth?: number; // longest thread in messages
	backAndForthThreads?: number; // threads with both directions and >=3 messages
	rsvpOnlyThreads?: number; // single-message threads matching invite/RSVP pattern
	lastThreadDepth?: number; // depth of the thread containing the most recent message
}

export interface ContactIndex {
	lastSync: string;
	userEmail: string;
	contacts: Record<string, Contact>; // keyed by email
}

// Local cache of already-processed message IDs to avoid re-fetching metadata.
// Stored in message-cache.json alongside contact-index.json.
export interface MessageCache {
	processedIds: string[]; // message IDs we've already fetched & processed
	lastSync: string;       // ISO date of last sync (used for after: query)
}

export interface GmailTokenResponse {
	access_token: string;
	refresh_token?: string;
	expires_in: number;
	token_type: string;
}

export interface GmailMessageHeader {
	name: string;
	value: string;
}

export interface GmailMessageMetadata {
	id: string;
	threadId: string;
	payload: {
		headers: GmailMessageHeader[];
	};
	internalDate: string;
}

export interface GmailListResponse {
	messages?: { id: string; threadId: string }[];
	nextPageToken?: string;
	resultSizeEstimate?: number;
}

// Relationship mapping types

export interface PersonPage {
	name: string;
	path: string;
	content: string;
	wikiLinks: string[];
	email: string | null;
	role: string | null;
	introducer: string | null;
	meetings: { date: string; title: string }[];
	howKnown: string | null;
	keyContext: string | null;
	gmailStats: GmailStats | null;
}

export interface GmailStats {
	totalExchanges: number;
	sentCount: number;
	receivedCount: number;
	lastContact: string;
	firstContact?: string;
	subjects: string[];
	lastSubject: string;
	domain: string;
	// Metadata pattern signals — surfaced to staleness/depth scoring
	threadCount?: number;
	maxThreadDepth?: number;
	backAndForthThreads?: number;
	rsvpOnlyThreads?: number;
	lastThreadDepth?: number;
}

export interface Relationship {
	target: string;
	type: "wiki_link" | "introduced_by" | "introduced" | "text_mention" | "shared_meeting";
	context: string;
}

export type RelationshipGraph = Record<string, Relationship[]>;
