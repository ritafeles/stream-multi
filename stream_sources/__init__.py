"""Shared stream-source clients used by local and Vercel HTTP handlers."""

from .cache import cached
from .errors import SourceError

__all__ = ["SourceError", "cached"]
