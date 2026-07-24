#!/usr/bin/env node
/**
 * Botwick bridge for the Reconnect web app (apps/reconnect-web).
 *
 * Dependency-free. Runs on the source-of-truth machine (it needs local
 * `peoplegraph` for both the read and the writes).
 *
 *   push  — compute the full unswiped re-engage pool, derive STABLE opaque ids
 *           (HMAC of email with a local salt; same contact -> same id forever),
 *           and sync only the DIFF (upserts/removes) to the Worker.
 *   pull  — fetch swipe decisions from the Worker, map id->email locally, apply
 *           them (boost/suppress -> feedback overlay, delete -> CLI removal +
 *           blocklist), then ack them.
 *   merge-push — auto-merge the >=0.94-confidence duplicate pairs locally via
 *           `peoplegraph apply-duplicates`, then sync the 0.88-0.93 band to
 *           the /merge review deck as stable pair cards (weekly unless --force).
 *   merge-pull — fetch merge/keep verdicts from the /merge deck and apply them
 *           via `peoplegraph apply-merge`/`dismiss-merge`, then ack them.
 *   run   — pull, merge-pull, push, merge-push (merge steps wrapped in
 *           try/catch so a merge-endpoint hiccup never blocks contact sync).
 *
 * State file (RECONNECT_STATE) schema v2:
 *   { version: 2, salt, map: {id -> email}, lastPush: {id -> {h, s}},
 *     mergeMap: {id -> {a, b}}, lastMergePush: {id -> {h, s}}, lastMergeScanUnix }
 * salt + map never leave this machine; lastPush/lastMergePush drive the diffs.
 * Deleting the state file is safe: the next push resets the Worker and
 * re-uploads the pool.
 *
 * Env:
 *   RECONNECT_WEB_URL        Worker base URL, e.g. https://reconnect-web.<acct>.workers.dev   (required)
 *   RECONNECT_SYNC_TOKEN     matches the Worker's SYNC_TOKEN secret                            (required)
 *   PEOPLEGRAPH_CACHE        path to contact-index.json (passed to peoplegraph --cache)        (required)
 *   PEOPLEGRAPH_BIN          peoplegraph binary (default: "peoplegraph")
 *   RECONNECT_STATE          state file: salt + id->email map + last-push hashes
 *                            (default: ~/.peoplegraph/reconnect-web-state.json)
 *   RECONNECT_DAILY_NOTE     optional path to today's daily note to append the link line
 *   RECONNECT_PUBLIC_URL     public URL used in the daily-note link (default: RECONNECT_WEB_URL)
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { stableId, contentHash, diffPool, migrateState, pairId, hashValues } from "./lib/reconnect-sync.mjs";

const env = process.env;
const WEB_URL = (env.RECONNECT_WEB_URL || "").replace(/\/$/, "");
const SYNC_TOKEN = env.RECONNECT_SYNC_TOKEN || "";
const CACHE = env.PEOPLEGRAPH_CACHE || "";
const BIN = env.PEOPLEGRAPH_BIN || "peoplegraph";
const STATE_PATH = env.RECONNECT_STATE || join(homedir(), ".peoplegraph", "reconnect-web-state.json");
const DAILY_NOTE = env.RECONNECT_DAILY_NOTE || "";
const PUBLIC_URL = (env.RECONNECT_PUBLIC_URL || WEB_URL).replace(/\/$/, "");
const PEOPLE_FOLDER = env.RECONNECT_PEOPLE_FOLDER || join(homedir(), "Documents", "master_jb_peoplecrm", "People");

function die(msg) {
	console.error(`error: ${msg}`);
	process.exit(1);
}

function requireEnv() {
	if (!WEB_URL) die("RECONNECT_WEB_URL is required");
	if (!SYNC_TOKEN) die("RECONNECT_SYNC_TOKEN is required");
	if (!CACHE) die("PEOPLEGRAPH_CACHE is required");
}

function todayStamp() {
	// Local date YYYY-MM-DD
	const d = new Date();
	const p = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function loadState() {
	let raw = null;
	if (existsSync(STATE_PATH)) {
		try { raw = JSON.parse(readFileSync(STATE_PATH, "utf8")); } catch { raw = null; }
	}
	return migrateState(raw);
}

function saveState(state) {
	mkdirSync(dirname(STATE_PATH), { recursive: true });
	writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function pg(args) {
	try {
		const out = execFileSync(BIN, ["--cache", CACHE, ...args], { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
		return JSON.parse(out);
	} catch (err) {
		const raw = err.stdout || err.output?.[1] || "{}";
		try { return JSON.parse(raw); } catch { return { ok: false, error: { message: String(err) } }; }
	}
}

async function api(path, { method = "GET", body } = {}) {
	const resp = await fetch(`${WEB_URL}${path}`, {
		method,
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${SYNC_TOKEN}`,
		},
		body: body ? JSON.stringify(body) : undefined,
	});
	const text = await resp.text();
	let data;
	try { data = JSON.parse(text); } catch { data = { raw: text }; }
	if (!resp.ok) throw new Error(`${path} -> ${resp.status}: ${text}`);
	return data;
}

// forceReset: wipe the Worker's candidates table before uploading (recovery
// tool — e.g. after a rogue bridge with a different salt polluted the pool).
async function push({ forceReset = false } = {}) {
	const state = loadState();

	// Full re-engage pool. The CLI excludes anyone with a feedback entry, so
	// this is exactly the not-yet-swiped set; the Worker sees only diffs.
	const res = pg(["reconnect", "--limit", "5000"]);
	if (!res.ok) die(`peoplegraph reconnect failed: ${JSON.stringify(res.error || res)}`);
	const people = res.data?.people ?? [];

	const pool = people.map((p) => {
		const id = stableId(state.salt, p.email);
		state.map[id] = p.email.trim().toLowerCase(); // merged, never clobbered
		const row = {
			id,
			name: p.name,
			company: p.company ?? null,
			last_contact: p.last_contact ?? null,
			score: p.effective_score ?? p.score?.combined ?? 0,
			nudge: p.nudge ?? null,
		};
		return { id, h: contentHash(row), s: row.score, row };
	});

	const reset = forceReset || Object.keys(state.lastPush).length === 0;
	// On a forced reset the server side starts empty, so everything must upload.
	const { upserts, removeIds, next } = diffPool(forceReset ? {} : state.lastPush, pool);

	if (!upserts.length && !removeIds.length && !reset) {
		console.log("pool unchanged — nothing to push");
	} else {
		const CHUNK = 400;
		for (let i = 0; i < Math.max(upserts.length, 1); i += CHUNK) {
			await api("/api/sync", {
				method: "POST",
				body: {
					upserts: upserts.slice(i, i + CHUNK),
					remove_ids: i === 0 ? removeIds : [],
					reset: reset && i === 0, // first chunk of a fresh state clears the table
				},
			});
		}
	}
	state.lastPush = next;
	saveState(state);

	writeDailyNoteLine(pool.length);
	console.log(`pool ${pool.length} candidates (${upserts.length} upserted, ${removeIds.length} removed)`);

	// Output only the top 20 candidate details as JSON for the Telegram preview.
	// The full set is in the swipe app already.
	const preview = people.slice(0, 20);
	console.log("CANDIDATES_JSON:" + JSON.stringify(preview.map(p => ({
		name: p.name,
		company: p.company ?? null,
		days_since: p.days_since_contact ?? null,
		nudge: p.nudge ?? null,
	}))));
	console.log(`TOTAL_CANDIDATES:${pool.length}`);
}

function writeDailyNoteLine(count) {
	if (!DAILY_NOTE || count === 0) return;
	const marker = "<!-- reconnect-web -->";
	let existing = "";
	try { existing = readFileSync(DAILY_NOTE, "utf8"); } catch { /* note may not exist yet */ }
	if (existing.includes(marker)) return; // already linked today
	const line = `- ☀️ [Reconnect — ${count} ${count === 1 ? "person" : "people"} to review](${PUBLIC_URL}) ${marker}\n`;
	appendFileSync(DAILY_NOTE, (existing && !existing.endsWith("\n") ? "\n" : "") + line);
}

