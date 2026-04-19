print("[1/4] Loading Flask...")
from flask import Flask, request, jsonify, g
from functools import wraps
from datetime import datetime
import os
import sys
import subprocess
import urllib.request
import urllib.parse
import json

print("[2/4] Loading Flask-CORS...")
try:
    from flask_cors import CORS
except ImportError:
    print("      flask_cors missing — installing now...")
    subprocess.check_call([sys.executable, "-m", "pip", "install", "Flask-CORS"])
    from flask_cors import CORS

print("[3/4] Loading supabase...")
try:
    from supabase import create_client
except ImportError:
    print("      supabase missing — installing now...")
    subprocess.check_call([sys.executable, "-m", "pip", "install", "supabase"])

print("[4/4] Loading database module...")
import database as db

# ── Load .env if present (local dev) ─────────────────────────────────────────
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass  # dotenv optional — env vars may be set by the host (Render, Railway, etc.)

# ── App setup ─────────────────────────────────────────────────────────────────
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
app = Flask(__name__, static_folder=BASE_DIR, static_url_path="")
CORS(app)


# ── Auth middleware ───────────────────────────────────────────────────────────
def require_auth(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        auth_header = request.headers.get("Authorization", "")
        token = None
        if auth_header.startswith("Bearer "):
            token = auth_header[7:]
        if not token:
            return jsonify({"error": "Authentication required"}), 401
        user = db.validate_token(token)
        if not user:
            return jsonify({"error": "Invalid or expired token. Please log in again."}), 401
        g.user = user
        return f(*args, **kwargs)
    return decorated


# ── Frontend ──────────────────────────────────────────────────────────────────
@app.route("/")
def index():
    return app.send_static_file("index.html")


# ── Translation endpoint ──────────────────────────────────────────────────────
@app.route("/api/translate", methods=["POST"])
def translate():
    """
    Translate text using MyMemory API (free, no key required).
    Body: { "text": "...", "source": "auto", "target": "en" }
    Returns: { "translated": "...", "detected_lang": "..." }
    """
    data = request.get_json()
    if not data or not data.get("text"):
        return jsonify({"error": "text is required"}), 400

    text        = data["text"].strip()
    target_lang = data.get("target", "en")
    source_lang = data.get("source", "auto")

    if not text:
        return jsonify({"translated": "", "detected_lang": "en"})

    try:
        # MyMemory free API — 5000 words/day, no key needed
        lang_pair = f"{source_lang}|{target_lang}" if source_lang != "auto" else f"|{target_lang}"
        params    = urllib.parse.urlencode({"q": text, "langpair": lang_pair})
        url       = f"https://api.mymemory.translated.net/get?{params}"

        req  = urllib.request.Request(url, headers={"User-Agent": "MedicineReminderApp/1.0"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            result = json.loads(resp.read().decode())

        translated    = result.get("responseData", {}).get("translatedText", text)
        detected_lang = result.get("responseData", {}).get("detectedLanguage", source_lang) or source_lang

        # MyMemory returns the original text when it can't translate
        if translated.upper() == text.upper():
            translated = text

        return jsonify({"translated": translated, "detected_lang": detected_lang})

    except Exception as e:
        # Fallback: return original text so the app keeps working
        return jsonify({"translated": text, "detected_lang": source_lang, "error": str(e)})


@app.route("/api/translate/detect", methods=["POST"])
def detect_language():
    """Detect language of given text."""
    data = request.get_json()
    if not data or not data.get("text"):
        return jsonify({"error": "text is required"}), 400
    text = data["text"].strip()
    try:
        params = urllib.parse.urlencode({"q": text, "langpair": "en|fr"})
        url    = f"https://api.mymemory.translated.net/get?{params}"
        req    = urllib.request.Request(url, headers={"User-Agent": "MedicineReminderApp/1.0"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            result = json.loads(resp.read().decode())
        detected = result.get("responseData", {}).get("detectedLanguage", "en") or "en"
        return jsonify({"detected_lang": detected})
    except Exception as e:
        return jsonify({"detected_lang": "en", "error": str(e)})


# ── Auth endpoints ────────────────────────────────────────────────────────────
@app.route("/api/auth/register", methods=["POST"])
def register():
    data = request.get_json()
    if not data or not data.get("username") or not data.get("password"):
        return jsonify({"error": "username and password are required"}), 400
    username = data["username"].strip()
    password = data["password"]
    if len(username) < 3:
        return jsonify({"error": "Username must be at least 3 characters"}), 400
    if len(password) < 6:
        return jsonify({"error": "Password must be at least 6 characters"}), 400
    try:
        db.register_user(username, password, data.get("email", ""))
        session = db.login_user(username, password)
        return jsonify({"message": "Account created!", "token": session["token"], "username": username}), 201
    except ValueError as e:
        return jsonify({"error": str(e)}), 409
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/auth/login", methods=["POST"])
def login():
    data = request.get_json()
    if not data or not data.get("username") or not data.get("password"):
        return jsonify({"error": "username and password are required"}), 400
    try:
        session = db.login_user(data["username"].strip(), data["password"])
        return jsonify({"token": session["token"], "username": session["username"], "user_id": session["user_id"]})
    except ValueError as e:
        return jsonify({"error": str(e)}), 401
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/auth/logout", methods=["POST"])
def logout():
    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Bearer "):
        db.logout_user(auth_header[7:])
    return jsonify({"message": "Logged out"})


@app.route("/api/auth/change-password", methods=["POST"])
@require_auth
def change_password():
    data = request.get_json()
    if not data or not data.get("old_password") or not data.get("new_password"):
        return jsonify({"error": "old_password and new_password required"}), 400
    if len(data["new_password"]) < 6:
        return jsonify({"error": "New password must be at least 6 characters"}), 400
    try:
        db.change_password(g.user["user_id"], data["old_password"], data["new_password"])
        return jsonify({"message": "Password updated successfully"})
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/auth/me", methods=["GET"])
@require_auth
def me():
    return jsonify({"user_id": g.user["user_id"], "username": g.user["username"]})


# ── Profiles ──────────────────────────────────────────────────────────────────
@app.route("/api/profiles", methods=["GET"])
@require_auth
def list_profiles():
    try:
        return jsonify({"profiles": db.get_profiles_for_user(g.user["user_id"])})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/profiles", methods=["POST"])
@require_auth
def add_profile():
    data = request.get_json()
    if not data or not data.get("name"):
        return jsonify({"error": "name required"}), 400
    try:
        pid = "profile_" + str(int(datetime.utcnow().timestamp() * 1000))
        p   = db.create_profile(g.user["user_id"], pid,
                                 data["name"].strip(), data.get("color", "#8B5CF6"))
        return jsonify({"profile": p}), 201
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/profiles/<pid>", methods=["DELETE"])
@require_auth
def remove_profile(pid):
    try:
        db.delete_profile(g.user["user_id"], pid)
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ── Medicines ─────────────────────────────────────────────────────────────────
@app.route("/api/profiles/<pid>/medicines", methods=["GET"])
@require_auth
def list_medicines(pid):
    try:
        return jsonify({"medicines": db.get_medicines_for_profile(g.user["user_id"], pid)})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/profiles/<pid>/medicines", methods=["POST"])
@require_auth
def add_medicine(pid):
    data = request.get_json()
    if not data or not data.get("name") or not data.get("dosage"):
        return jsonify({"error": "name and dosage required"}), 400
    if not isinstance(data.get("times"), list) or not data["times"]:
        return jsonify({"error": "times must be a non-empty list"}), 400
    try:
        m = db.create_medicine(g.user["user_id"], pid,
                               data["name"].strip(), data["dosage"].strip(), data["times"])
        return jsonify({"medicine": m}), 201
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/medicines/<int:mid>", methods=["DELETE"])
@require_auth
def remove_medicine(mid):
    try:
        db.delete_medicine(g.user["user_id"], mid)
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ── Dose logs ─────────────────────────────────────────────────────────────────
@app.route("/api/medicines/<int:mid>/log", methods=["POST"])
@require_auth
def log_dose(mid):
    data     = request.get_json()
    required = ["profile_id", "log_date", "log_time", "status"]
    if not data or any(k not in data for k in required):
        return jsonify({"error": f"Required: {required}"}), 400
    if data["status"] not in ("taken", "skipped"):
        return jsonify({"error": "status must be 'taken' or 'skipped'"}), 400
    try:
        log = db.log_dose(g.user["user_id"], mid, data["profile_id"],
                          data["log_date"], data["log_time"], data["status"])
        return jsonify({"log": log}), 201
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/medicines/<int:mid>/analytics", methods=["GET"])
@require_auth
def get_analytics(mid):
    days = int(request.args.get("days", 30))
    try:
        result = db.get_medicine_analytics(g.user["user_id"], mid, days)
        if result is None:
            return jsonify({"error": "Medicine not found"}), 404
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ── Health vitals ─────────────────────────────────────────────────────────────
@app.route("/api/profiles/<pid>/vitals", methods=["GET"])
@require_auth
def get_vitals(pid):
    days = int(request.args.get("days", 30))
    try:
        return jsonify(db.get_vitals_for_profile(g.user["user_id"], pid, days))
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/profiles/<pid>/vitals", methods=["POST"])
@require_auth
def add_vital(pid):
    data = request.get_json()
    if not data or not data.get("metric") or data.get("value") is None:
        return jsonify({"error": "metric and value required"}), 400
    if data["metric"] not in db.VITAL_THRESHOLDS:
        return jsonify({"error": f"Unknown metric. Valid: {list(db.VITAL_THRESHOLDS)}"}), 400
    try:
        v = db.log_vital(g.user["user_id"], pid,
                         data["metric"], float(data["value"]), data.get("notes", ""))
        return jsonify({"vital": v}), 201
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/vitals/<int:vid>", methods=["DELETE"])
@require_auth
def remove_vital(vid):
    try:
        db.delete_vital(g.user["user_id"], vid)
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/vitals/thresholds", methods=["GET"])
def get_thresholds():
    return jsonify(db.VITAL_THRESHOLDS)


# ── Reminder check ────────────────────────────────────────────────────────────
@app.route("/api/reminders/check", methods=["GET"])
@require_auth
def check_reminders():
    try:
        now  = datetime.now().strftime("%H:%M")
        meds = db.get_all_medicines_for_user(g.user["user_id"])
        due  = [m for m in meds if now in m.get("times", [])]
        return jsonify({"time": now, "due": due})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# ── Public cron endpoint (no auth required) ───────────────────────────────────
CRON_SECRET = "doseping2026"

@app.route("/api/cron/check", methods=["GET"])
def cron_check_reminders():
    token = request.args.get("token")
    if token != CRON_SECRET:
        return jsonify({"error": "Unauthorized"}), 401
    try:
        now = datetime.now().strftime("%H:%M")
        return jsonify({"status": "ok", "time": now})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# ── Health check (for Render/Railway) ────────────────────────────────────────
@app.route("/health")
def health():
    return jsonify({"status": "ok"})


# ── Entry point ───────────────────────────────────────────────────────────────
if __name__ == "__main__":
    print("\n" + "="*55)
    print("  Medicine Reminder — starting...")
    print("  Checking Supabase connection...")
    try:
        db.init_db()
    except RuntimeError as e:
        print(f"\n  ❌ {e}\n")
        print("  Steps to fix:")
        print("  1. Go to https://supabase.com and create a free project")
        print("  2. Run schema.sql in the Supabase SQL editor")
        print("  3. Copy your URL and anon key to a .env file:")
        print("     SUPABASE_URL=https://xxxx.supabase.co")
        print("     SUPABASE_KEY=your-anon-key")
        print("="*55 + "\n")
        sys.exit(1)
    except Exception as e:
        print(f"  ⚠ DB warning: {e}")
    print("  ✓ Database connected")
    print("="*55)
    print("  Open http://localhost:5000 in your browser")
    print("="*55 + "\n")
    port = int(os.getenv("PORT", 5000))
    app.run(debug=os.getenv("FLASK_DEBUG", "false").lower() == "true",
            host="0.0.0.0", port=port, use_reloader=False)
