import { requestUrl } from "obsidian";
import type { ContactEdge } from "./types";
import type { StalenessScore } from "./staleness";

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
	email: string;
	name: string;
	company: string | null;
	lastContact: string | null;
	staleness: StalenessScore;
}

export interface GraphNodeOut {
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
	pushedAt: string;
	nodes: GraphNodeOut[];
	edges: GraphEdgeOut[];
}

const MAX_EDGE_CONTEXTS = 5;
const MAX_CONTEXT_CHARS = 120;
// The worker rejects pushes near D1's 2MB row cap, and the viewer's force
// layout has no business rendering 23k nodes anyway. Push the connected graph:
// everyone with at least one tie, capped by connectivity, shrunk until the
// serialized payload fits the budget.
const MAX_NODES = 1500;
const BYTE_BUDGET = 1_600_000;
const MIN_NODES = 200;

/**
 * Build the push payload. Pure given its inputs; hashing is Web Crypto.
 *
 * Small vaults (fewer contacts than the cap) keep everyone, isolates included.
 * Large vaults keep only the most-connected people, so compare the returned
 * node count to `contacts.length` to report what was pruned.
 */
export async function buildGraphPayload(
	contacts: GraphContactInput[],
	edges: ContactEdge[],
	salt: string
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
	let ctxPerEdge = MAX_EDGE_CONTEXTS;
	for (;;) {
		// Under the cap, everyone fits (isolates included). Over it, only the
		// connected make the cut — an isolate can't out-rank a connected node.
		const kept = byEmail.size <= cap
			? byConnectivity
			: byConnectivity.slice(0, cap).filter((email) => (wdeg.get(email) ?? 0) > 0);
		const keptSet = new Set(kept);

		const nodes: GraphNodeOut[] = [];
		for (const email of kept) {
			const c = byEmail.get(email)!;
			nodes.push({
				id: await idFor(email),
				name: c.name,
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

		const payload: GraphPayload = { pushedAt: new Date().toISOString(), nodes, edges: edgesOut };
		if (JSON.stringify(payload).length <= BYTE_BUDGET || cap <= MIN_NODES) return payload;
		cap = Math.max(MIN_NODES, Math.floor(cap * 0.7));
		ctxPerEdge = 3;
	}
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
