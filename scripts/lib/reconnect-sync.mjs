// Pure helpers for the reconnect bridge (scripts/peoplegraph-reconnect-web.mjs).
// Kept dependency-free and side-effect-free so `node --test scripts/lib/` covers them.
import { createHmac, createHash, randomBytes } from "node:crypto";

// Stable opaque id: same contact -> same id every push, so a swipe recorded
// any day excludes the contact forever. Not reversible without the local salt.
export function stableId(saltHex, email) {
	return createHmac("sha256", Buffer.from(saltHex, "hex"))
		.update(email.trim().toLowerCase())
		.digest("hex")
		.slice(0, 32);
}

// Hash of the display fields that rarely change. Score is EXCLUDED (it can
// drift a point or two daily); diffPool applies a >=3 threshold to it instead.
export function contentHash({ name, company, last_contact, nudge }) {
	return createHash("sha256")
		.update(JSON.stringify([name ?? null, company ?? null, last_contact ?? null, nudge ?? null]))
		.digest("hex")
		.slice(0, 16);
}

const SCORE_THRESHOLD = 3;

// lastPush: { [id]: { h, s } }  pool: [{ id, h, s, row }]
export function diffPool(lastPush, pool) {
	const upserts = [];
	const next = {};
	const poolIds = new Set();
	for (const { id, h, s, row } of pool) {
		poolIds.add(id);
		const prev = lastPush[id];
		if (!prev || prev.h !== h || Math.abs(s - prev.s) >= SCORE_THRESHOLD) {
			upserts.push(row);
			next[id] = { h, s };
		} else {
			next[id] = prev; // unchanged: keep prior score so drift accumulates toward the threshold
		}
	}
	const removeIds = Object.keys(lastPush).filter((id) => !poolIds.has(id));
	return { upserts, removeIds, next };
}

// State schema v2. Legacy v1 state (random uuids, batch_date) is discarded:
// its map is only meaningful against decisions that the migration wipes.
export function migrateState(raw) {
	if (raw && raw.version === 2 && typeof raw.salt === "string") return raw;
	return { version: 2, salt: randomBytes(32).toString("hex"), map: {}, lastPush: {} };
}
