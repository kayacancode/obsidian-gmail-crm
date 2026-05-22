#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const localPeopleGraph = join(repoRoot, "bin", "peoplegraph");
const defaultStatePath = join(homedir(), ".peoplegraph", "merge-review-queue.json");

const command = process.argv[2] ?? "help";
const argv = process.argv.slice(3);

function usage() {
  return `PeopleGraph Telegram merge review bridge

Usage:
  node scripts/peoplegraph-telegram-review.mjs queue --source <source> [--limit 25] [--min-confidence 0.82]
  node scripts/peoplegraph-telegram-review.mjs list [--status pending] [--source <source>]
  node scripts/peoplegraph-telegram-review.mjs send-next [--source <source>] [--resend]
  node scripts/peoplegraph-telegram-review.mjs send <review_id>
  node scripts/peoplegraph-telegram-review.mjs handle-callback <telegram-update.json|-> 

Environment:
  PEOPLEGRAPH_CACHE                    Botwick source-of-truth contact-index.json
  PEOPLEGRAPH_BIN                      Optional peoplegraph binary path
  PEOPLEGRAPH_REVIEW_STATE             Optional queue state path
  TELEGRAM_BOT_TOKEN                   Required for sending/editing Telegram messages
  TELEGRAM_REVIEW_CHAT_ID              Required for send/send-next
  PEOPLEGRAPH_APPROVER_TELEGRAM_IDS    Comma or space separated Telegram user IDs allowed to approve
`;
}

function parseFlags(args) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith("--")) {
      rest.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }
  return { flags, rest };
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(kind, message, details = {}, exitCode = 1) {
  print({
    ok: false,
    command,
    error: { kind, message },
    details,
  });
  process.exit(exitCode);
}

function ok(data, stats = {}) {
  print({
    ok: true,
    command,
    data,
    stats,
  });
}

