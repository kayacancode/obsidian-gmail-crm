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
