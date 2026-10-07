"""Resolve a YouTube channel (@handle or UC... ID) to its current live video."""

import html as html_mod
import re
import urllib.parse

from .cache import cached
from .errors import SourceError
from .http import get_text

HANDLE_RE = re.compile(r"^@[^\s/?#]{1,100}$")
CHANNEL_ID_RE = re.compile(r"^UC[A-Za-z0-9_-]{22}$")
CANONICAL_RE = re.compile(
    r'<link rel="canonical" href="https://www\.youtube\.com/watch\?v=([A-Za-z0-9_-]{11})"')
TITLE_RE = re.compile(r'<meta property="og:title" content="([^"]*)"')
# Skip the EU cookie-consent interstitial.
CONSENT_COOKIE = {"Cookie": "SOCS=CAI"}


def get_live_video(channel):
    channel = (channel or "").strip()
    if HANDLE_RE.match(channel):
        path = "/" + urllib.parse.quote(channel, safe="@")
    elif CHANNEL_ID_RE.match(channel):
        path = "/channel/" + channel
    else:
        raise SourceError("INVALID_CHANNEL", "YouTube チャンネルの指定が正しくありません", status=400)
    # stale_seconds=0: a channel that just went offline must not keep returning its old stream.
    return cached(("youtube-live", channel.lower()), 60, lambda: _fetch(path), stale_seconds=0)


def _fetch(path):
    page = get_text("https://www.youtube.com" + path + "/live", timeout=10, headers=CONSENT_COOKIE)
    match = CANONICAL_RE.search(page)
    if not match:
        raise SourceError("NOT_LIVE", "このチャンネルは現在ライブ配信していません", status=404)
    title = TITLE_RE.search(page)
    return {"videoId": match.group(1), "title": html_mod.unescape(title.group(1)) if title else None}
