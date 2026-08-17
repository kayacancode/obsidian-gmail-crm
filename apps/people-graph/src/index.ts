/**
 * People graph viewer — Cloudflare Worker.
 *
 * Multi-tenant: the tenant key is a Google-verified email. Each user pushes
 * their own graph from the Obsidian plugin and can only ever read their own
 * row. There is no allowlist and no sharing — signing in with any Google
 * account shows that account's graph (usually empty until they push).
 *
 * Privacy model: like reconnect-web, this Worker never sees email addresses
 * of contacts. Node ids are salted hashes computed in the vault (salt stays
 * local); the blob holds names, scores, and edge contexts only. The only email
 * stored is the tenant's own sign-in address, used as the row key.
 *
 * Auth:
 *  - GET /api/graph and GET /api/token require a Google ID token.
 *  - POST /api/push requires a push token minted by /api/token — a stateless
 *    HMAC binding the email to TOKEN_SECRET, so the plugin can push headlessly
 *    without a Google session.
 */

interface Env {
	DB: D1Database;
	ASSETS: Fetcher;
	GOOGLE_CLIENT_ID: string;
	TOKEN_SECRET: string;
}

// Keep pushes bounded: a few thousand contacts with edges fits comfortably.
const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const { pathname } = url;

		try {
			if (pathname === "/api/config" && request.method === "GET") {
				// Public, non-secret config the UI needs to start Google sign-in.
				return json({ googleClientId: env.GOOGLE_CLIENT_ID });
			}
			if (pathname === "/api/token" && request.method === "GET") {
				return await mintToken(request, env);
			}
			if (pathname === "/api/push" && request.method === "POST") {
				return await push(request, env);
			}
			if (pathname === "/api/graph" && request.method === "GET") {
				return await getGraph(request, env);
			}
			if (pathname.startsWith("/api/")) {
				return json({ error: "not_found" }, 404);
			}
		} catch (err) {
			return json({ error: "server_error", message: String(err) }, 500);
		}

		// Everything else → the static graph UI.
		return env.ASSETS.fetch(request);
	},
} satisfies ExportedHandler<Env>;

// GET /api/token — mint the push token for the signed-in user. Stateless:
// pg1.<b64url(email)>.<hex(HMAC-SHA256(email, TOKEN_SECRET))>. Re-minting
// returns the same token; rotation = rotate TOKEN_SECRET.
async function mintToken(request: Request, env: Env): Promise<Response> {
	const auth = await requireGoogleUser(request, env);
	if ("error" in auth) return json({ error: auth.error }, 401);
	if (!env.TOKEN_SECRET) return json({ error: "not_configured" }, 500);

	const sig = await hmacHex(env.TOKEN_SECRET, auth.email);
	return json({ email: auth.email, token: `pg1.${b64url(auth.email)}.${sig}` });
}

// POST /api/push — upsert the caller's graph blob. Push-token gated.
async function push(request: Request, env: Env): Promise<Response> {
	const email = await verifyPushToken(bearer(request), env);
	if (!email) return json({ error: "unauthorized" }, 401);

	const raw = await request.text();
	if (raw.length > MAX_PAYLOAD_BYTES) {
		return json({ error: "too_large", message: `payload over ${MAX_PAYLOAD_BYTES} bytes` }, 413);
	}

	let body: { pushedAt?: string; nodes?: unknown[]; edges?: unknown[] } | null = null;
	try {
		body = JSON.parse(raw);
	} catch {
		return json({ error: "bad_request", message: "invalid JSON" }, 400);
	}
	if (!body || !Array.isArray(body.nodes) || !Array.isArray(body.edges)) {
		return json({ error: "bad_request", message: "need nodes[] and edges[]" }, 400);
	}
	// Guard the privacy invariant: node ids must be opaque hashes, not emails.
	for (const n of body.nodes as { id?: unknown }[]) {
		if (typeof n?.id !== "string" || n.id.includes("@")) {
			return json({ error: "bad_request", message: "node ids must be opaque (no emails)" }, 400);
		}
	}

	await env.DB.prepare(
		`INSERT INTO graphs (email, json, updated_at) VALUES (?, ?, ?)
		 ON CONFLICT(email) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`
	)
		.bind(email, raw, nowSeconds())
		.run();

	return json({ ok: true, nodes: body.nodes.length, edges: body.edges.length });
}

// GET /api/graph — the signed-in user's own graph, or null if never pushed.
async function getGraph(request: Request, env: Env): Promise<Response> {
	const auth = await requireGoogleUser(request, env);
	if ("error" in auth) return json({ error: auth.error }, 401);

	const row = await env.DB.prepare("SELECT json, updated_at FROM graphs WHERE email = ?")
		.bind(auth.email)
		.first<{ json: string; updated_at: number }>();

	if (!row) return json({ graph: null });
	return new Response(`{"updatedAt":${row.updated_at},"graph":${row.json}}`, {
		headers: { "content-type": "application/json; charset=utf-8" },
	});
}

async function verifyPushToken(token: string | null, env: Env): Promise<string | null> {
	if (!token || !env.TOKEN_SECRET) return null;
	const parts = token.split(".");
	if (parts.length !== 3 || parts[0] !== "pg1") return null;
	let email: string;
	try {
		email = fromB64url(parts[1]).toLowerCase();
	} catch {
		return null;
	}
	if (!email.includes("@")) return null;
	const expected = await hmacHex(env.TOKEN_SECRET, email);
	return timingSafeEqual(parts[2], expected) ? email : null;
}

// Verify a Google ID token (same flow as reconnect-web, minus the allowlist).
async function requireGoogleUser(
	request: Request,
	env: Env
): Promise<{ email: string } | { error: string }> {
	const token = bearer(request);
	if (!token) return { error: "missing_token" };

	const resp = await fetch(
		`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(token)}`
	);
	if (!resp.ok) return { error: "invalid_token" };
	const info = (await resp.json()) as {
		aud?: string;
		email?: string;
		email_verified?: string | boolean;
	};

	if (info.aud !== env.GOOGLE_CLIENT_ID) return { error: "wrong_audience" };
	const verified = info.email_verified === true || info.email_verified === "true";
	if (!info.email || !verified) return { error: "unverified_email" };

	return { email: info.email.toLowerCase() };
}

async function hmacHex(secret: string, message: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"]
	);
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
	return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

function b64url(s: string): string {
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): string {
	const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
	return atob(padded);
}

function bearer(request: Request): string | null {
	const header = request.headers.get("Authorization") ?? "";
	const match = header.match(/^Bearer\s+(.+)$/i);
	return match ? match[1].trim() : null;
}

function nowSeconds(): number {
	return Math.floor(Date.now() / 1000);
}

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json; charset=utf-8" },
	});
}
