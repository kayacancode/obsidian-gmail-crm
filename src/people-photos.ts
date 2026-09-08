import { requestUrl } from "obsidian";
import type { GmailCrmSettings, Contact } from "./types";

/**
 * Contact photos and titles from the Google People API.
 *
 * Gmail itself carries no photos. They live in People API, behind two extra
 * scopes: contacts.readonly (saved contacts) and contacts.other.readonly
 * ("Other contacts": people you have emailed but never saved, which is most
 * of a Gmail-derived CRM). Both are additive and non-fatal: if the token was
 * minted before the scopes were added, Google answers 403 and we leave the
 * contacts untouched.
 */

const PEOPLE_API_BASE = "https://people.googleapis.com/v1";
const PAGE_SIZE = 1000;
// Without READ_SOURCE_TYPE_PROFILE, Google returns only placeholder silhouettes
// for people you have emailed but never saved. Verified 2026-09-05: 0 vs 159
// real photos on the same account.
const SOURCES = "sources=READ_SOURCE_TYPE_CONTACT&sources=READ_SOURCE_TYPE_PROFILE";

interface PeoplePhoto {
	url?: string;
	default?: boolean; // true = Google's placeholder silhouette, not a real photo
	metadata?: { primary?: boolean };
}
interface PeopleEmail {
	value?: string;
	metadata?: { primary?: boolean };
}
interface PeopleOrg {
	name?: string;
	title?: string;
	metadata?: { primary?: boolean };
}
interface Person {
	emailAddresses?: PeopleEmail[];
	photos?: PeoplePhoto[];
	organizations?: PeopleOrg[];
}
interface PeopleListResponse {
	connections?: Person[];
	otherContacts?: Person[];
	nextPageToken?: string;
	totalItems?: number;
}

export interface PhotoRecord {
	photoUrl?: string;
	orgName?: string;
	orgTitle?: string;
}

export interface PhotoSyncResult {
	checked: number; // contacts examined
	withPhoto: number; // contacts that now carry a photo
	withOrg: number; // contacts that now carry an organization or title
}

/** Public, unauthenticated favicon for a company domain. Cached by the browser; falls back to a monogram in views. */
export function logoUrlForDomain(domain: string): string {
	return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`;
}

/**
 * Fetch photos and organizations for every contact in the index and merge
 * them in place. Throws on auth errors (401/403) so the caller can prompt a
 * reconnect; swallows nothing else silently.
 */
export async function syncContactPhotos(
	settings: GmailCrmSettings,
	contacts: Record<string, Contact>,
	onProgress?: (msg: string) => void
): Promise<PhotoSyncResult> {
	if (!settings.accessToken) {
		throw new Error("Not connected to Google");
	}
	const headers = { Authorization: `Bearer ${settings.accessToken}` };
	const byEmail = new Map<string, PhotoRecord>();

	// Saved contacts (supports organizations).
	onProgress?.("Reading saved contacts...");
	await listPages(
		`${PEOPLE_API_BASE}/people/me/connections?personFields=emailAddresses,photos,organizations&pageSize=${PAGE_SIZE}&${SOURCES}`,
		headers,
		(resp) => resp.connections ?? [],
		byEmail
	);

	// Other contacts: emailed-but-never-saved. No organizations on this endpoint.
	onProgress?.("Reading other contacts...");
	await listPages(
		`${PEOPLE_API_BASE}/otherContacts?readMask=emailAddresses,photos&pageSize=${PAGE_SIZE}&${SOURCES}`,
		headers,
		(resp) => resp.otherContacts ?? [],
		byEmail
	);

	const checkedAt = new Date().toISOString();
	const result: PhotoSyncResult = { checked: 0, withPhoto: 0, withOrg: 0 };
	for (const contact of Object.values(contacts)) {
		result.checked++;
		const emails = [contact.email, ...(contact.aliases ?? [])].map((e) => e.toLowerCase());
		const rec = emails.map((e) => byEmail.get(e)).find((r) => r !== undefined);
		contact.photoCheckedAt = checkedAt;
		if (rec?.photoUrl && (rec.photoUrl !== contact.photoUrl || !contact.photoUpdatedAt)) {
			contact.photoUrl = rec.photoUrl;
			contact.photoUpdatedAt = Date.now();
		}
		if (rec?.orgName && !contact.company) contact.orgName = rec.orgName;
		if (rec?.orgTitle) contact.orgTitle = rec.orgTitle;
		if (contact.photoUrl) result.withPhoto++;
		if (contact.orgName || contact.orgTitle) result.withOrg++;
	}
	return result;
}

async function listPages(
	baseUrl: string,
	headers: Record<string, string>,
	pick: (resp: PeopleListResponse) => Person[],
	into: Map<string, PhotoRecord>
): Promise<void> {
	let pageToken: string | undefined;
	let pages = 0;
	do {
		const url = pageToken ? `${baseUrl}&pageToken=${encodeURIComponent(pageToken)}` : baseUrl;
		const resp = await requestUrl({ url, headers, throw: false });
		if (resp.status === 401 || resp.status === 403) {
			throw new Error(`HTTP ${resp.status}: People API access denied. Reconnect your account to grant contacts access.`);
		}
		if (resp.status === 429 && pages > 0) {
			await new Promise((r) => setTimeout(r, 15_000));
			continue;
		}
		if (resp.status < 200 || resp.status >= 300) {
			throw new Error(`HTTP ${resp.status}: ${(resp.text ?? "").slice(0, 200)}`);
		}
		const body = resp.json as PeopleListResponse;
		for (const person of pick(body)) absorb(person, into);
		pageToken = body.nextPageToken;
		pages++;
	} while (pageToken && pages < 200);
}

function absorb(person: Person, into: Map<string, PhotoRecord>): void {
	const photo = (person.photos ?? []).find((p) => p.url && !p.default)
		?? undefined;
	const org = (person.organizations ?? []).find((o) => o.metadata?.primary) ?? person.organizations?.[0];
	const rec: PhotoRecord = {};
	if (photo?.url) rec.photoUrl = stripSizeSuffix(photo.url);
	if (org?.name) rec.orgName = org.name;
	if (org?.title) rec.orgTitle = org.title;
	if (!rec.photoUrl && !rec.orgName && !rec.orgTitle) return;
	for (const e of person.emailAddresses ?? []) {
		const email = e.value?.toLowerCase().trim();
		if (!email) continue;
		const existing = into.get(email);
		// First record wins per field. Saved contacts are listed before other
		// contacts, so a photo you chose beats one Google inferred.
		into.set(email, {
			photoUrl: existing?.photoUrl ?? rec.photoUrl,
			orgName: existing?.orgName ?? rec.orgName,
			orgTitle: existing?.orgTitle ?? rec.orgTitle,
		});
	}
}

/** Google photo URLs end in "=s100"; ask for a size views can actually use. */
function stripSizeSuffix(url: string): string {
	return url.replace(/=s\d+(-c)?$/, "=s256-c");
}
