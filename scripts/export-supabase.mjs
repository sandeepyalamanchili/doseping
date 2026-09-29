// One-off: copy existing data from Supabase into a SQL file for Cloudflare D1.
//   SUPABASE_URL=... SUPABASE_KEY=... node scripts/export-supabase.mjs
//   npx wrangler d1 execute doseping-db --remote --file=migrate.sql
// Existing passwords keep working: legacy SHA-256 hashes are re-hashed with PBKDF2 at each user's next login.
// Sessions are NOT copied, so everyone signs in again.
import { writeFileSync } from "node:fs";

const { SUPABASE_URL, SUPABASE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_KEY) { console.error("Set SUPABASE_URL and SUPABASE_KEY"); process.exit(1); }

const get = async (table) => {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=*`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, Range: `${from}-${from + 999}` },
    });
    if (!r.ok) throw new Error(`${table}: ${r.status} ${await r.text()}`);
    const page = await r.json();
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
};
const q = (v) => v == null ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replaceAll("'", "''")}'`;
const now = new Date().toISOString();

const out = ["PRAGMA defer_foreign_keys = ON;"];
const users = await get("users");
for (const u of users)
  out.push(`INSERT OR IGNORE INTO users (id,username,email,pwd_hash,created_at) VALUES (${q(u.id)},${q(u.username)},${q(u.email)},${q(`sha256$${u.pwd_salt}$${u.pwd_hash}`)},${q(u.created_at || now)});`);
for (const p of await get("profiles"))
  out.push(`INSERT OR IGNORE INTO profiles (id,user_id,name,color,created_at) VALUES (${q(p.id)},${q(p.user_id)},${q(p.name)},${q(p.color)},${q(p.created_at || now)});`);
for (const m of await get("medicines"))
  out.push(`INSERT OR IGNORE INTO medicines (id,profile_id,user_id,name,dosage,times,created_at) VALUES (${q(m.id)},${q(m.profile_id)},${q(m.user_id)},${q(m.name)},${q(m.dosage)},${q(typeof m.times === "string" ? m.times : JSON.stringify(m.times))},${q(m.created_at || now)});`);
for (const l of await get("dose_logs"))
  out.push(`INSERT OR REPLACE INTO dose_logs (med_id,profile_id,user_id,log_date,log_time,status,logged_at) VALUES (${q(l.med_id)},${q(l.profile_id)},${q(l.user_id)},${q(l.log_date)},${q(l.log_time)},${q(l.status)},${q(l.logged_at || now)});`);
for (const v of await get("health_vitals"))
  out.push(`INSERT OR IGNORE INTO health_vitals (id,profile_id,user_id,metric,value,unit,notes,recorded_at) VALUES (${q(v.id)},${q(v.profile_id)},${q(v.user_id)},${q(v.metric)},${q(v.value)},${q(v.unit)},${q(v.notes)},${q(v.recorded_at || now)});`);

writeFileSync("migrate.sql", out.join("\n") + "\n");
console.log(`Wrote migrate.sql (${users.length} users, ${out.length - 1} rows total)`);
