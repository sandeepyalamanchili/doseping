-- ============================================================
-- Medicine Reminder — Supabase Schema
-- Run this in: Supabase Dashboard → SQL Editor → New Query
-- ============================================================

-- Users
CREATE TABLE IF NOT EXISTS users (
    id          TEXT PRIMARY KEY,
    username    TEXT NOT NULL UNIQUE,
    email       TEXT,
    pwd_hash    TEXT NOT NULL,
    pwd_salt    TEXT NOT NULL,
    created_at  TEXT
);

-- Sessions (auth tokens)
CREATE TABLE IF NOT EXISTS sessions (
    token       TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    username    TEXT NOT NULL,
    expires_at  TEXT NOT NULL,
    created_at  TEXT
);

-- Profiles (one user can have multiple — e.g. Mom, Dad)
CREATE TABLE IF NOT EXISTS profiles (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    color       TEXT NOT NULL DEFAULT '#8B5CF6',
    created_at  TEXT
);

-- Medicines
CREATE TABLE IF NOT EXISTS medicines (
    id          BIGINT PRIMARY KEY,
    profile_id  TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    dosage      TEXT NOT NULL,
    times       TEXT NOT NULL,   -- JSON array e.g. ["08:00","21:00"]
    created_at  TEXT
);

-- Dose logs
CREATE TABLE IF NOT EXISTS dose_logs (
    id          BIGINT PRIMARY KEY,
    med_id      BIGINT NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
    profile_id  TEXT NOT NULL,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    log_date    TEXT NOT NULL,   -- YYYY-MM-DD
    log_time    TEXT NOT NULL,   -- HH:MM
    status      TEXT NOT NULL,   -- 'taken' | 'skipped'
    logged_at   TEXT
);

-- Health vitals
CREATE TABLE IF NOT EXISTS health_vitals (
    id          BIGINT PRIMARY KEY,
    profile_id  TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    metric      TEXT NOT NULL,
    value       REAL NOT NULL,
    unit        TEXT,
    notes       TEXT,
    recorded_at TEXT
);

-- Indexes for faster queries
CREATE INDEX IF NOT EXISTS idx_sessions_token     ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_profiles_user      ON profiles(user_id);
CREATE INDEX IF NOT EXISTS idx_medicines_profile  ON medicines(profile_id, user_id);
CREATE INDEX IF NOT EXISTS idx_dose_logs_med      ON dose_logs(med_id, user_id, log_date);
CREATE INDEX IF NOT EXISTS idx_vitals_profile     ON health_vitals(profile_id, user_id, recorded_at);

-- Disable Row Level Security (RLS) — we handle auth in Flask
-- If you want RLS, enable it and add policies for each table.
ALTER TABLE users         DISABLE ROW LEVEL SECURITY;
ALTER TABLE sessions      DISABLE ROW LEVEL SECURITY;
ALTER TABLE profiles      DISABLE ROW LEVEL SECURITY;
ALTER TABLE medicines     DISABLE ROW LEVEL SECURITY;
ALTER TABLE dose_logs     DISABLE ROW LEVEL SECURITY;
ALTER TABLE health_vitals DISABLE ROW LEVEL SECURITY;
