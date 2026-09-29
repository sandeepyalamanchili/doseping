# 💊 DosePing — Cloudflare edition

Medicine reminders, dose tracking and health vitals. One Cloudflare Worker serves the app and the API,
and stores data in Cloudflare D1 (SQLite). No servers, no Supabase, no Render/Vercel.

```
public/            static app (index.html, sw.js, manifest, icons)  -> Workers Static Assets
src/worker.js      /api/* backend                                   -> Cloudflare Worker
migrations/        D1 schema
scripts/           smoke-test.mjs, export-supabase.mjs (one-off data migration)
```

## Deploy

```bash
npm install
npx wrangler login
npx wrangler d1 create doseping-db          # copy the printed database_id into wrangler.toml
npm run db:remote                           # create tables in production
npm run deploy                              # -> https://doseping.<your-subdomain>.workers.dev
```

Local development: `npm run db:local && npm run dev`, then `npm test` in a second terminal (26 end-to-end checks).

Custom domain / auto-deploy from GitHub: Cloudflare dashboard → Workers & Pages → doseping → Settings.

## Move your existing Supabase data (optional)

```bash
SUPABASE_URL=... SUPABASE_KEY=... node scripts/export-supabase.mjs   # writes migrate.sql
npx wrangler d1 execute doseping-db --remote --file=migrate.sql
```
Old passwords keep working and are upgraded to PBKDF2 at each user's next login. Everyone signs in again (sessions aren't copied).

## ⚠️ Do these after migrating

1. **Delete (or pause) the old Supabase project.** Its anon key was committed to the repo and row-level security was off, so anyone could read that database.
2. **Remove `.env`, `venv/` and `__pycache__/` from git history**, not just the latest commit (`git filter-repo`, or start a fresh repo from this folder).
3. Delete the old Render and Vercel deployments.

## What changed

| Before | Now |
|---|---|
| Flask + Supabase (RLS off, plaintext session tokens) | Worker + D1; session tokens stored only as SHA-256 hashes |
| SHA-256 + salt passwords | PBKDF2-SHA256 (legacy hashes upgraded on login) |
| Any user's profile ID accepted on writes | Every read/write checks ownership |
| No login throttling, CORS `*` | 10 failed logins / 15 min per user+IP, same-origin only |
| Stored XSS (names, dosage, notes rendered as HTML) | Escaped |
| Doses dated in UTC (wrong day for late/early doses outside UTC) | Client's local date |
| Login lost when the tab closed | Stays signed in 30 days on the device |
| Fake background polling in the service worker | Honest offline-capable shell + installable PWA |
| Hard-coded `C:\Users\sande\...`, MindsDB leftovers, Render URLs | Removed |
New API endpoints: `GET /api/export`, `DELETE /api/account` (no buttons in the UI yet).

## Known limitations / next steps

- **Reminders while the app is closed or the phone is locked don't work yet.** Today the alarm only fires while the app is open. Fixing that needs Web Push (VAPID + a per-user timezone + a 1-minute Cron Trigger on this Worker) and, on iPhone, installing the app to the Home Screen. It is the next feature to build.
- **Free-plan CPU limit:** PBKDF2 at 100,000 iterations may exceed the Workers Free 10 ms CPU limit. If logins return errors, lower `PBKDF2_ITERATIONS` in `wrangler.toml` or use the Paid plan.
- The Content-Security-Policy in `public/_headers` is **Report-Only**. Open the deployed app with the browser console open, check for violations, then rename it to `Content-Security-Policy` to enforce.
- Tailwind is loaded from its CDN (fine for now; bundle it for offline-first use). Translation sends typed text to api.mymemory.translated.net. Mention both in your privacy policy.
- Not medical advice: add a visible disclaimer and a privacy policy before sharing publicly.
