import type { Interaction } from "./intelligence-model";
import type { PersonPage } from "./types";

const DAY = 86_400_000;
const MAX_PER_PERSON = 12;
const MAX_PHRASE_CHARS = 80;
const MEETING_LOOKBACK_DAYS = 90;
const THEME_SECTIONS = new Set([
	"key themes",
	"themes",
	"working on",
	"decisions",
	"action items",
]);

export interface LocalThemeCandidate {
	personEmail: string;
	canonicalName: string;
	aliases: string[];
	sourceType: "calendar" | "granola" | "obsidian_note";
	visibility: "private" | "firm";
	observedAt: string;
	confidence: number;
	summary: string;
	evidenceRef: string;
	contentHash: string;
}

export type ThemeCandidatePage = PersonPage & { modifiedAt?: string };

/**
 * Derive compact theme candidates only from permitted local note fields and
 * accepted meeting metadata. The raw note body never leaves this function.
 */
export async function buildLocalThemeCandidates(
	pages: ThemeCandidatePage[],
	events: Interaction[],
	now = Date.now(),
): Promise<LocalThemeCandidate[]> {
	const byPerson = new Map<string, LocalThemeCandidate[]>();
	const add = (candidate: LocalThemeCandidate) => {
		const current = byPerson.get(candidate.personEmail) ?? [];
		if (current.length < MAX_PER_PERSON) current.push(candidate);
		byPerson.set(candidate.personEmail, current);
	};

	for (const page of pages) {
		const email = validEmail(page.email ?? page.emails[0]);
		const frontmatter = frontmatterValues(page.content);
		const observedAt = noteObservedAt(frontmatter, page.modifiedAt);
		if (!email || !observedAt) continue;
		const sourceType = isGranola(frontmatter) ? "granola" : "obsidian_note";
		const visibility = frontmatter.scalar("relationship_visibility") === "firm" ? "firm" : "private";
		const sourceRef = `obsidian:${(await sha256Hex(page.path)).slice(0, 24)}`;
		const candidates = [
			...frontmatter.list("themes"),
			...frontmatter.list("topics"),
			...frontmatter.list("working_on"),
			...sectionPhrases(page.content),
		];
		const seen = new Set<string>();
		for (const raw of candidates) {
			const canonicalName = phrase(raw);
			if (!canonicalName) continue;
			const key = canonicalName.toLocaleLowerCase();
			if (seen.has(key)) continue;
			seen.add(key);
			const fragment = `${sourceType}:${observedAt}:${canonicalName}`;
			add({
				personEmail: email,
				canonicalName,
				aliases: [],
				sourceType,
				visibility,
				observedAt,
				confidence: 0.95,
				summary: `Local ${sourceType === "granola" ? "meeting note" : "note"}: ${canonicalName}`,
				evidenceRef: sourceRef,
				contentHash: await sha256Hex(fragment),
			});
		}
	}

	for (const event of events) {
		if (event.kind !== "meeting") continue;
		const email = validEmail(event.email);
		const observedAt = iso(event.date);
		if (!email || !observedAt || Date.parse(observedAt) > now || now - Date.parse(observedAt) > MEETING_LOOKBACK_DAYS * DAY) continue;
		const canonicalName = phrase(event.title);
		if (!canonicalName) continue;
		const fragment = `calendar:${event.id}:${event.sourceId}:${observedAt}:${canonicalName}`;
		add({
			personEmail: email,
			canonicalName,
			aliases: [],
			sourceType: "calendar",
			visibility: "private",
			observedAt,
			confidence: 1,
			summary: `Meeting: ${canonicalName}`,
			evidenceRef: `obsidian:${(await sha256Hex(`calendar:${event.sourceId}`)).slice(0, 24)}`,
			contentHash: await sha256Hex(fragment),
		});
	}

	return [...byPerson.values()].flat();
}

function frontmatterValues(content: string): {
	scalar(key: string): string | undefined;
	list(key: string): string[];
} {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
	const block = match?.[1] ?? "";
	const scalar = (key: string) => {
		const value = block.match(new RegExp(`^${escapeRegExp(key)}:\\s*(.+?)\\s*$`, "mi"))?.[1];
		if (!value || value === "|" || value === ">") return undefined;
		return value.replace(/^['"]|['"]$/g, "").trim();
	};
	const list = (key: string) => {
		const inline = scalar(key);
		if (inline && !inline.startsWith("[")) return splitValues(inline);
		if (inline?.startsWith("[")) return splitValues(inline.slice(1, inline.endsWith("]") ? -1 : undefined));
		const lines = block.match(new RegExp(`^${escapeRegExp(key)}:\\s*\\r?\\n((?:[ \\t]+-.*(?:\\r?\\n|$))+)`, "mi"))?.[1];
		return lines ? lines.split(/\r?\n/).map((line) => line.replace(/^\s*-\s*/, "")).filter(Boolean) : [];
	};
	return { scalar, list };
}

function sectionPhrases(content: string): string[] {
	const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
	const out: string[] = [];
	const headings = [...body.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)];
	for (let index = 0; index < headings.length; index++) {
		if (!THEME_SECTIONS.has(headings[index][1].trim().toLocaleLowerCase())) continue;
		const start = (headings[index].index ?? 0) + headings[index][0].length;
		const end = index + 1 < headings.length ? headings[index + 1].index! : body.length;
		for (const line of body.slice(start, end).split(/\r?\n/)) {
			const value = line.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/, "").trim();
			if (value) out.push(value);
		}
	}
	return out;
}

function splitValues(value: string): string[] {
	return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function phrase(value: string): string | undefined {
	const cleaned = value
		.replace(/!?\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
		.replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, "$1")
		.replace(/[`*_~>#]/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, MAX_PHRASE_CHARS)
		.trim();
	return cleaned && !/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/.test(cleaned) ? cleaned : undefined;
}

function validEmail(value: string | null | undefined): string | undefined {
	const normalized = value?.trim().toLocaleLowerCase();
	return normalized && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ? normalized : undefined;
}

function iso(value: string | undefined): string | undefined {
	if (!value || !Number.isFinite(Date.parse(value))) return undefined;
	return new Date(value).toISOString();
}

function noteObservedAt(frontmatter: ReturnType<typeof frontmatterValues>, modifiedAt?: string): string | undefined {
	return iso(frontmatter.scalar("updated")) ?? iso(frontmatter.scalar("date")) ?? iso(frontmatter.scalar("created")) ?? iso(modifiedAt);
}

function isGranola(frontmatter: ReturnType<typeof frontmatterValues>): boolean {
	return [frontmatter.scalar("source"), frontmatter.scalar("provider"), frontmatter.scalar("origin")]
		.some((value) => value?.toLocaleLowerCase() === "granola") || frontmatter.scalar("granola")?.toLocaleLowerCase() === "true";
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
