-- Reconnect swipe app — D1 schema.
-- Privacy: no emails or message content are ever stored here. Botwick keeps the
-- opaque id -> email map locally; this DB only holds names + display fields.

CREATE TABLE IF NOT EXISTS candidates (
  id           TEXT PRIMARY KEY,      -- opaque id assigned by Botwick (not an email)
  name         TEXT NOT NULL,
  company      TEXT,
  days_since   INTEGER,
  score        INTEGER,
  nudge        TEXT,
  batch_date   TEXT NOT NULL,         -- YYYY-MM-DD this candidate was pushed
  created_at   INTEGER NOT NULL       -- unix seconds
);

CREATE INDEX IF NOT EXISTS idx_candidates_batch ON candidates (batch_date);

CREATE TABLE IF NOT EXISTS decisions (
  id           TEXT PRIMARY KEY,      -- references candidates.id (one decision per candidate)
  action       TEXT NOT NULL,         -- 'boost' (right) | 'suppress' (left) | 'delete'
  decided_by   TEXT,                  -- google email of the swiper
  decided_at   INTEGER NOT NULL,      -- unix seconds
  applied      INTEGER NOT NULL DEFAULT 0  -- 0 until the Botwick bridge applies it
);

CREATE INDEX IF NOT EXISTS idx_decisions_applied ON decisions (applied);
