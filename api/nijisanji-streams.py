"""Vercel function for /api/nijisanji-streams."""
from stream_sources.api import ApiHandler


class handler(ApiHandler):
    route = "/api/nijisanji-streams"
