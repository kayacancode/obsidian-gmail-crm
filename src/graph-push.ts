import { requestUrl } from "obsidian";
import type { ContactEdge } from "./types";
import type { StalenessScore } from "./staleness";
import type { LocalThemeCandidate } from "./theme-candidates";
import { MAX_PUSH_THEMES, MAX_PUSH_THEME_SIGNALS } from "../shared/relevance-contract";

/**
 * People graph web push — serializes the vault's people graph and POSTs it to
 * the people-graph Worker (apps/people-graph). Privacy: contact emails never
 * leave the vault; node ids are sha256(salt + email) where the salt lives only
 * in plugin settings, so ids are stable across pushes but opaque server-side.
 */

export interface GraphPushConfig {
	url: string; // people-graph deployment, e.g. https://people-graph.<acct>.workers.dev
	token: string; // push token minted by the web app's "Get my push token"
}

/** One contact, resolved by the caller (email + display fields + scores). */
export interface GraphContactInput {
	role?: string;
	photoUrl?: string;
	email: string;
	name: string;
	company: string | null;
	lastContact: string | null;
	staleness: StalenessScore;
}

export interface GraphNodeOut {
	workspaceIdentities?: Record<string,string>;
	role?: string;
	photoUrl?: string;
	id: string;
	name: string;
	company: string | null;
	quadrant: StalenessScore["quadrant"];
	combined: number;
	strength: number;
	momentum: number;
	label: StalenessScore["label"];
	lastContact: string | null;
}

export interface GraphEdgeOut {
	source: string;
	target: string;
	weight: number; // connection strength = number of distinct relationship edges between the pair
	types: string[];
	contexts: string[]; // sample contexts (e.g. meeting titles), capped
}

export interface GraphPayload {
	coverage?: {totalContacts:number;publishedContacts:number;excludedContacts:number};
	pushedAt: string;
	nodes: GraphNodeOut[];
	edges: GraphEdgeOut[];
	relevanceVersion: 1;
	themes: GraphThemeOut[];
	themeSignals: GraphThemeSignalOut[];
}

export interface GraphThemeInput extends LocalThemeCandidate {}

export interface GraphThemeOut {
	id: string;
	canonicalName: string;
	aliases: string[];
	description: string;
	status: "active";
}

export interface GraphThemeSignalOut {
	id: string;
	personId: string;
	themeId: string;
	sourceType: "calendar" | "granola" | "obsidian_note";
	visibility: "private" | "firm";
	observedAt: string;
	ingestedAt: string;
	confidence: number;
	summary: string;
	evidenceRef: string;
	contentHash: string;
	extractorVersion: "local-theme-v1";
}

const MAX_EDGE_CONTEXTS = 5;
const MAX_CONTEXT_CHARS = 120;
// Keep up to 10k contacts, including isolates. Reduce only when the serialized
// snapshot exceeds the D1 row budget, and report exact publication coverage.
const MAX_NODES = 10000;
const BYTE_BUDGET = 1_600_000;
const MIN_NODES = 200;

