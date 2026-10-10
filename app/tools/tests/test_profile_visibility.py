"""Тумблер видимости профиля (окно «PDF-профиль») и его действие на окно
«Соискатели» рекрутёра; рабочая app/db не меняется.

Запуск: python app/tools/tests/test_profile_visibility.py
"""

import http.client
import json
import sys
import threading
import unittest
import uuid
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import applicant_search
import candidate_profile
import invitations
import profile_visibility
import projects
import ranking
import serve
import test_projects
import test_test_projects as fixtures
import vacancy_search
from users import UserError


class ProfileVisibility(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.TestGeneration()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.recruiter = self.fixture.recruiter
        generated = test_projects.generate(self.recruiter)
        self.project_id = generated["project_ids"][0]
        self.vacancies = [projects._load(projects._vacancy_path(vid)) for vid in generated["vacancy_ids"]]
        self.uid = self.fixture.candidates["Backend"]
        self.vacancy = next(v for v in self.vacancies
                            if v["specialization"] == "Backend" and v["project_id"] == self.project_id)
        self.block = ranking.USER_BLOCKS_DIR / f"{self.uid}.json"

    def found(self):
        """Где окно «Соискатели» показывает соискателя: поиск, вакансия, граф команды."""
        places = set()
        for specialization, grade in ((None, None), ("Backend", None), ("Backend", "Middle")):
            result = applicant_search.search(self.recruiter, specialization, grade)
            if self.uid in {c["user_id"] for c in result["candidates"] + result["unconfirmed"]}:
                places.add(f"search:{specialization}:{grade}")
        result = applicant_search.vacancy(self.recruiter, self.vacancy["id"])
        if self.uid in {c["user_id"] for c in result["candidates"] + result["unconfirmed"]}:
            places.add("vacancy")
        team = applicant_search.team(self.recruiter, self.project_id)
        if self.uid in {c["user_id"] for v in team["vacancies"] for c in v["candidates"]}:
            places.add("team")
        return places

    def test_toggle_writes_seed_format_file_and_removes_it(self):
        self.assertEqual(profile_visibility.state(self.uid), {"hidden": False, "hidden_at": None})
        result = profile_visibility.update(self.uid, True)
        record = json.loads(self.block.read_text(encoding="utf-8"))
        self.assertEqual(set(record), {"user_id", "created_at"})
        self.assertEqual(record["user_id"], self.uid)
        self.assertIsNotNone(datetime.fromisoformat(record["created_at"]).tzinfo)
        self.assertEqual(result, {"hidden": True, "hidden_at": record["created_at"]})
        self.assertEqual(profile_visibility.state(self.uid), result)
        self.assertEqual(list(self.block.parent.glob(".*")), [])  # временный файл не остался

        before = self.block.read_bytes()
        self.assertEqual(profile_visibility.update(self.uid, True), result)
        self.assertEqual(self.block.read_bytes(), before)

        self.assertEqual(profile_visibility.update(self.uid, False), {"hidden": False, "hidden_at": None})
        self.assertFalse(self.block.exists())
        self.assertEqual(profile_visibility.update(self.uid, False), {"hidden": False, "hidden_at": None})

    def test_hidden_applicant_disappears_from_recruiter_window_and_returns(self):
        visible = {"search:None:None", "search:Backend:None", "search:Backend:Middle", "vacancy", "team"}
        self.assertEqual(self.found(), visible)
        profile_visibility.update(self.uid, True)
        self.assertEqual(self.found(), set())
        self.assertNotIn(self.uid, {a["user_id"] for a in ranking.applicants()})
        with self.assertRaises(UserError):
            applicant_search.invite(self.recruiter, self.vacancy["id"], self.uid, "search")
        with self.assertRaises(UserError) as raised:
            candidate_profile.profile(self.recruiter, self.uid)
        self.assertEqual(raised.exception.status, 404)
        self.assertEqual(invitations.records(), [])
        # Соискатель по-прежнему видит вакансии.
        self.assertIn(self.vacancy["id"], {v["id"] for v in vacancy_search.listing(self.uid)["vacancies"]})

        profile_visibility.update(self.uid, False)
        self.assertEqual(self.found(), visible)
        self.assertEqual(applicant_search.invite(self.recruiter, self.vacancy["id"], self.uid, "search")["status"], "sent")

    def test_seeded_or_broken_block_file_counts_as_hidden(self):
        fixtures.write(self.block, {"user_id": self.uid, "created_at": "2026-08-18T08:44:04.713471+00:00"})
        self.assertEqual(profile_visibility.state(self.uid),
                         {"hidden": True, "hidden_at": "2026-08-18T08:44:04.713471+00:00"})
        self.block.write_text("broken", encoding="utf-8")
        self.assertEqual(profile_visibility.state(self.uid), {"hidden": True, "hidden_at": None})
        self.assertEqual(self.found(), set())
        profile_visibility.update(self.uid, False)
        self.assertFalse(self.block.exists())

    def test_invalid_requests_do_not_write(self):
        before = self.fixture._snapshot()
        for uid, hidden, status in ((None, True, 400), ("../private", True, 400), (str(uuid.uuid4()), True, 404),
                                    (self.uid, "true", 400), (self.uid, None, 400), (self.uid, 1, 400)):
            with self.subTest(uid=uid, hidden=hidden), self.assertRaises(UserError) as raised:
                profile_visibility.update(uid, hidden)
            self.assertEqual(raised.exception.status, status)
        for uid, status in ((None, 400), (str(uuid.uuid4()), 404)):
            with self.subTest(uid=uid), self.assertRaises(UserError) as raised:
                profile_visibility.state(uid)
            self.assertEqual(raised.exception.status, status)
        self.assertEqual(before, self.fixture._snapshot())
        self.assertEqual(list(ranking.USER_BLOCKS_DIR.iterdir()), [])

    def test_http_toggle_and_foreign_origin(self):
        server = serve.Server(("127.0.0.1", 0), serve.Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        def call(method, body=None, origin=None):
            connection = http.client.HTTPConnection("127.0.0.1", server.server_port)
            headers = {"Content-Type": "application/json"}
            if origin:
                headers["Origin"] = origin
            path = "/api/applicant/visibility" + (f"?user_id={self.uid}" if method == "GET" else "")
            connection.request(method, path, body=body and json.dumps(body), headers=headers)
            response = connection.getresponse()
            data = json.loads(response.read())
            connection.close()
            return response.status, data

        try:
            self.assertEqual(call("GET"), (200, {"hidden": False, "hidden_at": None}))
            self.assertEqual(call("POST", {"user_id": self.uid, "hidden": True}, origin="https://evil.example")[0], 403)
            self.assertFalse(self.block.exists())
            status, data = call("POST", {"user_id": self.uid, "hidden": True})
            self.assertEqual((status, data["hidden"]), (200, True))
            self.assertTrue(self.block.is_file())
            self.assertEqual(call("GET"), (200, data))
            self.assertEqual(self.found(), set())
            self.assertEqual(call("POST", {"user_id": self.uid, "hidden": False}), (200, {"hidden": False, "hidden_at": None}))
            self.assertFalse(self.block.exists())
        finally:
            server.shutdown(); server.server_close(); thread.join()


if __name__ == "__main__":
    unittest.main()
