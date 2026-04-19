print("[1/4] Loading Flask...")
from flask import Flask, request, jsonify, g
from functools import wraps
from datetime import datetime
import os
import sys
import subprocess
 
print("[2/4] Loading Flask-CORS...")
try:
    from flask_cors import CORS
except ImportError:
    print("      flask_cors missing — installing now...")
    subprocess.check_call([sys.executable, "-m", "pip", "install", "Flask-CORS"])
    from flask_cors import CORS
 
print("[3/4] Loading database module...")
import database as db
 
# ── Windows project path ──────────────────────────────────────────────────────
BASE_DIR = os.getenv(
    "MED_BASE_DIR",
    r"C:\Users\sande\Downloads\medicine reminder"
)
 
print("[4/4] Creating Flask app...")
app = Flask(__name__)
CORS(app, resources={r"/api/*": {"origins": "*"}})
 
 
# ── Auth middleware ───────────────────────────────────────────────────────────
def require_auth(f):
    """Decorator: validates Bearer token, injects g.user = {user_id, username}."""
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
    return jsonify({"status": "DosePing API", "version": "1.0"})
 
 
# ── Auth endpoints (NO token required) ───────────────────────────────────────
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
        user = db.register_user(username, password, data.get("email", ""))
        session = db.login_user(username, password)
        return jsonify({"message": "Account created!", "token": session["token"],
                        "username": username}), 201
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
        return jsonify({"token": session["token"], "username": session["username"],
                        "user_id": session["user_id"]})
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
    data = request.get_json()
    required = ["profile_id", "log_date", "log_time", "status"]
    if not data or any(k not in data for k in required):
        return jsonify({"error": f"Required: {required}"}), 400
    if data["status"] not in ("taken", "skipped"):
        return jsonify({"error": "status must be 'taken' or 'skipped'"}), 400
    try:
        log = db.log_dose(g.user["user_id"], mid,
                          data["profile_id"], data["log_date"],
                          data["log_time"], data["status"])
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
 
 
# ── Entry point ───────────────────────────────────────────────────────────────
if __name__ == "__main__":
    print("\n" + "="*50)
    print("  Medicine Reminder backend starting...")
    print("  Initialising database connection...")
    try:
        db.init_db()
        print("  Database OK")
    except Exception as e:
        print(f"  [WARNING] DB not ready yet: {e}")
        print("  Make sure MindsDB is running on http://127.0.0.1:47334")
    print("="*50)
    print("  Open http://localhost:5000 in your browser")
    print("="*50 + "\n")
    app.run(debug=True, port=5000, use_reloader=False)