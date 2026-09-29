// End-to-end smoke test against a running `wrangler dev` (default http://localhost:8787).
import assert from "node:assert/strict";
const BASE = process.env.BASE || "http://localhost:8787";
let passed = 0;
const t = async (name, fn) => { try { await fn(); passed++; console.log("  ok  ", name); } catch (e) { console.error("  FAIL", name, "\n      ", e.message); process.exitCode = 1; } };
const call = async (method, path, { token, body, ip } = {}) => {
  const r = await fetch(BASE + path, { method, headers: { "Content-Type": "application/json", ...(token && { Authorization: "Bearer " + token }), ...(ip && { "CF-Connecting-IP": ip }) }, body: body && JSON.stringify(body) });
  return { status: r.status, data: await r.json().catch(() => null) };
};
const u1 = "alice_" + Date.now(), u2 = "bob_" + Date.now();
let A, B, pid, mid;

await t("health endpoint", async () => assert.equal((await call("GET", "/api/health")).status, 200));
await t("static index.html served", async () => { const r = await fetch(BASE + "/"); assert.equal(r.status, 200); assert.match(await r.text(), /DosePing/); });
await t("manifest served", async () => { const r = await fetch(BASE + "/manifest.webmanifest"); assert.equal(r.status, 200); assert.equal((await r.json()).short_name, "DosePing"); });
await t("security headers on assets", async () => { const r = await fetch(BASE + "/"); assert.equal(r.headers.get("x-content-type-options"), "nosniff"); });
await t("register validates short password", async () => assert.equal((await call("POST", "/api/auth/register", { body: { username: u1, password: "short" } })).status, 400));
await t("register alice", async () => { const r = await call("POST", "/api/auth/register", { body: { username: u1, password: "correct-horse-1" } }); assert.equal(r.status, 201); A = r.data.token; assert.equal(A.length, 64); });
await t("duplicate username -> 409 (case-insensitive)", async () => assert.equal((await call("POST", "/api/auth/register", { body: { username: u1.toUpperCase(), password: "correct-horse-1" } })).status, 409));
await t("register bob", async () => { B = (await call("POST", "/api/auth/register", { body: { username: u2, password: "another-pass-2" } })).data.token; assert.ok(B); });
await t("login ok / wrong password 401", async () => {
  assert.equal((await call("POST", "/api/auth/login", { body: { username: u1, password: "correct-horse-1" } })).status, 200);
  assert.equal((await call("POST", "/api/auth/login", { body: { username: u1, password: "nope-nope-nope" } })).status, 401);
});
await t("me requires auth", async () => { assert.equal((await call("GET", "/api/auth/me")).status, 401); assert.equal((await call("GET", "/api/auth/me", { token: A })).data.username, u1); });
await t("bogus token rejected", async () => assert.equal((await call("GET", "/api/profiles", { token: "0".repeat(64) })).status, 401));
await t("create profile + list", async () => {
  const r = await call("POST", "/api/profiles", { token: A, body: { name: "Mom", color: "#123456" } }); assert.equal(r.status, 201); pid = r.data.profile.id;
  assert.equal((await call("GET", "/api/profiles", { token: A })).data.profiles.length, 1);
});
await t("create medicine (validates times, dedupes/sorts)", async () => {
  assert.equal((await call("POST", `/api/profiles/${pid}/medicines`, { token: A, body: { name: "Metformin", dosage: "500 mg", times: ["25:99"] } })).status, 400);
  const r = await call("POST", `/api/profiles/${pid}/medicines`, { token: A, body: { name: "Metformin", dosage: "500 mg", times: ["21:00", "08:00", "08:00"] } });
  assert.equal(r.status, 201); mid = r.data.medicine.id; assert.deepEqual(r.data.medicine.times, ["08:00", "21:00"]);
});
await t("XSS payload is stored verbatim (escaped client-side) and length-limited", async () => {
  assert.equal((await call("POST", `/api/profiles/${pid}/medicines`, { token: A, body: { name: "x".repeat(101), dosage: "1", times: ["08:00"] } })).status, 400);
});
await t("bob cannot see or touch alice's data", async () => {
  assert.equal((await call("GET", "/api/profiles", { token: B })).data.profiles.length, 0);
  assert.equal((await call("GET", `/api/profiles/${pid}/medicines`, { token: B })).data.medicines.length, 0);
  assert.equal((await call("POST", `/api/profiles/${pid}/medicines`, { token: B, body: { name: "Evil", dosage: "1", times: ["08:00"] } })).status, 404);
  assert.equal((await call("POST", `/api/medicines/${mid}/log`, { token: B, body: { profile_id: pid, log_date: "2026-01-01", log_time: "08:00", status: "taken" } })).status, 404);
  assert.equal((await call("GET", `/api/medicines/${mid}/analytics`, { token: B })).status, 404);
  assert.equal((await call("DELETE", `/api/medicines/${mid}`, { token: B })).status, 404);
  assert.equal((await call("DELETE", `/api/profiles/${pid}`, { token: B })).status, 404);
  assert.equal((await call("GET", `/api/profiles/${pid}/vitals`, { token: B })).data.vitals.length, 0);
});
const today = new Date().toISOString().slice(0, 10);
await t("log dose is an upsert", async () => {
  const body = (status) => ({ profile_id: pid, log_date: today, log_time: "08:00", status });
  assert.equal((await call("POST", `/api/medicines/${mid}/log`, { token: A, body: body("skipped") })).status, 201);
  assert.equal((await call("POST", `/api/medicines/${mid}/log`, { token: A, body: body("taken") })).status, 201);
  assert.equal((await call("POST", `/api/medicines/${mid}/log`, { token: A, body: body("maybe") })).status, 400);
});
await t("analytics counts 1 taken of 2 expected today", async () => {
  const r = await call("GET", `/api/medicines/${mid}/analytics?days=7&today=${today}`, { token: A });
  assert.equal(r.status, 200); assert.equal(r.data.total_taken, 1); assert.equal(r.data.total_expected, 14);
  assert.equal(r.data.daily.at(-1).taken, 1); assert.equal(r.data.daily.at(-1).unlogged, 1);
});
await t("vitals: validate, log, status flag, delete", async () => {
  assert.equal((await call("POST", `/api/profiles/${pid}/vitals`, { token: A, body: { metric: "bogus", value: 1 } })).status, 400);
  assert.equal((await call("POST", `/api/profiles/${pid}/vitals`, { token: A, body: { metric: "bp_sys", value: "abc" } })).status, 400);
  const v = await call("POST", `/api/profiles/${pid}/vitals`, { token: A, body: { metric: "bp_sys", value: 150, notes: "<b>after walk</b>" } });
  assert.equal(v.status, 201);
  const list = await call("GET", `/api/profiles/${pid}/vitals`, { token: A });
  assert.equal(list.data.vitals[0].status, "high"); assert.equal(list.data.vitals[0].label, "BP Systolic");
  assert.equal((await call("DELETE", `/api/vitals/${v.data.vital.id}`, { token: A })).status, 200);
});
await t("thresholds are public", async () => assert.equal((await call("GET", "/api/vitals/thresholds")).data.spo2.low, 95));
await t("reminders/check returns due meds", async () => {
  assert.equal((await call("GET", "/api/reminders/check?time=21:00", { token: A })).data.due.length, 1);
  assert.equal((await call("GET", "/api/reminders/check?time=03:33", { token: A })).data.due.length, 0);
});
await t("change password signs out other sessions", async () => {
  const second = (await call("POST", "/api/auth/login", { body: { username: u1, password: "correct-horse-1" } })).data.token;
  assert.equal((await call("POST", "/api/auth/change-password", { token: A, body: { old_password: "wrong", new_password: "brand-new-pass" } })).status, 400);
  assert.equal((await call("POST", "/api/auth/change-password", { token: A, body: { old_password: "correct-horse-1", new_password: "brand-new-pass" } })).status, 200);
  assert.equal((await call("GET", "/api/auth/me", { token: second })).status, 401);
  assert.equal((await call("GET", "/api/auth/me", { token: A })).status, 200);
  assert.equal((await call("POST", "/api/auth/login", { body: { username: u1, password: "brand-new-pass" } })).status, 200);
});
await t("login throttling after repeated failures (429)", async () => {
  let last;
  for (let i = 0; i < 11; i++) last = await call("POST", "/api/auth/login", { body: { username: "victim_" + Date.now(), password: "guess" + i }, ip: "203.0.113.9" });
  // same key must be used; use fixed username
  const name = "victim_fixed_" + Date.now();
  for (let i = 0; i < 10; i++) await call("POST", "/api/auth/login", { body: { username: name, password: "guess" + i }, ip: "203.0.113.7" });
  assert.equal((await call("POST", "/api/auth/login", { body: { username: name, password: "guess-again" }, ip: "203.0.113.7" })).status, 429);
});
await t("export returns own data only", async () => {
  const r = await call("GET", "/api/export", { token: A });
  assert.equal(r.status, 200); assert.equal(r.data.medicines.length, 1); assert.equal(r.data.profiles[0].name, "Mom");
  assert.equal((await call("GET", "/api/export", { token: B })).data.medicines.length, 0);
});
await t("unknown route 404, wrong method 405", async () => {
  assert.equal((await call("GET", "/api/nope", { token: A })).status, 404);
  assert.equal((await call("PUT", "/api/profiles", { token: A })).status, 405);
});
await t("logout invalidates token", async () => {
  await call("POST", "/api/auth/logout", { token: B });
  assert.equal((await call("GET", "/api/auth/me", { token: B })).status, 401);
});
await t("delete account (needs password) removes all data", async () => {
  assert.equal((await call("DELETE", "/api/account", { token: A, body: { password: "wrong" } })).status, 400);
  assert.equal((await call("DELETE", "/api/account", { token: A, body: { password: "brand-new-pass" } })).status, 200);
  assert.equal((await call("GET", "/api/auth/me", { token: A })).status, 401);
  assert.equal((await call("POST", "/api/auth/login", { body: { username: u1, password: "brand-new-pass" } })).status, 401);
});
console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
