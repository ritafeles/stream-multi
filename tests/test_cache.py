import unittest
from unittest.mock import patch

from stream_sources import cache


class CacheTests(unittest.TestCase):
    def setUp(self):
        cache._entries.clear()

    def test_reuses_value_during_ttl(self):
        calls = []
        loader = lambda: calls.append(True) or {"value": len(calls)}
        with patch("stream_sources.cache.time.monotonic", return_value=10):
            first = cache.cached("key", 30, loader)
        with patch("stream_sources.cache.time.monotonic", return_value=20):
            second = cache.cached("key", 30, loader)
        self.assertEqual(first, second)
        self.assertEqual(len(calls), 1)

    def test_returns_stale_value_when_refresh_fails(self):
        with patch("stream_sources.cache.time.monotonic", return_value=10):
            cache.cached("key", 5, lambda: ["cached"], stale_seconds=30)
        with patch("stream_sources.cache.time.monotonic", return_value=20):
            value = cache.cached("key", 5, lambda: (_ for _ in ()).throw(RuntimeError()), stale_seconds=30)
        self.assertEqual(value, ["cached"])


if __name__ == "__main__":
    unittest.main()
