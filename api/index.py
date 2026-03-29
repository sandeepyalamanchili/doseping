import sys
import os

try:
    sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
    from app import app
    handler = app
except Exception as e:
    from http.server import BaseHTTPRequestHandler
    class handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(500)
            self.send_header("Content-type", "application/json")
            self.end_headers()
            self.wfile.write(f'{{"error": "{str(e)}"}}'.encode())
