-- People graph viewer — D1 schema.
-- One row per tenant (Google-verified email). The blob is the full graph the
-- plugin pushed: nodes carry opaque ids (salted hash, salt stays in the vault),
-- names, and scores; edges carry weights and sample contexts. Never emails.

CREATE TABLE IF NOT EXISTS graphs (
  email      TEXT PRIMARY KEY,   -- tenant key: Google-verified sign-in email, lowercase
  json       TEXT NOT NULL,      -- {pushedAt, nodes:[...], edges:[...]}
  updated_at INTEGER NOT NULL    -- unix seconds of last push
);
