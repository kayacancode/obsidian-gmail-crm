import { TFile, TFolder, Vault, normalizePath } from "obsidian";
import type {
	PersonPage,
	RelationshipGraph,
	ContactIndex,
	Contact,
} from "./types";

interface NameTrieNode {
	children: Map<string, NameTrieNode>;
	name?: string;
}

/** Character trie over every candidate name, built once per graph pass. */
function buildNameTrie(names: string[]): NameTrieNode {
	const root: NameTrieNode = { children: new Map() };
	for (const name of names) {
		let node = root;
		// Indexed by UTF-16 code unit, not code point: the scan below advances one
		// code unit at a time, so an astral character (emoji, CJK Ext-B) keyed as a
		// single 2-unit edge would be unreachable and its name silently unmatchable.
		for (let position = 0; position < name.length; position++) {
			const char = name[position];
			let next = node.children.get(char);
			if (!next) {
				next = { children: new Map() };
				node.children.set(char, next);
			}
			node = next;
		}
		node.name = name;
	}
	return root;
}

/**
 * Every name that occurs as a substring of `content`, found in one pass.
 *
 * This replaces testing each page against every other name in the vault, which
 * is O(pages x names) substring searches — about 545 million at 23k people, on
 * the main thread, which freezes Obsidian outright. Walking a trie from each
 * position costs O(content length) instead, independent of how many people are
 * in the vault, and matches the same substrings the original scan did:
 * case-sensitive, no word-boundary requirement.
 */
