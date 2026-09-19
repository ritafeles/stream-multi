#!/usr/bin/env python3
"""Local static server with the same stream-source modules used in production."""
import http.server, json, logging, os, socketserver, urllib.parse
from stream_sources.errors import public_error
from stream_sources.ikioi import get_streams as get_ikioi_streams
from stream_sources.nijisanji import get_on_air
from stream_sources.vmiru import get_streams as get_vmiru_streams

PORT = 8080
DIRECTORY = os.path.dirname(os.path.abspath(__file__))

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        try:
            if path == "/api/nijisanji-streams":
                return self._json(200, {"days": [{"label": "🔴 ON AIR", "streams": get_on_air()}]})
            if path == "/api/ikioi-streams":
                params = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
                keyword = (params.get("keyword") or ["Vtuber"])[0]
                return self._json(200, {"keyword": keyword, "streams": get_ikioi_streams(keyword)})
            if path == "/api/vmiru-streams":
                return self._json(200, {"streams": get_vmiru_streams()})
        except Exception as exc:
            logging.exception("API request failed: %s", path)
            return self._json(*public_error(exc))
        super().do_GET()

    def _json(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        cache_control = "public, max-age=30, stale-while-revalidate=300" if code < 400 else "no-store"
        self.send_header("Cache-Control", cache_control)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers(); self.wfile.write(body)

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        super().end_headers()

class ThreadingHTTPServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    daemon_threads = True
    allow_reuse_address = True

if __name__ == "__main__":
    with ThreadingHTTPServer(("", PORT), Handler) as httpd:
        print(f"http://localhost:{PORT} で起動中 (Ctrl+C で停止)")
        httpd.serve_forever()
