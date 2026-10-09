"""Hosted ingress, health probes, and persistent storage integration checks."""

import http.client
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

TOOLS = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(TOOLS))
import serve


class Deployment(unittest.TestCase):
    def setUp(self):
        class QuietHandler(serve.Handler):
            def log_message(self, *args):
                pass

        self.server = serve.Server(("127.0.0.1", 0), QuietHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.origin = patch.dict(os.environ, {"PUBLIC_ORIGIN": ""})
        self.origin.start()

    def tearDown(self):
        self.origin.stop()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def request(self, method, path, origin=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port)
        headers = {"Host": "itinder.example.com", "Content-Type": "application/json"}
        if origin is not None:
            headers["Origin"] = origin
        connection.request(method, path, body="{}" if method == "POST" else None, headers=headers)
        response = connection.getresponse()
        result = response.status, response.read()
        connection.close()
        return result

    def test_health_probes_accept_get_and_head(self):
        status, body = self.request("GET", "/healthz")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {"status": "ok"})
        self.assertEqual(self.request("HEAD", "/healthz"), (200, b""))

    def test_https_ingress_accepts_own_origin_and_rejects_foreign_page(self):
        self.assertEqual(self.request("POST", "/api/login", "https://itinder.example.com")[0], 400)
        for origin in ("https://evil.example.com", "null", "https://itinder.example.com/", "https://itinder.example.com@evil.example.com"):
            self.assertEqual(self.request("POST", "/api/login", origin)[0], 403)
        with patch.dict(os.environ, {"PUBLIC_ORIGIN": "https://custom.example.com"}):
            self.assertEqual(self.request("POST", "/api/login", "https://custom.example.com")[0], 400)
            self.assertEqual(self.request("POST", "/api/login", "https://itinder.example.com")[0], 403)

    def test_portfolio_deep_link_uses_spa_but_missing_assets_stay_404(self):
        with tempfile.TemporaryDirectory() as folder:
            build = Path(folder)
            (build / "index.html").write_text("<html>portfolio</html>", encoding="utf-8")
            with patch.dict(serve.MOUNTS, {"/os/": build}):
                status, body = self.request("GET", "/os/experience/ozon")
                self.assertEqual(status, 200)
                self.assertIn(b"portfolio", body)
                self.assertEqual(self.request("GET", "/os/missing.js")[0], 404)

    def test_external_data_directory_survives_process_restart(self):
        with tempfile.TemporaryDirectory() as folder:
            environment = {**os.environ, "APP_DATA_DIR": folder, "PYTHONPATH": str(TOOLS)}
            setup = (
                "from data_paths import initialize_data; initialize_data(); "
                "from users import create_user; create_user('deployment@example.com', 'test-password')"
            )
            subprocess.run([sys.executable, "-c", setup], check=True, env=environment, capture_output=True)
            self.assertEqual(len(list((Path(folder) / "users").glob("*.json"))), 1)
            login = (
                "from users import authenticate; "
                "assert authenticate('deployment@example.com', 'test-password')['email'] == 'deployment@example.com'"
            )
            subprocess.run([sys.executable, "-c", login], check=True, env=environment, capture_output=True)
            check_paths = (
                "from pathlib import Path; import os, users, specializations, user_names, grade_tests, fsp, "
                "invitations, projects, ranking, seed_applicants; "
                "root=Path(os.environ['APP_DATA_DIR']); "
                "paths=[users.USERS_DIR,specializations.SPECIALIZATIONS_DIR,user_names.USER_NAMES_DIR,"
                "grade_tests.TESTS_DIR,fsp.USER_FSP_DIR,invitations.INVITATIONS_DIR,projects.COMPANIES_DIR,"
                "projects.PROJECTS_DIR,projects.VACANCIES_DIR,projects.USER_FSP_DIR,projects.USER_BLOCKS_DIR,"
                "ranking.USER_FSP_DIR,ranking.USER_BLOCKS_DIR,seed_applicants.NAMES_DIR,seed_applicants.BLOCKS_DIR]; "
                "assert all(path.parent == root for path in paths)"
            )
            subprocess.run([sys.executable, "-c", check_paths], check=True, env=environment, capture_output=True)


if __name__ == "__main__":
    unittest.main()
