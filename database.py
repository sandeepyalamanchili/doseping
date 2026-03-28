"""
database.py — Supabase (PostgreSQL) backend for Medicine Reminder App
Works anywhere: local, GitHub Actions, Render, Railway, etc.
Tables: users, sessions, profiles, medicines, dose_logs, health_vitals

Setup:
  1. Create a free account at https://supabase.com
  2. Create a new project
  3. Run the SQL in schema.sql in the Supabase SQL editor
  4. Copy your Project URL and anon key into .env (see .env.example)
"""

import os
import json
import hashlib
import secrets
from datetime import datetime, date, timedelta

# ── Supabase client ───────────────────────────────────────────────────────────
try:
    from supabase import create_client, Client
except ImportError:
    raise ImportError("Run: pip install supabase")

SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_KEY = os.getenv("SUPABASE_KEY", "")

_client: Client = None

def get_client() -> Client:
    global _client
    if _client is None:
        if not SUPABASE_URL or not SUPABASE_KEY:
            raise RuntimeError(
                "Set SUPABASE_URL and SUPABASE_KEY environment variables.\n"
                "Get them from: https://app.supabase.com → Project → Settings → API"
            )
        _client = create_client(SUPABASE_URL, SUPABASE_KEY)
    return _client


# ── Password helpers ──────────────────────────────────────────────────────────
def _hash_password(password: str, salt: str = None):
    if salt is None:
        salt = secrets.token_hex(16)
    h = hashlib.sha256((salt + password).encode()).hexdigest()
    return h, salt


def _verify_password(password: str, stored_hash: str, salt: str) -> bool:
    h, _ = _hash_password(password, salt)
    return h == stored_hash


# ── DB init (just validates connection) ───────────────────────────────────────
def init_db():
    """Validate that Supabase is reachable and tables exist."""
    sb = get_client()
    # ping the users table — raises if not set up
    sb.table("users").select("id").limit(1).execute()
    print("  Supabase connection OK")


# ── Auth ──────────────────────────────────────────────────────────────────────
def register_user(username: str, password: str, email: str = ""):
    sb = get_client()
    existing = sb.table("users").select("id").eq("username", username).execute()
    if existing.data:
        raise ValueError("Username already taken")

    uid = "user_" + secrets.token_hex(8)
    now = datetime.utcnow().isoformat()
    pwd_hash, pwd_salt = _hash_password(password)

    sb.table("users").insert({
        "id": uid,
        "username": username,
        "email": email,
        "pwd_hash": pwd_hash,
        "pwd_salt": pwd_salt,
        "created_at": now
    }).execute()
    return {"id": uid, "username": username}


def login_user(username: str, password: str):
    sb = get_client()
    rows = sb.table("users").select("*").eq("username", username).execute()
    if not rows.data:
        raise ValueError("Invalid username or password")
    row = rows.data[0]
    if not _verify_password(password, row["pwd_hash"], row["pwd_salt"]):
        raise ValueError("Invalid username or password")

    token      = secrets.token_hex(32)
    now        = datetime.utcnow()
    expires_at = (now + timedelta(days=30)).isoformat()

    sb.table("sessions").insert({
        "token": token,
        "user_id": row["id"],
        "username": username,
        "expires_at": expires_at,
        "created_at": now.isoformat()
    }).execute()
    return {"token": token, "user_id": row["id"], "username": username}


def validate_token(token: str):
    if not token:
        return None
    sb = get_client()
    rows = sb.table("sessions").select("*").eq("token", token).execute()
    if not rows.data:
        return None
    row = rows.data[0]
    if datetime.utcnow().isoformat() > row["expires_at"]:
        sb.table("sessions").delete().eq("token", token).execute()
        return None
    return {"user_id": row["user_id"], "username": row["username"]}


def logout_user(token: str):
    get_client().table("sessions").delete().eq("token", token).execute()


def change_password(user_id: str, old_password: str, new_password: str):
    sb = get_client()
    rows = sb.table("users").select("*").eq("id", user_id).execute()
    if not rows.data:
        raise ValueError("User not found")
    row = rows.data[0]
    if not _verify_password(old_password, row["pwd_hash"], row["pwd_salt"]):
        raise ValueError("Current password is incorrect")
    new_hash, new_salt = _hash_password(new_password)
    sb.table("users").update({"pwd_hash": new_hash, "pwd_salt": new_salt}).eq("id", user_id).execute()


