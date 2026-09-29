// DosePing API — Cloudflare Worker + D1.
// Replaces the old Flask + Supabase backend. Same /api/* contract, so the frontend keeps working.

const enc = new TextEncoder();
const SESSION_DAYS = 30;
const MAX_FAILED_LOGINS = 10;          // per username+IP per 15 minutes
const FAIL_WINDOW_SEC = 15 * 60;

export const VITAL_THRESHOLDS = {
  bp_sys:        { unit: "mmHg",  low: 90,   high: 140,  label: "BP Systolic" },
  bp_dia:        { unit: "mmHg",  low: 60,   high: 90,   label: "BP Diastolic" },
  sugar_fasting: { unit: "mg/dL", low: 70,   high: 100,  label: "Blood Sugar (Fasting)" },
  sugar_pp:      { unit: "mg/dL", low: 70,   high: 140,  label: "Blood Sugar (Post-Meal)" },
  heart_rate:    { unit: "bpm",   low: 60,   high: 100,  label: "Heart Rate" },
  spo2:          { unit: "%",     low: 95,   high: 100,  label: "SpO2" },
  weight:        { unit: "kg",    low: null, high: null, label: "Weight" },
  temperature:   { unit: "C",     low: 36.1, high: 37.2, label: "Temperature" },
  cholesterol:   { unit: "mg/dL", low: null, high: 200,  label: "Total Cholesterol" },
  hba1c:         { unit: "%",     low: null, high: 5.7,  label: "HbA1c" },
};

// ── helpers ─────────────────────────────────────────────────────────────────
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (m) => new HttpError(400, m);

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const randHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const sha256hex = async (s) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
const nowIso = () => new Date().toISOString();

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function readJson(request) {
  try {
    const body = await request.json();
    if (body && typeof body === "object") return body;
  } catch { /* fall through */ }
  throw bad("Invalid JSON body");
}

const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
const isTime = (s) => typeof s === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
const str = (v, max, field) => {
  if (typeof v !== "string" || !v.trim()) throw bad(`${field} required`);
  if (v.trim().length > max) throw bad(`${field} must be at most ${max} characters`);
  return v.trim();
};

// ── passwords (PBKDF2 via WebCrypto; legacy SHA-256 accepted once, then upgraded) ──
async function pbkdf2(password, saltBytes, iterations) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: saltBytes, iterations }, key, 256);
}

