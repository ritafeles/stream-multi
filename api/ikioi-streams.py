"""Vercel serverless function: ikioi-ranking.com の検索結果(配信)を JSON で返す。
ルート: /api/ikioi-streams?keyword=Vtuber
"""
from http.server import BaseHTTPRequestHandler
import urllib.request
import urllib.parse
import html as html_mod
import json
import re

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                  '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'ja,en;q=0.5',
}


def fetch_ikioi(keyword):
    """検索結果ページを解析して配信リストを返す"""
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


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            qs = urllib.parse.urlparse(self.path).query
            params = urllib.parse.parse_qs(qs)
            keyword = (params.get('keyword') or ['Vtuber'])[0]
            streams = fetch_ikioi(keyword)
            self._json(200, {'keyword': keyword, 'streams': streams})
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
