"""Vercel function for /api/youtube-live."""
from stream_sources.api import ApiHandler


class handler(ApiHandler):
    route = "/api/youtube-live"
