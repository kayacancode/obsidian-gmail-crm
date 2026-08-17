export interface GmailCrmSettings {
	clientId: string;
	clientSecret: string;
	useCustomOAuth: boolean; // false = use built-in shared credentials
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
	autoUpdateStaleness: boolean; // run staleness update after each sync
	stalenessUpdateInterval: number; // 0 = only on sync, otherwise hours between auto-updates
	excludeCategories: string; // comma-separated Gmail categories to skip (promotions,social,updates,forums)
	excludeLabels: string; // comma-separated Gmail labels to skip (e.g. shop@,service@)
	// betaworks os score push
	betaworksOsUrl: string; // e.g. https://betaworks-os.<acct>.workers.dev — empty disables
	betaworksPartnerEmail: string; // identity shown in betaworks os ("john@betaworks.com")
	betaworksSalienceKey: string; // Salience API key, used to authenticate the push
	autoPushScores: boolean; // push after each staleness update
	// people graph web view (apps/people-graph)
	graphPushUrl: string; // people-graph deployment URL — empty disables
	graphPushToken: string; // push token minted on the web app
	graphPushSalt: string; // vault-local salt for opaque node ids; auto-generated
	debugScoring: boolean; // log a line per contact while scoring (slow on large vaults)
	lastSyncAt: number; // epoch ms of the last completed sync; 0 = never
	lastScoredAt: number; // epoch ms of the last scoring pass; pages touched since then get rewritten
}

export const CONTACT_INDEX_SCHEMA_VERSION = 1;

export const DEFAULT_SETTINGS: GmailCrmSettings = {
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
	stalenessUpdateInterval: 0, // 0 = only after sync, not on its own timer
	excludeCategories: "promotions,social", // skip promo and social by default
	excludeLabels: "", // user-configured labels to skip
	betaworksOsUrl: "",
	betaworksPartnerEmail: "",
	betaworksSalienceKey: "",
	autoPushScores: true,
	graphPushUrl: "",
	graphPushToken: "",
	graphPushSalt: "", // generated on first push
	debugScoring: false,
	lastSyncAt: 0,
	lastScoredAt: 0,
};

export interface ContactScore {
	depth: number;
	recency: number;
	combined: number;
	quadrant: "nurture" | "re-engage" | "developing" | "deprioritize";
	strength: number;
	momentum: number;
	staleness: number;
	label: "active" | "warm" | "cooling" | "stale" | "dormant";
	updatedAt: string;
}

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
	// Optional canonical ID for linking to an external shared contact graph.
	// Populated by external sync commands; absent on records that haven't been
	// reconciled with an external graph.
	canonicalId?: string;
	aliases?: string[]; // alternate emails for the same person
	lastCanonicalSync?: string; // ISO date of last reconcile with shared graph
	// Calendar meeting signals (populated by calendar-sync)
	calendarMeetings?: number;       // total shared calendar events
	calendarAccepted?: number;       // events where BOTH accepted
	calendarLastMeeting?: string;    // ISO date of most recent shared meeting
	calendarOrganizedByThem?: number; // events they organized with owner as attendee
	calendarMeetingsLast90d?: number; // meetings in last 90 days
	// Email open tracking (from Superhuman read receipts)
	openCount?: number;         // total opens on recent outbound emails
	lastOpenAt?: string;        // ISO timestamp of most recent open
	openEngagement?: string;    // "none" | "sent_no_open" | "opened" | "multi_opened" | "replied"
	role?: string;
	company?: string;
	score?: ContactScore;
	relationshipDepth?: number;
	relationshipRecency?: number;
	combinedScore?: number;
	quadrant?: "nurture" | "re-engage" | "developing" | "deprioritize";
	// Relationship-graph edge count from the last full pass. Persisted so the
	// incremental pass can score without rebuilding the graph.
	connections?: number;
}

export interface ContactEdge {
	sourceEmail: string;
	sourceName: string;
	targetEmail: string;
	targetName: string;
	type: Relationship["type"];
	context: string;
	combinedScore: number;
	sourceScore?: number;
	targetScore?: number;
}

export interface ContactIndex {
	schemaVersion: number;
	lastSync: string;
	userEmail: string;
	contacts: Record<string, Contact>; // keyed by email
	edges: ContactEdge[];
}

// Local cache of already-processed message IDs to avoid re-fetching metadata.
// Stored in message-cache.json alongside contact-index.json.
export interface MessageCache {
	processedIds: string[]; // message IDs we've already fetched & processed
	lastSync: string;       // ISO date of last sync; processedIds drives metadata-safe incremental sync
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
	emails: string[];
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
	profileEmail?: string;
	profileSourcePreferred?: boolean;
	// Calendar meeting signals (mirrored from Contact for scoring)
	calendarMeetings?: number;
	calendarAccepted?: number;
	calendarLastMeeting?: string;
	calendarOrganizedByThem?: number;
	calendarMeetingsLast90d?: number;
	// Email open tracking (from Superhuman read receipts)
	openCount?: number;
	lastOpenAt?: string;
	openEngagement?: string;
}

export interface Relationship {
	target: string;
	type: "wiki_link" | "introduced_by" | "introduced" | "text_mention" | "shared_meeting";
	context: string;
}

export type RelationshipGraph = Record<string, Relationship[]>;
