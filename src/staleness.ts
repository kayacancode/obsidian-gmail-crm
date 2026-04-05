import type { PersonPage, Relationship } from "./types";

export interface StalenessScore {
	score: number; // 0-100, 100 = very fresh, 0 = completely stale
	label: "active" | "warm" | "cooling" | "stale" | "dormant";
	daysSinceContact: number | null;
	relationshipStrength: "strong" | "moderate" | "weak" | "unknown";
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
		nudge,
	};
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
