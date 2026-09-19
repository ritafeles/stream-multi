from concurrent.futures import ThreadPoolExecutor

from .cache import cached
from .http import get_json

CDN = "https://d3t40075vqz7f2.cloudfront.net"
AGENCY_LABELS = {
    "nijisanji": "にじさんじ", "hololive": "ホロライブ", "vspo": "ぶいすぽっ！",
    "774inc": "774inc", "noripro": "のりプロ", "hololive_en": "hololive EN",
    "hololive_id": "hololive ID", "nijisanji_en": "NIJISANJI EN", "holostars": "ホロスターズ",
    "neoporte": "ネオポルテ", "dotlive": ".LIVE", "independent": "個人勢",
    "nijisanji_kr": "NIJISANJI KR", "aogirihs": "あおぎり高校",
}


def get_streams():
    return cached("vmiru", 30, _fetch)


def _as_list(obj):
    if isinstance(obj, list):
        return obj
    if not isinstance(obj, dict):
        return []
    for value in obj.values():
        if isinstance(value, list):
            return value
    return list(obj.values())


def _fetch():
    paths = ["/main/videos.json", "/main/channels.json", "/main/tags.json",
             "/main/twitch/streams.json", "/main/twitch/users.json"]
    with ThreadPoolExecutor(max_workers=len(paths)) as pool:
        videos, channels, tags, tw_streams, tw_users = pool.map(
            lambda path: get_json(CDN + path, timeout=12), paths)
    videos, channels = _as_list(videos), _as_list(channels)
    tw_streams, tw_users = _as_list(tw_streams), _as_list(tw_users)
    channel_by_id = {channel.get("id"): channel for channel in channels}
    user_by_id = {user.get("id"): user for user in tw_users}
    raw_tags = tags.get("channelTags", []) if isinstance(tags, dict) else []
    channel_tags = {tag.get("channelId"): tag.get("tag") for tag in raw_tags if isinstance(tag, dict)}
    out = []
    for video in videos:
        if not (video.get("actualStartTimeMs") and not video.get("actualEndTimeMs")):
            continue
        channel_id = video.get("channelId")
        channel, agency = channel_by_id.get(channel_id, {}), channel_tags.get(channel_id)
        out.append({
            "title": video.get("title"), "url": "https://www.youtube.com/watch?v=" + video.get("id", ""),
            "channel": channel.get("title") or "", "channel-thumbnail": channel.get("thumbnailImgUrl"),
            "viewers": video.get("concurrentViewers"), "thumbnail-url": video.get("thumbnailImgUrl"),
            "site": "youtube", "agency": agency, "agency-label": AGENCY_LABELS.get(agency, agency),
        })
    for stream in tw_streams:
        user = user_by_id.get(stream.get("userId"), {})
        login = user.get("login")
        if not login:
            continue
        agency = channel_tags.get(stream.get("userId")) or channel_tags.get(user.get("id"))
        thumbnail = (stream.get("thumbnailUrl") or "").replace("{width}", "320").replace("{height}", "180")
        out.append({
            "title": stream.get("title"), "url": "https://www.twitch.tv/" + login,
            "channel": user.get("displayName") or login, "channel-thumbnail": user.get("profileImageUrl"),
            "viewers": stream.get("viewerCount"), "thumbnail-url": thumbnail,
            "site": "twitch", "agency": agency, "agency-label": AGENCY_LABELS.get(agency, agency),
        })
    out.sort(key=lambda item: item.get("viewers") or 0, reverse=True)
    return out
