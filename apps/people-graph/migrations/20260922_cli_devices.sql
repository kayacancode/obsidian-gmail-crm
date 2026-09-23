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
