import { TFile, TFolder, Vault, normalizePath } from "obsidian";
import type { PersonPage, Relationship } from "./types";
import type { StalenessScore } from "./staleness";

export interface CrmFrontmatter {
	email?: string;
	role?: string;
	company?: string;
	last_contact?: string;
	first_contact?: string;
	total_exchanges?: number;
	sent?: number;
	received?: number;
	staleness_score?: number;
	staleness_label?: string;
	relationship_strength?: string;
	relationship_depth?: number; // 1–5
	relationship_recency?: number; // 1–5
	days_since_contact?: number;
	nudge?: string;
	connections?: number;
	last_subject?: string;
	recent_subjects?: string[];
	last_thread_depth?: number;
	max_thread_depth?: number;
	back_and_forth_threads?: number;
	domain?: string;
	strength_score?: number;
	momentum_score?: number;
	combined_score?: number;
	quadrant?: string;
	harper_enriched?: string;
	canonical_id?: string;
	aliases?: string[];
	last_canonical_sync?: string;
	// Email open tracking
	open_engagement?: string;
	open_count?: number;
}

export class FrontmatterManager {
	private vault: Vault;
	private companyIndex: Map<string, string> | null = null; // lowercase name -> actual file basename
	private companiesFolder: string;

	constructor(vault: Vault, companiesFolder = "Companies") {
		this.vault = vault;
		this.companiesFolder = companiesFolder;
	}

	private loadCompanyIndex(): Map<string, string> {
		if (this.companyIndex) return this.companyIndex;

		this.companyIndex = new Map();
		const folder = this.vault.getAbstractFileByPath(
			normalizePath(this.companiesFolder)
		);
		if (folder instanceof TFolder) {
			for (const child of folder.children) {
				if (child instanceof TFile && child.extension === "md") {
					this.companyIndex.set(child.basename.toLowerCase(), child.basename);
				}
			}
		}
		return this.companyIndex;
	}

	private matchCompany(rawCompany: string): string | null {
		const index = this.loadCompanyIndex();
		const lower = rawCompany.toLowerCase().trim();

		// Exact match
		if (index.has(lower)) return index.get(lower)!;

		// Strip common suffixes for matching
		const stripped = lower
			.replace(/[,\s]*(inc\.?|llc|corp\.?|co\.?|ltd\.?)$/i, "")
			.trim();
		if (index.has(stripped)) return index.get(stripped)!;

		// Partial match — company name contained in page name or vice versa
		for (const [key, name] of index) {
			if (key.includes(stripped) || stripped.includes(key)) {
				return name;
			}
		}

		return null;
	}

