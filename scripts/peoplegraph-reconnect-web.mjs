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
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const env = process.env;
const WEB_URL = (env.RECONNECT_WEB_URL || "").replace(/\/$/, "");
const SYNC_TOKEN = env.RECONNECT_SYNC_TOKEN || "";
const CACHE = env.PEOPLEGRAPH_CACHE || "";
const BIN = env.PEOPLEGRAPH_BIN || "peoplegraph";
const LIMIT = Number(env.RECONNECT_LIMIT || "5");
const STATE_PATH = env.RECONNECT_STATE || join(homedir(), ".peoplegraph", "reconnect-web-state.json");
const DAILY_NOTE = env.RECONNECT_DAILY_NOTE || "";
const PUBLIC_URL = (env.RECONNECT_PUBLIC_URL || WEB_URL).replace(/\/$/, "");

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
	const out = execFileSync(BIN, ["--cache", CACHE, ...args], { encoding: "utf8" });
	return JSON.parse(out);
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

	await api("/api/sync", { method: "POST", body: { batch_date, replace: true, candidates } });
	saveState(state);

	writeDailyNoteLine(candidates.length);
	console.log(`pushed ${candidates.length} candidates for ${batch_date}`);
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

async function pull() {
	const state = loadState();
	const { decisions = [] } = await api("/api/decisions?applied=0");
	if (decisions.length === 0) {
		console.log("no pending decisions");
		return;
	}

	const acked = [];
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
		const res = pg(["feedback", "--email", email, "--action", d.action]);
		if (res.ok) {
			acked.push(d.id);
			console.log(`applied ${d.action} -> ${email}`);
		} else {
			console.warn(`feedback failed for ${email}: ${JSON.stringify(res.error || res)}`);
		}
	}

	if (acked.length) await api("/api/decisions/ack", { method: "POST", body: { ids: acked } });

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
