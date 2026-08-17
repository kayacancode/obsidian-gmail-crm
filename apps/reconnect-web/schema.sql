-- Reconnect swipe app — D1 schema (v2: stable ids, no batches).
-- Privacy: no emails or message content are ever stored here. The bridge keeps
-- the salt + id -> email map locally; this DB only holds opaque ids + display fields.

CREATE TABLE IF NOT EXISTS candidates (
  id           TEXT PRIMARY KEY,      -- stable opaque id (HMAC of email, salt local to the bridge)
  name         TEXT NOT NULL,
  company      TEXT,
  last_contact TEXT,                  -- YYYY-MM-DD of last real contact (UI renders recency)
  score        INTEGER,
  nudge        TEXT,
  updated_at   INTEGER NOT NULL       -- unix seconds of last upsert
);

CREATE INDEX IF NOT EXISTS idx_candidates_score ON candidates (score DESC);

CREATE TABLE IF NOT EXISTS decisions (
  id           TEXT PRIMARY KEY,      -- references candidates.id (one decision per contact, forever)
  action       TEXT NOT NULL,         -- 'boost' (right) | 'suppress' (left) | 'delete'
  decided_by   TEXT,                  -- google email of the swiper
  decided_at   INTEGER NOT NULL,      -- unix seconds
  applied      INTEGER NOT NULL DEFAULT 0  -- 0 until the bridge applies it locally
);

CREATE INDEX IF NOT EXISTS idx_decisions_applied ON decisions (applied);

-- Merge review: uncertain duplicate pairs (0.88-0.93) for human judgment.
-- Same privacy rule: opaque pair ids; emails never stored here.

CREATE TABLE IF NOT EXISTS merge_candidates (
  id             TEXT PRIMARY KEY,   -- opaque pair id (HMAC, salt local to bridge)
  confidence     REAL,
  reasons        TEXT,               -- comma-joined tags e.g. 'same_name,very_similar_name'
  name_a         TEXT NOT NULL,
  company_a      TEXT,
  domain_a       TEXT,
  last_contact_a TEXT,
  exchanges_a    INTEGER,
  name_b         TEXT NOT NULL,
  company_b      TEXT,
  domain_b       TEXT,
  last_contact_b TEXT,
  exchanges_b    INTEGER,
  updated_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_merge_candidates_conf ON merge_candidates (confidence DESC);

CREATE TABLE IF NOT EXISTS merge_decisions (
  id           TEXT PRIMARY KEY,     -- references merge_candidates.id
  action       TEXT NOT NULL,        -- 'merge' (right) | 'keep' (left)
  decided_by   TEXT,
  decided_at   INTEGER NOT NULL,
  applied      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_merge_decisions_applied ON merge_decisions (applied);