/** Build a private, opaque-ID snapshot with explicit coverage counts. */
export async function buildGraphPayload(
	contacts: GraphContactInput[],
	edges: ContactEdge[],
	salt: string,
	themeInputs: GraphThemeInput[] = [],
	workspaces: Array<{id:string;key:string}> = [],
): Promise<GraphPayload> {
	const byEmail = new Map<string, GraphContactInput>();
	for (const c of contacts) {
		const email = c.email.toLowerCase();
		if (!byEmail.has(email)) byEmail.set(email, c); // one node per email
	}

	// Merge directed typed edges into one undirected edge per pair; the number
	// of underlying relationship edges is the connection strength.
	interface MergedEdge { a: string; b: string; weight: number; typeSet: Set<string>; contextSet: Set<string> }
	const merged = new Map<string, MergedEdge>();
	for (const e of edges) {
		const s = e.sourceEmail.toLowerCase();
		const t = e.targetEmail.toLowerCase();
		if (s === t || !byEmail.has(s) || !byEmail.has(t)) continue;
		const [a, b] = s < t ? [s, t] : [t, s];
		const key = `${a}|${b}`;
		let entry = merged.get(key);
		if (!entry) {
			entry = { a, b, weight: 0, typeSet: new Set(), contextSet: new Set() };
			merged.set(key, entry);
		}
		entry.weight += 1;
		entry.typeSet.add(e.type);
		if (e.context) entry.contextSet.add(e.context.slice(0, MAX_CONTEXT_CHARS));
	}

	const wdeg = new Map<string, number>();
	for (const m of merged.values()) {
		wdeg.set(m.a, (wdeg.get(m.a) ?? 0) + m.weight);
		wdeg.set(m.b, (wdeg.get(m.b) ?? 0) + m.weight);
	}
	const byConnectivity = [...byEmail.keys()].sort((x, y) => (wdeg.get(y) ?? 0) - (wdeg.get(x) ?? 0));

	const idByEmail = new Map<string, string>();
	async function idFor(email: string): Promise<string> {
		let id = idByEmail.get(email);
		if (!id) { id = await opaqueId(salt, email); idByEmail.set(email, id); }
		return id;
	}
	let cap = MAX_NODES;
	let themeCandidatesPerPerson = MAX_THEME_CANDIDATES_PER_PERSON;
	let ctxPerEdge = MAX_EDGE_CONTEXTS;
	for (;;) {
		const boundedThemes = limitThemesByPerson(themeInputs, byEmail, themeCandidatesPerPerson);
		// Preserve isolates as well as connected people within the publication budget.
		const kept = byConnectivity.slice(0, cap);
		const keptSet = new Set(kept);

		const nodes: GraphNodeOut[] = [];
		for (const email of kept) {
			const c = byEmail.get(email)!;
			nodes.push({
				id: await idFor(email),
                ...(workspaces.length ? {workspaceIdentities:Object.fromEntries(await Promise.all(workspaces.map(async w=>[w.id,await workspaceIdentity(w.key,email)])))} : {}),
				name: c.name,
				role: c.role?.slice(0, 200),
				photoUrl: safeGraphPhoto(c.photoUrl),
				company: c.company,
				quadrant: c.staleness.quadrant,
				combined: c.staleness.combinedScore,
				strength: c.staleness.strengthScore,
				momentum: c.staleness.momentumScore,
				label: c.staleness.label,
				lastContact: c.lastContact,
			});
		}

		const edgesOut: GraphEdgeOut[] = [];
		for (const m of merged.values()) {
			if (!keptSet.has(m.a) || !keptSet.has(m.b)) continue;
			edgesOut.push({
				source: await idFor(m.a),
				target: await idFor(m.b),
				weight: m.weight,
				types: [...m.typeSet].sort(),
				contexts: [...m.contextSet].slice(0, ctxPerEdge),
			});
		}

		const pushedAt = new Date().toISOString();
		const { themes, themeSignals } = await graphThemesFor(keptSet, boundedThemes, idFor, salt, pushedAt);
		const payload: GraphPayload = {
			coverage:{totalContacts:byEmail.size,publishedContacts:nodes.length,excludedContacts:byEmail.size-nodes.length},
			pushedAt,
			nodes,
			edges: edgesOut,
			relevanceVersion: 1,
			themes,
			themeSignals,
		};
		if (JSON.stringify(payload).length <= BYTE_BUDGET || cap <= MIN_NODES) return payload;
		if (themeCandidatesPerPerson > 1 && [...boundedThemes.values()].some((inputs) => inputs.length > 1)) {
			themeCandidatesPerPerson = Math.max(1, Math.floor(themeCandidatesPerPerson * 0.7));
			continue;
		}
		cap = Math.max(MIN_NODES, Math.floor(cap * 0.7));
		ctxPerEdge = 3;
	}
}

const MAX_THEME_CANDIDATES_PER_PERSON = 12;

function limitThemesByPerson(
	inputs: GraphThemeInput[],
	contacts: Map<string, GraphContactInput>,
	limit: number,
): Map<string, GraphThemeInput[]> {
	const byPerson = new Map<string, GraphThemeInput[]>();
	for (const input of inputs) {
		const email = input.personEmail.trim().toLocaleLowerCase();
		if (!contacts.has(email) || !validThemeInput(input)) continue;
		const current = byPerson.get(email) ?? [];
		if (current.length < limit) current.push(input);
		byPerson.set(email, current);
	}
	return byPerson;
}

async function graphThemesFor(
	kept: Set<string>,
	byPerson: Map<string, GraphThemeInput[]>,
	idFor: (email: string) => Promise<string>,
	salt: string,
	ingestedAt: string,
): Promise<{ themes: GraphThemeOut[]; themeSignals: GraphThemeSignalOut[] }> {
	const themeByKey = new Map<string, GraphThemeOut>();
	const themeSignals: GraphThemeSignalOut[] = [];
	for (const [email, inputs] of byPerson) {
		if (!kept.has(email)) continue;
		const personId = await idFor(email);
		for (const input of inputs) {
			if (themeSignals.length >= MAX_PUSH_THEME_SIGNALS) break;
			const canonicalName = compact(input.canonicalName, 80);
			const key = canonicalName.toLocaleLowerCase();
			let theme = themeByKey.get(key);
			if (!theme) {
				if (themeByKey.size >= MAX_PUSH_THEMES) continue;
				theme = {
					id: `theme-${(await opaqueId(salt, `theme:${key}`)).slice(0, 16)}`,
					canonicalName,
					aliases: uniqueCompact(input.aliases, 20, 80),
					description: `Local theme: ${canonicalName}`,
					status: "active",
				};
				themeByKey.set(key, theme);
			} else {
				theme.aliases = uniqueCompact([...theme.aliases, ...input.aliases], 20, 80);
			}
			themeSignals.push({
				id: `signal-${(await opaqueId(salt, `theme-signal:${email}:${theme.id}:${input.sourceType}:${input.observedAt}:${input.contentHash}`)).slice(0, 16)}`,
				personId,
				themeId: theme.id,
				sourceType: input.sourceType,
				visibility: input.visibility,
				observedAt: new Date(input.observedAt).toISOString(),
				ingestedAt,
				confidence: Math.max(0, Math.min(1, input.confidence)),
				summary: compact(input.summary, 240),
				evidenceRef: compact(input.evidenceRef, 500),
				contentHash: compact(input.contentHash, 128),
				extractorVersion: "local-theme-v1",
			});
		}
	}
	return { themes: [...themeByKey.values()], themeSignals };
}

