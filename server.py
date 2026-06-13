#!/usr/bin/env python3
"""
ローカル開発サーバー
- 静的ファイルを http://localhost:8080 で配信
- /api/nijisanji-streams       → nijisanji.jp の ON AIR 配信を JSON で返す
- /api/ikioi-streams?keyword=X → ikioi-ranking.com の検索結果(配信)を JSON で返す
"""
import http.server
import socketserver
import urllib.request
import urllib.parse
import html as html_mod
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
        elif self.path.startswith('/api/ikioi-streams'):
            self.handle_ikioi()
        elif self.path.startswith('/api/vmiru-streams'):
            self.handle_vmiru()
        else:
            super().do_GET()

    def handle_vmiru(self):
        try:
            self._json_ok({'streams': fetch_vmiru()})
        except Exception as e:
            self._json_error(500, str(e))

    def handle_ikioi(self):
        try:
            qs = urllib.parse.urlparse(self.path).query
            params = urllib.parse.parse_qs(qs)
            keyword = (params.get('keyword') or ['Vtuber'])[0]
            streams = self._fetch_ikioi(keyword)
            self._json_ok({'keyword': keyword, 'streams': streams})
        except Exception as e:
            self._json_error(500, str(e))

    def _fetch_ikioi(self, keyword):
        """ikioi-ranking.com の検索結果ページを解析して配信リストを返す"""
        url = 'https://ikioi-ranking.com/?keyword=' + urllib.parse.quote(keyword)
        req = urllib.request.Request(url, headers=HEADERS)
        with urllib.request.urlopen(req, timeout=20) as res:
            page = res.read().decode('utf-8', 'replace')

        out, seen = [], set()
        # 各配信は <div id="livebox" ...> ブロック。これで分割して個別に解析する
        for block in page.split('<div id="livebox"')[1:]:
            m = re.search(r'class="live_maintitle"><a href="([^"]+)"[^>]*title="([^"]*)"', block)
            if not m:
                continue
            stream_url = html_mod.unescape(m.group(1))
            title = html_mod.unescape(m.group(2)).strip()
            if not stream_url or stream_url in seen:
                continue
            seen.add(stream_url)

            cm = re.search(r'class="live_name">.*?<a [^>]*>([^<]*)</a>', block, re.S)
            channel = html_mod.unescape(cm.group(1)).strip() if cm else ''

            vm = re.search(r'class="live_viewer[^"]*"[^>]*>.*?<span>([\d,]+)</span>', block, re.S)
            viewers = int(vm.group(1).replace(',', '')) if vm else None

            tm = re.search(r'class="live_movieImg2"><a [^>]*src="([^"]+)"', block)
            thumb = html_mod.unescape(tm.group(1)) if tm else ''

            site = 'twitch' if 'twitch.tv' in stream_url else 'youtube'

            out.append({
                'title': title,
                'url': stream_url,
                'channel': channel,
                'viewers': viewers,
                'thumbnail-url': thumb,
                'site': site,
            })
        return out

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
            # 配信開始が新しい順（降順）
            on_air.sort(key=lambda s: s.get('start-at') or '', reverse=True)

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


# ===== vmiru (ぶいみる) =====
# データは Next.js + Firebase の SPA が CloudFront 上の JSON を取得して描画している。
# 配信中の判定: YouTube は actualStartTimeMs あり & actualEndTimeMs なし、Twitch は streams.json に載っているもの。
VMIRU_CDN = 'https://d3t40075vqz7f2.cloudfront.net'

# 事務所キー → 表示名
VMIRU_AGENCY_LABELS = {
    'nijisanji': 'にじさんじ', 'hololive': 'ホロライブ', 'vspo': 'ぶいすぽっ！',
    '774inc': '774inc', 'noripro': 'のりプロ', 'hololive_en': 'hololive EN',
    'hololive_id': 'hololive ID', 'nijisanji_en': 'NIJISANJI EN', 'holostars': 'ホロスターズ',
    'neoporte': 'ネオポルテ', 'dotlive': '.LIVE', 'independent': '個人勢',
    'nijisanji_kr': 'NIJISANJI KR', 'aogirihs': 'あおぎり高校',
}


def _vmiru_json(path):
    req = urllib.request.Request(VMIRU_CDN + path, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=25) as res:
        return json.loads(res.read().decode('utf-8', 'replace'))


def _vmiru_list(obj):
    """{key: [...]} 形式・リスト形式の両対応で配列を取り出す"""
    if isinstance(obj, list):
        return obj
    for v in obj.values():
        if isinstance(v, list):
            return v
    return list(obj.values())


def fetch_vmiru():
    videos = _vmiru_list(_vmiru_json('/main/videos.json'))
    channels = _vmiru_list(_vmiru_json('/main/channels.json'))
    tags = _vmiru_json('/main/tags.json')
    tw_streams = _vmiru_list(_vmiru_json('/main/twitch/streams.json'))
    tw_users = _vmiru_list(_vmiru_json('/main/twitch/users.json'))

    ch_by_id = {c.get('id'): c for c in channels}
    tw_user_by_id = {u.get('id'): u for u in tw_users}
    # channelTags: [{channelId, tag}] → {channelId: tag}
    raw_tags = tags.get('channelTags', []) if isinstance(tags, dict) else []
    channel_tags = {t.get('channelId'): t.get('tag') for t in raw_tags if isinstance(t, dict)}

    def agency_of(cid):
        return channel_tags.get(cid)

    out = []
    # YouTube: 配信中のみ
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
            'agency-label': VMIRU_AGENCY_LABELS.get(ag, ag),
        })

    # Twitch: streams.json は配信中のみ
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
            'agency-label': VMIRU_AGENCY_LABELS.get(ag, ag),
        })

    out.sort(key=lambda x: x.get('viewers') or 0, reverse=True)
    return out


class ThreadingHTTPServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == '__main__':
    with ThreadingHTTPServer(('', PORT), Handler) as httpd:
        print(f'http://localhost:{PORT} で起動中 (Ctrl+C で停止)')
        httpd.serve_forever()
