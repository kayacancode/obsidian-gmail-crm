/**
 * Reconnect swipe web app — Cloudflare Worker.
 *
 * Privacy model: this Worker never sees emails. Botwick pushes candidates with
 * opaque ids (it keeps the id -> email map locally), the UI shows names only,
 * and decisions are recorded against the opaque id. Botwick pulls decisions and
 * maps them back to emails on its own machine.
 *
 * Auth:
 *  - Reads (GET /api/candidates) and writes (POST /api/swipe) require a Google
 *    ID token whose email is in ALLOWED_EMAILS (John + Kaya).
 *  - Machine sync (/api/sync, /api/decisions) requires the SYNC_TOKEN bearer.
 *
 * Ids are STABLE (HMAC of email, salted on the bridge machine): a decision on
 * an id excludes that contact from /api/candidates forever, across every push.
 */

interface Env {
	DB: D1Database;
	ASSETS: Fetcher;
	ALLOWED_EMAILS: string;
	GOOGLE_CLIENT_ID: string;
	SYNC_TOKEN: string;
}

const ACTIONS = new Set(["boost", "suppress", "delete"]);

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const { pathname } = url;

		try {
			if (pathname === "/api/candidates" && request.method === "GET") {
				return await listCandidates(request, env);
			}
			if (pathname === "/api/swipe" && request.method === "POST") {
				return await swipe(request, env);
			}
			if (pathname === "/api/sync" && request.method === "POST") {
				return await sync(request, env);
			}
			if (pathname === "/api/decisions" && request.method === "GET") {
				return await listDecisions(request, env);
			}
			if (pathname === "/api/decisions/ack" && request.method === "POST") {
				return await ackDecisions(request, env);
			}
			if (pathname === "/api/merge/candidates" && request.method === "GET") {
				return await listMergeCandidates(request, env);
			}
			if (pathname === "/api/merge/swipe" && request.method === "POST") {
				return await mergeSwipe(request, env);
			}
			if (pathname === "/api/merge/sync" && request.method === "POST") {
				return await mergeSync(request, env);
			}
			if (pathname === "/api/merge/decisions" && request.method === "GET") {
				return await listMergeDecisions(request, env);
			}
			if (pathname === "/api/merge/decisions/ack" && request.method === "POST") {
				return await ackMergeDecisions(request, env);
			}
			if (pathname === "/api/config" && request.method === "GET") {
				// Public, non-secret config the UI needs to start Google sign-in.
				return json({ googleClientId: env.GOOGLE_CLIENT_ID });
			}
			if (pathname.startsWith("/api/")) {
				return json({ error: "not_found" }, 404);
			}
		} catch (err) {
			return json({ error: "server_error", message: String(err) }, 500);
		}

		// Everything else → the static swipe UI.
		return env.ASSETS.fetch(request);
	},
} satisfies ExportedHandler<Env>;

// GET /api/candidates — the unswiped pool, best first. Google allowlist gated:
// names/companies/nudges are relationship intelligence, not for anonymous viewers.
async function listCandidates(request: Request, env: Env): Promise<Response> {
	const auth = await requireGoogleUser(request, env);
	if ("error" in auth) return json({ error: auth.error }, 401);

	const totalRow = await env.DB.prepare(
		`SELECT COUNT(*) AS n FROM candidates c LEFT JOIN decisions d ON d.id = c.id WHERE d.id IS NULL`
	).first<{ n: number }>();

	const rows = await env.DB.prepare(
		`SELECT c.id, c.name, c.company, c.last_contact, c.score, c.nudge
		   FROM candidates c
		   LEFT JOIN decisions d ON d.id = c.id
		  WHERE d.id IS NULL
		  ORDER BY c.score DESC
		  LIMIT 500`
	).all();

	return json({ total: totalRow?.n ?? 0, candidates: rows.results ?? [] });
}

