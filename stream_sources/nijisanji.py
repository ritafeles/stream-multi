from .cache import cached
from .http import get_json


def get_on_air():
    return cached("nijisanji", 45, _fetch_on_air)


def _fetch_on_air():
    streams = _fetch_streams(-1) + _fetch_streams(0)
    on_air, seen = [], set()
    for stream in streams:
        url = stream.get("url")
        if stream.get("status") != "on_air" or url in seen:
            continue
        seen.add(url)
        on_air.append(stream)
    on_air.sort(key=lambda stream: stream.get("start-at") or "", reverse=True)
    return on_air


def _fetch_streams(day_offset):
    data = get_json(f"https://www.nijisanji.jp/api/streams?day_offset={day_offset}", timeout=10)
    if isinstance(data, list):
        out = []
        for item in data:
            if not isinstance(item, dict):
                continue
            channel = item.get("channel") or {}
            out.append({
                "title": item.get("title"), "url": item.get("url"),
                "thumbnail-url": item.get("thumbnail-url"),
                "fallback-thumbnail-url": item.get("fallback-thumbnail-url"),
                "start-at": item.get("start-at"), "status": item.get("status"),
                "youtube-channel": {"name": channel.get("name"), "thumbnail-url": channel.get("thumbnail-url")},
            })
        return out

    channels = {item["id"]: item.get("attributes", {}) for item in data.get("included", [])
                if item.get("type") == "youtube_channel"}
    out = []
    for event in data.get("data", []):
        attr = event.get("attributes", {})
        ref = event.get("relationships", {}).get("youtube_channel", {}).get("data") or {}
        channel = channels.get(ref.get("id"), {})
        out.append({
            "title": attr.get("title"), "url": attr.get("url"),
            "thumbnail-url": attr.get("thumbnail_url"),
            "fallback-thumbnail-url": attr.get("fallback_thumbnail_url"),
            "start-at": attr.get("start_at"), "status": attr.get("status"),
            "youtube-channel": {"name": channel.get("name"), "thumbnail-url": channel.get("thumbnail_url")},
        })
    return out
