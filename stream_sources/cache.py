"""Small in-process TTL cache with stale-on-error support."""

import copy
import threading
import time
from collections import OrderedDict

MAX_ENTRIES = 128

_entries = OrderedDict()
_lock = threading.Lock()


def cached(key, ttl_seconds, loader, stale_seconds=300):
    """Return cached data for this process.

    A recently expired successful value is returned if the upstream refresh fails.
    Values are copied so callers cannot mutate the cached object.
    At most MAX_ENTRIES keys are kept; the least recently used key is evicted first.
    """
    now = time.monotonic()
    with _lock:
        entry = _entries.get(key)
        if entry and now < entry["expires_at"]:
            _entries.move_to_end(key)
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
        _entries.move_to_end(key)
        while len(_entries) > MAX_ENTRIES:
            _entries.popitem(last=False)
    return value