// POST /api/swipe { id, action } — requires Google sign-in (allowlisted email).
async function swipe(request: Request, env: Env): Promise<Response> {
	const auth = await requireGoogleUser(request, env);
	if ("error" in auth) return json({ error: auth.error }, 401);

	const body = (await request.json().catch(() => null)) as
		| { id?: string; action?: string }
		| null;
	if (!body?.id || !body.action || !ACTIONS.has(body.action)) {
		return json({ error: "bad_request", message: "need id + action in {boost,suppress,delete}" }, 400);
	}

	// Candidate must exist (and not be from a stale id).
	const exists = await env.DB.prepare("SELECT id FROM candidates WHERE id = ?")
		.bind(body.id)
		.first();
	if (!exists) return json({ error: "unknown_candidate" }, 404);

	await env.DB.prepare(
		`INSERT INTO decisions (id, action, decided_by, decided_at, applied)
		 VALUES (?, ?, ?, ?, 0)
		 ON CONFLICT(id) DO UPDATE SET
		   action = excluded.action,
		   decided_by = excluded.decided_by,
		   decided_at = excluded.decided_at,
		   applied = 0`
	)
		.bind(body.id, body.action, auth.email, nowSeconds())
		.run();

	return json({ ok: true, id: body.id, action: body.action });
}

// POST /api/sync { upserts, remove_ids, reset? } — bridge diff push.
async function sync(request: Request, env: Env): Promise<Response> {
	if (!checkSyncToken(request, env)) return json({ error: "unauthorized" }, 401);

	const body = (await request.json().catch(() => null)) as
		| { upserts?: CandidateInput[]; remove_ids?: string[]; reset?: boolean }
		| null;
	if (!body || (!Array.isArray(body.upserts) && !Array.isArray(body.remove_ids) && !body.reset)) {
		return json({ error: "bad_request", message: "need upserts[] and/or remove_ids[] (or reset)" }, 400);
	}
	const upserts = body.upserts ?? [];
	const removeIds = body.remove_ids ?? [];

	const stmts: D1PreparedStatement[] = [];
	if (body.reset) stmts.push(env.DB.prepare("DELETE FROM candidates"));

	const now = nowSeconds();
	const insert = env.DB.prepare(
		`INSERT INTO candidates (id, name, company, last_contact, score, nudge, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET
		   name = excluded.name, company = excluded.company, last_contact = excluded.last_contact,
		   score = excluded.score, nudge = excluded.nudge, updated_at = excluded.updated_at`
	);
	for (const c of upserts) {
		if (!c?.id || !c?.name) continue;
		stmts.push(insert.bind(c.id, c.name, c.company ?? null, c.last_contact ?? null, c.score ?? null, c.nudge ?? null, now));
	}
	const remove = env.DB.prepare("DELETE FROM candidates WHERE id = ?");
	for (const id of removeIds) stmts.push(remove.bind(id));

	// D1 batches are transactional; chunk to stay well under statement limits.
	for (let i = 0; i < stmts.length; i += 100) {
		await env.DB.batch(stmts.slice(i, i + 100));
	}
	return json({ ok: true, upserted: upserts.length, removed: removeIds.length, reset: !!body.reset });
}

// GET /api/decisions?applied=0 — Botwick pulls decisions to apply locally.
async function listDecisions(request: Request, env: Env): Promise<Response> {
	if (!checkSyncToken(request, env)) return json({ error: "unauthorized" }, 401);
	const url = new URL(request.url);
	const onlyPending = url.searchParams.get("applied") !== "1";

	const query = onlyPending
		? "SELECT id, action, decided_by, decided_at, applied FROM decisions WHERE applied = 0 ORDER BY decided_at"
		: "SELECT id, action, decided_by, decided_at, applied FROM decisions ORDER BY decided_at";
	const rows = await env.DB.prepare(query).all();
	return json({ decisions: rows.results ?? [] });
}

