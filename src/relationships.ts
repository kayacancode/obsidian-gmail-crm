import { TFile, TFolder, Vault, normalizePath } from "obsidian";
import type {
	PersonPage,
	RelationshipGraph,
	ContactIndex,
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

			// Email(s) — support multiple via comma/space separation or YAML list
			const emailMatch = content.match(/\*\*Email:\*\*\s*(.+)/);
			const emails: string[] = [];
			if (emailMatch) {
				// Split on commas, spaces, or pipes and extract valid emails
				const raw = emailMatch[1].trim();
				for (const token of raw.split(/[,\s|]+/)) {
					const cleaned = token.replace(/[<>]/g, "").trim().toLowerCase();
					if (cleaned.includes("@")) emails.push(cleaned);
				}
			}
			// Also check YAML frontmatter for emails list and scalar email field.
			// Scalar `email:` is what FrontmatterManager writes, so pages without a
			// `**Email:**` body line still resolve their gmailStats via the YAML.
			const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
			if (fmMatch) {
				const yamlEmails = fmMatch[1].match(/emails:\s*\n((?:\s+-\s+\S+@\S+\n?)+)/);
				if (yamlEmails) {
					for (const line of yamlEmails[1].split("\n")) {
						const em = line.replace(/^\s*-\s*/, "").trim().toLowerCase();
						if (em.includes("@") && !emails.includes(em)) emails.push(em);
					}
				}
				const yamlEmailScalar = fmMatch[1].match(/^email:\s*(.+?)\s*$/m);
				if (yamlEmailScalar) {
					const em = yamlEmailScalar[1].replace(/^["']|["']$/g, "").trim().toLowerCase();
					if (em.includes("@") && !emails.includes(em)) emails.push(em);
				}
			}

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

			// How known — match "How <owner name> knows them:" for any owner
			const howMatch = content.match(/\*\*How .+? knows them:\*\*\s*(.+)/);

			// Key context
			const ctxMatch = content.match(/\*\*Key context:\*\*\s*(.+)/);

			pages[name] = {
				name,
				path: child.path,
				content,
				wikiLinks,
				email: emails.length > 0 ? emails[0] : null,
				emails,
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

		// Gmail stats enrichment — merge across multiple emails per person
		if (contactIndex) {
			// Build email → page name mapping (supports multiple emails per page)
			const emailToName: Record<string, string> = {};
			for (const [name, page] of Object.entries(pages)) {
				for (const em of page.emails) {
					emailToName[em] = name;
				}
				// Fallback: single email field
				if (page.emails.length === 0 && page.email) {
					emailToName[page.email.toLowerCase()] = name;
				}
			}

			// Also match contacts by normalized name when no email match exists
			const nameToPage: Record<string, string> = {};
			for (const name of Object.keys(pages)) {
				nameToPage[this.normalizeName(name)] = name;
			}

			for (const [email, contact] of Object.entries(contactIndex.contacts)) {
				let pageName = emailToName[email];

				// Fuzzy name match: "Jonathan Chin" matches page "Jon Chin"
				if (!pageName && contact.name) {
					pageName = nameToPage[this.normalizeName(contact.name)];
				}

				if (!pageName || !pages[pageName]) continue;

				const existing = pages[pageName].gmailStats;
				if (existing) {
					// Merge stats from additional email addresses
					existing.totalExchanges += contact.totalExchanges;
					existing.sentCount += contact.sentCount;
					existing.receivedCount += contact.receivedCount;
					if (contact.lastContact > existing.lastContact) {
						existing.lastContact = contact.lastContact;
						if (contact.lastSubject) existing.lastSubject = contact.lastSubject;
					}
					if (contact.firstContact && (!existing.firstContact || contact.firstContact < existing.firstContact)) {
						existing.firstContact = contact.firstContact;
					}
					// Merge subjects (cap at 10)
					for (const s of contact.subjects ?? []) {
						if (existing.subjects.length < 10 && !existing.subjects.includes(s)) {
							existing.subjects.push(s);
						}
					}
					existing.threadCount = (existing.threadCount ?? 0) + (contact.threadCount ?? 0);
					existing.maxThreadDepth = Math.max(existing.maxThreadDepth ?? 0, contact.maxThreadDepth ?? 0);
					existing.backAndForthThreads = (existing.backAndForthThreads ?? 0) + (contact.backAndForthThreads ?? 0);
					existing.rsvpOnlyThreads = (existing.rsvpOnlyThreads ?? 0) + (contact.rsvpOnlyThreads ?? 0);
					if (contact.lastThreadDepth !== undefined) {
						existing.lastThreadDepth = Math.max(existing.lastThreadDepth ?? 0, contact.lastThreadDepth);
					}
				} else {
					pages[pageName].gmailStats = {
						totalExchanges: contact.totalExchanges,
						sentCount: contact.sentCount,
						receivedCount: contact.receivedCount,
						lastContact: contact.lastContact,
						firstContact: contact.firstContact,
						subjects: contact.subjects ?? [],
						lastSubject: contact.lastSubject ?? "",
						domain: contact.domain ?? "",
						threadCount: contact.threadCount,
						maxThreadDepth: contact.maxThreadDepth,
						backAndForthThreads: contact.backAndForthThreads,
						rsvpOnlyThreads: contact.rsvpOnlyThreads,
						lastThreadDepth: contact.lastThreadDepth,
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

	/**
	 * Normalize a name for fuzzy matching: lowercased, common nicknames mapped,
	 * so "Jonathan Chin" and "Jon Chin" produce the same key.
	 */
	private normalizeName(name: string): string {
		const NICKNAMES: Record<string, string> = {
			jon: "jonathan", john: "jonathan", johnny: "jonathan",
			mike: "michael", mikey: "michael",
			rob: "robert", bob: "robert", bobby: "robert",
			will: "william", bill: "william", billy: "william",
			dan: "daniel", danny: "daniel",
			dave: "david",
			chris: "christopher",
			matt: "matthew",
			tom: "thomas", tommy: "thomas",
			jim: "james", jimmy: "james", jamie: "james",
			joe: "joseph", joey: "joseph",
			ben: "benjamin", benny: "benjamin",
			sam: "samuel", sammy: "samuel",
			alex: "alexander",
			nick: "nicholas",
			rick: "richard", dick: "richard", rich: "richard",
			steve: "steven", stephen: "steven",
			ed: "edward", eddie: "edward",
			tony: "anthony",
			charlie: "charles", chuck: "charles",
			pat: "patrick",
			greg: "gregory",
			jeff: "jeffrey",
			kate: "katherine", kathy: "katherine", kat: "katherine",
			liz: "elizabeth", beth: "elizabeth", betty: "elizabeth",
			jen: "jennifer", jenny: "jennifer",
			meg: "margaret", maggie: "margaret", peggy: "margaret",
			sue: "susan", susie: "susan",
		};

		const parts = name.toLowerCase().trim().split(/\s+/);
		// Map first name through nicknames, keep last name(s) as-is
		if (parts.length > 0) {
			parts[0] = NICKNAMES[parts[0]] ?? parts[0];
		}
		return parts.join(" ");
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
