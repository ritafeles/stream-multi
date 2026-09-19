"""Vercel function for /api/vmiru-streams."""
from http.server import BaseHTTPRequestHandler
import json, logging
from stream_sources.errors import public_error
from stream_sources.vmiru import get_streams

class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            self._json(200, {"streams": get_streams()})
        except Exception as exc:
            logging.exception("vmiru stream request failed")
            self._json(*public_error(exc))

    def _json(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        cache_control = "public, s-maxage=30, stale-while-revalidate=300" if code < 400 else "no-store"
        self.send_header("Cache-Control", cache_control)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers(); self.wfile.write(body)
