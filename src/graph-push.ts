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

/** Build the push payload. Pure given its inputs; hashing is Web Crypto. */
export async function buildGraphPayload(
	contacts: GraphContactInput[],
	edges: ContactEdge[],
	salt: string
): Promise<GraphPayload> {
	const idByEmail = new Map<string, string>();
	const nodes: GraphNodeOut[] = [];
	for (const c of contacts) {
		const email = c.email.toLowerCase();
		if (idByEmail.has(email)) continue; // one node per email
		const id = await opaqueId(salt, email);
		idByEmail.set(email, id);
		nodes.push({
			id,
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

	// Merge directed typed edges into one undirected edge per pair; the number
	// of underlying relationship edges is the connection strength.
	const merged = new Map<string, GraphEdgeOut & { contextSet: Set<string>; typeSet: Set<string> }>();
	for (const e of edges) {
		const source = idByEmail.get(e.sourceEmail.toLowerCase());
		const target = idByEmail.get(e.targetEmail.toLowerCase());
		if (!source || !target || source === target) continue;
		const [a, b] = source < target ? [source, target] : [target, source];
		const key = `${a}|${b}`;
		let entry = merged.get(key);
		if (!entry) {
			entry = { source: a, target: b, weight: 0, types: [], contexts: [], contextSet: new Set(), typeSet: new Set() };
			merged.set(key, entry);
		}
		entry.weight += 1;
		entry.typeSet.add(e.type);
		if (e.context) entry.contextSet.add(e.context.slice(0, MAX_CONTEXT_CHARS));
	}

	const edgesOut: GraphEdgeOut[] = [...merged.values()].map((e) => ({
		source: e.source,
		target: e.target,
		weight: e.weight,
		types: [...e.typeSet].sort(),
		contexts: [...e.contextSet].slice(0, MAX_EDGE_CONTEXTS),
	}));

	return { pushedAt: new Date().toISOString(), nodes, edges: edgesOut };
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