let _emailToPath = null;
function buildEmailToPath() {
	if (_emailToPath) return _emailToPath;
	const map = new Map();
	if (!existsSync(PEOPLE_FOLDER)) {
		console.warn(`people folder not found, skipping note overrides: ${PEOPLE_FOLDER}`);
		_emailToPath = map;
		return map;
	}
	for (const name of readdirSync(PEOPLE_FOLDER)) {
		if (!name.endsWith(".md")) continue;
		const p = join(PEOPLE_FOLDER, name);
		let head;
		try { head = readFileSync(p, "utf8").slice(0, 4096); } catch { continue; }
		const fm = head.match(/^---\n([\s\S]*?)\n---/);
		if (!fm) continue;
		const m = fm[1].match(/^email:\s*(.+?)\s*$/m);
		if (!m) continue;
		const e = m[1].replace(/^["']|["']$/g, "").trim().toLowerCase();
		if (e) map.set(e, p);
	}
	_emailToPath = map;
	return map;
}

function patchOverride(filePath, action, dateStamp) {
	const src = readFileSync(filePath, "utf8");
	const fm = src.match(/^---\n([\s\S]*?)\n---/);
	if (!fm) return false;
	let yaml = fm[1];
	const setField = (name, value) => {
		const re = new RegExp(`^${name}:.*$`, "m");
		if (re.test(yaml)) yaml = yaml.replace(re, `${name}: ${value}`);
		else yaml = yaml.replace(/\s*$/, "") + `\n${name}: ${value}`;
	};
	setField("override", action);
	setField("override_at", dateStamp);
	const rebuilt = `---\n${yaml}\n---` + src.slice(fm[0].length);
	writeFileSync(filePath, rebuilt);
	return true;
}

async function pull() {
	const state = loadState();
	const { decisions = [] } = await api("/api/decisions?applied=0");
	if (decisions.length === 0) {
		console.log("no pending decisions");
		return;
	}

	const acked = [];
	// Write feedback directly to reconnect-feedback.json instead of calling
	// `peoplegraph feedback` (which fails via server in V1 remote mode).
	// Also avoids the 23K-index-load-per-call performance pitfall.
	const fbPath = join(dirname(CACHE), "reconnect-feedback.json");
	let fb;
	try {
		fb = JSON.parse(readFileSync(fbPath, "utf8"));
	} catch {
		fb = { schemaVersion: 1, updatedAtUnix: 0, entries: {} };
	}
	const nowUnix = Math.floor(Date.now() / 1000);

	for (const d of decisions) {
		const email = state.map?.[d.id];
		if (!email) {
			// Ids are stable and the map is permanent, so this only fires for
			// pre-migration ids. Ack once (with a warning) instead of looping forever.
			console.warn(`ack ${d.id} without applying: no local email mapping (pre-migration id?)`);
			acked.push(d.id);
			continue;
		}
		if (!["boost", "suppress", "delete"].includes(d.action)) {
			console.warn(`skip ${d.id}: unknown action ${d.action}`);
			continue;
		}

		if (d.action === "delete") {
			// Gone-gone: the CLI removes the contact from the cache AND blocklists
			// the email so future Gmail syncs can't resurrect it.
			const res = pg(["feedback", "--email", email, "--action", "delete"]);
			if (!res.ok) {
				console.warn(`delete failed for ${email}: ${JSON.stringify(res.error || res)}`);
				continue; // not acked -> retried next run
			}
		} else {
			// boost/suppress: write the overlay directly (fast path, no index load)
			fb.entries[email.trim().toLowerCase()] = { action: d.action, delta: 10, updatedUnix: nowUnix };
		}
		acked.push(d.id);
		console.log(`applied ${d.action} -> ${email}`);

		const notePath = buildEmailToPath().get(email.toLowerCase());
		if (notePath) {
			try {
				patchOverride(notePath, d.action, todayStamp());
				console.log(`override ${d.action} -> ${notePath}`);
			} catch (e) {
				console.warn(`override write failed for ${email}: ${e.message}`);
			}
		} else {
			console.warn(`no Person note found for ${email} (override not written)`);
		}
	}

	// Persist feedback file and ack decisions on the Worker
	if (acked.length) {
		fb.updatedAtUnix = nowUnix;
		writeFileSync(fbPath, JSON.stringify(fb, null, 2));
		// Ack in chunks of 50 to stay within D1 SQL variable limits
		for (let i = 0; i < acked.length; i += 50) {
			const chunk = acked.slice(i, i + 50);
			try {
				await api("/api/decisions/ack", { method: "POST", body: { ids: chunk } });
			} catch (e) {
				console.warn(`ack chunk ${i}-${i + chunk.length} failed: ${e.message}`);
			}
		}
	}

	// Ids are stable: the map is the permanent id->email dictionary, never pruned.
	saveState(state);

	console.log(`applied ${acked.length}/${decisions.length} decisions`);
}

const MERGE_SCAN_INTERVAL_SECS = 7 * 86400; // pair scan is O(n^2) — weekly is plenty
const AUTO_MERGE_CONFIDENCE = "0.94";
const REVIEW_MIN_CONFIDENCE = "0.88";

// merge-push: auto-merge the corroborated tier locally, then sync the
// uncertain band (0.88-0.93) to the /merge review deck. Weekly unless --force.
async function mergePush({ force = false } = {}) {
	const state = loadState();
	const nowUnix = Math.floor(Date.now() / 1000);
	if (!force && nowUnix - state.lastMergeScanUnix < MERGE_SCAN_INTERVAL_SECS) {
		console.log("merge scan ran recently — skipping (use merge-push --force to override)");
		return;
	}

	const applied = pg(["apply-duplicates", "--min-confidence", AUTO_MERGE_CONFIDENCE]);
	if (!applied.ok) die(`apply-duplicates failed: ${JSON.stringify(applied.error || applied)}`);
	console.log(`auto-merged ${applied.data?.applied_pairs ?? 0} corroborated pairs`);

	const res = pg(["suggest-duplicates", "--min-confidence", REVIEW_MIN_CONFIDENCE, "--limit", "2000"]);
	if (!res.ok) die(`suggest-duplicates failed: ${JSON.stringify(res.error || res)}`);
	const suggestions = (res.data?.suggestions ?? []).filter((s) => s.confidence < 0.94);

	const pool = suggestions.map((s) => {
		const id = pairId(state.salt, s.primary.email, s.duplicate.email);
		state.mergeMap[id] = {
			a: s.primary.email.trim().toLowerCase(),
			b: s.duplicate.email.trim().toLowerCase(),
		};
		const row = {
			id,
			confidence: s.confidence,
			reasons: (s.reasons ?? []).join(","),
			name_a: s.primary.name, company_a: s.primary.company ?? null,
			domain_a: s.primary.domain ?? null, last_contact_a: s.primary.last_contact ?? null,
			exchanges_a: s.primary.total_exchanges ?? null,
			name_b: s.duplicate.name, company_b: s.duplicate.company ?? null,
			domain_b: s.duplicate.domain ?? null, last_contact_b: s.duplicate.last_contact ?? null,
			exchanges_b: s.duplicate.total_exchanges ?? null,
		};
		return { id, h: hashValues([row.confidence, row.reasons, row.name_a, row.name_b, row.company_a, row.company_b]), s: 0, row };
	});

	const reset = Object.keys(state.lastMergePush).length === 0;
	const { upserts, removeIds, next } = diffPool(state.lastMergePush, pool);
	if (!upserts.length && !removeIds.length && !reset) {
		console.log("merge pairs unchanged — nothing to push");
	} else {
		const CHUNK = 200;
		for (let i = 0; i < Math.max(upserts.length, 1); i += CHUNK) {
			await api("/api/merge/sync", {
				method: "POST",
				body: {
					upserts: upserts.slice(i, i + CHUNK),
					remove_ids: i === 0 ? removeIds : [],
					reset: reset && i === 0,
				},
			});
		}
	}
	state.lastMergePush = next;
	state.lastMergeScanUnix = nowUnix;
	saveState(state);
	console.log(`merge review pool: ${pool.length} pairs (${upserts.length} upserted, ${removeIds.length} removed)`);
}

// merge-pull: apply human verdicts. right/'merge' -> apply-merge (canonical id
// + unioned aliases); left/'keep' -> dismiss-merge (never suggested again).
async function mergePull() {
	const state = loadState();
	const { decisions = [] } = await api("/api/merge/decisions?applied=0");
	if (decisions.length === 0) {
		console.log("no pending merge decisions");
		return;
	}
	const acked = [];
	for (const d of decisions) {
		const pair = state.mergeMap?.[d.id];
		if (!pair) {
			console.warn(`ack merge ${d.id} without applying: no local pair mapping`);
			acked.push(d.id);
			continue;
		}
		if (d.action === "merge") {
			const res = pg(["apply-merge", pair.a, pair.b]);
			if (!res.ok) {
				console.warn(`apply-merge failed for ${pair.a}+${pair.b}: ${JSON.stringify(res.error || res)}`);
				continue; // not acked -> retried next run
			}
			console.log(`merged ${pair.a} + ${pair.b}`);
		} else if (d.action === "keep") {
			const res = pg(["dismiss-merge", pair.a, pair.b, "--reason", "not_duplicate"]);
			if (!res.ok) {
				console.warn(`dismiss-merge failed for ${pair.a}+${pair.b}: ${JSON.stringify(res.error || res)}`);
				continue;
			}
			console.log(`kept apart ${pair.a} | ${pair.b}`);
		} else {
			console.warn(`skip merge ${d.id}: unknown action ${d.action}`);
			continue;
		}
		acked.push(d.id);
	}
	if (acked.length) {
		for (let i = 0; i < acked.length; i += 50) {
			try {
				await api("/api/merge/decisions/ack", { method: "POST", body: { ids: acked.slice(i, i + 50) } });
			} catch (e) {
				console.warn(`merge ack chunk failed: ${e.message}`);
			}
		}
	}
	saveState(state);
	console.log(`applied ${acked.length}/${decisions.length} merge decisions`);
}

function help() {
	console.log(`peoplegraph-reconnect-web — Botwick bridge for the Reconnect swipe app

Usage:
  node scripts/peoplegraph-reconnect-web.mjs <command>

Commands:
  push        sync the unswiped pool to the Worker (--reset wipes server rows first)
  pull        fetch swipe decisions, apply via 'peoplegraph feedback', ack them
  merge-push  auto-merge >=0.94 pairs locally, sync 0.88-0.93 band to the /merge review deck (--force to bypass the weekly scan interval)
  merge-pull  fetch merge/keep verdicts from the /merge deck, apply via apply-merge/dismiss-merge, ack them
  run         pull, merge-pull, push, merge-push (recommended daily cron; merge steps wrapped in try/catch)
  help        show this

Required env: RECONNECT_WEB_URL, RECONNECT_SYNC_TOKEN, PEOPLEGRAPH_CACHE`);
}

const cmd = process.argv[2] || "help";
if (cmd === "help" || cmd === "-h" || cmd === "--help") {
	help();
} else {
	requireEnv();
	const forceReset = process.argv.includes("--reset");
	const force = process.argv.includes("--force");
	if (cmd === "push") await push({ forceReset });
	else if (cmd === "pull") await pull();
	else if (cmd === "merge-push") await mergePush({ force });
	else if (cmd === "merge-pull") await mergePull();
	else if (cmd === "run") {
		await pull();
		try { await mergePull(); } catch (e) { console.warn(`merge-pull failed (contact sync unaffected): ${e.message}`); }
		await push({ forceReset });
		try { await mergePush({ force }); } catch (e) { console.warn(`merge-push failed (contact sync unaffected): ${e.message}`); }
	}
	else { help(); process.exit(1); }
}
