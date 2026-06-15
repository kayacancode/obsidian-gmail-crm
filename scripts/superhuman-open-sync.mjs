#!/usr/bin/env node
/**
 * Superhuman Open Tracking Sync
 *
 * Connects to the Superhuman MCP server, fetches read receipt data via
 * get_read_status_feed, and writes open tracking fields (openCount,
 * lastOpenAt, openEngagement) into contact-index.json.
 *
 * Usage:
 *   node scripts/superhuman-open-sync.mjs [--since DAYS] [--dry-run]
 *
 * Env:
 *   PEOPLEGRAPH_CACHE    path to contact-index.json (required)
 *
 * Requires: npx @superhuman/mcp-mail (OAuth must be pre-authenticated)
 */

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const CACHE = process.env.PEOPLEGRAPH_CACHE || "";
if (!CACHE) {
	console.error("error: PEOPLEGRAPH_CACHE is required");
	process.exit(1);
}

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const sinceIdx = args.indexOf("--since");
const SINCE_DAYS = sinceIdx >= 0 ? parseInt(args[sinceIdx + 1], 10) : 14;

// ─── MCP JSON-RPC client over stdio ───────────────────────────────────

class McpClient {
	constructor() {
		this._id = 0;
		this._pending = new Map();
		this._buffer = "";
		this._proc = null;
	}

	async connect() {
		return new Promise((resolve, reject) => {
			this._proc = spawn("npx", ["-y", "@superhuman/mcp-mail"], {
				stdio: ["pipe", "pipe", "pipe"],
			});

			this._proc.stdout.on("data", (chunk) => {
				this._buffer += chunk.toString();
				this._drain();
			});

			this._proc.stderr.on("data", (chunk) => {
				const line = chunk.toString().trim();
				if (line) process.stderr.write(`[superhuman] ${line}\n`);
			});

			this._proc.on("error", reject);
			this._proc.on("close", (code) => {
				for (const [, { reject: rej }] of this._pending) {
					rej(new Error(`MCP process exited with code ${code}`));
				}
				this._pending.clear();
			});

			// Wait for the server to be ready, then initialize
			setTimeout(async () => {
				try {
					await this._call("initialize", {
						protocolVersion: "2025-03-26",
						capabilities: {},
						clientInfo: { name: "superhuman-open-sync", version: "1.0" },
					});
					// Send initialized notification
					this._send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
					resolve();
				} catch (e) {
					reject(e);
				}
			}, 3000); // give npx time to start
		});
	}

	async callTool(name, args = {}) {
		const result = await this._call("tools/call", { name, arguments: args });
		// MCP tool results come as content array
		if (result.content) {
			for (const item of result.content) {
				if (item.type === "text") {
					try { return JSON.parse(item.text); } catch { return item.text; }
				}
			}
		}
		return result;
	}

	close() {
		if (this._proc) {
			this._proc.stdin.end();
			this._proc.kill();
		}
	}

	_call(method, params) {
		return new Promise((resolve, reject) => {
			const id = ++this._id;
			this._pending.set(id, { resolve, reject });
			this._send({ jsonrpc: "2.0", id, method, params });
			// timeout
			setTimeout(() => {
				if (this._pending.has(id)) {
					this._pending.delete(id);
					reject(new Error(`MCP call ${method} timed out`));
				}
			}, 60000);
		});
	}

	_send(msg) {
		this._proc.stdin.write(JSON.stringify(msg) + "\n");
	}

	_drain() {
		// Split on newlines — each JSON-RPC message is one line
		const lines = this._buffer.split("\n");
		this._buffer = lines.pop(); // keep incomplete line
		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				const msg = JSON.parse(line);
				if (msg.id != null && this._pending.has(msg.id)) {
					const { resolve, reject } = this._pending.get(msg.id);
					this._pending.delete(msg.id);
					if (msg.error) reject(new Error(JSON.stringify(msg.error)));
					else resolve(msg.result);
				}
			} catch {
				// not JSON, ignore
			}
		}
	}
}

// ─── Main sync logic ──────────────────────────────────────────────────