// POST /api/decisions/ack { ids:[...] } — mark decisions applied after Botwick runs them.
async function ackDecisions(request: Request, env: Env): Promise<Response> {
	if (!checkSyncToken(request, env)) return json({ error: "unauthorized" }, 401);
	const body = (await request.json().catch(() => null)) as { ids?: string[] } | null;
	if (!Array.isArray(body?.ids) || body.ids.length === 0) {
		return json({ error: "bad_request", message: "need ids[]" }, 400);
	}
	const placeholders = body.ids.map(() => "?").join(",");
	await env.DB.prepare(`UPDATE decisions SET applied = 1 WHERE id IN (${placeholders})`)
		.bind(...body.ids)
		.run();
	// Applied contacts leave the pool for good; prune them from candidates now
	// (the bridge's next remove_ids would catch them anyway — belt and braces).
	await env.DB.prepare(`DELETE FROM candidates WHERE id IN (${placeholders})`)
		.bind(...body.ids)
		.run();
	return json({ ok: true, acked: body.ids.length });
}

const MERGE_ACTIONS = new Set(["merge", "keep"]);

interface MergePairInput {
	id: string;
	confidence?: number | null;
	reasons?: string | null;
	name_a: string; company_a?: string | null; domain_a?: string | null;
	last_contact_a?: string | null; exchanges_a?: number | null;
	name_b: string; company_b?: string | null; domain_b?: string | null;
	last_contact_b?: string | null; exchanges_b?: number | null;
}

// GET /api/merge/candidates — undecided pairs, most confident first.
async function listMergeCandidates(request: Request, env: Env): Promise<Response> {
	const auth = await requireGoogleUser(request, env);
	if ("error" in auth) return json({ error: auth.error }, 401);
	const totalRow = await env.DB.prepare(
		`SELECT COUNT(*) AS n FROM merge_candidates m LEFT JOIN merge_decisions d ON d.id = m.id WHERE d.id IS NULL`
	).first<{ n: number }>();
	const rows = await env.DB.prepare(
		`SELECT m.* FROM merge_candidates m
		   LEFT JOIN merge_decisions d ON d.id = m.id
		  WHERE d.id IS NULL
		  ORDER BY m.confidence DESC
		  LIMIT 500`
	).all();
	return json({ total: totalRow?.n ?? 0, candidates: rows.results ?? [] });
}

// POST /api/merge/swipe { id, action: merge|keep }
async function mergeSwipe(request: Request, env: Env): Promise<Response> {
	const auth = await requireGoogleUser(request, env);
	if ("error" in auth) return json({ error: auth.error }, 401);
	const body = (await request.json().catch(() => null)) as { id?: string; action?: string } | null;
	if (!body?.id || !body.action || !MERGE_ACTIONS.has(body.action)) {
		return json({ error: "bad_request", message: "need id + action in {merge,keep}" }, 400);
	}
	const exists = await env.DB.prepare("SELECT id FROM merge_candidates WHERE id = ?").bind(body.id).first();
	if (!exists) return json({ error: "unknown_pair" }, 404);
	await env.DB.prepare(
		`INSERT INTO merge_decisions (id, action, decided_by, decided_at, applied)
		 VALUES (?, ?, ?, ?, 0)
		 ON CONFLICT(id) DO UPDATE SET
		   action = excluded.action, decided_by = excluded.decided_by,
		   decided_at = excluded.decided_at, applied = 0`
	).bind(body.id, body.action, auth.email, nowSeconds()).run();
	return json({ ok: true, id: body.id, action: body.action });
}

