import { requestUrl } from "obsidian";
import type { PersonPage } from "./types";
import type { StalenessScore } from "./staleness";

export interface BetaworksPushConfig {
	url: string;
	partnerEmail: string;
	salienceKey: string;
}

export interface ScoredPage {
	page: PersonPage;
	staleness: StalenessScore;
}

/** POST a full score snapshot to betaworks os. Returns pushed contact count. */
export async function pushScoresToBetaworks(
	config: BetaworksPushConfig,
	scored: ScoredPage[]
): Promise<number> {
	const contacts = scored
		.filter(({ page }) => page.email || page.emails.length > 0)
		.map(({ page, staleness }) => ({
			email: page.email ?? page.emails[0],
			emails: page.emails,
			name: page.name,
			strengthScore: staleness.strengthScore,
			momentumScore: staleness.momentumScore,
			combinedScore: staleness.combinedScore,
			quadrant: staleness.quadrant,
			lastContact: page.gmailStats?.lastContact ?? null,
		}));

	const res = await requestUrl({
		url: `${config.url.replace(/\/$/, "")}/api/scores/push`,
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-Api-Key": config.salienceKey,
		},
		body: JSON.stringify({
			partner: config.partnerEmail,
			pushedAt: new Date().toISOString(),
			contacts,
		}),
		throw: false,
	});
	if (res.status !== 200) {
		throw new Error(`betaworks os push failed (${res.status}): ${res.text}`);
	}
	return contacts.length;
}
