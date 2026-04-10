import type { PersonPage, Relationship } from "./types";

export interface StalenessScore {
	score: number; // 0-100, 100 = very fresh, 0 = completely stale
	label: "active" | "warm" | "cooling" | "stale" | "dormant";
	daysSinceContact: number | null;
	relationshipStrength: "strong" | "moderate" | "weak" | "unknown";
	// Numerical scores per John Borthwick's feedback. These complement the
	// existing string-based `relationshipStrength` and `label` fields rather than
	// replacing them.
	relationshipDepth: number; // 1–5, driven by email metadata patterns
	relationshipRecency: number; // 1–10, driven by days since last contact
	nudge: string | null; // suggested re-engagement reason, null if not stale
}

export function computeStaleness(
	page: PersonPage,
	relationships: Relationship[]
): StalenessScore {
	const gmail = page.gmailStats;
	const now = Date.now();

	// If no Gmail data, try to extract last contact from page content
	let daysSinceContact: number | null = null;
	let totalExchanges = 0;

	if (gmail) {
		const lastDate = new Date(gmail.lastContact).getTime();
		daysSinceContact = Math.floor((now - lastDate) / 86_400_000);
		totalExchanges = gmail.totalExchanges;
	} else {
		// Try meeting dates as fallback
		const meetingDates = page.meetings
			.map((m) => new Date(m.date).getTime())
			.filter((t) => !isNaN(t));
		if (meetingDates.length > 0) {
			const latest = Math.max(...meetingDates);
			daysSinceContact = Math.floor((now - latest) / 86_400_000);
		}
	}

	// Relationship strength from email volume + relationship edges
	const relationshipStrength = computeStrength(totalExchanges, relationships.length);

	// 1–5 numerical scores (John Borthwick's feedback)
	const relationshipRecency = computeRecency(daysSinceContact);
	const relationshipDepth = computeDepth(gmail, totalExchanges, relationships.length);

	// Staleness score (0-100)
	let score: number;
	if (daysSinceContact === null) {
		score = 0; // no data = treat as dormant
	} else if (daysSinceContact <= 7) {
		score = 100;
	} else if (daysSinceContact <= 30) {
		score = 90 - (daysSinceContact - 7) * (20 / 23); // 90 -> 70
	} else if (daysSinceContact <= 90) {
		score = 70 - (daysSinceContact - 30) * (30 / 60); // 70 -> 40
	} else if (daysSinceContact <= 180) {
		score = 40 - (daysSinceContact - 90) * (25 / 90); // 40 -> 15
	} else {
		score = Math.max(0, 15 - (daysSinceContact - 180) * (15 / 180)); // 15 -> 0
	}

	// Boost score for high-volume relationships
	if (totalExchanges > 50) score = Math.min(100, score + 10);
	else if (totalExchanges > 20) score = Math.min(100, score + 5);

	// Boost for many relationship edges (well-connected in the graph)
	if (relationships.length > 5) score = Math.min(100, score + 5);

	score = Math.round(score);

	const label = scoreToLabel(score);

	// Generate nudge for stale/cooling relationships that were once strong
	let nudge: string | null = null;
	if (label === "stale" || label === "dormant") {
		if (relationshipStrength === "strong" || relationshipStrength === "moderate") {
			nudge = generateNudge(page, daysSinceContact, totalExchanges);
		} else if (label === "dormant") {
			nudge = "No recent contact — consider if re-engagement is worthwhile";
		}
	} else if (label === "cooling" && relationshipStrength === "strong") {
		nudge = generateNudge(page, daysSinceContact, totalExchanges);
	}

	return {
		score,
		label,
		daysSinceContact,
		relationshipStrength,
		relationshipDepth,
		relationshipRecency,
		nudge,
	};
}

// Relationship recency on a 1–10 scale for finer granularity.
//   10 = today/yesterday, 1 = over a year ago or no data
function computeRecency(daysSinceContact: number | null): number {
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

// Relationship depth on a 1–5 scale, driven by metadata patterns per John:
//   "personal back-and-forth replies → stronger; single RSVP responses → weaker;
//    reply frequency and thread depth as key strength signals"
// Prefers metadata signals when Gmail data is available; falls back to the
// existing volume-based heuristic when no thread metadata is present (e.g.,
// cached indexes built before task #4 landed).
function computeDepth(
	gmail: PersonPage["gmailStats"],
	totalExchanges: number,
	edgeCount: number
): number {
	if (!gmail) {
		// No Gmail data — fall back to relationship-graph edges alone
		if (edgeCount >= 5) return 3;
		if (edgeCount >= 2) return 2;
		return 1;
	}

	const backAndForth = gmail.backAndForthThreads ?? 0;
	const maxThread = gmail.maxThreadDepth ?? 0;
	const rsvpOnly = gmail.rsvpOnlyThreads ?? 0;
	const threadCount = gmail.threadCount ?? 0;

	// If we have no thread metadata at all, fall back to the volume heuristic
	// used before metadata tracking existed.
	if (threadCount === 0 && totalExchanges > 0) {
		if (totalExchanges >= 20) return 4;
		if (totalExchanges >= 8) return 3;
		if (totalExchanges >= 3) return 2;
		return 1;
	}

	// Real conversations with many messages → deepest relationship
	if (backAndForth >= 3 && totalExchanges >= 20 && maxThread >= 5) return 5;
	// Some real conversations and solid volume
	if (backAndForth >= 1 && totalExchanges >= 8) return 4;
	// Moderate volume with at least one multi-message thread
	if (totalExchanges >= 8 && maxThread >= 3) return 3;
	// Some exchanges but mostly shallow — drop a notch if most are RSVPs
	if (totalExchanges >= 3) {
		if (rsvpOnly > 0 && rsvpOnly >= threadCount / 2) return 1;
		return 2;
	}
	return 1;
}

function computeStrength(
	totalExchanges: number,
	edgeCount: number
): "strong" | "moderate" | "weak" | "unknown" {
	if (totalExchanges === 0 && edgeCount === 0) return "unknown";
	if (totalExchanges === 0) {
		// No email data — edges alone can't make you "strong"
		if (edgeCount >= 5) return "moderate";
		if (edgeCount >= 2) return "weak";
		return "unknown";
	}
	// Email-based strength
	if (totalExchanges >= 20) return "strong";
	if (totalExchanges >= 8) return "moderate";
	return "weak";
}

function scoreToLabel(score: number): StalenessScore["label"] {
	if (score >= 70) return "active";
	if (score >= 50) return "warm";
	if (score >= 30) return "cooling";
	if (score >= 10) return "stale";
	return "dormant";
}

function generateNudge(
	page: PersonPage,
	days: number | null,
	exchanges: number
): string {
	const parts: string[] = [];

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

	return parts.join(" — ") || "Consider re-engaging";
}
