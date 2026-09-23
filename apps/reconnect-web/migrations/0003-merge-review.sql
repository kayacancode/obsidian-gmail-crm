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
