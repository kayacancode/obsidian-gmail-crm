/**
 * Reconnect swipe web app — Cloudflare Worker.
 *
 * Privacy model: this Worker never sees emails. Botwick pushes candidates with
 * opaque ids (it keeps the id -> email map locally), the UI shows names only,
 * and decisions are recorded against the opaque id. Botwick pulls decisions and
 * maps them back to emails on its own machine.
 *
 * Auth:
 *  - Reads (GET /api/candidates) are public — names only, low sensitivity.
 *  - Writes (POST /api/swipe) require a Google ID token whose email is in
 *    ALLOWED_EMAILS (John + Kaya).
 *  - Machine sync (/api/sync, /api/decisions) requires the SYNC_TOKEN bearer.
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

// GET /api/candidates — pending (undecided) candidates from the latest batch.
// Requires Google sign-in (allowlisted email): the list exposes names, companies
// and nudges, i.e. relationship intelligence — not for anonymous viewers.
async function listCandidates(request: Request, env: Env): Promise<Response> {
	const auth = await requireGoogleUser(request, env);
	if ("error" in auth) return json({ error: auth.error }, 401);

	const latest = await env.DB.prepare(
		"SELECT batch_date FROM candidates ORDER BY batch_date DESC LIMIT 1"
	).first<{ batch_date: string }>();
	if (!latest) return json({ batch_date: null, candidates: [] });

	const rows = await env.DB.prepare(
		`SELECT c.id, c.name, c.company, c.days_since, c.score, c.nudge
		   FROM candidates c
		   LEFT JOIN decisions d ON d.id = c.id
		  WHERE c.batch_date = ? AND d.id IS NULL
		  ORDER BY c.score DESC`
	)
		.bind(latest.batch_date)
		.all();

	return json({ batch_date: latest.batch_date, candidates: rows.results ?? [] });
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

// POST /api/sync { batch_date, candidates:[...], replace? } — Botwick push.
async function sync(request: Request, env: Env): Promise<Response> {
	if (!checkSyncToken(request, env)) return json({ error: "unauthorized" }, 401);

	const body = (await request.json().catch(() => null)) as
		| { batch_date?: string; replace?: boolean; candidates?: CandidateInput[] }
		| null;
	if (!body?.batch_date || !Array.isArray(body.candidates)) {
		return json({ error: "bad_request", message: "need batch_date + candidates[]" }, 400);
	}

	const stmts: D1PreparedStatement[] = [];
	if (body.replace) {
		// Clear this batch's candidates (and their decisions) before re-inserting.
		stmts.push(
			env.DB.prepare(
				"DELETE FROM decisions WHERE id IN (SELECT id FROM candidates WHERE batch_date = ?)"
			).bind(body.batch_date)
		);
		stmts.push(env.DB.prepare("DELETE FROM candidates WHERE batch_date = ?").bind(body.batch_date));
	}

	const now = nowSeconds();
	const insert = env.DB.prepare(
		`INSERT INTO candidates (id, name, company, days_since, score, nudge, batch_date, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET
		   name = excluded.name, company = excluded.company, days_since = excluded.days_since,
		   score = excluded.score, nudge = excluded.nudge, batch_date = excluded.batch_date`
	);
	for (const c of body.candidates) {
		if (!c?.id || !c?.name) continue;
		stmts.push(
			insert.bind(
				c.id,
				c.name,
				c.company ?? null,
				c.days_since ?? null,
				c.score ?? null,
				c.nudge ?? null,
				body.batch_date,
				now
			)
		);
	}

	if (stmts.length) await env.DB.batch(stmts);
	return json({ ok: true, inserted: body.candidates.length, batch_date: body.batch_date });
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
	return json({ ok: true, acked: body.ids.length });
}

interface CandidateInput {
	id: string;
	name: string;
	company?: string | null;
	days_since?: number | null;
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
