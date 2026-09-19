"""Vercel function for /api/ikioi-streams."""
from http.server import BaseHTTPRequestHandler
import json, logging, urllib.parse
from stream_sources.errors import public_error
from stream_sources.ikioi import get_streams

class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            params = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            keyword = (params.get("keyword") or ["Vtuber"])[0]
            self._json(200, {"keyword": keyword, "streams": get_streams(keyword)})
        except Exception as exc:
            logging.exception("ikioi stream request failed")
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
