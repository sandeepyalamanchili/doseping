CREATE TABLE users (
  id          TEXT PRIMARY KEY,
  username    TEXT NOT NULL UNIQUE COLLATE NOCASE,
  email       TEXT,
  pwd_hash    TEXT NOT NULL,          -- "pbkdf2$iters$salt$hash" or legacy "sha256$salt$hash"
  created_at  TEXT NOT NULL
);

CREATE TABLE sessions (
  token_hash  TEXT PRIMARY KEY,       -- SHA-256 of the bearer token (token itself is never stored)
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE profiles (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  color       TEXT NOT NULL DEFAULT '#8B5CF6',
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_profiles_user ON profiles(user_id);

CREATE TABLE medicines (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id  TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  dosage      TEXT NOT NULL,
  times       TEXT NOT NULL,          -- JSON array e.g. ["08:00","21:00"]
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_medicines_profile ON medicines(profile_id, user_id);

CREATE TABLE dose_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  med_id      INTEGER NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
  profile_id  TEXT NOT NULL,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  log_date    TEXT NOT NULL,          -- YYYY-MM-DD
  log_time    TEXT NOT NULL,          -- HH:MM
  status      TEXT NOT NULL CHECK (status IN ('taken','skipped')),
  logged_at   TEXT NOT NULL,
  UNIQUE (med_id, log_date, log_time)
);
CREATE INDEX idx_dose_logs_med ON dose_logs(med_id, user_id, log_date);

CREATE TABLE health_vitals (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id  TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  metric      TEXT NOT NULL,
  value       REAL NOT NULL,
  unit        TEXT,
  notes       TEXT,
  recorded_at TEXT NOT NULL
);
CREATE INDEX idx_vitals_profile ON health_vitals(profile_id, user_id, recorded_at);

CREATE TABLE login_attempts (
  key         TEXT NOT NULL,          -- "username|ip"
  at          INTEGER NOT NULL        -- epoch seconds
);
CREATE INDEX idx_login_attempts ON login_attempts(key, at);
