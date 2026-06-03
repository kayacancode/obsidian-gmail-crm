import { requestUrl } from "obsidian";
import type { GmailCrmSettings, Contact } from "./types";

const CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3";

interface CalendarAttendee {
	email: string;
	responseStatus: "accepted" | "declined" | "tentative" | "needsAction";
	organizer?: boolean;
	self?: boolean;
}

interface CalendarEvent {
	summary?: string;
	status?: string;
	start?: { dateTime?: string; date?: string };
	end?: { dateTime?: string; date?: string };
	attendees?: CalendarAttendee[];
	organizer?: { email?: string; self?: boolean };
}

interface CalendarListResponse {
	items?: CalendarEvent[];
	nextPageToken?: string;
}

interface CalendarStats {
	meetings: number;
	accepted: number;
	organizedByThem: number;
	meetingsLast90d: number;
	lastMeeting: string | null; // ISO date
}

/**
 * Fetch calendar events and merge meeting stats into existing contacts.
 * Resilient: if the Calendar API is inaccessible (missing scope, 403, etc.)
 * we log a warning and return without modifying contacts.
 */
export async function syncCalendarData(
	settings: GmailCrmSettings,
	contacts: Record<string, Contact>,
	userEmail?: string
): Promise<void> {
	if (!settings.accessToken) {
		console.warn("[Gmail CRM] Calendar sync skipped — no access token");
		return;
	}

	try {
		const ownerEmail = (userEmail ?? "").toLowerCase();
		const stats = await fetchCalendarStats(settings, ownerEmail);
		mergeCalendarStats(contacts, stats);
		console.log(`[Gmail CRM] Calendar sync complete — updated ${stats.size} contacts`);
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e);
		// Don't throw — calendar data is additive / optional
		console.warn(`[Gmail CRM] Calendar sync failed (non-fatal): ${msg}`);
	}
}

async function getHeaders(settings: GmailCrmSettings): Promise<Record<string, string>> {
	// Token refresh is handled by the caller (main.ts ensures fresh token
	// before invoking calendar sync via the GmailApi instance). We just use
	// the current access token.
	return { Authorization: `Bearer ${settings.accessToken}` };
}

async function fetchCalendarStats(
	settings: GmailCrmSettings,
	ownerEmail: string
): Promise<Map<string, CalendarStats>> {
	const headers = await getHeaders(settings);
	const now = new Date();
	const yearAgo = new Date(now.getTime() - 365 * 86_400_000);
	const ninetyDaysAgo = new Date(now.getTime() - 90 * 86_400_000);

	const timeMin = yearAgo.toISOString();
	const timeMax = now.toISOString();

	const statsMap = new Map<string, CalendarStats>();
	let pageToken: string | undefined;

	do {
		const params = new URLSearchParams({
			timeMin,
			timeMax,
			maxResults: "2500",
			singleEvents: "true",
			fields: "items(summary,start,end,attendees,organizer,status),nextPageToken",
		});
		if (pageToken) params.set("pageToken", pageToken);

		const url = `${CALENDAR_API_BASE}/calendars/primary/events?${params.toString()}`;

		const resp = await requestUrl({ url, headers, throw: false });

		if (resp.status === 401 || resp.status === 403) {
			throw new Error(
				`Calendar API returned ${resp.status}. ` +
				"You may need to re-authenticate to grant the calendar.events.readonly scope."
			);
		}
		if (resp.status < 200 || resp.status >= 300) {
			throw new Error(`Calendar API HTTP ${resp.status}: ${(resp.text ?? "").slice(0, 300)}`);
		}

		const data: CalendarListResponse = resp.json;
		const events = data.items ?? [];

		for (const event of events) {
			if (event.status === "cancelled") continue;
			if (!event.attendees || event.attendees.length === 0) continue;

			const eventStart = event.start?.dateTime ?? event.start?.date ?? "";
			if (!eventStart) continue;

			const eventDate = new Date(eventStart);
			const isLast90d = eventDate >= ninetyDaysAgo;

			// Find the owner's attendance status
			const ownerAttendee = event.attendees.find(
				(a) => a.self || a.email?.toLowerCase() === ownerEmail
			);
			const ownerAccepted = ownerAttendee?.responseStatus === "accepted";

			// Who organized this event?
			const organizerEmail = event.organizer?.email?.toLowerCase() ?? "";
			const organizerIsSelf = event.organizer?.self ?? false;

			for (const attendee of event.attendees) {
				if (attendee.self) continue;
				const email = attendee.email?.toLowerCase();
				if (!email) continue;
				if (email === ownerEmail) continue;

				let stat = statsMap.get(email);
				if (!stat) {
					stat = {
						meetings: 0,
						accepted: 0,
						organizedByThem: 0,
						meetingsLast90d: 0,
						lastMeeting: null,
					};
					statsMap.set(email, stat);
				}

				stat.meetings++;

				// Both the owner and this attendee accepted
				if (ownerAccepted && attendee.responseStatus === "accepted") {
					stat.accepted++;
				}

				// They organized, owner is attendee
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

function mergeCalendarStats(
	contacts: Record<string, Contact>,
	stats: Map<string, CalendarStats>
): void {
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