	async resolveCompany(rawCompany: string): Promise<string> {
		const matched = this.matchCompany(rawCompany);
		if (matched) {
			return `"[[${this.companiesFolder}/${matched}|${matched}]]"`;
		}

		// Create a stub
		const safeName = rawCompany.replace(/[\\/:*?"<>|]/g, "_").trim();
		const stubPath = normalizePath(`${this.companiesFolder}/${safeName}.md`);

		const existing = this.vault.getAbstractFileByPath(stubPath);
		if (!existing) {
			const today = new Date().toISOString().split("T")[0];
			const content = [
				"---",
				`title: "${safeName}"`,
				`date: ${today}`,
				"tags: [company]",
				"type: company",
				"status: active",
				"---",
				"",
				`# ${safeName}`,
				"",
				"## Company Overview",
				"",
				"## People",
				"",
			].join("\n");

			try {
				// Ensure folder exists
				const folder = this.vault.getAbstractFileByPath(
					normalizePath(this.companiesFolder)
				);
				if (!folder) {
					await this.vault.createFolder(normalizePath(this.companiesFolder));
				}
				await this.vault.create(stubPath, content);
			} catch {
				// folder or file already exists
			}

			// Update index
			this.loadCompanyIndex().set(safeName.toLowerCase(), safeName);
		}

		return `"[[${this.companiesFolder}/${safeName}|${safeName}]]"`;
	}

	async updateFrontmatter(
		file: TFile,
		page: PersonPage,
		staleness: StalenessScore,
		relationships: Relationship[]
	): Promise<void> {
		const content = await this.vault.read(file);

		const crm: CrmFrontmatter = {
			staleness_score: staleness.score,
			staleness_label: staleness.label,
			relationship_strength: staleness.relationshipStrength,
			relationship_depth: staleness.relationshipDepth,
			relationship_recency: staleness.relationshipRecency,
			strength_score: staleness.strengthScore,
			momentum_score: staleness.momentumScore,
			combined_score: staleness.combinedScore,
			quadrant: staleness.quadrant,
			connections: relationships.length,
		};

		if (page.email) crm.email = page.email;

		let rawCompany: string | null = null;
		if (page.role) {
			const parsed = this.parseRoleCompany(page.role);
			crm.role = parsed.role;
			rawCompany = parsed.company;
		}

		// Resolve company to wiki link
		// Use domain as fallback company signal if no role/company parsed
		if (!rawCompany && page.gmailStats?.domain) {
			const d = page.gmailStats.domain;
			// Skip generic email providers
			const generic = new Set(["gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "icloud.com", "aol.com", "protonmail.com", "me.com", "live.com", "mail.com"]);
			if (!generic.has(d)) {
				rawCompany = d.split(".")[0]; // e.g., "betaworks" from "betaworks.com"
				// Capitalize
				rawCompany = rawCompany.charAt(0).toUpperCase() + rawCompany.slice(1);
			}
		}
		if (rawCompany) {
			crm.company = await this.resolveCompany(rawCompany);
		}

		if (page.gmailStats) {
			crm.last_contact = page.gmailStats.lastContact.split("T")[0];
			crm.first_contact = page.gmailStats.firstContact.split("T")[0];
			crm.total_exchanges = page.gmailStats.totalExchanges;
			crm.sent = page.gmailStats.sentCount;
			crm.received = page.gmailStats.receivedCount;
			if (page.gmailStats.lastSubject) {
				crm.last_subject = page.gmailStats.lastSubject;
			}
			if (page.gmailStats.subjects && page.gmailStats.subjects.length > 0) {
				crm.recent_subjects = page.gmailStats.subjects;
			}
			if (page.gmailStats.domain) {
				crm.domain = page.gmailStats.domain;
			}
			if (page.gmailStats.maxThreadDepth !== undefined) {
				crm.max_thread_depth = page.gmailStats.maxThreadDepth;
			}
			if (page.gmailStats.backAndForthThreads !== undefined) {
				crm.back_and_forth_threads = page.gmailStats.backAndForthThreads;
			}
			if (page.gmailStats.lastThreadDepth !== undefined) {
				crm.last_thread_depth = page.gmailStats.lastThreadDepth;
			}
			// Email open tracking (from Superhuman read receipts)
			if (page.gmailStats.openCount !== undefined && page.gmailStats.openCount > 0) {
				crm.open_count = page.gmailStats.openCount;
				const eng = page.gmailStats.openEngagement ?? "none";
				const label =
					eng === "replied" ? "💬 Replied" :
					eng === "multi_opened" ? "📬 Opened multiple times" :
					eng === "opened" ? "📬 Opened" :
					eng === "sent_no_open" ? "📭 No opens" :
					"📭 No opens";
				crm.open_engagement = label;
			}
		}

		if (staleness.daysSinceContact !== null) {
			crm.days_since_contact = staleness.daysSinceContact;
		}

		if (staleness.nudge) {
			crm.nudge = staleness.nudge;
		} else {
			// Explicitly clear stale nudges: set to empty string so mergeFrontmatter
			// overwrites the old value, then strip the empty line in the merge.
			crm.nudge = "";
		}

		const updated = this.mergeFrontmatter(content, crm);
		// Update the Relationship Status section in the page body
		const withStatus = this.updateRelationshipStatus(updated, page, staleness, relationships);
		if (withStatus !== content) {
			await this.vault.modify(file, withStatus);
		}
	}

	private updateRelationshipStatus(
		content: string,
		page: PersonPage,
		staleness: StalenessScore,
		relationships: Relationship[]
	): string {
		const lines: string[] = [];

		// Quadrant + label line
		const quadrantEmoji: Record<string, string> = {
			"nurture": "🟢",
			"re-engage": "🟡",
			"developing": "🔵",
			"deprioritize": "⚪",
		};
		const emoji = quadrantEmoji[staleness.quadrant] ?? "⚪";
		lines.push(`${emoji} **${staleness.quadrant.charAt(0).toUpperCase() + staleness.quadrant.slice(1)}** · ${staleness.label}`);
		lines.push("");

		// Score bars
		lines.push(`| Metric | Score |`);
		lines.push(`|--------|-------|`);
		lines.push(`| Strength | ${staleness.strengthScore}/100 ${this.scoreBar(staleness.strengthScore)} |`);
		lines.push(`| Momentum | ${staleness.momentumScore}/100 ${this.scoreBar(staleness.momentumScore)} |`);
		lines.push(`| Combined | ${staleness.combinedScore}/100 ${this.scoreBar(staleness.combinedScore)} |`);
		lines.push(`| Depth | ${staleness.relationshipDepth}/5 |`);
		lines.push(`| Recency | ${staleness.relationshipRecency}/10 |`);
		lines.push("");

		// Email stats
		if (page.gmailStats) {
			const g = page.gmailStats;
			const sent = g.sentCount ?? 0;
			const received = g.receivedCount ?? 0;
			const total = g.totalExchanges ?? 0;
			const threads = g.threadCount ?? 0;
			const baf = g.backAndForthThreads ?? 0;
			lines.push(`**${total} emails** (${sent} sent · ${received} received) across ${threads} threads · ${baf} back-and-forth`);

			if (g.firstContact && g.lastContact) {
				const first = g.firstContact.split("T")[0];
				const last = g.lastContact.split("T")[0];
				if (first === last) {
					lines.push(`Only contact: ${last}`);
				} else {
					lines.push(`First contact: ${first} · Last contact: ${last}`);
				}
			}

			// Calendar meetings
			const meetings90d = g.calendarMeetingsLast90d ?? 0;
			const meetingsTotal = g.calendarMeetings ?? 0;
			if (meetingsTotal > 0) {
				lines.push(`📅 ${meetingsTotal} calendar meetings (${meetings90d} in last 90 days)`);
			}
			lines.push("");
		}

		// Connections
		if (relationships.length > 0) {
			const names = relationships
				.slice(0, 5)
				.map((r) => `[[${r.target}]]`)
				.join(", ");
			const suffix = relationships.length > 5 ? ` + ${relationships.length - 5} more` : "";
			lines.push(`**${relationships.length} connections:** ${names}${suffix}`);
			lines.push("");
		}

		// Nudge
		if (staleness.nudge) {
			lines.push(`> [!tip] Nudge`);
			lines.push(`> ${staleness.nudge}`);
			lines.push("");
		}

		const section = `## Relationship Status\n\n${lines.join("\n")}`;

		// Replace existing section or insert after frontmatter
		const sectionRegex = /## Relationship Status\n[\s\S]*?(?=\n## (?!Relationship Status)|\n---\n|$)/;
		if (sectionRegex.test(content)) {
			return content.replace(sectionRegex, section);
		} else {
			// Insert after frontmatter closing ---
			const fmEnd = content.indexOf("---", content.indexOf("---") + 3);
			if (fmEnd !== -1) {
				const insertPos = fmEnd + 3;
				const before = content.slice(0, insertPos);
				const after = content.slice(insertPos);
				// If there's already a heading right after, insert before it
				return `${before}\n\n${section}\n${after}`;
			}
			// No frontmatter — prepend
			return `${section}\n\n${content}`;
		}
	}

	private scoreBar(score: number): string {
		const filled = Math.round(score / 10);
		return "█".repeat(filled) + "░".repeat(10 - filled);
	}

	private parseRoleCompany(role: string): { role: string; company: string | null } {
		const roleParts = role.split(/\s+at\s+|\s+@\s+/i);
		if (roleParts.length === 2) {
			return {
				role: roleParts[0].trim(),
				company: roleParts[1].trim(),
			};
		}

		const ofMatch = role.match(/^(founder|co[-\s]?founder|owner|principal|partner|managing partner|ceo|cto|cpo|coo|president)\s+of\s+(.+)$/i);
		if (ofMatch) {
			return {
				role: ofMatch[1].trim(),
				company: ofMatch[2].trim(),
			};
		}

		return { role, company: null };
	}

	async setCanonicalLink(
		file: TFile,
		link: { canonicalId: string; aliases?: string[]; syncedAt?: string }
	): Promise<void> {
		const content = await this.vault.read(file);
		const fields: CrmFrontmatter = {
			canonical_id: link.canonicalId,
			last_canonical_sync: link.syncedAt ?? new Date().toISOString(),
		};
		if (link.aliases && link.aliases.length > 0) fields.aliases = link.aliases;
		const updated = this.mergeFrontmatter(content, fields);
		if (updated !== content) {
			await this.vault.modify(file, updated);
		}
	}

	private mergeFrontmatter(content: string, fields: CrmFrontmatter): string {
		const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);

		if (fmMatch) {
			const existingLines = fmMatch[1].split("\n");
			const existingKeys = new Set<string>();
			const updatedLines: string[] = [];
			let skipContinuation = false;

			for (const line of existingLines) {
				const keyMatch = line.match(/^(\w[\w_-]*):/);
				if (keyMatch) {
					skipContinuation = false;
					const key = keyMatch[1];
					existingKeys.add(key);
					if (key in fields) {
						const val = fields[key as keyof CrmFrontmatter];
						if (val !== undefined && val !== "") {
							updatedLines.push(this.formatField(key, val));
							// If the new value is multi-line (array), skip old continuation lines
							if (Array.isArray(val)) {
								skipContinuation = true;
							}
						} else if (val === "") {
							// Empty string = remove this key from frontmatter
							skipContinuation = true;
						} else {
							updatedLines.push(line);
						}
					} else {
						updatedLines.push(line);
					}
				} else if (skipContinuation && (line.match(/^\s+-\s/) || line.match(/^\s+/))) {
					// Skip old YAML list/continuation lines for replaced keys
					continue;
				} else {
					skipContinuation = false;
					updatedLines.push(line);
				}
			}

			for (const [key, val] of Object.entries(fields)) {
				if (!existingKeys.has(key) && val !== undefined) {
					updatedLines.push(this.formatField(key, val));
				}
			}

			const newFm = `---\n${updatedLines.join("\n")}\n---`;
			return content.replace(/^---\n[\s\S]*?\n---/, newFm);
		} else {
			const lines: string[] = [];
			for (const [key, val] of Object.entries(fields)) {
				if (val !== undefined) {
					lines.push(this.formatField(key, val));
				}
			}
			return `---\n${lines.join("\n")}\n---\n\n${content}`;
		}
	}

	private formatField(key: string, val: string | number | boolean | string[]): string {
		if (Array.isArray(val)) {
			if (val.length === 0) return `${key}: []`;
			const items = val.map((v) => `  - "${v.replace(/"/g, '\\"')}"`);
			return `${key}:\n${items.join("\n")}`;
		}
		if (typeof val === "number" || typeof val === "boolean") {
			return `${key}: ${val}`;
		}
		// Already quoted (wiki links come pre-quoted)
		if (val.startsWith('"') && val.endsWith('"')) {
			return `${key}: ${val}`;
		}
		// Quote strings with special YAML chars
		if (val.includes(":") || val.includes("#") || val.includes("'") || val.includes('"') || val.includes("\n") || val.includes("[")) {
			return `${key}: "${val.replace(/"/g, '\\"')}"`;
		}
		return `${key}: ${val}`;
	}
}
