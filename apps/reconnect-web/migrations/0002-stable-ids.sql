-- v2 migration: stable ids replace daily random uuids.
-- Candidates are disposable (re-pushed by the bridge); legacy decisions
-- reference dead uuids and their outcomes live in reconnect-feedback.json.
-- PRECONDITION (runbook-enforced): GET /api/decisions?applied=0 is empty.
DROP TABLE IF EXISTS candidates;
DELETE FROM decisions;
CREATE TABLE candidates (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  company      TEXT,
  last_contact TEXT,
  score        INTEGER,
  nudge        TEXT,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX idx_candidates_score ON candidates (score DESC);
