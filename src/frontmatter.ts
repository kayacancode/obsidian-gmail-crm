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
	quadrant?: string;
	harper_enriched?: string;
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
			.replace(/\s*(inc\.?|llc|corp\.?|co\.?|ltd\.?)$/i, "")
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
			quadrant: staleness.quadrant,
			connections: relationships.length,
		};

		if (page.email) crm.email = page.email;

		let rawCompany: string | null = null;
		if (page.role) {
			const roleParts = page.role.split(/\s+at\s+|\s+@\s+/i);
			if (roleParts.length === 2) {
				crm.role = roleParts[0].trim();
				rawCompany = roleParts[1].trim();
			} else {
				crm.role = page.role;
			}
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
		}

		if (staleness.daysSinceContact !== null) {
			crm.days_since_contact = staleness.daysSinceContact;
		}

		if (staleness.nudge) {
			crm.nudge = staleness.nudge;
		}

		const updated = this.mergeFrontmatter(content, crm);
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
						if (val !== undefined) {
							updatedLines.push(this.formatField(key, val));
							// If the new value is multi-line (array), skip old continuation lines
							if (Array.isArray(val)) {
								skipContinuation = true;
							}
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
