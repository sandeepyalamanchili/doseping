# 💊 Medicine Reminder

A full-stack medicine reminder app with **cloud database** (Supabase), **multi-language support**, and deployable anywhere — including free hosting on Render.

---

## ✨ What's New

| Feature | Details |
|---|---|
| ☁️ Cloud Database | Switched from local SQLite → **Supabase** (free PostgreSQL). Works on any machine, any deployment |
| 🌐 Multi-language | 20 languages supported. Translate the entire UI with one click. Type inputs in any language and translate them to English before saving |
| 🚀 Deploy anywhere | Run locally, push to GitHub, deploy free on Render |
| 🔑 No API key needed | Translation uses MyMemory (free, 5000 words/day, no signup) |

---

## 🚀 Quick Start (Local)

### Step 1 — Set up Supabase (free)

1. Go to [https://supabase.com](https://supabase.com) and create a free account
2. Click **New Project** (choose any region)
3. Go to **SQL Editor → New Query**
4. Copy and paste the entire contents of `schema.sql` and click **Run**
5. Go to **Settings → API**
6. Copy your **Project URL** and **anon public key**

### Step 2 — Configure environment

```
# Copy the example file
copy .env.example .env       # Windows
cp .env.example .env         # Mac/Linux

# Edit .env and paste your Supabase URL and key:
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_KEY=eyJhbGci...
```

### Step 3 — Install and run

```powershell
# Install dependencies
pip install -r requirements.txt

# Run the app
python app.py
```

Open **http://localhost:5000** in your browser.

---

## 🌐 Multi-Language Usage

### Translate the UI
- Use the **Language** dropdown at the top of the page
- Click **Translate Page** to translate all labels to your chosen language
- The app remembers your language choice

### Type inputs in your language
- When adding a medicine name, dosage, or notes — type in **any language**
- Click the 🌐 button next to the input field to auto-translate it to English before saving
- Supported: Hindi, Telugu, Tamil, Kannada, Malayalam, Marathi, Bengali, Gujarati, Punjabi, Urdu, Arabic, French, German, Spanish, Portuguese, Russian, Chinese, Japanese, Korean, and more

---

## ☁️ Deploy to Render (Free Hosting)

1. Push your code to a GitHub repository
2. Go to [https://render.com](https://render.com) and sign up (free)
3. Click **New → Web Service** → connect your GitHub repo
4. Set these environment variables in the Render dashboard:
   - `SUPABASE_URL` = your Supabase project URL
   - `SUPABASE_KEY` = your Supabase anon key
5. Click **Deploy**

Your app will be live at `https://your-app-name.onrender.com`

> **Note:** Render's free tier spins down after 15 minutes of inactivity. The first request after idle may take 30–60 seconds.

---

## 📁 File Structure

```
medicine-reminder/
├── app.py              # Flask backend + translation API
├── database.py         # Supabase database layer
├── index.html          # Single-page frontend (all-in-one)
├── schema.sql          # Run this once in Supabase SQL Editor
├── requirements.txt    # Python dependencies
├── render.yaml         # One-click Render deployment config
├── .env.example        # Template for your credentials
├── .env                # Your actual credentials (never commit this)
└── .gitignore
```

---

## 🔒 Security Notes

- Passwords are hashed with SHA-256 + random salt (never stored in plain text)
- Auth tokens expire after 30 days
- The `.env` file is in `.gitignore` — your keys will never be committed to GitHub
- Never commit your `.env` file or share your `SUPABASE_KEY` publicly

---

## 📊 Features

- **Multi-profile** — track medicines for Mom, Dad, Grandma etc. separately
- **Medicine reminders** — set multiple reminder times per medicine
- **Dose logging** — mark doses as taken or skipped
- **Adherence analytics** — 30-day charts, streak counter, calendar heatmap
- **Health vitals** — log BP, blood sugar, heart rate, SpO2, weight, temperature, cholesterol, HbA1c with normal range alerts
- **Alarm system** — audio alarm + browser notification when medicine time arrives
- **Snooze** — 5-minute snooze on alarms