async function hashPassword(password, env) {
  const iters = parseInt(env.PBKDF2_ITERATIONS, 10) || 100000;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${iters}$${b64(salt)}$${b64(await pbkdf2(password, salt, iters))}`;
}

// returns { ok, needsUpgrade }
async function verifyPassword(password, stored) {
  const parts = stored.split("$");
  if (parts[0] === "pbkdf2" && parts.length === 4) {
    const derived = b64(await pbkdf2(password, unb64(parts[2]), parseInt(parts[1], 10)));
    return { ok: safeEqual(derived, parts[3]), needsUpgrade: false };
  }
  if (parts[0] === "sha256" && parts.length === 3) {            // migrated from the old Flask app
    const h = await sha256hex(parts[1] + password);
    return { ok: safeEqual(h, parts[2]), needsUpgrade: true };
  }
  return { ok: false, needsUpgrade: false };
}

// ── sessions ────────────────────────────────────────────────────────────────
async function createSession(env, userId) {
  const token = randHex(32);
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DAYS * 86400000);
  await env.DB.prepare("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?,?,?,?)")
    .bind(await sha256hex(token), userId, expires.toISOString(), now.toISOString()).run();
  return token;
}

async function authenticate(request, env) {
  const h = request.headers.get("Authorization") || "";
  if (!h.startsWith("Bearer ")) throw new HttpError(401, "Authentication required");
  const th = await sha256hex(h.slice(7));
  const row = await env.DB.prepare(
    "SELECT s.expires_at, u.id AS user_id, u.username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?"
  ).bind(th).first();
  if (!row || row.expires_at < nowIso()) {
    if (row) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(th).run();
    throw new HttpError(401, "Invalid or expired token. Please log in again.");
  }
  return { user_id: row.user_id, username: row.username, token_hash: th };
}

// ── login throttling ────────────────────────────────────────────────────────
async function checkThrottle(env, key) {
  const since = Math.floor(Date.now() / 1000) - FAIL_WINDOW_SEC;
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM login_attempts WHERE key = ? AND at > ?").bind(key, since).first();
  if (r.n >= MAX_FAILED_LOGINS) throw new HttpError(429, "Too many failed attempts. Try again in 15 minutes.");
}
const recordFailure = (env, key) =>
  env.DB.prepare("INSERT INTO login_attempts (key, at) VALUES (?,?)").bind(key, Math.floor(Date.now() / 1000)).run();

async function login(env, request, username, password) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const key = `${username.toLowerCase()}|${ip}`;
  await checkThrottle(env, key);

  const user = await env.DB.prepare("SELECT id, username, pwd_hash FROM users WHERE username = ?").bind(username).first();
  // Burn comparable time for unknown users so response timing doesn't reveal which usernames exist.
  const res = user ? await verifyPassword(password, user.pwd_hash) : (await pbkdf2(password, new Uint8Array(16), 1000), { ok: false });
  if (!res.ok) {
    await recordFailure(env, key);
    throw new HttpError(401, "Invalid username or password");
  }
  if (res.needsUpgrade) {
    await env.DB.prepare("UPDATE users SET pwd_hash = ? WHERE id = ?").bind(await hashPassword(password, env), user.id).run();
  }
  await env.DB.prepare("DELETE FROM login_attempts WHERE key = ?").bind(key).run();
  return { token: await createSession(env, user.id), user_id: user.id, username: user.username };
}

// ── data helpers ────────────────────────────────────────────────────────────
const parseTimes = (row) => {
  let times = [];
  try { times = JSON.parse(row.times); } catch { /* keep [] */ }
  return { ...row, times: Array.isArray(times) ? times : [] };
};

async function ownProfile(env, userId, pid) {
  const p = await env.DB.prepare("SELECT id FROM profiles WHERE id = ? AND user_id = ?").bind(pid, userId).first();
  if (!p) throw new HttpError(404, "Profile not found");
}
async function ownMedicine(env, userId, mid) {
  const m = await env.DB.prepare("SELECT * FROM medicines WHERE id = ? AND user_id = ?").bind(mid, userId).first();
  if (!m) throw new HttpError(404, "Medicine not found");
  return parseTimes(m);
}
const clampDays = (v, def = 30) => Math.min(365, Math.max(1, parseInt(v, 10) || def));

// ── route handlers ──────────────────────────────────────────────────────────
const routes = [];
const route = (method, pattern, handler, { auth = true } = {}) =>
  routes.push({ method, re: new RegExp("^" + pattern.replace(/:(\w+)/g, "(?<$1>[^/]+)") + "$"), handler, auth });

route("GET", "/api/health", async () => json({ ok: true, time: nowIso() }), { auth: false });

route("POST", "/api/auth/register", async ({ env, request }) => {
  const d = await readJson(request);
  const username = str(d.username, 64, "username");
  const password = typeof d.password === "string" ? d.password : "";
  if (username.length < 3) throw bad("Username must be at least 3 characters");
  if (/[\u0000-\u001f<>]/.test(username)) throw bad("Username contains invalid characters");
  if (password.length < 8) throw bad("Password must be at least 8 characters");
  if (password.length > 200) throw bad("Password too long");
  const email = typeof d.email === "string" ? d.email.trim().slice(0, 200) : "";

  const uid = "user_" + randHex(8);
  try {
    await env.DB.prepare("INSERT INTO users (id, username, email, pwd_hash, created_at) VALUES (?,?,?,?,?)")
      .bind(uid, username, email, await hashPassword(password, env), nowIso()).run();
  } catch (e) {
    if (/UNIQUE/i.test(String(e.message))) throw new HttpError(409, "Username already taken");
    throw e;
  }
  return json({ message: "Account created!", token: await createSession(env, uid), username }, 201);
}, { auth: false });

route("POST", "/api/auth/login", async ({ env, request }) => {
  const d = await readJson(request);
  if (typeof d.username !== "string" || typeof d.password !== "string" || !d.username || !d.password)
    throw bad("username and password are required");
  return json(await login(env, request, d.username.trim(), d.password));
}, { auth: false });

route("POST", "/api/auth/logout", async ({ env, request }) => {
  const h = request.headers.get("Authorization") || "";
  if (h.startsWith("Bearer ")) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256hex(h.slice(7))).run();
  return json({ message: "Logged out" });
}, { auth: false });

route("POST", "/api/auth/change-password", async ({ env, request, user }) => {
  const d = await readJson(request);
  if (typeof d.old_password !== "string" || typeof d.new_password !== "string") throw bad("old_password and new_password required");
  if (d.new_password.length < 8) throw bad("New password must be at least 8 characters");
  if (d.new_password.length > 200) throw bad("Password too long");
  const row = await env.DB.prepare("SELECT pwd_hash FROM users WHERE id = ?").bind(user.user_id).first();
  if (!row || !(await verifyPassword(d.old_password, row.pwd_hash)).ok) throw bad("Current password is incorrect");
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET pwd_hash = ? WHERE id = ?").bind(await hashPassword(d.new_password, env), user.user_id),
    // sign out every other device
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?").bind(user.user_id, user.token_hash),
  ]);
  return json({ message: "Password updated successfully" });
});

route("GET", "/api/auth/me", async ({ user }) => json({ user_id: user.user_id, username: user.username }));

// Profiles
route("GET", "/api/profiles", async ({ env, user }) => {
  const { results } = await env.DB.prepare("SELECT id, user_id, name, color, created_at FROM profiles WHERE user_id = ? ORDER BY created_at")
    .bind(user.user_id).all();
  return json({ profiles: results });
});

route("POST", "/api/profiles", async ({ env, request, user }) => {
  const d = await readJson(request);
  const name = str(d.name, 50, "name");
  const color = typeof d.color === "string" && /^#[0-9a-fA-F]{6}$/.test(d.color) ? d.color : "#8B5CF6";
  const p = { id: "profile_" + randHex(8), user_id: user.user_id, name, color, created_at: nowIso() };
  await env.DB.prepare("INSERT INTO profiles (id, user_id, name, color, created_at) VALUES (?,?,?,?,?)")
    .bind(p.id, p.user_id, p.name, p.color, p.created_at).run();
  return json({ profile: p }, 201);
});

route("DELETE", "/api/profiles/:pid", async ({ env, user, params }) => {
  await ownProfile(env, user.user_id, params.pid);
  await env.DB.prepare("DELETE FROM profiles WHERE id = ? AND user_id = ?").bind(params.pid, user.user_id).run(); // cascades
  return json({ success: true });
});

// Medicines
route("GET", "/api/profiles/:pid/medicines", async ({ env, user, params }) => {
  const { results } = await env.DB.prepare("SELECT * FROM medicines WHERE profile_id = ? AND user_id = ? ORDER BY created_at, id")
    .bind(params.pid, user.user_id).all();
  return json({ medicines: results.map(parseTimes) });
});

route("POST", "/api/profiles/:pid/medicines", async ({ env, request, user, params }) => {
  const d = await readJson(request);
  const name = str(d.name, 100, "name");
  const dosage = str(d.dosage, 100, "dosage");
  if (!Array.isArray(d.times) || !d.times.length) throw bad("times must be a non-empty list");
  if (d.times.length > 12 || !d.times.every(isTime)) throw bad("times must be HH:MM values (max 12)");
  const times = [...new Set(d.times)].sort();
  await ownProfile(env, user.user_id, params.pid);
  const created_at = nowIso();
  const r = await env.DB.prepare("INSERT INTO medicines (profile_id, user_id, name, dosage, times, created_at) VALUES (?,?,?,?,?,?)")
    .bind(params.pid, user.user_id, name, dosage, JSON.stringify(times), created_at).run();
  return json({ medicine: { id: r.meta.last_row_id, profile_id: params.pid, user_id: user.user_id, name, dosage, times, created_at } }, 201);
});

route("DELETE", "/api/medicines/:mid", async ({ env, user, params }) => {
  await ownMedicine(env, user.user_id, params.mid);
  await env.DB.prepare("DELETE FROM medicines WHERE id = ? AND user_id = ?").bind(params.mid, user.user_id).run(); // cascades logs
  return json({ success: true });
});

// Dose logs
route("POST", "/api/medicines/:mid/log", async ({ env, request, user, params }) => {
  const d = await readJson(request);
  if (!isDate(d.log_date) || !isTime(d.log_time)) throw bad("log_date (YYYY-MM-DD) and log_time (HH:MM) required");
  if (d.status !== "taken" && d.status !== "skipped") throw bad("status must be 'taken' or 'skipped'");
  const med = await ownMedicine(env, user.user_id, params.mid);
  const logged_at = nowIso();
  await env.DB.prepare(
    `INSERT INTO dose_logs (med_id, profile_id, user_id, log_date, log_time, status, logged_at) VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(med_id, log_date, log_time) DO UPDATE SET status = excluded.status, logged_at = excluded.logged_at`
  ).bind(med.id, med.profile_id, user.user_id, d.log_date, d.log_time, d.status, logged_at).run();
  return json({ log: { med_id: med.id, log_date: d.log_date, log_time: d.log_time, status: d.status } }, 201);
});

route("GET", "/api/medicines/:mid/analytics", async ({ env, user, params, url }) => {
  const med = await ownMedicine(env, user.user_id, params.mid);
  const days = clampDays(url.searchParams.get("days"));
  // Client may pass its local date so "today" matches the user's timezone; default is UTC.
  const todayParam = url.searchParams.get("today");
  const today = isDate(todayParam) ? new Date(todayParam + "T00:00:00Z") : new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
  const iso = (dt) => dt.toISOString().slice(0, 10);
  const shift = (n) => new Date(today.getTime() - n * 86400000);

  const { results } = await env.DB.prepare("SELECT log_date, log_time, status FROM dose_logs WHERE med_id = ? AND user_id = ? AND log_date >= ?")
    .bind(med.id, user.user_id, iso(shift(days))).all();
  const logMap = new Map(results.map((l) => [l.log_date + "|" + l.log_time, l.status]));

  const daily = [];
  let totalExpected = 0, totalTaken = 0, totalSkipped = 0;
  for (let i = days - 1; i >= 0; i--) {
    const d = iso(shift(i));
    const taken = med.times.filter((t) => logMap.get(d + "|" + t) === "taken").length;
    const skipped = med.times.filter((t) => logMap.get(d + "|" + t) === "skipped").length;
    daily.push({ date: d, taken, skipped, unlogged: med.times.length - taken - skipped, expected: med.times.length });
    totalExpected += med.times.length; totalTaken += taken; totalSkipped += skipped;
  }
  let streak = 0;
  for (let i = daily.length - 1; i >= 0; i--) {
    if (daily[i].expected > 0 && daily[i].taken === daily[i].expected) streak++; else break;
  }
  return json({
    med_id: med.id, med_name: med.name, med_dosage: med.dosage, days,
    total_expected: totalExpected, total_taken: totalTaken, total_skipped: totalSkipped,
    total_unlogged: totalExpected - totalTaken - totalSkipped,
    adherence_pct: totalExpected ? Math.round((totalTaken / totalExpected) * 1000) / 10 : 0,
    streak_days: streak, daily,
  });
});

// Vitals
route("GET", "/api/vitals/thresholds", async () => json(VITAL_THRESHOLDS), { auth: false });

route("GET", "/api/profiles/:pid/vitals", async ({ env, user, params, url }) => {
  const days = clampDays(url.searchParams.get("days"));
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const { results } = await env.DB.prepare(
    "SELECT * FROM health_vitals WHERE profile_id = ? AND user_id = ? AND recorded_at >= ? ORDER BY recorded_at DESC"
  ).bind(params.pid, user.user_id, since).all();
  const vitals = results.map((r) => {
    const t = VITAL_THRESHOLDS[r.metric] || {};
    const v = Number(r.value);
    const status = t.low != null && v < t.low ? "low" : t.high != null && v > t.high ? "high" : "normal";
    return { ...r, status, label: t.label || r.metric, unit: t.unit || r.unit || "" };
  });
  const grouped = {};
  for (const r of vitals) (grouped[r.metric] ||= []).push(r);
  return json({ vitals, grouped, thresholds: VITAL_THRESHOLDS });
});

route("POST", "/api/profiles/:pid/vitals", async ({ env, request, user, params }) => {
  const d = await readJson(request);
  if (!Object.hasOwn(VITAL_THRESHOLDS, d.metric)) throw bad(`Unknown metric. Valid: ${Object.keys(VITAL_THRESHOLDS).join(", ")}`);
  const value = Number(d.value);
  if (d.value === null || d.value === "" || !Number.isFinite(value) || Math.abs(value) > 100000) throw bad("value must be a number");
  const notes = typeof d.notes === "string" ? d.notes.trim().slice(0, 500) : "";
  await ownProfile(env, user.user_id, params.pid);
  const unit = VITAL_THRESHOLDS[d.metric].unit;
  const recorded_at = nowIso();
  const r = await env.DB.prepare("INSERT INTO health_vitals (profile_id, user_id, metric, value, unit, notes, recorded_at) VALUES (?,?,?,?,?,?,?)")
    .bind(params.pid, user.user_id, d.metric, value, unit, notes, recorded_at).run();
  return json({ vital: { id: r.meta.last_row_id, profile_id: params.pid, user_id: user.user_id, metric: d.metric, value, unit, notes, recorded_at } }, 201);
});

route("DELETE", "/api/vitals/:vid", async ({ env, user, params }) => {
  await env.DB.prepare("DELETE FROM health_vitals WHERE id = ? AND user_id = ?").bind(params.vid, user.user_id).run();
  return json({ success: true });
});

// Reminders (client sends its local HH:MM)
route("GET", "/api/reminders/check", async ({ env, user, url }) => {
  let now = (url.searchParams.get("time") || "").trim();
  if (!isTime(now)) now = new Date().toISOString().slice(11, 16);
  const { results } = await env.DB.prepare("SELECT * FROM medicines WHERE user_id = ?").bind(user.user_id).all();
  return json({ time: now, due: results.map(parseTimes).filter((m) => m.times.includes(now)) });
});

// Privacy: export and delete everything
route("GET", "/api/export", async ({ env, user }) => {
  const q = (sql) => env.DB.prepare(sql).bind(user.user_id).all().then((r) => r.results);
  return json({
    exported_at: nowIso(), username: user.username,
    profiles: await q("SELECT * FROM profiles WHERE user_id = ?"),
    medicines: (await q("SELECT * FROM medicines WHERE user_id = ?")).map(parseTimes),
    dose_logs: await q("SELECT * FROM dose_logs WHERE user_id = ?"),
    health_vitals: await q("SELECT * FROM health_vitals WHERE user_id = ?"),
  });
});

route("DELETE", "/api/account", async ({ env, request, user }) => {
  const d = await readJson(request);
  const row = await env.DB.prepare("SELECT pwd_hash FROM users WHERE id = ?").bind(user.user_id).first();
  if (typeof d.password !== "string" || !row || !(await verifyPassword(d.password, row.pwd_hash)).ok) throw bad("Password is incorrect");
  await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(user.user_id).run(); // cascades everything
  return json({ success: true });
});

// ── entry point ─────────────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

    try {
      const path = url.pathname.replace(/\/+$/, "") || "/";
      let pathMatched = false;
      for (const r of routes) {
        const m = path.match(r.re);
        if (!m) continue;
        pathMatched = true;
        if (r.method !== request.method) continue;
        const user = r.auth ? await authenticate(request, env) : null;
        return await r.handler({ env, request, url, user, params: m.groups || {} });
      }
      return json({ error: pathMatched ? "Method not allowed" : "Not found" }, pathMatched ? 405 : 404);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error("Unhandled error:", e);
      return json({ error: "Internal server error" }, 500);
    }
  },

  // Housekeeping (cron trigger, see wrangler.toml): purge expired sessions and old login attempts.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(env.DB.batch([
      env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(nowIso()),
      env.DB.prepare("DELETE FROM login_attempts WHERE at < ?").bind(Math.floor(Date.now() / 1000) - 86400),
    ]));
  },
};