# ── Profiles ──────────────────────────────────────────────────────────────────
def get_profiles_for_user(user_id: str):
    rows = get_client().table("profiles").select("*").eq("user_id", user_id).order("created_at").execute()
    return rows.data or []


def create_profile(user_id: str, profile_id: str, name: str, color: str):
    now = datetime.utcnow().isoformat()
    data = {"id": profile_id, "user_id": user_id, "name": name, "color": color, "created_at": now}
    get_client().table("profiles").insert(data).execute()
    return data


def delete_profile(user_id: str, profile_id: str):
    sb = get_client()
    sb.table("dose_logs").delete().eq("profile_id", profile_id).eq("user_id", user_id).execute()
    sb.table("medicines").delete().eq("profile_id", profile_id).eq("user_id", user_id).execute()
    sb.table("health_vitals").delete().eq("profile_id", profile_id).eq("user_id", user_id).execute()
    sb.table("profiles").delete().eq("id", profile_id).eq("user_id", user_id).execute()


# ── Medicines ─────────────────────────────────────────────────────────────────
def _parse_times(row: dict) -> dict:
    r = dict(row)
    try:
        r["times"] = json.loads(r["times"]) if isinstance(r["times"], str) else r["times"]
    except Exception:
        r["times"] = []
    return r


def get_medicines_for_profile(user_id: str, profile_id: str):
    rows = get_client().table("medicines").select("*")\
        .eq("profile_id", profile_id).eq("user_id", user_id)\
        .order("created_at").execute()
    return [_parse_times(r) for r in (rows.data or [])]


def get_all_medicines_for_user(user_id: str):
    rows = get_client().table("medicines").select("*").eq("user_id", user_id).execute()
    return [_parse_times(r) for r in (rows.data or [])]


def create_medicine(user_id: str, profile_id: str, name: str, dosage: str, times: list):
    now    = datetime.utcnow().isoformat()
    med_id = int(datetime.utcnow().timestamp() * 1000)
    data   = {
        "id": med_id, "profile_id": profile_id, "user_id": user_id,
        "name": name, "dosage": dosage,
        "times": json.dumps(times),
        "created_at": now
    }
    get_client().table("medicines").insert(data).execute()
    return {**data, "times": times}


def delete_medicine(user_id: str, med_id: int):
    sb = get_client()
    sb.table("dose_logs").delete().eq("med_id", med_id).eq("user_id", user_id).execute()
    sb.table("medicines").delete().eq("id", med_id).eq("user_id", user_id).execute()


# ── Dose logs ─────────────────────────────────────────────────────────────────
def log_dose(user_id: str, med_id: int, profile_id: str, log_date: str, log_time: str, status: str):
    sb     = get_client()
    log_id = int(datetime.utcnow().timestamp() * 1000)
    now    = datetime.utcnow().isoformat()
    # upsert: delete existing then insert
    sb.table("dose_logs").delete()\
        .eq("med_id", med_id).eq("log_date", log_date)\
        .eq("log_time", log_time).eq("user_id", user_id).execute()
    data = {
        "id": log_id, "med_id": med_id, "profile_id": profile_id,
        "user_id": user_id, "log_date": log_date, "log_time": log_time,
        "status": status, "logged_at": now
    }
    sb.table("dose_logs").insert(data).execute()
    return {"id": log_id, "med_id": med_id, "log_date": log_date, "log_time": log_time, "status": status}


