import unittest
from unittest.mock import patch

from stream_sources import ikioi, nijisanji, vmiru, youtube_live
from stream_sources.errors import SourceError


class SourceTests(unittest.TestCase):
    @patch("stream_sources.ikioi.get_text")
    def test_ikioi_parses_stream(self, get_text):
        get_text.return_value = ('<div id="livebox"><div class="live_maintitle">'
            '<a href="https://youtube.com/watch?v=abc" title="Title"></a></div>'
            '<div class="live_name"><a href="#">Channel</a></div>'
            '<div class="live_viewer"><span>1,234</span></div></div>')
        result = ikioi._fetch("Vtuber")
        self.assertEqual(result[0]["viewers"], 1234)
        self.assertEqual(result[0]["channel"], "Channel")

    @patch("stream_sources.nijisanji.get_json")
    def test_nijisanji_normalizes_current_format(self, get_json):
        get_json.return_value = [{"title": "Live", "url": "url", "status": "on_air",
                                  "channel": {"name": "Channel"}}]
        result = nijisanji._fetch_streams(0)
        self.assertEqual(result[0]["youtube-channel"]["name"], "Channel")

    def test_vmiru_as_list_handles_invalid_data(self):
        self.assertEqual(vmiru._as_list(None), [])

    @patch("stream_sources.youtube_live.get_text")
    def test_youtube_live_resolves_handle(self, get_text):
        get_text.return_value = ('<link rel="canonical" href="https://www.youtube.com/watch?v=dQw4w9WgXcQ">'
                                 '<meta property="og:title" content="Live &amp; Chat">')
        result = youtube_live.get_live_video("@resolve_test")
        self.assertEqual(result, {"videoId": "dQw4w9WgXcQ", "title": "Live & Chat"})
        self.assertEqual(get_text.call_args[0][0], "https://www.youtube.com/@resolve_test/live")

    @patch("stream_sources.youtube_live.get_text")
    def test_youtube_live_not_live(self, get_text):
        get_text.return_value = '<link rel="canonical" href="https://www.youtube.com/@offline_test">'
        with self.assertRaises(SourceError) as ctx:
            youtube_live.get_live_video("@offline_test")
        self.assertEqual(ctx.exception.status, 404)

    def test_youtube_live_rejects_invalid_channel(self):
        with self.assertRaises(SourceError) as ctx:
            youtube_live.get_live_video("../../etc")
        self.assertEqual(ctx.exception.status, 400)


if __name__ == "__main__":
    unittest.main()
