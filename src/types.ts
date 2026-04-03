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
	peopleFolder: string;
	anthropicApiKey: string;
	harperModel: string;
	enrichOnSync: boolean;
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
	peopleFolder: "People pages",
	anthropicApiKey: "",
	harperModel: "claude-sonnet-4-6",
	enrichOnSync: false,
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
}

export interface ContactIndex {
	lastSync: string;
	userEmail: string;
	contacts: Record<string, Contact>; // keyed by email
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
	subjects: string[];
}

export interface Relationship {
	target: string;
	type: "wiki_link" | "introduced_by" | "introduced" | "text_mention" | "shared_meeting";
	context: string;
}

export type RelationshipGraph = Record<string, Relationship[]>;