function validThemeInput(input: GraphThemeInput): boolean {
	return Boolean(
		compact(input.canonicalName, 80) &&
		Number.isFinite(Date.parse(input.observedAt)) &&
		input.evidenceRef.startsWith("obsidian:") &&
		input.contentHash,
	) &&
		(input.sourceType === "calendar" || input.sourceType === "granola" || input.sourceType === "obsidian_note") &&
		(input.visibility === "private" || input.visibility === "firm") &&
		!containsEmail(input.canonicalName) &&
		!containsEmail(input.summary) &&
		!containsEmail(input.evidenceRef) &&
		!containsEmail(input.contentHash);
}

function uniqueCompact(values: string[], limit: number, charLimit: number): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const value of values) {
		const compacted = compact(value, charLimit);
		if (!compacted || containsEmail(compacted) || seen.has(compacted.toLocaleLowerCase())) continue;
		seen.add(compacted.toLocaleLowerCase());
		out.push(compacted);
		if (out.length === limit) break;
	}
	return out;
}

function compact(value: string, limit: number): string {
	return value.replace(/\s+/g, " ").trim().slice(0, limit).trim();
}

function containsEmail(value: string): boolean {
	return /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/.test(value);
}

/** POST the payload. Returns {nodes, edges} counts confirmed by the server. */
export async function pushGraphToWeb(
	config: GraphPushConfig,
	payload: GraphPayload
): Promise<{ nodes: number; edges: number }> {
	const res = await requestUrl({
		url: `${config.url.replace(/\/$/, "")}/api/push`,
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${config.token}`,
		},
		body: JSON.stringify(payload),
		throw: false,
	});
	if (res.status !== 200) {
		throw new Error(`people graph push failed (${res.status}): ${res.text}`);
	}
	return { nodes: payload.nodes.length, edges: payload.edges.length };
}

/** Random hex salt for stable-but-opaque node ids; generated once per vault. */
export function generateGraphSalt(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return hex(bytes);
}

async function opaqueId(salt: string, email: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}:${email}`));
	return hex(new Uint8Array(digest)).slice(0, 16);
}

function hex(bytes: Uint8Array): string {
	return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Only Google-hosted contact photos; never arbitrary URLs or embedded credentials. */
export function safeGraphPhoto(value?: string): string | undefined {
	if (!value) return undefined;
	try { const u = new URL(value); return u.protocol === "https:" && (u.hostname === "googleusercontent.com" || u.hostname.endsWith(".googleusercontent.com")) && !u.username && !u.password && !u.href.includes("@") ? u.href : undefined; } catch { return undefined; }
}

/** Only opted-in shared workspaces receive matching identifiers. */
export async function fetchMatchingWorkspaces(config:GraphPushConfig):Promise<Array<{id:string;key:string}>>{
 const res=await requestUrl({url:`${config.url.replace(/\/$/, "")}/api/matching-workspaces`,method:'GET',headers:{Authorization:`Bearer ${config.token}`},throw:false});
 if(res.status===404)return []; // Compatible with an older self-hosted viewer.
 if(res.status!==200)throw new Error(`Could not prepare shared identity matching (${res.status}). Retry the push.`);
 const value=res.json;
 if(!Array.isArray(value?.workspaces)||value.workspaces.length>8||value.workspaces.some((w:any)=>typeof w.id!=='string'||!/^[a-zA-Z0-9-]{1,80}$/.test(w.id)||typeof w.key!=='string'||!w.key))throw new Error('Invalid shared matching configuration');
 return value.workspaces;
}
export async function workspaceIdentity(key:string,email:string):Promise<string>{
 const enc=new TextEncoder(),k=await crypto.subtle.importKey('raw',enc.encode(key),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 return hex(new Uint8Array(await crypto.subtle.sign('HMAC',k,enc.encode(email.trim().toLowerCase()))));
}
