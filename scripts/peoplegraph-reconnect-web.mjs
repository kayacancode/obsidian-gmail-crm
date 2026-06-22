#!/usr/bin/env node
/**
 * Botwick bridge for the Reconnect web app (apps/reconnect-web).
 *
 * Dependency-free. Runs on the source-of-truth machine (it needs local
 * `peoplegraph` for both the read and the writes).
 *
 *   push  — compute today's re-engage candidates, assign opaque ids (kept in a
 *           local id->email map so emails never leave the machine), POST them to
 *           the Worker, and drop a one-line click-through into the daily note.
 *   pull  — fetch swipe decisions from the Worker, map id->email locally, apply
 *           each via `peoplegraph feedback`, then ack them.
 *   run   — pull (apply yesterday's swipes) then push (post today's).
 *
 * Env:
 *   RECONNECT_WEB_URL        Worker base URL, e.g. https://reconnect-web.<acct>.workers.dev   (required)
 *   RECONNECT_SYNC_TOKEN     matches the Worker's SYNC_TOKEN secret                            (required)
 *   PEOPLEGRAPH_CACHE        path to contact-index.json (passed to peoplegraph --cache)        (required)
 *   PEOPLEGRAPH_BIN          peoplegraph binary (default: "peoplegraph")
 *   RECONNECT_LIMIT          candidates per batch (default: 5)
 *   RECONNECT_STATE          id->email map file (default: ~/.peoplegraph/reconnect-web-state.json)
 *   RECONNECT_DAILY_NOTE     optional path to today's daily note to append the link line
 *   RECONNECT_PUBLIC_URL     public URL used in the daily-note link (default: RECONNECT_WEB_URL)
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const env = process.env;
const WEB_URL = (env.RECONNECT_WEB_URL || "").replace(/\/$/, "");
const SYNC_TOKEN = env.RECONNECT_SYNC_TOKEN || "";
const CACHE = env.PEOPLEGRAPH_CACHE || "";
const BIN = env.PEOPLEGRAPH_BIN || "peoplegraph";
const RAW_LIMIT = Number(env.RECONNECT_LIMIT || "5");
const MAX_LIMIT = Number(env.RECONNECT_MAX_LIMIT || "50");
const LIMIT = Math.min(RAW_LIMIT, MAX_LIMIT);
if (RAW_LIMIT > MAX_LIMIT) {
	console.error(`warning: RECONNECT_LIMIT=${RAW_LIMIT} exceeds MAX (${MAX_LIMIT}); capped. Every pushed candidate gets a 30-day "shown" cooldown, so over-pushing silently drains the re-engage pool. Lower RECONNECT_LIMIT to what the human actually swipes per day, or raise RECONNECT_MAX_LIMIT explicitly.`);
}
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
	if (!existsSync(STATE_PATH)) return { batch_date: null, map: {} };
	try {
		return JSON.parse(readFileSync(STATE_PATH, "utf8"));
	} catch {
		return { batch_date: null, map: {} };
	}
}

function saveState(state) {
	mkdirSync(dirname(STATE_PATH), { recursive: true });
	writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function pg(args) {
	try {
		const out = execFileSync(BIN, ["--cache", CACHE, ...args], { encoding: "utf8" });
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

async function push() {
	const res = pg(["reconnect", "--limit", String(LIMIT)]);
	if (!res.ok) die(`peoplegraph reconnect failed: ${JSON.stringify(res.error || res)}`);
	const people = res.data?.people ?? [];

	const state = loadState();
	const batch_date = todayStamp();
	state.batch_date = batch_date;
	if (!state.map) state.map = {}; // keep old mappings so pull can resolve them

	const candidates = people.map((p) => {
		const id = randomUUID();
		state.map[id] = p.email; // email stays local; only id leaves the machine
		return {
			id,
			name: p.name,
			company: p.company ?? null,
			days_since: p.days_since_contact ?? null,
			score: p.effective_score ?? p.score?.combined ?? null,
			nudge: p.nudge ?? null,
		};
	});

	// Push in chunks to avoid D1 batch limits (Worker does one DB.batch per sync)
	const CHUNK = 500;
	for (let i = 0; i < candidates.length; i += CHUNK) {
		const chunk = candidates.slice(i, i + CHUNK);
		// Only replace on the first chunk to clear old batch; subsequent chunks append
		await api("/api/sync", { method: "POST", body: { batch_date, replace: i === 0, candidates: chunk } });
	}
	saveState(state);

	// Mark all pushed candidates as "shown" in reconnect-feedback.json so
	// they don't reappear in tomorrow's batch. Written directly to the JSON
	// file (not via CLI) for speed. Real swipe decisions (boost/suppress/delete)
	// from pull() will overwrite "shown" entries. Shown entries expire after
	// 30 days in the reconnect filter so unswiped contacts eventually resurface.
	const fbPath = join(dirname(CACHE), "reconnect-feedback.json");
	let fb;
	try {
		fb = JSON.parse(readFileSync(fbPath, "utf8"));
	} catch {
		fb = { schemaVersion: 1, updatedAtUnix: 0, entries: {} };
	}
	const nowUnix = Math.floor(Date.now() / 1000);
	let shownCount = 0;
	for (const p of people) {
		const email = p.email.trim().toLowerCase();
		const existing = fb.entries?.[email];
		if (existing && existing.action !== "shown") continue; // don't overwrite real swipes
		fb.entries[email] = { action: "shown", delta: 0, updatedUnix: nowUnix };
		shownCount++;
	}
	fb.updatedAtUnix = nowUnix;
	writeFileSync(fbPath, JSON.stringify(fb, null, 2));
	console.log(`marked ${shownCount} candidates as shown`);

	writeDailyNoteLine(candidates.length);
	console.log(`pushed ${candidates.length} candidates for ${batch_date}`);

	// Output only the top 20 candidate details as JSON for the Telegram preview.
	// The full set is in the swipe app already.
	const preview = people.slice(0, 20);
	console.log("CANDIDATES_JSON:" + JSON.stringify(preview.map(p => ({
		name: p.name,
		company: p.company ?? null,
		days_since: p.days_since_contact ?? null,
		nudge: p.nudge ?? null,
	}))));
	console.log(`TOTAL_CANDIDATES:${candidates.length}`);
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
			console.warn(`skip ${d.id}: no local email mapping (stale id?)`);
			continue;
		}
		if (!["boost", "suppress", "delete"].includes(d.action)) {
			console.warn(`skip ${d.id}: unknown action ${d.action}`);
			continue;
		}

		// Write to feedback JSON directly
		const delta = d.action === "delete" ? 0 : 10;
		fb.entries[email] = { action: d.action, delta, updatedUnix: nowUnix };
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

	// Clean up applied IDs from the local map to prevent unbounded growth
	for (const id of acked) delete state.map[id];
	saveState(state);

	console.log(`applied ${acked.length}/${decisions.length} decisions`);
}

function help() {
	console.log(`peoplegraph-reconnect-web — Botwick bridge for the Reconnect swipe app

Usage:
  node scripts/peoplegraph-reconnect-web.mjs <command>

Commands:
  push   compute today's candidates, sync to the Worker, link the daily note
  pull   fetch swipe decisions, apply via 'peoplegraph feedback', ack them
  run    pull then push (recommended daily cron)
  help   show this

Required env: RECONNECT_WEB_URL, RECONNECT_SYNC_TOKEN, PEOPLEGRAPH_CACHE`);
}

const cmd = process.argv[2] || "help";
if (cmd === "help" || cmd === "-h" || cmd === "--help") {
	help();
} else {
	requireEnv();
	if (cmd === "push") await push();
	else if (cmd === "pull") await pull();
	else if (cmd === "run") { await pull(); await push(); }
	else { help(); process.exit(1); }
}
