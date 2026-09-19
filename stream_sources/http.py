import json
import urllib.error
import urllib.request

from .errors import SourceError

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Accept-Language": "ja,en;q=0.5",
}


def get_text(url, *, timeout=12, accept="text/html,application/xhtml+xml,*/*;q=0.8"):
    request = urllib.request.Request(url, headers={**HEADERS, "Accept": accept})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.read().decode("utf-8", "replace")
    except (urllib.error.URLError, TimeoutError) as exc:
        raise SourceError("UPSTREAM_UNAVAILABLE", "配信情報の取得元に接続できませんでした") from exc


def get_json(url, *, timeout=12):
    try:
        return json.loads(get_text(url, timeout=timeout, accept="application/json"))
    except json.JSONDecodeError as exc:
        raise SourceError("UPSTREAM_INVALID_RESPONSE", "配信情報の形式が正しくありません") from exc
