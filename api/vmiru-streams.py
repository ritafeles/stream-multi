"""Vercel function for /api/vmiru-streams."""
from stream_sources.api import ApiHandler


class handler(ApiHandler):
    route = "/api/vmiru-streams"
