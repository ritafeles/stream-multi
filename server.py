#!/usr/bin/env python3
"""
ローカル開発サーバー
- 静的ファイルを http://localhost:8080 で配信
- /api/nijisanji-streams  → nijisanji.jp の ON AIR 配信を JSON で返す
"""
import http.server
import socketserver
import urllib.request
import json
import re
import os

PORT = 8080
DIRECTORY = os.path.dirname(os.path.abspath(__file__))
HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                  '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'ja,en;q=0.5',
}


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def do_GET(self):
        if self.path == '/api/nijisanji-streams':
            self.handle_nijisanji()
        else:
            super().do_GET()

    def handle_nijisanji(self):
        try:
            # 前日(day_offset=-1)と今日(day_offset=0)を取得し ON AIR のみ抽出
            # ※前日分は日付をまたいで継続中の配信を拾うため
            streams = self._fetch_streams(-1) + self._fetch_streams(0)
            on_air, seen = [], set()
            for s in streams:
                if s.get('status') != 'on_air':
                    continue
                if s.get('url') in seen:
                    continue
                seen.add(s.get('url'))
                on_air.append(s)
            on_air.sort(key=lambda s: s.get('start-at') or '')

            self._json_ok({
                'days': [
                    {'label': '🔴 ON AIR', 'streams': on_air},
                ]
            })
        except Exception as e:
            self._json_error(500, str(e))

    def _fetch_streams(self, day_offset):
        """/api/streams?day_offset=N を取得し、フロント用に正規化したリストを返す"""
        url = f'https://www.nijisanji.jp/api/streams?day_offset={day_offset}'
        req = urllib.request.Request(url, headers={**HEADERS, 'Accept': 'application/json'})
        with urllib.request.urlopen(req, timeout=15) as res:
            data = json.loads(res.read().decode('utf-8'))

        # included の youtube_channel を id で引けるようにする
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
        # 開始時刻順
        out.sort(key=lambda s: s.get('start-at') or '')
        return out

    def _json_ok(self, obj):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(body)

    def _json_error(self, code, msg):
        body = json.dumps({'error': msg}, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        # 静的ファイルは常に最新を取得させる（ブラウザキャッシュ無効化）
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
        super().end_headers()

    def log_message(self, fmt, *args):
        print(fmt % args)


class ThreadingHTTPServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == '__main__':
    with ThreadingHTTPServer(('', PORT), Handler) as httpd:
        print(f'http://localhost:{PORT} で起動中 (Ctrl+C で停止)')
        httpd.serve_forever()
