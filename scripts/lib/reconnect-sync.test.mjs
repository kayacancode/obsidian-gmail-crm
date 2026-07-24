import { test } from "node:test";
import assert from "node:assert/strict";
import { stableId, contentHash, diffPool, migrateState } from "./reconnect-sync.mjs";

const SALT = "ab".repeat(32);

test("stableId is deterministic, case/space-insensitive, 32 hex chars", () => {
	const a = stableId(SALT, "Alice@Example.com ");
	const b = stableId(SALT, "alice@example.com");
	assert.equal(a, b);
	assert.match(a, /^[0-9a-f]{32}$/);
	assert.notEqual(a, stableId(SALT, "bob@example.com"));
	assert.notEqual(a, stableId("cd".repeat(32), "alice@example.com"), "salt matters");
});

test("contentHash ignores score and day-to-day noise fields", () => {
	const base = { name: "A", company: "B", last_contact: "2026-07-01", nudge: "at B" };
	assert.equal(contentHash(base), contentHash({ ...base, extra: "ignored" }));
	assert.notEqual(contentHash(base), contentHash({ ...base, last_contact: "2026-07-20" }));
	assert.match(contentHash(base), /^[0-9a-f]{16}$/);
});

test("diffPool: new, changed, score-threshold, removed", () => {
	const rowA = { id: "a", name: "A", score: 50 };
	const rowB = { id: "b", name: "B", score: 50 };
	const last = { a: { h: "same", s: 50 }, gone: { h: "x", s: 10 } };
	const pool = [
		{ id: "a", h: "same", s: 52, row: rowA },   // hash same, |Δs|=2 -> skip
		{ id: "b", h: "new", s: 50, row: rowB },     // new id -> upsert
	];
	const { upserts, removeIds, next } = diffPool(last, pool);
	assert.deepEqual(upserts, [rowB]);
	assert.deepEqual(removeIds, ["gone"]);
	assert.deepEqual(Object.keys(next).sort(), ["a", "b"]);
	assert.equal(next.a.s, 50, "unchanged entries keep their last-pushed score");
	// score drift past threshold triggers an upsert
	const drift = diffPool({ a: { h: "same", s: 50 } }, [{ id: "a", h: "same", s: 54, row: rowA }]);
	assert.deepEqual(drift.upserts, [rowA]);
	assert.equal(drift.next.a.s, 54);
});

test("migrateState: fresh, legacy v1, and passthrough", () => {
	const fresh = migrateState(null);
	assert.equal(fresh.version, 2);
	assert.match(fresh.salt, /^[0-9a-f]{64}$/);
	assert.deepEqual(fresh.map, {});
	assert.deepEqual(fresh.lastPush, {});
	const legacy = migrateState({ batch_date: "2026-07-22", map: { uuid: "a@b.com" } });
	assert.equal(legacy.version, 2, "legacy v1 state is discarded into a fresh v2");
	assert.deepEqual(legacy.map, {}, "old uuid map is useless once decisions are wiped");
	const v2 = { version: 2, salt: SALT, map: { x: "a@b.com" }, lastPush: { x: { h: "h", s: 1 } } };
	assert.deepEqual(migrateState(v2), v2, "v2 passes through untouched");
});
