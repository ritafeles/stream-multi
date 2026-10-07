"""API routes shared by the local server and the Vercel functions."""

import json
import logging
import urllib.parse
from http.server import BaseHTTPRequestHandler

from .errors import SourceError, public_error
from .ikioi import get_streams as get_ikioi_streams
from .nijisanji import get_on_air
from .vmiru import get_streams as get_vmiru_streams
from .youtube_live import get_live_video


def _first(query, name, default=None):
    return (query.get(name) or [default])[0]


def _nijisanji(query):
    return {"days": [{"label": "🔴 ON AIR", "streams": get_on_air()}]}


def _ikioi(query):
    keyword = _first(query, "keyword", "Vtuber")
    return {"keyword": keyword, "streams": get_ikioi_streams(keyword)}


def _vmiru(query):
    return {"streams": get_vmiru_streams()}


def _youtube_live(query):
    return get_live_video(_first(query, "channel", ""))


# path -> (payload builder, shared-cache seconds)
ROUTES = {
    "/api/nijisanji-streams": (_nijisanji, 45),
    "/api/ikioi-streams": (_ikioi, 45),
    "/api/vmiru-streams": (_vmiru, 30),
    "/api/youtube-live": (_youtube_live, 60),
}


def handle_api(handler, path):
    """Write the JSON response for an API path. Returns False if the path is not an API route."""
    route = ROUTES.get(path)
    if not route:
        return False
    build, max_age = route
    query = urllib.parse.parse_qs(urllib.parse.urlparse(handler.path).query)
    try:
        code, payload = 200, build(query)
    except Exception as exc:
        if not isinstance(exc, SourceError):
            logging.exception("API request failed: %s", path)
        code, payload = public_error(exc)
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(code)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    cache_control = f"public, s-maxage={max_age}, stale-while-revalidate=300" if code < 400 else "no-store"
    handler.send_header("Cache-Control", cache_control)
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.end_headers()
    handler.wfile.write(body)
    return True


class ApiHandler(BaseHTTPRequestHandler):
    """Base class for Vercel functions; subclasses set `route`."""
    route = None

    def do_GET(self):
        handle_api(self, self.route)