def get_medicine_analytics(user_id: str, med_id: int, days: int = 30):
    sb   = get_client()
    rows = sb.table("medicines").select("*").eq("id", med_id).eq("user_id", user_id).execute()
    if not rows.data:
        return None
    med = _parse_times(rows.data[0])
    med_times = med["times"]

    since = (date.today() - timedelta(days=days)).isoformat()
    logs  = sb.table("dose_logs").select("*")\
        .eq("med_id", med_id).eq("user_id", user_id)\
        .gte("log_date", since).order("log_date").order("log_time").execute()
    log_map = {(l["log_date"], l["log_time"]): l["status"] for l in (logs.data or [])}

    today_date = date.today()
    daily = []
    total_expected = total_taken = total_skipped = 0

    for i in range(days - 1, -1, -1):
        d  = (today_date - timedelta(days=i)).isoformat()
        dt = sum(1 for t in med_times if log_map.get((d, t)) == "taken")
        ds = sum(1 for t in med_times if log_map.get((d, t)) == "skipped")
        daily.append({
            "date": d, "taken": dt, "skipped": ds,
            "unlogged": len(med_times) - dt - ds,
            "expected": len(med_times)
        })
        total_expected += len(med_times)
        total_taken    += dt
        total_skipped  += ds

    streak = 0
    for day in reversed(daily):
        if day["expected"] > 0 and day["taken"] == day["expected"]:
            streak += 1
        else:
            break

    adherence_pct = round((total_taken / total_expected * 100) if total_expected else 0, 1)
    return {
        "med_id": med_id, "med_name": med["name"], "med_dosage": med["dosage"],
        "days": days, "total_expected": total_expected, "total_taken": total_taken,
        "total_skipped": total_skipped,
        "total_unlogged": total_expected - total_taken - total_skipped,
        "adherence_pct": adherence_pct, "streak_days": streak, "daily": daily
    }


# ── Health vitals ─────────────────────────────────────────────────────────────
VITAL_THRESHOLDS = {
    "bp_sys":        {"unit": "mmHg",  "low": 90,   "high": 140,  "label": "BP Systolic"},
    "bp_dia":        {"unit": "mmHg",  "low": 60,   "high": 90,   "label": "BP Diastolic"},
    "sugar_fasting": {"unit": "mg/dL", "low": 70,   "high": 100,  "label": "Blood Sugar (Fasting)"},
    "sugar_pp":      {"unit": "mg/dL", "low": 70,   "high": 140,  "label": "Blood Sugar (Post-Meal)"},
    "heart_rate":    {"unit": "bpm",   "low": 60,   "high": 100,  "label": "Heart Rate"},
    "spo2":          {"unit": "%",     "low": 95,   "high": 100,  "label": "SpO2"},
    "weight":        {"unit": "kg",    "low": None, "high": None, "label": "Weight"},
    "temperature":   {"unit": "C",     "low": 36.1, "high": 37.2, "label": "Temperature"},
    "cholesterol":   {"unit": "mg/dL", "low": None, "high": 200,  "label": "Total Cholesterol"},
    "hba1c":         {"unit": "%",     "low": None, "high": 5.7,  "label": "HbA1c"},
}


def log_vital(user_id: str, profile_id: str, metric: str, value: float, notes: str = ""):
    vid  = int(datetime.utcnow().timestamp() * 1000)
    now  = datetime.utcnow().isoformat()
    unit = VITAL_THRESHOLDS.get(metric, {}).get("unit", "")
    data = {
        "id": vid, "profile_id": profile_id, "user_id": user_id,
        "metric": metric, "value": value, "unit": unit,
        "notes": notes, "recorded_at": now
    }
    get_client().table("health_vitals").insert(data).execute()
    return data


def get_vitals_for_profile(user_id: str, profile_id: str, days: int = 30):
    since = (datetime.utcnow() - timedelta(days=days)).isoformat()
    rows  = get_client().table("health_vitals").select("*")\
        .eq("profile_id", profile_id).eq("user_id", user_id)\
        .gte("recorded_at", since).order("recorded_at", desc=True).execute()

    result = []
    for row in (rows.data or []):
        r      = dict(row)
        thresh = VITAL_THRESHOLDS.get(r["metric"], {})
        v, lo, hi = float(r["value"]), thresh.get("low"), thresh.get("high")
        if   lo is not None and v < lo: r["status"] = "low"
        elif hi is not None and v > hi: r["status"] = "high"
        else:                           r["status"] = "normal"
        r["label"] = thresh.get("label", r["metric"])
        r["unit"]  = thresh.get("unit",  r.get("unit", ""))
        result.append(r)

    grouped = {}
    for r in result:
        grouped.setdefault(r["metric"], []).append(r)

    return {"vitals": result, "grouped": grouped, "thresholds": VITAL_THRESHOLDS}


def delete_vital(user_id: str, vital_id: int):
    get_client().table("health_vitals").delete()\
        .eq("id", vital_id).eq("user_id", user_id).execute()
