"""Vercel serverless function: nijisanji.jp の ON AIR 配信を JSON で返す。
ルート: /api/nijisanji-streams
"""
from http.server import BaseHTTPRequestHandler
import urllib.request
import json

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                  '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'Accept-Language': 'ja,en;q=0.5',
}


def _fetch_streams(day_offset):
    """/api/streams?day_offset=N を取得し、フロント用に正規化したリストを返す"""
    url = f'https://www.nijisanji.jp/api/streams?day_offset={day_offset}'
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=15) as res:
        data = json.loads(res.read().decode('utf-8'))

    channels = {}
    for item in data.get('included', []):
        if item.get('type') == 'youtube_channel':
            channels[item['id']] = item.get('attributes', {})

    out = []
    for ev in data.get('data', []):
        attr = ev.get('attributes', {})
        ch_ref = ev.get('relationships', {}).get('youtube_channel', {}).get('data') or {}
        ch = channels.get(ch_ref.get('id'), {})
        out.append({
            'title': attr.get('title'),
            'url': attr.get('url'),
            'thumbnail-url': attr.get('thumbnail_url'),
            'fallback-thumbnail-url': attr.get('fallback_thumbnail_url'),
            'start-at': attr.get('start_at'),
            'status': attr.get('status'),
            'youtube-channel': {
                'name': ch.get('name'),
                'thumbnail-url': ch.get('thumbnail_url'),
            },
        })
    return out


def get_on_air():
    # 前日(-1)と今日(0)を取得し ON AIR のみ抽出（日付をまたいで継続中の配信を拾う）
    streams = _fetch_streams(-1) + _fetch_streams(0)
    on_air, seen = [], set()
    for s in streams:
        if s.get('status') != 'on_air':
            continue
        if s.get('url') in seen:
            continue
        seen.add(s.get('url'))
        on_air.append(s)
    # 配信開始が新しい順（降順）
    on_air.sort(key=lambda s: s.get('start-at') or '', reverse=True)
    return on_air


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            on_air = get_on_air()
            self._json(200, {'days': [{'label': '🔴 ON AIR', 'streams': on_air}]})
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
