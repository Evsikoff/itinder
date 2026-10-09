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
import data_paths
import serve


class SeedDataInitialization(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.static = Path(self.folder.name) / "image-db"
        self.persistent = Path(self.folder.name) / "data"
        for name in data_paths.MUTABLE_NAMES:
            (self.static / name).mkdir(parents=True)
            (self.static / name / "seed.json").write_text('{"source":"local"}', encoding="utf-8")
        self.static_patch = patch.object(data_paths, "STATIC_DB", self.static)
        self.data_patch = patch.object(data_paths, "DATA_DB", self.persistent)
        self.static_patch.start()
        self.data_patch.start()
        self.addCleanup(self.static_patch.stop)
        self.addCleanup(self.data_patch.stop)
        self.ledger = self.persistent / data_paths.SEED_LEDGER_NAME

    def test_imports_all_mutable_json_records_and_preserves_server_records(self):
        (self.static / "static-catalog.json").write_text("{}", encoding="utf-8")
        for name in data_paths.MUTABLE_NAMES:
            directory = self.persistent / name
            directory.mkdir(parents=True)
            (directory / "seed.json").write_text('{"source":"server"}', encoding="utf-8")
            (directory / "remote.json").write_text('{"source":"remote"}', encoding="utf-8")
            (self.static / name / "additional.json").write_text('{"source":"local"}', encoding="utf-8")
            (self.static / name / "ignored.txt").write_text("ignore", encoding="utf-8")

        data_paths.initialize_data()

        for name in data_paths.MUTABLE_NAMES:
            directory = self.persistent / name
            self.assertEqual(json.loads((directory / "seed.json").read_text())['source'], "server")
            self.assertEqual(json.loads((directory / "remote.json").read_text())['source'], "remote")
            self.assertEqual(json.loads((directory / "additional.json").read_text())['source'], "local")
            self.assertFalse((directory / "ignored.txt").exists())
        self.assertFalse((self.persistent / "static-catalog.json").exists())
        self.assertEqual(
            set(json.loads(self.ledger.read_text())["imported"]),
            {f"{name}/{file}" for name in data_paths.MUTABLE_NAMES for file in ("seed.json", "additional.json")},
        )

    def test_restarts_preserve_deletions_and_import_new_seed_records(self):
        data_paths.initialize_data()
        for name in data_paths.MUTABLE_NAMES:
            (self.persistent / name / "seed.json").unlink()
            (self.static / name / "seed.json").write_text('{"source":"updated"}', encoding="utf-8")
            (self.static / name / "new.json").write_text('{"source":"new"}', encoding="utf-8")

        data_paths.initialize_data()
        data_paths.initialize_data()

        for name in data_paths.MUTABLE_NAMES:
            self.assertFalse((self.persistent / name / "seed.json").exists())
            self.assertEqual(json.loads((self.persistent / name / "new.json").read_text())['source'], "new")

    def test_failed_copy_aborts_without_publishing_partial_records(self):
        def failed_copy(original, destination):
            destination.write(b"partial")
            raise OSError("Simulated copy failure")

        with patch.object(data_paths.shutil, "copyfileobj", side_effect=failed_copy):
            with self.assertRaises(OSError):
                data_paths.initialize_data()
        self.assertFalse(self.ledger.exists())
        self.assertEqual(list(self.persistent.rglob("*.*")), [])

        data_paths.initialize_data()
        for name in data_paths.MUTABLE_NAMES:
            self.assertEqual(json.loads((self.persistent / name / "seed.json").read_text())['source'], "local")

    def test_failed_ledger_save_preserves_previous_ledger_and_retries_safely(self):
        data_paths.initialize_data()
        previous = self.ledger.read_bytes()
        (self.static / "users" / "new.json").write_text('{"source":"new"}', encoding="utf-8")
        with patch.object(data_paths.os, "replace", side_effect=OSError("Simulated ledger failure")):
            with self.assertRaises(OSError):
                data_paths.initialize_data()
        self.assertEqual(self.ledger.read_bytes(), previous)
        self.assertEqual(sorted(path.name for path in self.persistent.iterdir() if path.is_file()), [self.ledger.name])

        record = self.persistent / "users" / "new.json"
        record.write_text('{"source":"server"}', encoding="utf-8")
        data_paths.initialize_data()
        self.assertEqual(json.loads(record.read_text())['source'], "server")
        self.assertIn("users/new.json", json.loads(self.ledger.read_text())["imported"])

    def test_corrupt_ledger_aborts_instead_of_reimporting_deleted_records(self):
        data_paths.initialize_data()
        record = self.persistent / "users" / "seed.json"
        record.unlink()
        for invalid in ("invalid json", '{"version":2,"imported":[]}', '{"version":1,"imported":[123]}'):
            with self.subTest(invalid=invalid):
                self.ledger.write_text(invalid, encoding="utf-8")
                with self.assertRaises(ValueError):
                    data_paths.initialize_data()
                self.assertFalse(record.exists())


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
                "import data_paths; data_paths.STATIC_DB=data_paths.DATA_DB/'empty-seeds'; "
                "data_paths.initialize_data(); "
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
