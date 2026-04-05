import { requestUrl } from "obsidian";
import type { PersonPage, Relationship } from "./types";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";

export class HarperSkill {
	private apiKey: string;
	private model: string;

	constructor(apiKey: string, model: string) {
		this.apiKey = apiKey;
		this.model = model;
	}

	async rewritePersonPage(
		name: string,
		page: PersonPage,
		relationships: Relationship[],
		allPages: Record<string, PersonPage>
	): Promise<string> {
		// Build relationship context with wiki links
		const relLines = relationships.map(
			(r) => `- [[p- ${r.target}]] (${r.type.replace(/_/g, " ")}): ${r.context}`
		);
		const relText = relLines.length > 0 ? relLines.join("\n") : "No mapped relationships yet.";

		// Build connected people summaries (top 15)
		const seen = new Set<string>();
		const connected: string[] = [];
		for (const r of relationships.slice(0, 15)) {
			if (seen.has(r.target) || !allPages[r.target]) continue;
			seen.add(r.target);
			const p = allPages[r.target];
			connected.push(
				`**${r.target}** — ${p.role ?? "Unknown role"}. ${p.howKnown ?? ""} ${p.keyContext ?? ""}`
			);
		}
		const connectedText = connected.length > 0 ? connected.join("\n") : "None";

		// Gmail stats
		let gmailText = "No Gmail data linked.";
		if (page.gmailStats) {
			const g = page.gmailStats;
			gmailText = [
				`Total emails: ${g.totalExchanges} (sent: ${g.sentCount}, received: ${g.receivedCount})`,
				`Last contact: ${g.lastContact.split("T")[0]}`,
				`Recent subjects: ${g.subjects.slice(0, 5).join(", ")}`,
			].join("\n");
		}

		const today = new Date().toISOString().split("T")[0];

		const prompt = `You are Harper Skill — an AI relationship intelligence analyst. You are rewriting a people page in Kaya Jones's Obsidian vault.

Your job: take ALL the existing information about this person and produce a comprehensive, well-structured people page. Preserve every fact, meeting, action item, and detail from the original — lose nothing. Then enrich it with relationship mapping, strategic analysis, and suggested actions.

## Person: ${name}

## EXISTING PAGE CONTENT (preserve all facts, meetings, action items):
${page.content}

## MAPPED RELATIONSHIPS (from graph analysis):
${relText}

## CONNECTED PEOPLE IN KAYA'S NETWORK:
${connectedText}

## GMAIL COMMUNICATION STATS:
${gmailText}

---

Rewrite the full people page in this exact structure. Use Obsidian wiki links like [[p- Name]] when referencing other people. Preserve ALL meeting history entries verbatim — do not summarize or remove any meetings. Keep all action items, decisions, and details from the original.

Output the complete page in markdown (no code fences). Start with the h1 heading. Use this structure:

# ${name}

## Overview
- **Role/Company:** ...
- **Email:** ...
- **Connection:** how they connect to Kaya's network
- **How Kaya knows them:** ...
- **Key context:** ...

## Background
A 2-3 sentence bio synthesized from all available information.

## Relationship Map
For each key connection in Kaya's network:
- [[p- Name]] — connection type, strength signal, thematic link

## Key Themes & Interests
3-5 bullets on what this person cares about.

## Strategic Context
1-2 sentences on why this person matters — opportunities, leverage, or risks.

## Communication Pattern
Email frequency, engagement level, responsiveness. Use Gmail stats if available.

## Meeting History
COPY ALL EXISTING MEETING ENTRIES EXACTLY AS THEY APPEAR. Do not summarize, merge, or remove any meeting. Each meeting should keep its original ### heading, summary, key topics, decisions, and action items.

## Suggested Actions
1-3 specific, concrete next steps for Kaya.

---
*Harper Skill enriched: ${today}*`;

		const resp = await requestUrl({
			url: ANTHROPIC_API_URL,
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-api-key": this.apiKey,
				"anthropic-version": "2023-06-01",
			},
			body: JSON.stringify({
				model: this.model,
				max_tokens: 8000,
				messages: [{ role: "user", content: prompt }],
			}),
		});

		const data = resp.json;
		return data.content[0].text;
	}
}
