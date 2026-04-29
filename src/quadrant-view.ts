import { TFile, TFolder, Vault, normalizePath } from "obsidian";

interface PersonRow {
	name: string;
	combinedScore: number;
	strengthScore: number;
	momentumScore: number;
	quadrant: string;
}

const QUADRANT_ORDER = ["nurture", "re-engage", "developing", "deprioritize"] as const;
const QUADRANT_LABELS: Record<string, { title: string; subtitle: string }> = {
	nurture: { title: "NURTURE", subtitle: "strong + active" },
	"re-engage": { title: "RE-ENGAGE", subtitle: "strong + dormant" },
	developing: { title: "DEVELOPING", subtitle: "weak + active" },
	deprioritize: { title: "DEPRIORITIZE", subtitle: "weak + dormant" },
};

export async function writeQuadrantView(
	vault: Vault,
	peopleFolder: string
): Promise<string> {
	const folder = vault.getAbstractFileByPath(normalizePath(peopleFolder));
	if (!(folder instanceof TFolder)) {
		throw new Error(`People folder not found: ${peopleFolder}`);
	}

	const buckets: Record<string, PersonRow[]> = {
		nurture: [],
		"re-engage": [],
		developing: [],
		deprioritize: [],
	};

	for (const child of folder.children) {
		if (!(child instanceof TFile) || child.extension !== "md") continue;
		const content = await vault.read(child);
		const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
		if (!fmMatch) continue;
		const yaml = fmMatch[1];
		const quadrant = readField(yaml, "quadrant");
		if (!quadrant || !buckets[quadrant]) continue;
		buckets[quadrant].push({
			name: child.basename,
			combinedScore: readNumber(yaml, "combined_score") ?? 0,
			strengthScore: readNumber(yaml, "strength_score") ?? 0,
			momentumScore: readNumber(yaml, "momentum_score") ?? 0,
			quadrant,
		});
	}

	for (const q of QUADRANT_ORDER) {
		buckets[q].sort((a, b) => b.combinedScore - a.combinedScore);
	}

	const html = renderGrid(buckets, peopleFolder);
	// Underscore prefix sorts the file ahead of alphabetic siblings (CRM.base, etc.)
	// so the dashboard sits at the top of the people-pages folder.
	const path = normalizePath(`${peopleFolder}/_Quadrants.md`);
	const existing = vault.getAbstractFileByPath(path);
	if (existing instanceof TFile) {
		await vault.modify(existing, html);
	} else {
		try {
			await vault.create(path, html);
		} catch {
			await vault.adapter.write(path, html);
		}
	}

	// Clean up the old un-prefixed location written by earlier versions.
	const legacyPath = normalizePath(`${peopleFolder}/Quadrants.md`);
	const legacy = vault.getAbstractFileByPath(legacyPath);
	if (legacy instanceof TFile) {
		try {
			await vault.delete(legacy);
		} catch {
			// non-fatal — user can delete manually
		}
	}

	return path;
}

function readField(yaml: string, key: string): string | null {
	const re = new RegExp(`^${key}:\\s*(.+?)\\s*$`, "m");
	const m = yaml.match(re);
	if (!m) return null;
	return m[1].replace(/^["']|["']$/g, "").trim();
}

function readNumber(yaml: string, key: string): number | null {
	const v = readField(yaml, key);
	if (v === null) return null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

function renderGrid(
	buckets: Record<string, PersonRow[]>,
	peopleFolder: string
): string {
	const cell = (q: typeof QUADRANT_ORDER[number]) => {
		const rows = buckets[q];
		const items = rows
			.slice(0, 50)
			.map(
				(r) =>
					`<li><a class="internal-link" href="${escapeHtml(peopleFolder)}/${escapeHtml(r.name)}.md" data-href="${escapeHtml(peopleFolder)}/${escapeHtml(r.name)}.md">${escapeHtml(r.name)}</a> <span class="gmail-crm-q-score">${r.combinedScore}</span></li>`
			)
			.join("");
		const overflow =
			rows.length > 50 ? `<div class="gmail-crm-q-overflow">+${rows.length - 50} more</div>` : "";
		const label = QUADRANT_LABELS[q];
		return `<div class="gmail-crm-q gmail-crm-q-${q}">
  <div class="gmail-crm-q-header">
    <h3>${label.title}</h3>
    <span class="gmail-crm-q-sub">${label.subtitle}</span>
    <span class="gmail-crm-q-count">${rows.length}</span>
  </div>
  <ul class="gmail-crm-q-list">${items}</ul>
  ${overflow}
</div>`;
	};

	return `# Quadrants

<div class="gmail-crm-q-grid">
  <div class="gmail-crm-q-axis-y-top">ACTIVE</div>
  <div class="gmail-crm-q-axis-y-bottom">DORMANT</div>
  <div class="gmail-crm-q-axis-x-left">STRONG</div>
  <div class="gmail-crm-q-axis-x-right">WEAK</div>
${cell("nurture")}
${cell("developing")}
${cell("re-engage")}
${cell("deprioritize")}
</div>

> Sorted by combined score within each quadrant. Top 50 per cell.
`;
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}
