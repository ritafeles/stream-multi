"""Vercel function for /api/ikioi-streams."""
from stream_sources.api import ApiHandler


class handler(ApiHandler):
    route = "/api/ikioi-streams"
