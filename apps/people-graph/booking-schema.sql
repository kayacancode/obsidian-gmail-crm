-- Additive Booking tables. Safe to apply to the existing People database.

CREATE TABLE IF NOT EXISTS booking_settings(owner TEXT PRIMARY KEY,slug TEXT NOT NULL UNIQUE,revision INTEGER NOT NULL,data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS booking_requests(id TEXT PRIMARY KEY,owner TEXT NOT NULL,email TEXT NOT NULL,client_key TEXT NOT NULL,created_at INTEGER NOT NULL,data TEXT NOT NULL,UNIQUE(owner,email,client_key));
CREATE INDEX IF NOT EXISTS booking_owner_requests ON booking_requests(owner,created_at);
CREATE TABLE IF NOT EXISTS booking_calendars(owner TEXT PRIMARY KEY,data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS booking_challenges(id TEXT PRIMARY KEY,owner TEXT NOT NULL,slug TEXT NOT NULL,email TEXT NOT NULL,browser TEXT NOT NULL,code_hash TEXT NOT NULL,expires INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,used INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS booking_sessions(token_hash TEXT PRIMARY KEY,owner TEXT NOT NULL,slug TEXT NOT NULL,email TEXT NOT NULL,browser TEXT NOT NULL,expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS booking_limits(key TEXT PRIMARY KEY,count INTEGER NOT NULL,expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS booking_oauth(id TEXT PRIMARY KEY,owner TEXT NOT NULL,cookie_hash TEXT NOT NULL,verifier TEXT NOT NULL,expires INTEGER NOT NULL);
