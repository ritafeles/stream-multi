import io
import json
import unittest
from unittest.mock import patch

import server
from stream_sources import api
from stream_sources.errors import SourceError


class FakeHandler:
    def __init__(self, path):
        self.path = path
        self.status = None
        self.headers = {}
        self.wfile = io.BytesIO()

    def send_response(self, code):
        self.status = code

    def send_header(self, name, value):
        self.headers[name] = value

    def end_headers(self):
        pass


class ServerTests(unittest.TestCase):
    def test_only_frontend_files_are_public(self):
        for path in ["/", "/index.html", "/assets/app.js"]:
            self.assertTrue(server.is_public(path), path)
        for path in ["/.git/config", "/server.py", "/tests/test_server.py",
                     "/assets/../.git/config", "/assets/%2e%2e/server.py"]:
            self.assertFalse(server.is_public(path), path)

    def test_api_error_keeps_user_facing_message(self):
        handler = FakeHandler("/api/vmiru-streams")
        error = SourceError("UPSTREAM_UNAVAILABLE", "接続できませんでした")
        with patch.dict(api.ROUTES, {"/api/vmiru-streams": (lambda q: (_ for _ in ()).throw(error), 30)}):
            self.assertTrue(api.handle_api(handler, "/api/vmiru-streams"))
        self.assertEqual(handler.status, 502)
        self.assertEqual(handler.headers["Cache-Control"], "no-store")
        body = json.loads(handler.wfile.getvalue())
        self.assertEqual(body["error"]["message"], "接続できませんでした")

    def test_unknown_path_is_not_api(self):
        self.assertFalse(api.handle_api(FakeHandler("/nope"), "/nope"))


if __name__ == "__main__":
    unittest.main()
