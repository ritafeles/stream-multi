"""Small in-process TTL cache with stale-on-error support."""

import copy
import threading
import time

_entries = {}
_lock = threading.Lock()


def cached(key, ttl_seconds, loader, stale_seconds=300):
    """Return cached data for this process.

    A recently expired successful value is returned if the upstream refresh fails.
    Values are copied so callers cannot mutate the cached object.
    """
    now = time.monotonic()
    with _lock:
        entry = _entries.get(key)
        if entry and now < entry["expires_at"]:
            return copy.deepcopy(entry["value"])

    try:
        value = loader()
    except Exception:
        with _lock:
            entry = _entries.get(key)
            if entry and now < entry["stale_until"]:
                return copy.deepcopy(entry["value"])
        raise

    with _lock:
        _entries[key] = {
            "value": copy.deepcopy(value),
            "expires_at": now + ttl_seconds,
            "stale_until": now + ttl_seconds + stale_seconds,
        }
    return value
