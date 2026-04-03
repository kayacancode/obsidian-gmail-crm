import { TFile, TFolder, Vault, normalizePath } from "obsidian";
import type {
	PersonPage,
	Relationship,
	RelationshipGraph,
	ContactIndex,
	GmailStats,
} from "./types";

export class RelationshipEngine {
	private vault: Vault;
	private peopleFolder: string;

	constructor(vault: Vault, peopleFolder: string) {
		this.vault = vault;
		this.peopleFolder = peopleFolder;
	}

	async loadPeoplePages(): Promise<Record<string, PersonPage>> {
		const folder = this.vault.getAbstractFileByPath(
			normalizePath(this.peopleFolder)
		);
		if (!(folder instanceof TFolder)) return {};

		const pages: Record<string, PersonPage> = {};

		for (const child of folder.children) {
			if (!(child instanceof TFile) || child.extension !== "md") continue;

			const content = await this.vault.read(child);
			const name = child.basename.replace(/^p-\s*/, "");

			// Wiki links: [[p- Name]] or [[p- Name|alias]]
			const wikiLinks: string[] = [];
			const linkRegex = /\[\[p-\s*([^\]|]+?)(?:\|[^\]]*?)?\]\]/g;
			let match;
			while ((match = linkRegex.exec(content)) !== null) {
				wikiLinks.push(match[1].trim());
			}

			// Email
			const emailMatch = content.match(/\*\*Email:\*\*\s*(\S+@\S+)/);

			// Role
			const roleMatch = content.match(/\*\*Role\/Company:\*\*\s*(.+)/);

			// Introducer
			const introMatch = content.match(
				/(?:introduced by|via|through)\s+(?:\[\[p-\s*)?([A-Z][a-z]+ [A-Z][a-z]+)/i
			);

			// Meetings
			const meetings: { date: string; title: string }[] = [];
			const meetingRegex = /###\s+(\d{4}-\d{2}-\d{2})\s*[—–-]\s*(.+)/g;
			while ((match = meetingRegex.exec(content)) !== null) {
				meetings.push({ date: match[1], title: match[2].trim() });
			}

			// How known
			const howMatch = content.match(/\*\*How Kaya knows them:\*\*\s*(.+)/);

			// Key context
			const ctxMatch = content.match(/\*\*Key context:\*\*\s*(.+)/);

			pages[name] = {
				name,
				path: child.path,
				content,
				wikiLinks,
				email: emailMatch ? emailMatch[1] : null,
				role: roleMatch ? roleMatch[1].trim() : null,
				introducer: introMatch ? introMatch[1].trim() : null,
				meetings,
				howKnown: howMatch ? howMatch[1].trim() : null,
				keyContext: ctxMatch ? ctxMatch[1].trim() : null,
				gmailStats: null,
			};
		}

		return pages;
	}

	buildGraph(
		pages: Record<string, PersonPage>,
		contactIndex: ContactIndex | null
	): RelationshipGraph {
		const graph: RelationshipGraph = {};
		const allNames = new Set(Object.keys(pages));

		for (const name of allNames) {
			graph[name] = [];
		}

		for (const [name, page] of Object.entries(pages)) {
			// Wiki link edges
			for (const link of page.wikiLinks) {
				if (allNames.has(link) && link !== name) {
					graph[name].push({
						target: link,
						type: "wiki_link",
						context: "Referenced in notes",
					});
				}
			}

			// Introducer edges
			if (page.introducer) {
				const matched = this.fuzzyMatch(page.introducer, allNames);
				if (matched && matched !== name) {
					graph[name].push({
						target: matched,
						type: "introduced_by",
						context: `Introduced by ${matched}`,
					});
					graph[matched].push({
						target: name,
						type: "introduced",
						context: `Introduced ${name}`,
					});
				}
			}

			// Text mentions of full names
			for (const otherName of allNames) {
				if (otherName === name) continue;
				if (page.wikiLinks.includes(otherName)) continue;
				if (otherName.includes(" ") && page.content.includes(otherName)) {
					graph[name].push({
						target: otherName,
						type: "text_mention",
						context: "Mentioned in notes",
					});
				}
			}
		}

		// Shared meetings
		const meetingAttendees: Record<string, Set<string>> = {};
		for (const [name, page] of Object.entries(pages)) {
			for (const m of page.meetings) {
				const key = `${m.date}:${m.title}`;
				if (!meetingAttendees[key]) meetingAttendees[key] = new Set();
				meetingAttendees[key].add(name);
			}
		}

		for (const [key, attendees] of Object.entries(meetingAttendees)) {
			if (attendees.size < 2) continue;
			const list = Array.from(attendees);
			const [date, title] = key.split(":", 2);
			for (let i = 0; i < list.length; i++) {
				for (let j = i + 1; j < list.length; j++) {
					graph[list[i]].push({
						target: list[j],
						type: "shared_meeting",
						context: `Both at: ${title} (${date})`,
					});
					graph[list[j]].push({
						target: list[i],
						type: "shared_meeting",
						context: `Both at: ${title} (${date})`,
					});
				}
			}
		}

		// Gmail stats enrichment
		if (contactIndex) {
			const emailToName: Record<string, string> = {};
			for (const [name, page] of Object.entries(pages)) {
				if (page.email) {
					emailToName[page.email.toLowerCase()] = name;
				}
			}

			for (const [email, contact] of Object.entries(contactIndex.contacts)) {
				const name = emailToName[email];
				if (name && pages[name]) {
					pages[name].gmailStats = {
						totalExchanges: contact.totalExchanges,
						sentCount: contact.sentCount,
						receivedCount: contact.receivedCount,
						lastContact: contact.lastContact,
						subjects: contact.subjects ?? [],
					};
				}
			}
		}

		// Deduplicate
		for (const name of Object.keys(graph)) {
			const seen = new Set<string>();
			graph[name] = graph[name].filter((edge) => {
				const key = `${edge.target}:${edge.type}`;
				if (seen.has(key)) return false;
				seen.add(key);
				return true;
			});
		}

		return graph;
	}

	private fuzzyMatch(query: string, candidates: Set<string>): string | null {
		const q = query.toLowerCase();
		for (const c of candidates) {
			if (c.toLowerCase() === q) return c;
		}
		for (const c of candidates) {
			if (q.includes(c.toLowerCase()) || c.toLowerCase().includes(q)) return c;
		}
		const qParts = q.split(/\s+/);
		if (qParts.length >= 2) {
			for (const c of candidates) {
				const cParts = c.toLowerCase().split(/\s+/);
				if (cParts.length >= 2 && cParts[cParts.length - 1] === qParts[qParts.length - 1]) {
					return c;
				}
			}
		}
		return null;
	}
}
