import html as html_mod
import re
import urllib.parse

from .cache import cached
from .http import get_text


def get_streams(keyword="Vtuber"):
    keyword = (keyword or "Vtuber").strip()[:100]
    return cached(("ikioi", keyword), 45, lambda: _fetch(keyword))


def _fetch(keyword):
    page = get_text("https://ikioi-ranking.com/?keyword=" + urllib.parse.quote(keyword), timeout=12)
    out, seen = [], set()
    for block in page.split('<div id="livebox"')[1:]:
        match = re.search(r'class="live_maintitle"><a href="([^"]+)"[^>]*title="([^"]*)"', block)
        if not match:
            continue
        stream_url = html_mod.unescape(match.group(1))
        if not stream_url or stream_url in seen:
            continue
        seen.add(stream_url)
        channel_match = re.search(r'class="live_name">.*?<a [^>]*>([^<]*)</a>', block, re.S)
        viewer_match = re.search(r'class="live_viewer[^"]*"[^>]*>.*?<span>([\d,]+)</span>', block, re.S)
        thumb_match = re.search(r'class="live_movieImg2"><a [^>]*src="([^"]+)"', block)
        out.append({
            "title": html_mod.unescape(match.group(2)).strip(),
            "url": stream_url,
            "channel": html_mod.unescape(channel_match.group(1)).strip() if channel_match else "",
            "viewers": int(viewer_match.group(1).replace(",", "")) if viewer_match else None,
            "thumbnail-url": html_mod.unescape(thumb_match.group(1)) if thumb_match else "",
            "site": "twitch" if "twitch.tv" in stream_url else "youtube",
        })
    return out
