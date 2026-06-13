"""Vercel serverless function: ぶいみる(vmiru.tv) の配信中ストリームを JSON で返す。
ルート: /api/vmiru-streams

vmiru.tv は Next.js + Firebase の SPA で、配信データを CloudFront 上の JSON
(/main/videos.json, /main/channels.json, /main/tags.json, /main/twitch/*) から取得して描画している。
配信中の判定: YouTube は actualStartTimeMs あり & actualEndTimeMs なし。Twitch は streams.json に載っているもの。
"""
from http.server import BaseHTTPRequestHandler
import urllib.request
import json

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                  '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Accept': 'application/json',
}

CDN = 'https://d3t40075vqz7f2.cloudfront.net'

AGENCY_LABELS = {
    'nijisanji': 'にじさんじ', 'hololive': 'ホロライブ', 'vspo': 'ぶいすぽっ！',
    '774inc': '774inc', 'noripro': 'のりプロ', 'hololive_en': 'hololive EN',
    'hololive_id': 'hololive ID', 'nijisanji_en': 'NIJISANJI EN', 'holostars': 'ホロスターズ',
    'neoporte': 'ネオポルテ', 'dotlive': '.LIVE', 'independent': '個人勢',
    'nijisanji_kr': 'NIJISANJI KR', 'aogirihs': 'あおぎり高校',
}


def _json_get(path):
    req = urllib.request.Request(CDN + path, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=25) as res:
        return json.loads(res.read().decode('utf-8', 'replace'))


def _as_list(obj):
    if isinstance(obj, list):
        return obj
    for v in obj.values():
        if isinstance(v, list):
            return v
    return list(obj.values())


def fetch_vmiru():
    videos = _as_list(_json_get('/main/videos.json'))
    channels = _as_list(_json_get('/main/channels.json'))
    tags = _json_get('/main/tags.json')
    tw_streams = _as_list(_json_get('/main/twitch/streams.json'))
    tw_users = _as_list(_json_get('/main/twitch/users.json'))

    ch_by_id = {c.get('id'): c for c in channels}
    tw_user_by_id = {u.get('id'): u for u in tw_users}
    # channelTags: [{channelId, tag}] → {channelId: tag}
    raw_tags = tags.get('channelTags', []) if isinstance(tags, dict) else []
    channel_tags = {t.get('channelId'): t.get('tag') for t in raw_tags if isinstance(t, dict)}

    def agency_of(cid):
        return channel_tags.get(cid)

    out = []
    for v in videos:
        if not (v.get('actualStartTimeMs') and not v.get('actualEndTimeMs')):
            continue
        cid = v.get('channelId')
        ch = ch_by_id.get(cid, {})
        ag = agency_of(cid)
        out.append({
            'title': v.get('title'),
            'url': 'https://www.youtube.com/watch?v=' + v.get('id', ''),
            'channel': ch.get('title') or '',
            'channel-thumbnail': ch.get('thumbnailImgUrl'),
            'viewers': v.get('concurrentViewers'),
            'thumbnail-url': v.get('thumbnailImgUrl'),
            'site': 'youtube',
            'agency': ag,
            'agency-label': AGENCY_LABELS.get(ag, ag),
        })

    for s in tw_streams:
        u = tw_user_by_id.get(s.get('userId'), {})
        login = u.get('login')
        if not login:
            continue
        ag = agency_of(s.get('userId')) or agency_of(u.get('id'))
        thumb = (s.get('thumbnailUrl') or '').replace('{width}', '320').replace('{height}', '180')
        out.append({
            'title': s.get('title'),
            'url': 'https://www.twitch.tv/' + login,
            'channel': u.get('displayName') or login,
            'channel-thumbnail': u.get('profileImageUrl'),
            'viewers': s.get('viewerCount'),
            'thumbnail-url': thumb,
            'site': 'twitch',
            'agency': ag,
            'agency-label': AGENCY_LABELS.get(ag, ag),
        })

    out.sort(key=lambda x: x.get('viewers') or 0, reverse=True)
    return out


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            self._json(200, {'streams': fetch_vmiru()})
        except Exception as e:
            self._json(500, {'error': str(e)})

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Cache-Control', 'no-store, max-age=0')
        self.end_headers()
        self.wfile.write(body)
