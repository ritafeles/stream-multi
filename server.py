#!/usr/bin/env python3
"""Local static server with the same stream-source modules used in production.

Usage: python server.py [--open]
  PORT (default 8080) and HOST (default 127.0.0.1) can be set via environment variables.
  If the port is busy, the next free port is used.
"""
import http.server, os, posixpath, socketserver, sys, urllib.parse, webbrowser
from stream_sources.api import handle_api

HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8080"))
DIRECTORY = os.path.dirname(os.path.abspath(__file__))
# Only the frontend is served; source code, .git, tests etc. are never exposed.
PUBLIC_FILES = {"/", "/index.html"}
PUBLIC_DIRS = ("/assets/",)


def is_public(path):
    path = posixpath.normpath(urllib.parse.unquote(path))
    return path in PUBLIC_FILES or path.startswith(PUBLIC_DIRS)


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if handle_api(self, path):
            return
        if not is_public(path):
            return self.send_error(404)
        super().do_GET()

    def do_HEAD(self):
        if not is_public(urllib.parse.urlparse(self.path).path):
            return self.send_error(404)
        super().do_HEAD()

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        super().end_headers()


class ThreadingHTTPServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    daemon_threads = True
    # Windows SO_REUSEADDR allows double-binding, which would hide a busy port.
    allow_reuse_address = os.name != "nt"


def bind(host, port, attempts=10):
    for candidate in range(port, port + attempts):
        try:
            return ThreadingHTTPServer((host, candidate), Handler)
        except OSError:
            print(f"ポート {candidate} は使用中です。次を試します…")
    raise SystemExit(f"空いているポートが見つかりませんでした（{port}〜{port + attempts - 1}）")


if __name__ == "__main__":
    with bind(HOST, PORT) as httpd:
        url = f"http://{'localhost' if HOST in ('127.0.0.1', '0.0.0.0') else HOST}:{httpd.server_address[1]}"
        print(f"{url} で起動中 (Ctrl+C で停止)")
        if "--open" in sys.argv:
            webbrowser.open(url)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