// POST /api/merge/sync { upserts, remove_ids, reset? }
async function mergeSync(request: Request, env: Env): Promise<Response> {
	if (!checkSyncToken(request, env)) return json({ error: "unauthorized" }, 401);
	const body = (await request.json().catch(() => null)) as
		| { upserts?: MergePairInput[]; remove_ids?: string[]; reset?: boolean }
		| null;
	if (!body || (!Array.isArray(body.upserts) && !Array.isArray(body.remove_ids) && !body.reset)) {
		return json({ error: "bad_request", message: "need upserts[] and/or remove_ids[] (or reset)" }, 400);
	}
	const upserts = body.upserts ?? [];
	const removeIds = body.remove_ids ?? [];
	const stmts: D1PreparedStatement[] = [];
	if (body.reset) stmts.push(env.DB.prepare("DELETE FROM merge_candidates"));
	const now = nowSeconds();
	const insert = env.DB.prepare(
		`INSERT INTO merge_candidates (id, confidence, reasons,
		   name_a, company_a, domain_a, last_contact_a, exchanges_a,
		   name_b, company_b, domain_b, last_contact_b, exchanges_b, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET
		   confidence = excluded.confidence, reasons = excluded.reasons,
		   name_a = excluded.name_a, company_a = excluded.company_a, domain_a = excluded.domain_a,
		   last_contact_a = excluded.last_contact_a, exchanges_a = excluded.exchanges_a,
		   name_b = excluded.name_b, company_b = excluded.company_b, domain_b = excluded.domain_b,
		   last_contact_b = excluded.last_contact_b, exchanges_b = excluded.exchanges_b,
		   updated_at = excluded.updated_at`
	);
	for (const p of upserts) {
		if (!p?.id || !p?.name_a || !p?.name_b) continue;
		stmts.push(insert.bind(
			p.id, p.confidence ?? null, p.reasons ?? null,
			p.name_a, p.company_a ?? null, p.domain_a ?? null, p.last_contact_a ?? null, p.exchanges_a ?? null,
			p.name_b, p.company_b ?? null, p.domain_b ?? null, p.last_contact_b ?? null, p.exchanges_b ?? null,
			now
		));
	}
	const remove = env.DB.prepare("DELETE FROM merge_candidates WHERE id = ?");
	for (const id of removeIds) stmts.push(remove.bind(id));
	for (let i = 0; i < stmts.length; i += 100) {
		await env.DB.batch(stmts.slice(i, i + 100));
	}
	return json({ ok: true, upserted: upserts.length, removed: removeIds.length, reset: !!body.reset });
}

// GET /api/merge/decisions?applied=0
async function listMergeDecisions(request: Request, env: Env): Promise<Response> {
	if (!checkSyncToken(request, env)) return json({ error: "unauthorized" }, 401);
	const url = new URL(request.url);
	const onlyPending = url.searchParams.get("applied") !== "1";
	const query = onlyPending
		? "SELECT id, action, decided_by, decided_at, applied FROM merge_decisions WHERE applied = 0 ORDER BY decided_at"
		: "SELECT id, action, decided_by, decided_at, applied FROM merge_decisions ORDER BY decided_at";
	const rows = await env.DB.prepare(query).all();
	return json({ decisions: rows.results ?? [] });
}

// POST /api/merge/decisions/ack { ids } — mark applied + prune the pairs.
async function ackMergeDecisions(request: Request, env: Env): Promise<Response> {
	if (!checkSyncToken(request, env)) return json({ error: "unauthorized" }, 401);
	const body = (await request.json().catch(() => null)) as { ids?: string[] } | null;
	if (!Array.isArray(body?.ids) || body.ids.length === 0) {
		return json({ error: "bad_request", message: "need ids[]" }, 400);
	}
	const placeholders = body.ids.map(() => "?").join(",");
	await env.DB.prepare(`UPDATE merge_decisions SET applied = 1 WHERE id IN (${placeholders})`).bind(...body.ids).run();
	await env.DB.prepare(`DELETE FROM merge_candidates WHERE id IN (${placeholders})`).bind(...body.ids).run();
	return json({ ok: true, acked: body.ids.length });
}

interface CandidateInput {
	id: string;
	name: string;
	company?: string | null;
	last_contact?: string | null;
	score?: number | null;
	nudge?: string | null;
}

function checkSyncToken(request: Request, env: Env): boolean {
	const token = bearer(request);
	return !!env.SYNC_TOKEN && token === env.SYNC_TOKEN;
}

// Verify a Google ID token and confirm the email is allowlisted.
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

	const allowed = env.ALLOWED_EMAILS.split(",").map((e) => e.trim().toLowerCase());
	if (!allowed.includes(info.email.toLowerCase())) return { error: "forbidden" };

	return { email: info.email.toLowerCase() };
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