function env(name, fallback = "") {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

function statePath() {
  return env("PEOPLEGRAPH_REVIEW_STATE", defaultStatePath);
}

function peoplegraphBin() {
  return env("PEOPLEGRAPH_BIN", existsSync(localPeopleGraph) ? localPeopleGraph : "peoplegraph");
}

function requireCache() {
  const cache = env("PEOPLEGRAPH_CACHE");
  if (!cache) {
    fail(
      "missing_cache",
      "set PEOPLEGRAPH_CACHE to Botwick's source-of-truth contact-index.json"
    );
  }
  return cache;
}

function runPeopleGraph(args) {
  const result = spawnSync(
    peoplegraphBin(),
    ["--cache", requireCache(), ...args],
    {
      encoding: "utf8",
      env: process.env,
    }
  );

  if (result.error) {
    fail("peoplegraph_failed", result.error.message, { args });
  }

  let parsed;
  try {
    parsed = JSON.parse(result.stdout || "{}");
  } catch (err) {
    fail("peoplegraph_parse_failed", `failed to parse PeopleGraph JSON: ${err.message}`, {
      args,
      stdout: result.stdout,
      stderr: result.stderr,
      status: result.status,
    });
  }

  if (result.status !== 0 || !parsed.ok) {
    fail("peoplegraph_error", parsed.error?.message ?? "PeopleGraph command failed", {
      args,
      status: result.status,
      stderr: result.stderr,
      response: parsed,
    });
  }

  return parsed;
}

function readState() {
  const path = statePath();
  if (!existsSync(path)) {
    return {
      schema_version: 1,
      updated_at: null,
      reviews: [],
    };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return {
      schema_version: parsed.schema_version ?? 1,
      updated_at: parsed.updated_at ?? null,
      reviews: Array.isArray(parsed.reviews) ? parsed.reviews : [],
    };
  } catch (err) {
    fail("state_parse_failed", `failed to parse ${path}: ${err.message}`, { path });
  }
}

function writeState(state) {
  const path = statePath();
  const tmp = `${path}.${process.pid}.tmp`;
  state.updated_at = new Date().toISOString();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

function reviewId(source, primary, external) {
  const digest = createHash("sha256")
    .update(`${source}\0${primary}\0${external}`)
    .digest("hex")
    .slice(0, 12);
  return `m_${digest}`;
}

function findReview(state, id) {
  return state.reviews.find((review) => review.review_id === id);
}

function briefName(brief) {
  return brief?.name || brief?.email || "Unknown";
}

function field(label, value) {
  if (value === null || value === undefined || value === "") {
    return `${label}: unknown`;
  }
  if (Array.isArray(value)) {
    return `${label}: ${value.length ? value.join(", ") : "unknown"}`;
  }
  return `${label}: ${value}`;
}

function suggestionToReview(suggestion) {
  const source = suggestion.source;
  const primary = suggestion.primary?.email;
  const external = suggestion.external?.email;
  if (!source || !primary || !external) {
    fail("bad_suggestion", "PeopleGraph returned a suggestion without source/primary/external", {
      suggestion,
    });
  }

  return {
    review_id: reviewId(source, primary, external),
    source,
    primary,
    external,
    confidence: suggestion.confidence,
    reasons: suggestion.reasons ?? [],
    status: "pending",
    primary_contact: suggestion.primary,
    external_contact: suggestion.external,
    next_command: suggestion.next_command,
    dismiss_command: suggestion.dismiss_command,
    telegram_chat_id: null,
    telegram_message_id: null,
    telegram_poll_id: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    reviewed_at: null,
    reviewed_by: null,
    command_result: null,
  };
}

function upsertReviews(state, suggestions) {
  let created = 0;
  let refreshed = 0;
  for (const suggestion of suggestions) {
    const next = suggestionToReview(suggestion);
    const existing = findReview(state, next.review_id);
    if (!existing) {
      state.reviews.push(next);
      created += 1;
      continue;
    }
    if (existing.status === "pending") {
      Object.assign(existing, {
        source: next.source,
        primary: next.primary,
        external: next.external,
        confidence: next.confidence,
        reasons: next.reasons,
        primary_contact: next.primary_contact,
        external_contact: next.external_contact,
        next_command: next.next_command,
        dismiss_command: next.dismiss_command,
        updated_at: new Date().toISOString(),
      });
      refreshed += 1;
    }
  }
  return { created, refreshed };
}

function filteredReviews(state, flags = {}) {
  const status = flags.status ?? "pending";
  const source = flags.source;
  return state.reviews
    .filter((review) => status === "all" || review.status === status)
    .filter((review) => !source || review.source === source)
    .sort((a, b) => {
      const confidence = Number(b.confidence ?? 0) - Number(a.confidence ?? 0);
      if (confidence !== 0) return confidence;
      return String(a.created_at).localeCompare(String(b.created_at));
    });
}

function renderReview(review, finalStatus = null) {
  const statusLine = finalStatus ? `Status: ${finalStatus}\n\n` : "";
  const confidence = Math.round(Number(review.confidence ?? 0) * 100);
  const reasons = review.reasons?.length ? review.reasons.join(", ") : "unknown";
  const primary = review.primary_contact ?? { email: review.primary };
  const external = review.external_contact ?? { email: review.external };

  return `${statusLine}PeopleGraph merge review ${review.review_id}

Confidence: ${confidence}%
Why flagged: ${reasons}

Botwick source of truth
${briefName(primary)}
${field("Email", primary.email ?? review.primary)}
${field("Company", primary.company)}
${field("Domain", primary.domain)}

External source: ${review.source}
${briefName(external)}
${field("Email", external.email ?? review.external)}
${field("Company", external.company)}
${field("Domain", external.domain)}

If approved, PeopleGraph will merge objective identity fields only. Private relationship context stays source-specific.`;
}

function renderDetails(cardResponse) {
  const data = cardResponse.data ?? {};
  const core = data.core ?? {};
  const sources = Array.isArray(data.sources) ? data.sources : [];
  const sourceLines = sources
    .slice(0, 5)
    .map((source) => {
      const contact = source.contact ?? {};
      const confidence = Math.round(Number(source.match_confidence ?? 0) * 100);
      return `- ${source.source}: ${contact.name ?? contact.email ?? "unknown"} (${confidence}%) ${contact.email ?? ""}`;
    })
    .join("\n");

  return `PeopleGraph contact card

${field("Name", core.name)}
${field("Emails", core.emails)}
${field("Company", core.company)}
${field("Role", core.role)}
${field("Previous names", core.previous_names)}
${field("Location history", core.location_history)}

External source evidence:
${sourceLines || "none"}

Private relationship context remains source-specific and is not merged into the core card.`;
}

function reviewKeyboard(review) {
  return {
    inline_keyboard: [
      [
        { text: "Merge", callback_data: `pgm:${review.review_id}:approve` },
        { text: "Reject", callback_data: `pgm:${review.review_id}:reject` },
      ],
      [{ text: "Details", callback_data: `pgm:${review.review_id}:details` }],
    ],
  };
}

async function callTelegram(method, payload) {
  const token = env("TELEGRAM_BOT_TOKEN");
  if (!token) {
    throw new Error(`set TELEGRAM_BOT_TOKEN before calling ${method}`);
  }
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const parsed = await response.json().catch(() => null);
  if (!response.ok || !parsed?.ok) {
    const err = new Error(`Telegram ${method} failed`);
    err.details = {
      status: response.status,
      response: parsed,
    };
    throw err;
  }
  return parsed.result;
}

async function telegram(method, payload) {
  try {
    return await callTelegram(method, payload);
  } catch (err) {
    fail(
      err.message.startsWith("set TELEGRAM_BOT_TOKEN")
        ? "missing_telegram_token"
        : "telegram_error",
      err.message,
      err.details ?? {}
    );
  }
}

async function maybeTelegram(method, payload) {
  if (!env("TELEGRAM_BOT_TOKEN")) {
    return null;
  }
  try {
    return await callTelegram(method, payload);
  } catch (err) {
    return { error: err.message, details: err.details ?? {} };
  }
}

async function sendReview(review) {
  const chatId = env("TELEGRAM_REVIEW_CHAT_ID");
  if (!chatId) {
    fail("missing_review_chat", "set TELEGRAM_REVIEW_CHAT_ID before sending review messages");
  }
  const message = await telegram("sendMessage", {
    chat_id: chatId,
    text: renderReview(review),
    disable_web_page_preview: true,
    reply_markup: reviewKeyboard(review),
  });
  review.telegram_chat_id = String(chatId);
  review.telegram_message_id = message.message_id;
  review.sent_at = new Date().toISOString();
  review.updated_at = new Date().toISOString();
  return message;
}

function approverIds() {
  return env("PEOPLEGRAPH_APPROVER_TELEGRAM_IDS")
    .split(/[,\s]+/)
    .map((id) => id.trim())
    .filter(Boolean);
}

function isAuthorized(userId) {
  const allowed = approverIds();
  return allowed.length > 0 && allowed.includes(String(userId));
}

function readCallbackPayload(input) {
  let raw;
  if (input === "-") {
    raw = readFileSync(0, "utf8");
  } else if (input) {
    raw = readFileSync(input, "utf8");
  } else if (!process.stdin.isTTY) {
    raw = readFileSync(0, "utf8");
  } else {
    fail("missing_callback", "pass a Telegram update JSON file or '-' for stdin");
  }

  try {
    const parsed = JSON.parse(raw);
    return parsed.callback_query ?? parsed.update?.callback_query ?? parsed;
  } catch (err) {
    fail("callback_parse_failed", `failed to parse Telegram callback JSON: ${err.message}`);
  }
}

async function answerCallback(callback, text, showAlert = false) {
  if (!callback?.id || !env("TELEGRAM_BOT_TOKEN")) {
    return null;
  }
  return maybeTelegram("answerCallbackQuery", {
    callback_query_id: callback.id,
    text,
    show_alert: showAlert,
  });
}

async function editReviewMessage(review, text, removeButtons = true) {
  if (!env("TELEGRAM_BOT_TOKEN") || !review.telegram_chat_id || !review.telegram_message_id) {
    return null;
  }
  const payload = {
    chat_id: review.telegram_chat_id,
    message_id: review.telegram_message_id,
    text,
    disable_web_page_preview: true,
  };
  if (removeButtons) {
    payload.reply_markup = { inline_keyboard: [] };
  }
  return maybeTelegram("editMessageText", payload);
}

async function sendDetailsMessage(callback, text) {
  const chatId = callback?.message?.chat?.id ?? env("TELEGRAM_REVIEW_CHAT_ID");
  if (!env("TELEGRAM_BOT_TOKEN") || !chatId) {
    return null;
  }
  return maybeTelegram("sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  });
}

async function commandQueue(flags) {
  const source = flags.source;
  if (!source || typeof source !== "string") {
    fail("missing_source", "queue requires --source <source>");
  }
  const limit = String(flags.limit ?? "25");
  const minConfidence = String(flags["min-confidence"] ?? "0.82");
  const response = runPeopleGraph([
    "suggest-external-merges",
    "--source",
    source,
    "--limit",
    limit,
    "--min-confidence",
    minConfidence,
  ]);
  const suggestions = response.data?.suggestions ?? [];
  const state = readState();
  const changes = upsertReviews(state, suggestions);
  writeState(state);
  ok({
    state_path: statePath(),
    source,
    suggestion_count: suggestions.length,
    pending_count: filteredReviews(state, { status: "pending", source }).length,
    ...changes,
  });
}

function commandList(flags) {
  const state = readState();
  const reviews = filteredReviews(state, flags).map((review) => ({
    review_id: review.review_id,
    source: review.source,
    primary: review.primary,
    external: review.external,
    confidence: review.confidence,
    reasons: review.reasons,
    status: review.status,
    telegram_message_id: review.telegram_message_id,
  }));
  ok({
    state_path: statePath(),
    reviews,
  }, {
    returned: reviews.length,
  });
}

async function commandSend(flags, rest) {
  const id = rest[0];
  if (!id) {
    fail("missing_review_id", "send requires a review_id");
  }
  const state = readState();
  const review = findReview(state, id);
  if (!review) {
    fail("review_not_found", `no review found for ${id}`);
  }
  const message = await sendReview(review);
  writeState(state);
  ok({
    review_id: review.review_id,
    telegram_chat_id: review.telegram_chat_id,
    telegram_message_id: review.telegram_message_id,
  }, {
    message_id: message.message_id,
  });
}

async function commandSendNext(flags) {
  const state = readState();
  const pending = filteredReviews(state, {
    status: "pending",
    source: flags.source,
  });
  const review = pending.find((candidate) => flags.resend || !candidate.telegram_message_id);
  if (!review) {
    ok({
      state_path: statePath(),
      sent: false,
      reason: "no unsent pending reviews",
    });
    return;
  }
  const message = await sendReview(review);
  writeState(state);
  ok({
    sent: true,
    review_id: review.review_id,
    telegram_chat_id: review.telegram_chat_id,
    telegram_message_id: review.telegram_message_id,
  }, {
    message_id: message.message_id,
  });
}

async function commandHandleCallback(rest) {
  const callback = readCallbackPayload(rest[0]);
  const match = String(callback.data ?? "").match(/^pgm:([A-Za-z0-9_-]+):(approve|reject|details)$/);
  if (!match) {
    await answerCallback(callback, "Unknown PeopleGraph action", true);
    fail("unknown_callback", "callback_data must look like pgm:<review_id>:<approve|reject|details>", {
      callback_data: callback.data,
    });
  }

  const [, id, action] = match;
  const userId = callback.from?.id;
  if (!isAuthorized(userId)) {
    await answerCallback(callback, "Not authorized", true);
    fail("unauthorized", "Telegram user is not allowed to approve PeopleGraph merges", {
      telegram_user_id: userId ?? null,
    });
  }

  const state = readState();
  const review = findReview(state, id);
  if (!review) {
    await answerCallback(callback, "Review not found", true);
    fail("review_not_found", `no review found for ${id}`);
  }

  if (action === "details") {
    const card = runPeopleGraph(["contact-card", review.primary]);
    const details = renderDetails(card);
    await answerCallback(callback, "Details sent");
    await sendDetailsMessage(callback, details);
    ok({
      review_id: id,
      action,
      card: card.data,
    });
    return;
  }

  if (review.status !== "pending") {
    await answerCallback(callback, `Already ${review.status}`, true);
    ok({
      review_id: id,
      action,
      status: review.status,
      closed: true,
    });
    return;
  }

  const now = new Date().toISOString();
  let response;
  if (action === "approve") {
    response = runPeopleGraph([
      "apply-external-merge",
      "--source",
      review.source,
      "--primary",
      review.primary,
      "--external",
      review.external,
    ]);
    review.status = "approved";
  } else {
    response = runPeopleGraph([
      "dismiss-external-merge",
      "--source",
      review.source,
      "--primary",
      review.primary,
      "--external",
      review.external,
      "--reason",
      "not_same_person",
    ]);
    review.status = "rejected";
  }

  review.reviewed_at = now;
  review.reviewed_by = String(userId);
  review.updated_at = now;
  review.command_result = response;
  writeState(state);

  await answerCallback(callback, action === "approve" ? "Merge applied" : "Merge rejected");
  await editReviewMessage(review, renderReview(review, review.status.toUpperCase()));

  ok({
    review_id: id,
    action,
    status: review.status,
    result: response.data,
  });
}

async function main() {
  const { flags, rest } = parseFlags(argv);
  switch (command) {
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(usage());
      break;
    case "queue":
      commandQueue(flags);
      break;
    case "list":
      commandList(flags);
      break;
    case "send":
      await commandSend(flags, rest);
      break;
    case "send-next":
      await commandSendNext(flags);
      break;
    case "handle-callback":
      await commandHandleCallback(rest);
      break;
    default:
      fail("unknown_command", `unknown command: ${command}`, { usage: usage() });
  }
}

main().catch((err) => {
  fail("unhandled_error", err instanceof Error ? err.message : String(err));
});