async function main() {
	console.log(`Superhuman open tracking sync (since ${SINCE_DAYS} days, dry_run=${DRY_RUN})`);

	// Load contact index
	const index = JSON.parse(readFileSync(CACHE, "utf8"));
	const contacts = index.contacts ?? {};
	const contactEmails = new Set(Object.keys(contacts).map((e) => e.toLowerCase()));
	console.log(`Loaded ${contactEmails.size} contacts from cache`);

	// Connect to Superhuman MCP
	const client = new McpClient();
	await client.connect();
	console.log("Connected to Superhuman MCP");

	// Fetch read receipt events
	const since = new Date(Date.now() - SINCE_DAYS * 86_400_000).toISOString();
	const allEvents = [];
	let cursor = undefined;
	const MAX_PAGES = 5; // cap at ~1000 events to avoid timeout
	let page = 0;

	do {
		const params = { since, limit: 200 };
		if (cursor) params.cursor = cursor;

		const result = await client.callTool("get_read_status_feed", params);
		const events = result.events ?? [];
		allEvents.push(...events);
		cursor = result.next_cursor;
		page++;
		console.log(`Fetched ${events.length} events (total: ${allEvents.length})${cursor && page < MAX_PAGES ? ", more..." : ""}`);
	} while (cursor && page < MAX_PAGES);

	client.close();
	console.log(`Total read receipt events: ${allEvents.length}`);

	if (allEvents.length === 0) {
		console.log("No open events found — nothing to sync");
		return;
	}

	// Group events by recipient email
	const byRecipient = new Map();
	for (const event of allEvents) {
		const email = event.recipient?.email?.toLowerCase();
		if (!email) continue;
		if (!byRecipient.has(email)) {
			byRecipient.set(email, { count: 0, lastAt: null });
		}
		const rec = byRecipient.get(email);
		rec.count++;
		if (!rec.lastAt || event.occurred_at > rec.lastAt) {
			rec.lastAt = event.occurred_at;
		}
	}
	console.log(`Unique recipients with opens: ${byRecipient.size}`);

	// Merge into contacts
	let updated = 0;
	let matched = 0;
	for (const [email, data] of byRecipient) {
		// Find contact by email (case-insensitive)
		const contact = contacts[email];
		if (!contact) continue;
		matched++;

		// Accumulate opens (don't reset — these are additive signals)
		const prevCount = contact.openCount ?? 0;
		const newCount = prevCount + data.count;

		// Only update if we have new data
		const prevLastOpen = contact.lastOpenAt ?? "";
		const newLastOpen = data.lastAt && data.lastAt > prevLastOpen ? data.lastAt : prevLastOpen;

		// Derive engagement state
		let engagement = "none";
		if (newCount === 0) {
			engagement = "sent_no_open";
		} else if (newCount === 1) {
			engagement = "opened";
		} else if (newCount > 1) {
			engagement = "multi_opened";
		}
		// Check if they replied (receivedCount > 0 and lastContact is after our last sent)
		if (contact.receivedCount > 0 && contact.lastContact) {
			// If last contact is more recent than last open, they replied
			if (newLastOpen && contact.lastContact > newLastOpen) {
				engagement = "replied";
			}
		}

		if (newCount !== prevCount || newLastOpen !== prevLastOpen) {
			contact.openCount = newCount;
			contact.lastOpenAt = newLastOpen || undefined;
			contact.openEngagement = engagement;
			updated++;
		}
	}

	console.log(`Matched ${matched} recipients to contacts, updated ${updated}`);

	if (DRY_RUN) {
		console.log("DRY RUN — not writing changes");
		// Print sample
		for (const [email, data] of [...byRecipient].slice(0, 5)) {
			const c = contacts[email];
			if (c) {
				console.log(`  ${c.name} <${email}>: ${data.count} opens, last=${data.lastAt}, engagement=${c.openEngagement}`);
			}
		}
		return;
	}

	// Write back
	writeFileSync(CACHE, JSON.stringify(index, null, 2));
	console.log(`Wrote updated contact-index.json (${updated} contacts modified)`);
}

main().catch((err) => {
	console.error(`Fatal: ${err.message}`);
	process.exit(1);
});
