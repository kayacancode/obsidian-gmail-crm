-- People graph viewer — D1 schema.
-- One row per tenant (Google-verified email). The blob is the full graph the
-- plugin pushed: nodes carry opaque ids (salted hash, salt stays in the vault),
-- names, and scores; edges carry weights and sample contexts. Never emails.

CREATE TABLE IF NOT EXISTS graphs (
  email      TEXT PRIMARY KEY,   -- tenant key: Google-verified sign-in email, lowercase
  json       TEXT NOT NULL,      -- {pushedAt, nodes:[...], edges:[...]}
  updated_at INTEGER NOT NULL    -- unix seconds of last push
);

-- Network sharing: the global index of who shares which slice with whom. One row per
-- (owner, viewer) pair. No graph data lives here — the owner's Durable Object exports the
-- slice on demand and the viewer's object caches it (see src/network-share.ts). Both columns
-- hold lowercase Google sign-in emails, the same keys the MAIL namespace is addressed by.
-- Created lazily by src/share-routes.ts (CREATE TABLE IF NOT EXISTS, memoized per isolate);
-- this file is the documentation of record, not a migration that has to be run.
CREATE TABLE IF NOT EXISTS shares (
  owner_email TEXT NOT NULL,           -- who shares (the only party who may create or change it)
  viewer_email TEXT NOT NULL,          -- who receives it
  scope TEXT NOT NULL,                 -- JSON ShareScope: {kind:'all'|'folders'|'people', ...}
  level TEXT NOT NULL,                 -- 'names' | 'themes' | 'statements'
  created_at INTEGER NOT NULL,         -- unix ms
  updated_at INTEGER NOT NULL,         -- unix ms
  hidden INTEGER NOT NULL DEFAULT 0,   -- 1 = the viewer declined it; their cached copy is dropped
  PRIMARY KEY(owner_email, viewer_email)
);
CREATE INDEX IF NOT EXISTS shares_viewer ON shares(viewer_email, hidden);
CREATE TABLE IF NOT EXISTS cli_challenges (
 id TEXT PRIMARY KEY, poll_hash TEXT NOT NULL, user_code TEXT NOT NULL UNIQUE,
 name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', owner TEXT,
 created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_poll INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS cli_challenges_expiry ON cli_challenges(expires_at);
CREATE TABLE IF NOT EXISTS cli_devices (
 id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, owner TEXT NOT NULL,
 name TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS cli_devices_owner ON cli_devices(owner);
CREATE TABLE IF NOT EXISTS cli_rate_limits (key TEXT PRIMARY KEY, window INTEGER NOT NULL, count INTEGER NOT NULL);