function findMentionedNames(content: string, root: NameTrieNode): Set<string> {
	const found = new Set<string>();
	for (let start = 0; start < content.length; start++) {
		let node = root.children.get(content[start]);
		let cursor = start + 1;
		while (node) {
			if (node.name !== undefined) found.add(node.name);
			if (cursor >= content.length) break;
			node = node.children.get(content[cursor]);
			cursor++;
		}
	}
	return found;
}

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
			// Skip plugin-generated dashboard files so they don't get scored as people.
			if (child.basename === "_Quadrants" || child.basename === "Quadrants") continue;

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
			const addEmail = (value: string) => {
				const cleaned = value.replace(/[<>]/g, "").replace(/^["']|["']$/g, "").trim().toLowerCase();
				if (cleaned.includes("@") && !emails.includes(cleaned)) emails.push(cleaned);
			};
			if (emailMatch) {
				// Split on commas, spaces, or pipes and extract valid emails
				const raw = emailMatch[1].trim();
				for (const token of raw.split(/[,\s|]+/)) {
					addEmail(token);
				}
			}
			// Also check YAML frontmatter for emails list and scalar email field.
			// Scalar `email:` is what FrontmatterManager writes, so pages without a
			// `**Email:**` body line still resolve their gmailStats via the YAML.
			const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
			if (fmMatch) {
				for (const field of ["emails", "aliases"]) {
					const yamlList = fmMatch[1].match(new RegExp(`${field}:\\s*\\n((?:\\s+-\\s+\\S+@\\S+\\n?)+)`));
					if (yamlList) {
						for (const line of yamlList[1].split("\n")) {
							addEmail(line.replace(/^\s*-\s*/, ""));
						}
					}
				}
				const yamlEmailScalar = fmMatch[1].match(/^email:\s*(.+?)\s*$/m);
				if (yamlEmailScalar) {
					addEmail(yamlEmailScalar[1]);
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

		// Only multi-word names are eligible for text mentions, same as before.
		const multiWordNames = Array.from(allNames).filter((n) => n.includes(" "));
		const nameOrder = new Map<string, number>();
		multiWordNames.forEach((name, position) => nameOrder.set(name, position));
		const nameTrie = buildNameTrie(multiWordNames);

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
			const wikiLinks = new Set(page.wikiLinks);
			const mentioned = findMentionedNames(page.content, nameTrie);
			// Sorted back into vault order so edge order matches the original scan.
			const ordered = Array.from(mentioned).sort(
				(a, b) => (nameOrder.get(a) ?? 0) - (nameOrder.get(b) ?? 0)
			);
			for (const otherName of ordered) {
				if (otherName === name) continue;
				if (wikiLinks.has(otherName)) continue;
				graph[name].push({
					target: otherName,
					type: "text_mention",
					context: "Mentioned in notes",
				});
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
			const lastNameToPage: Record<string, string[]> = {};
			for (const name of Object.keys(pages)) {
				const normalized = this.normalizeName(name);
				nameToPage[normalized] = name;
				const parts = normalized.split(/\s+/);
				if (parts.length >= 2) {
					const last = parts[parts.length - 1];
					(lastNameToPage[last] ??= []).push(name);
				}
			}

			let matched = 0;
			let attempted = 0;
			const unmatchedSamples: string[] = [];

			for (const [email, contact] of Object.entries(contactIndex.contacts)) {
				attempted++;
				let pageName = emailToName[email];

				// Fuzzy name match: "Jonathan Chin" matches page "Jon Chin"
				if (!pageName && contact.name) {
					pageName = nameToPage[this.normalizeName(contact.name)];
				}

				// Last-name-only match when only one page has that last name
				if (!pageName && contact.name) {
					const parts = this.normalizeName(contact.name).split(/\s+/);
					if (parts.length >= 2) {
						const last = parts[parts.length - 1];
						const candidates = lastNameToPage[last];
						if (candidates && candidates.length === 1) {
							pageName = candidates[0];
						}
					}
				}

				// Email local-part match: "alex.smith@foo.com" → page "Alex Smith"
				if (!pageName) {
					const local = email.split("@")[0]?.replace(/[._-]+/g, " ").trim();
					if (local) {
						const candidate = nameToPage[this.normalizeName(local)];
						if (candidate) pageName = candidate;
					}
				}

				if (!pageName || !pages[pageName]) {
					if (unmatchedSamples.length < 5) {
						unmatchedSamples.push(`${contact.name || "(no name)"} <${email}>`);
					}
					continue;
				}
				matched++;
				const profileEmail = this.contactEmail(email, contact);
				const preferredProfileSource = this.isPreferredProfileContact(pages[pageName], email, contact);
				if (!pages[pageName].emails.includes(profileEmail)) {
					pages[pageName].emails.push(profileEmail);
				}
				if (!pages[pageName].email || preferredProfileSource) {
					pages[pageName].email = profileEmail;
				}

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
					// Merge calendar stats
					existing.calendarMeetings = (existing.calendarMeetings ?? 0) + (contact.calendarMeetings ?? 0);
					existing.calendarAccepted = (existing.calendarAccepted ?? 0) + (contact.calendarAccepted ?? 0);
					existing.calendarOrganizedByThem = (existing.calendarOrganizedByThem ?? 0) + (contact.calendarOrganizedByThem ?? 0);
					existing.calendarMeetingsLast90d = (existing.calendarMeetingsLast90d ?? 0) + (contact.calendarMeetingsLast90d ?? 0);
					if (contact.calendarLastMeeting && (!existing.calendarLastMeeting || contact.calendarLastMeeting > existing.calendarLastMeeting)) {
						existing.calendarLastMeeting = contact.calendarLastMeeting;
					}
					if (preferredProfileSource && !existing.profileSourcePreferred) {
						existing.domain = contact.domain ?? existing.domain;
						existing.profileEmail = profileEmail;
						existing.profileSourcePreferred = true;
					} else if (!existing.domain && contact.domain) {
						existing.domain = contact.domain;
						existing.profileEmail = profileEmail;
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
						profileEmail,
						profileSourcePreferred: preferredProfileSource,
						calendarMeetings: contact.calendarMeetings,
						calendarAccepted: contact.calendarAccepted,
						calendarLastMeeting: contact.calendarLastMeeting,
						calendarOrganizedByThem: contact.calendarOrganizedByThem,
						calendarMeetingsLast90d: contact.calendarMeetingsLast90d,
						openCount: contact.openCount,
						lastOpenAt: contact.lastOpenAt,
						openEngagement: contact.openEngagement,
						};
				}
			}

			console.log(`[Gmail CRM] Page-to-contact match: ${matched}/${attempted}`, {
				totalPages: Object.keys(pages).length,
				unmatchedSample: unmatchedSamples,
			});
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

	private contactEmail(key: string, contact: Contact): string {
		return (contact.email || key).trim().toLowerCase();
	}

	private isPreferredProfileContact(page: PersonPage, key: string, contact: Contact): boolean {
		const email = this.contactEmail(key, contact);
		const pageEmail = page.email?.trim().toLowerCase();
		if (pageEmail && email === pageEmail) return true;

		const canonicalEmail = contact.canonicalId?.trim().toLowerCase().replace(/^local:/, "");
		return !!canonicalEmail && email === canonicalEmail;
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
