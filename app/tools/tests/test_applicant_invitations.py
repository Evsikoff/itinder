"""Изолированные проверки окна соискателя; реальная app/db не меняется.

Запуск: python app/tools/tests/test_applicant_invitations.py
"""

import concurrent.futures
import copy
import json
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import applicant_invitations
import invitations
import ranking
import specializations
from users import UserError


def write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")


class CandidateInvitations(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="ittinder-candidate-invitations-")
        self.addCleanup(temporary.cleanup)
        self.db = Path(temporary.name)
        for module, name, folder in (
            (invitations, "INVITATIONS_DIR", "invitations"),
            (specializations, "USERS_DIR", "users"),
            (ranking, "USER_NAMES_DIR", "user_names"),
        ):
            replacement = patch.object(module, name, self.db / folder)
            replacement.start()
            self.addCleanup(replacement.stop)
        self.candidate, self.other_candidate, self.recruiter = (str(uuid.uuid4()) for _ in range(3))
        for user_id in (self.candidate, self.other_candidate, self.recruiter):
            write(specializations.USERS_DIR / f"{user_id}.json", {"id": user_id})
        write(ranking.USER_NAMES_DIR / f"{self.recruiter}.json",
              {"first_name": "Анна", "last_name": "Петрова"})

    def make(self, *, flow="plain", type=None, status="sent", user_id=None, created_at=None, assignments=None):
        record = {
            "id": str(uuid.uuid4()),
            "type": type or invitations.RECRUITER_TO_APPLICANT,
            "applicant_id": user_id or self.candidate,
            "recruiter_id": self.recruiter,
            "project_id": str(uuid.uuid4()),
            "vacancy_id": str(uuid.uuid4()),
            "created_at": created_at or "2026-10-08T12:00:00+00:00",
            "flow": flow,
            "vacancy": {
                "title": "Backend разработчик",
                "company": {"id": str(uuid.uuid4()), "name": "Тестовая компания"},
                "project": {"name": "Тестовый проект", "summary": "Пример приложения"},
                "grade": "Middle",
                "salary": {"min": 100000, "max": 150000, "currency": "RUB"},
                "requirements": [{"kind": "languages", "ids": [1], "min_degree": 2}],
                "assignments": assignments if assignments is not None else (["Первое задание", "Второе задание"]
                                                                         if flow == "assignment" else []),
                "notes": "Условия вакансии",
            },
            "status_history": [{"status": "sent", "at": "2026-10-08T12:00:00+00:00"}],
            "source": "search",
            "relevance": 98.5,
        }
        if status != "sent":
            record["status_history"].append({"status": status, "at": "2026-10-09T12:00:00+00:00"})
        write(self.path(record), record)
        return record

    def path(self, record):
        return invitations.INVITATIONS_DIR / f"{record['id']}.json"

    def saved(self, record):
        return json.loads(self.path(record).read_text(encoding="utf-8"))

    def assert_error(self, status, function, *args):
        with self.assertRaises(UserError) as raised:
            function(*args)
        self.assertEqual(raised.exception.status, status)

    def test_list_is_pure_sorted_contains_snapshots_and_reference_labels(self):
        old = self.make(created_at="2026-10-08T12:00:00+00:00")
        new = self.make(created_at="2026-10-09T12:00:00+00:00", flow="assignment")
        before = {path: path.read_bytes() for path in invitations.INVITATIONS_DIR.glob("*")}
        result = applicant_invitations.list_for_user(self.candidate)
        self.assertEqual([item["id"] for item in result["invitations"]], [new["id"], old["id"]])
        view = result["invitations"][0]
        self.assertEqual(view["vacancy"], new["vacancy"])
        self.assertEqual(view["recruiter_name"], "Анна Петрова")
        self.assertEqual(view["revision"], 1)
        self.assertIsNone(view["assignment_answers"])
        self.assertTrue(view["can_respond"])
        self.assertTrue(view["unseen"])
        self.assertEqual(result["flows"], invitations.FLOWS)
        self.assertEqual(result["flows"]["plain"]["read"], "Просмотрено")
        self.assertTrue(result["stack"]["languages"])
        self.assertTrue(result["kind_names"])
        self.assertEqual(result["degree_names"][2], "уверенная")
        self.assertEqual(before, {path: path.read_bytes() for path in invitations.INVITATIONS_DIR.glob("*")})
        # API data is independent of the in-memory record and file.
        view["vacancy"]["assignments"].append("Changed client-side")
        self.assertEqual(self.saved(new)["vacancy"], new["vacancy"])

    def test_plain_read_appends_once_and_acknowledges_current_revision(self):
        record = self.make()
        self.assertIsNotNone(applicant_invitations.alert(self.candidate))
        view = applicant_invitations.read(self.candidate, record["id"], 1)
        self.assertEqual(view["status"], "read")
        self.assertEqual(view["revision"], 2)
        self.assertTrue(view["can_respond"])
        self.assertFalse(view["unseen"])
        saved = self.saved(record)
        self.assertEqual(saved["status_history"][:-1], record["status_history"])
        self.assertEqual(saved["applicant_seen"], {**saved["status_history"][-1], "revision": 2})
        self.assertEqual(saved["vacancy"], record["vacancy"])
        self.assertIsNone(applicant_invitations.alert(self.candidate))
        before = self.path(record).read_bytes()
        with patch.object(invitations, "_write") as mocked_write:
            again = applicant_invitations.read(self.candidate, record["id"], 2)
        mocked_write.assert_not_called()
        self.assertEqual(again, view)
        self.assertEqual(self.path(record).read_bytes(), before)
        self.assert_error(409, applicant_invitations.read, self.candidate, record["id"], 1)

    def test_plain_accept_after_view_preserves_snapshot_and_previous_history(self):
        record = self.make()
        shown = applicant_invitations.read(self.candidate, record["id"], 1)
        previous = copy.deepcopy(shown["status_history"])
        view = applicant_invitations.respond(self.candidate, record["id"], "accept", None, 2)
        self.assertEqual([row["status"] for row in view["status_history"]], ["sent", "read", "accepted"])
        self.assertEqual(view["status_history"][:-1], previous)
        self.assertEqual(view["status"], "accepted")
        self.assertFalse(view["can_respond"])
        self.assertFalse(view["unseen"])
        self.assertEqual(self.saved(record)["vacancy"], record["vacancy"])
        self.assertIsNone(applicant_invitations.alert(self.candidate))
        before = self.path(record).read_bytes()
        self.assert_error(409, applicant_invitations.respond, self.candidate, record["id"], "decline", None, 2)
        self.assert_error(409, applicant_invitations.respond, self.candidate, record["id"], "decline", None, 3)
        self.assertEqual(self.path(record).read_bytes(), before)

    def test_plain_accept_or_decline_is_allowed_directly_from_sent(self):
        for action, expected in (("accept", "accepted"), ("decline", "declined")):
            with self.subTest(action=action):
                record = self.make()
                view = applicant_invitations.respond(self.candidate, record["id"], action, None, 1)
                self.assertEqual(view["status"], expected)
                self.assertEqual(len(self.saved(record)["status_history"]), 2)
                self.assertFalse(view["unseen"])

    def test_assignment_view_does_not_add_read_status(self):
        record = self.make(flow="assignment")
        view = applicant_invitations.read(self.candidate, record["id"], 1)
        self.assertEqual(view["status"], "sent")
        self.assertEqual(view["status_history"], record["status_history"])
        self.assertEqual(view["revision"], 1)
        self.assertFalse(view["unseen"])
        self.assertTrue(view["can_respond"])
        self.assertIsNone(applicant_invitations.alert(self.candidate))

    def test_assignment_accept_requires_answers_and_saves_multiline_solutions(self):
        record = self.make(flow="assignment")
        answers = ["Первая строка\nВторая строка", " SELECT *\nFROM example; "]
        result = applicant_invitations.respond(self.candidate, record["id"], "accept", answers, 1)
        self.assertEqual(result["status"], "task_sent_for_review")
        self.assertEqual(result["assignment_answers"], [answer.strip() for answer in answers])
        self.assertFalse(result["can_respond"])
        self.assertFalse(result["unseen"])
        saved = self.saved(record)
        self.assertEqual(saved["status_history"][:-1], record["status_history"])
        self.assertEqual(saved["vacancy"], record["vacancy"])
        self.assertEqual(saved["assignment_answers"], result["assignment_answers"])
        self.assertIsNone(applicant_invitations.alert(self.candidate))

    def test_assignment_answers_validation_is_exact_and_does_not_write(self):
        record = self.make(flow="assignment")
        before = self.path(record).read_bytes()
        for answers in (None, [], "text", ["one"], ["one", "two", "three"],
                        ["one", "   \n "], ["one", 42], ["one", "x" * 5001]):
            with self.subTest(answers=repr(answers)[:60]):
                self.assert_error(400, applicant_invitations.respond,
                                  self.candidate, record["id"], "accept", answers, 1)
                self.assertEqual(self.path(record).read_bytes(), before)
        # The documented maximum is accepted.
        result = applicant_invitations.respond(self.candidate, record["id"], "accept", ["x" * 5000, "two"], 1)
        self.assertEqual(len(result["assignment_answers"][0]), 5000)

    def test_assignment_decline_requires_no_answers(self):
        record = self.make(flow="assignment")
        result = applicant_invitations.respond(self.candidate, record["id"], "decline", None, 1)
        self.assertEqual(result["status"], "declined")
        self.assertIsNone(result["assignment_answers"])
        self.assertEqual(self.saved(record)["status_history"][:-1], record["status_history"])

    def test_all_flow_statuses_display_and_terminal_statuses_cannot_be_answered(self):
        for flow, statuses in invitations.FLOWS.items():
            for status in statuses:
                with self.subTest(flow=flow, status=status):
                    record = self.make(flow=flow, status=status)
                    result = applicant_invitations.read(self.candidate, record["id"], len(record["status_history"]))
                    self.assertEqual(result["can_respond"], status in ("sent", "read"))
                    if status not in ("sent", "read"):
                        self.assert_error(409, applicant_invitations.respond, self.candidate, record["id"],
                                          "accept", ["one", "two"], result["revision"])
                    self.assertEqual(self.saved(record)["vacancy"], record["vacancy"])
        self.assertEqual(len(applicant_invitations.list_for_user(self.candidate)["invitations"]),
                         sum(map(len, invitations.FLOWS.values())))

    def test_outgoing_is_read_only_for_canonical_type_and_alias(self):
        for type in (invitations.APPLICANT_TO_RECRUITER, applicant_invitations.OUTGOING_ALIAS):
            for flow in invitations.FLOWS:
                with self.subTest(type=type, flow=flow):
                    record = self.make(type=type, flow=flow)
                    shown = applicant_invitations.read(self.candidate, record["id"], 1)
                    self.assertEqual(shown["status"], "sent")
                    self.assertFalse(shown["can_respond"])
                    self.assertFalse(shown["unseen"])
                    self.assertEqual(shown["type"], invitations.APPLICANT_TO_RECRUITER)
                    saved = self.saved(record)
                    self.assertEqual(saved["type"], type)
                    self.assertEqual(saved["status_history"], record["status_history"])
                    before = self.path(record).read_bytes()
                    for action in ("accept", "decline"):
                        self.assert_error(403, applicant_invitations.respond, self.candidate, record["id"],
                                          action, ["one", "two"], 1)
                    self.assertEqual(before, self.path(record).read_bytes())

    def test_legacy_missing_type_defaults_incoming_without_rewriting_type(self):
        record = self.make()
        del record["type"]
        write(self.path(record), record)
        shown = applicant_invitations.read(self.candidate, record["id"], 1)
        self.assertEqual(shown["type"], invitations.RECRUITER_TO_APPLICANT)
        self.assertNotIn("type", self.saved(record))

    def test_alerts_reappear_after_external_status_change_and_new_invitation(self):
        record = self.make(flow="assignment")
        applicant_invitations.read(self.candidate, record["id"], 1)
        self.assertIsNone(applicant_invitations.alert(self.candidate))
        external = self.saved(record)
        external["status_history"].append({"status": "task_needs_review", "at": "2026-10-09T15:00:00+00:00"})
        write(self.path(record), external)
        self.assertIsNotNone(applicant_invitations.alert(self.candidate))
        self.assertTrue(applicant_invitations.list_for_user(self.candidate)["invitations"][0]["unseen"])
        before = self.path(record).read_bytes()
        self.assert_error(409, applicant_invitations.read, self.candidate, record["id"], 1)
        self.assertEqual(before, self.path(record).read_bytes())
        applicant_invitations.read(self.candidate, record["id"], 2)
        self.assertIsNone(applicant_invitations.alert(self.candidate))
        another = self.make()
        self.assertIsNotNone(applicant_invitations.alert(self.candidate))
        applicant_invitations.read(self.candidate, another["id"], 1)
        self.assertIsNone(applicant_invitations.alert(self.candidate))

    def test_notification_marker_matches_revision_status_and_timestamp(self):
        record = self.make(flow="assignment")
        applicant_invitations.read(self.candidate, record["id"], 1)
        external = self.saved(record)
        external["status_history"][-1]["at"] = "2026-10-09T15:00:00+00:00"
        write(self.path(record), external)
        self.assertIsNotNone(applicant_invitations.alert(self.candidate))

    def test_foreign_records_are_invisible_and_cannot_be_read_or_changed(self):
        own = self.make()
        foreign = self.make(user_id=self.other_candidate)
        self.assertEqual([row["id"] for row in applicant_invitations.list_for_user(self.candidate)["invitations"]],
                         [own["id"]])
        before = self.path(foreign).read_bytes()
        self.assert_error(404, applicant_invitations.read, self.candidate, foreign["id"], 1)
        self.assert_error(404, applicant_invitations.respond, self.candidate, foreign["id"], "accept", None, 1)
        self.assertEqual(before, self.path(foreign).read_bytes())
        applicant_invitations.read(self.candidate, own["id"], 1)
        self.assertIsNone(applicant_invitations.alert(self.candidate))
        self.assertIsNotNone(applicant_invitations.alert(self.other_candidate))

    def test_invalid_record_ids_user_ids_revisions_and_actions_do_not_write(self):
        record = self.make()
        before = self.path(record).read_bytes()
        for invitation_id in ("../users/example", None, str(uuid.uuid4())):
            self.assert_error(404, applicant_invitations.read, self.candidate, invitation_id, 1)
        for revision in (None, True, "1", 0, -1, 1.0):
            self.assert_error(400, applicant_invitations.read, self.candidate, record["id"], revision)
        self.assert_error(400, applicant_invitations.respond, self.candidate, record["id"], "remove", None, 1)
        self.assert_error(404, applicant_invitations.list_for_user, str(uuid.uuid4()))
        self.assert_error(400, applicant_invitations.list_for_user, "invalid")
        self.assertEqual(before, self.path(record).read_bytes())

    def test_concurrent_responses_commit_one_transition(self):
        record = self.make()

        def respond(action):
            try:
                return applicant_invitations.respond(self.candidate, record["id"], action, None, 1)
            except UserError as error:
                return error.status

        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(respond, ["accept", "decline"] * 4))
        self.assertEqual(sum(isinstance(result, dict) for result in results), 1)
        self.assertEqual(results.count(409), 7)
        saved = self.saved(record)
        self.assertEqual(len(saved["status_history"]), 2)
        self.assertIn(saved["status_history"][-1]["status"], ("accepted", "declined"))
        self.assertEqual(saved["status_history"][0], record["status_history"][0])

    def test_concurrent_reads_of_plain_sent_commit_one_read_transition(self):
        record = self.make()

        def read(_):
            try:
                return applicant_invitations.read(self.candidate, record["id"], 1)
            except UserError as error:
                return error.status

        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(read, range(8)))
        self.assertEqual(sum(isinstance(result, dict) for result in results), 1)
        self.assertEqual(results.count(409), 7)
        self.assertEqual([row["status"] for row in self.saved(record)["status_history"]], ["sent", "read"])

    def test_atomic_replace_failure_preserves_original_and_cleans_temporary(self):
        record = self.make()
        before = self.path(record).read_bytes()
        with patch.object(invitations.os, "replace", side_effect=OSError("Simulated disk failure")):
            with self.assertRaises(OSError):
                applicant_invitations.read(self.candidate, record["id"], 1)
        self.assertEqual(before, self.path(record).read_bytes())
        self.assertEqual(list(invitations.INVITATIONS_DIR.glob("*.tmp")), [])
        self.assertEqual(list(invitations.INVITATIONS_DIR.iterdir()), [self.path(record)])

    def test_malformed_records_are_skipped_without_hiding_valid_records(self):
        record = self.make()
        malformed = [None, [], {"applicant_id": self.candidate},
                     {**record, "id": str(uuid.uuid4()), "flow": []},
                     {**record, "id": str(uuid.uuid4()), "status_history": []},
                     {**record, "id": str(uuid.uuid4()), "created_at": 123},
                     {**record, "id": str(uuid.uuid4()), "status_history": [{"status": [], "at": "today"}]},
                     {**record, "id": str(uuid.uuid4()), "status_history": [{"status": "invalid", "at": "today"}]}]
        for data in malformed:
            write(invitations.INVITATIONS_DIR / f"{uuid.uuid4()}.json", data)
        (invitations.INVITATIONS_DIR / "broken.json").write_text("{not JSON", encoding="utf-8")
        listed = applicant_invitations.list_for_user(self.candidate)["invitations"]
        self.assertEqual([row["id"] for row in listed], [record["id"]])
        self.assertIsNotNone(applicant_invitations.alert(self.candidate))

    def test_optional_empty_snapshot_arrays_are_normalized_without_writing(self):
        record = self.make()
        record["vacancy"].pop("assignments")
        record["vacancy"]["requirements"] = None
        write(self.path(record), record)
        before = self.path(record).read_bytes()
        view = applicant_invitations.list_for_user(self.candidate)["invitations"][0]
        self.assertEqual(view["vacancy"]["assignments"], [])
        self.assertEqual(view["vacancy"]["requirements"], [])
        self.assertEqual(before, self.path(record).read_bytes())

    def test_corrupt_snapshot_fields_are_skipped_without_crashing_the_list(self):
        valid = self.make()
        corrupt_fields = [
            {"assignments": "Task"}, {"assignments": [{"text": "Task"}]},
            {"requirements": {}}, {"requirements": [None]},
            {"requirements": [{"kind": "languages", "ids": None}]},
            {"requirements": [{"kind": {}, "ids": ["python"]}]},
            {"requirements": [{"kind": "languages", "ids": [{}]}]},
            {"task": {}}, {"title": []}, {"project": {"summary": {}}},
        ]
        corrupt = []
        for fields in corrupt_fields:
            record = self.make()
            record["vacancy"].update(fields)
            write(self.path(record), record)
            corrupt.append(record)
        bad_answers = self.make()
        bad_answers["assignment_answers"] = [{}]
        write(self.path(bad_answers), bad_answers)
        corrupt.append(bad_answers)
        listed = applicant_invitations.list_for_user(self.candidate)["invitations"]
        self.assertEqual([record["id"] for record in listed], [valid["id"]])
        for record in corrupt:
            self.assert_error(404, applicant_invitations.read, self.candidate, record["id"], 1)

    def test_snapshot_tasks_must_match_the_status_flow(self):
        valid = self.make()
        plain_with_tasks = self.make(flow="plain", assignments=["Task"])
        tasks_missing = self.make(flow="assignment", assignments=[])
        listed = applicant_invitations.list_for_user(self.candidate)["invitations"]
        self.assertEqual([record["id"] for record in listed], [valid["id"]])
        for record in (plain_with_tasks, tasks_missing):
            self.assert_error(404, applicant_invitations.respond, self.candidate, record["id"], "accept", ["Answer"], 1)


if __name__ == "__main__":
    unittest.main()
