"""Vercel function for /api/nijisanji-streams."""
from http.server import BaseHTTPRequestHandler
import json, logging
from stream_sources.errors import public_error
from stream_sources.nijisanji import get_on_air

class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            self._json(200, {"days": [{"label": "🔴 ON AIR", "streams": get_on_air()}]})
        except Exception as exc:
            logging.exception("nijisanji stream request failed")
            self._json(*public_error(exc))

    def _json(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        cache_control = "public, s-maxage=45, stale-while-revalidate=300" if code < 400 else "no-store"
        self.send_header("Cache-Control", cache_control)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers(); self.wfile.write(body)
