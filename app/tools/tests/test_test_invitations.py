"""Изолированные проверки генератора приглашений; реальная app/db не меняется.

Запуск: python app/tools/tests/test_test_invitations.py
"""

import concurrent.futures
import json
import sys
import tempfile
import unittest
import uuid
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import applicant_invitations
import invitations
import projects
import ranking
import specializations
import test_invitations
import user_names
import users


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")


class TestInvitationGeneration(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="ittinder-test-invitations-")
        self.addCleanup(temporary.cleanup)
        self.db = Path(temporary.name)
        for module in (invitations, projects, ranking, specializations, users, user_names):
            for name, value in list(vars(module).items()):
                if name.endswith("_DIR") and isinstance(value, Path):
                    target = self.db / value.name
                    replacement = patch.object(module, name, target)
                    replacement.start()
                    self.addCleanup(replacement.stop)
        self.user, self.other, self.real_recruiter = (str(uuid.uuid4()) for _ in range(3))
        for user_id in (self.user, self.other, self.real_recruiter):
            write(users.USERS_DIR / f"{user_id}.json", {"id": user_id, "email": f"{user_id}@example.invalid"})

    def records(self, result):
        return [json.loads((invitations.INVITATIONS_DIR / f"{record_id}.json").read_text(encoding="utf-8"))
                for record_id in result["invitation_ids"]]

    def snapshot(self):
        return {path: path.read_bytes() for path in self.db.rglob("*") if path.is_file()}

    def existing(self):
        """Реальные данные в изолированной БД, которые генератор обязан сохранить."""
        vacancy_id, project_id = str(uuid.uuid4()), str(uuid.uuid4())
        write(projects.PROJECTS_DIR / f"{project_id}.json",
              {"id": project_id, "user_id": self.real_recruiter, "vacancy_ids": [vacancy_id]})
        write(projects.VACANCIES_DIR / f"{vacancy_id}.json",
              {"id": vacancy_id, "project_id": project_id, "user_id": self.real_recruiter, "count": 1})
        record = {
            "id": str(uuid.uuid4()), "type": invitations.RECRUITER_TO_APPLICANT,
            "applicant_id": self.other, "recruiter_id": self.real_recruiter,
            "project_id": project_id, "vacancy_id": vacancy_id,
            "vacancy": {"title": "Настоящая вакансия", "assignments": []}, "flow": "plain",
            "status_history": [{"status": "sent", "at": "2026-10-01T10:00:00+00:00"}],
            "created_at": "2026-10-01T10:00:00+00:00",
        }
        write(invitations.INVITATIONS_DIR / f"{record['id']}.json", record)
        return record

    def test_exact_twenty_all_type_flow_status_combinations_owned_by_user(self):
        result = test_invitations.generate(self.user)
        self.assertEqual(result["created_invitations"], 20)
        self.assertEqual(len(result["invitation_ids"]), 20)
        self.assertEqual(len(set(result["invitation_ids"])), 20)
        records = self.records(result)
        expected = Counter((type, flow, status) for type in invitations.TYPES
                           for flow, statuses in invitations.FLOWS.items() for status in statuses)
        self.assertEqual(Counter((r["type"], r["flow"], invitations.status(r)) for r in records), expected)
        self.assertEqual(Counter(r["type"] for r in records), {type: 10 for type in invitations.TYPES})
        self.assertEqual({r["applicant_id"] for r in records}, {self.user})
        views = applicant_invitations.list_for_user(self.user)["invitations"]
        self.assertEqual(len(views), 20)
        self.assertEqual(applicant_invitations.list_for_user(self.other)["invitations"], [])
        self.assertTrue(all(view["unseen"] for view in views))
        self.assertTrue(all(view["recruiter_name"].endswith("(тест)") for view in views))
        self.assertEqual({r["test_generation"]["version"] for r in records}, {1})
        self.assertEqual(len({r["test_generation"]["batch_id"] for r in records}), 1)
        self.assertEqual(len({r["test_generation"]["scenario"] for r in records}), 20)

    def test_histories_are_complete_with_strict_utc_chronology_and_matching_solutions(self):
        result = test_invitations.generate(self.user)
        assignment_counts = set()
        for record in self.records(result):
            with self.subTest(scenario=record["test_generation"]["scenario"]):
                flow, status = record["flow"], invitations.status(record)
                history = record["status_history"]
                self.assertEqual(tuple(row["status"] for row in history), test_invitations.HISTORIES[flow][status])
                steps = [row["status"] for row in history]
                self.assertEqual(steps[0], "sent")
                self.assertEqual(steps[-1], status)
                allowed = ({("sent", "read"), ("read", "accepted"), ("read", "declined")}
                           if flow == "plain" else {
                               ("sent", "declined"), ("sent", "task_sent_for_review"),
                               ("task_sent_for_review", "task_needs_review"),
                               ("task_needs_review", "accepted"), ("task_needs_review", "solution_rejected"),
                           })
                self.assertTrue(all(transition in allowed for transition in zip(steps, steps[1:])))
                dates = [datetime.fromisoformat(row["at"]) for row in history]
                self.assertTrue(all(date.utcoffset().total_seconds() == 0 for date in dates))
                self.assertTrue(all(first < second for first, second in zip(dates, dates[1:])))
                self.assertTrue(all(date <= datetime.now(timezone.utc) for date in dates))
                self.assertEqual(record["created_at"], history[0]["at"])
                if flow == "assignment":
                    assignment_counts.add(len(record["vacancy"]["assignments"]))
                    if "task_sent_for_review" in tuple(row["status"] for row in history):
                        self.assertEqual(len(record["assignment_answers"]), len(record["vacancy"]["assignments"]))
                        self.assertTrue(all("\n" in answer and answer.strip() for answer in record["assignment_answers"]))
                    else:
                        self.assertNotIn("assignment_answers", record)
                else:
                    self.assertEqual(record["vacancy"]["assignments"], [])
                    self.assertNotIn("assignment_answers", record)
        self.assertEqual(assignment_counts, {1, 2, 3})

    def test_valid_diverse_snapshots_are_self_contained_and_do_not_close_real_vacancies(self):
        real = self.existing()
        before = self.snapshot()
        result = test_invitations.generate(self.user)
        records = self.records(result)
        catalog = projects.Catalog()
        for record in records:
            vacancy = record["vacancy"]
            self.assertTrue(applicant_invitations._valid(record))
            self.assertTrue(projects._vacancy(vacancy, catalog, approve=True))
            self.assertTrue(vacancy["title"].startswith("[Тест] "))
            self.assertEqual(vacancy["id"], record["vacancy_id"])
            self.assertEqual(vacancy["project_id"], record["project_id"])
            self.assertNotEqual(record["vacancy_id"], real["vacancy_id"])
            self.assertNotEqual(record["project_id"], real["project_id"])
            self.assertNotIn(record["recruiter_id"], (self.user, self.other, self.real_recruiter))
            self.assertEqual(vacancy["salary"]["currency"], "RUB")
            self.assertTrue(vacancy["requirements"])
            self.assertTrue(vacancy["task"])
            self.assertTrue(vacancy["company"]["name"])
            self.assertTrue(vacancy["project"]["summary"])
            self.assertTrue(record["test_generation"]["recruiter_name"])
        self.assertEqual({r["vacancy"]["specialization"] for r in records}, {role["specialization"] for role in catalog.roles.values()})
        self.assertEqual({r["vacancy"]["grade"] for r in records}, {"Junior", "Middle", "Senior"})
        for path, original in before.items():
            self.assertEqual(path.read_bytes(), original)
        after = self.snapshot()
        added = set(after) - set(before)
        self.assertEqual(len(added), 20)
        self.assertTrue(all(path.parent == invitations.INVITATIONS_DIR for path in added))
        self.assertFalse(invitations.is_closed({"id": real["vacancy_id"], "count": 1},
                                               invitations.vacancy_counts(invitations.records())))

    def test_repeated_and_concurrent_generations_add_fresh_packages_without_overwriting(self):
        self.existing()
        before = self.snapshot()
        first = test_invitations.generate(self.user)
        first_files = self.snapshot()
        second = test_invitations.generate(self.user)
        self.assertEqual(second["created_invitations"], 20)
        self.assertTrue(set(first["invitation_ids"]).isdisjoint(second["invitation_ids"]))
        self.assertTrue({r["test_generation"]["batch_id"] for r in self.records(first)}.isdisjoint(
            {r["test_generation"]["batch_id"] for r in self.records(second)}))
        for path, original in first_files.items():
            self.assertEqual(path.read_bytes(), original)
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
            concurrent_results = list(executor.map(test_invitations.generate, [self.user] * 3))
        all_ids = first["invitation_ids"] + second["invitation_ids"]
        for result in concurrent_results:
            self.assertEqual(result["created_invitations"], 20)
            all_ids.extend(result["invitation_ids"])
        self.assertEqual(len(all_ids), 100)
        self.assertEqual(len(set(all_ids)), 100)
        self.assertEqual(len(applicant_invitations.list_for_user(self.user)["invitations"]), 100)
        for path, original in before.items():
            self.assertEqual(path.read_bytes(), original)

    def test_failure_during_partial_write_rolls_back_only_this_package(self):
        self.existing()
        earlier = test_invitations.generate(self.user)
        before = self.snapshot()
        original_dump = json.dump
        calls = 0

        def broken_dump(record, file, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 4:
                file.write('{"partial":')
                raise OSError("Simulated write failure")
            return original_dump(record, file, **kwargs)

        with patch.object(test_invitations.json, "dump", side_effect=broken_dump):
            with self.assertRaises(OSError):
                test_invitations.generate(self.user)
        self.assertEqual(calls, 4)
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(len(self.records(earlier)), 20)

    def test_exclusive_filename_collision_preserves_preexisting_file(self):
        self.existing()
        prepared = test_invitations._records(self.user, projects.Catalog(), str(uuid.uuid4()))
        conflicting = prepared[2]
        write(invitations.INVITATIONS_DIR / f"{conflicting['id']}.json", {"do_not_overwrite": True})
        before = self.snapshot()
        with patch.object(test_invitations, "_records", return_value=prepared):
            with self.assertRaises(FileExistsError):
                test_invitations.generate(self.user)
        self.assertEqual(self.snapshot(), before)

    def test_unknown_user_is_rejected_before_any_file_changes(self):
        before = self.snapshot()
        for user_id, expected_status in (("invalid", 400), (str(uuid.uuid4()), 404)):
            with self.subTest(user_id=user_id):
                with self.assertRaises(users.UserError) as raised:
                    test_invitations.generate(user_id)
                self.assertEqual(raised.exception.status, expected_status)
                self.assertEqual(self.snapshot(), before)

    def test_notifications_and_normal_read_response_work_for_generated_sent(self):
        self.assertIsNone(applicant_invitations.alert(self.user))
        result = test_invitations.generate(self.user)
        records = self.records(result)
        self.assertIn("20", applicant_invitations.alert(self.user))
        plain = next(record for record in records if record["type"] == invitations.RECRUITER_TO_APPLICANT
                     and record["flow"] == "plain" and invitations.status(record) == "sent")
        shown = applicant_invitations.read(self.user, plain["id"], 1)
        self.assertEqual(shown["status"], "read")
        accepted = applicant_invitations.respond(self.user, plain["id"], "accept", None, shown["revision"])
        self.assertEqual(accepted["status"], "accepted")
        self.assertEqual([row["status"] for row in accepted["status_history"]], ["sent", "read", "accepted"])
        assignment = next(record for record in records if record["type"] == invitations.RECRUITER_TO_APPLICANT
                          and record["flow"] == "assignment" and invitations.status(record) == "sent")
        shown = applicant_invitations.read(self.user, assignment["id"], 1)
        self.assertEqual(shown["status"], "sent")
        answers = ["Решение\nВторая строка" for _ in shown["vacancy"]["assignments"]]
        submitted = applicant_invitations.respond(self.user, assignment["id"], "accept", answers, shown["revision"])
        self.assertEqual(submitted["status"], "task_sent_for_review")
        self.assertEqual(submitted["assignment_answers"], answers)
        self.assertFalse(submitted["unseen"])
        for record in records:
            if record["id"] in (plain["id"], assignment["id"]):
                continue
            shown = applicant_invitations.read(self.user, record["id"], len(record["status_history"]))
            if record["type"] == invitations.APPLICANT_TO_RECRUITER:
                self.assertEqual(shown["status_history"], record["status_history"])
                self.assertFalse(shown["can_respond"])
                with self.assertRaises(users.UserError) as raised:
                    applicant_invitations.respond(self.user, record["id"], "decline", None, shown["revision"])
                self.assertEqual(raised.exception.status, 403)
        self.assertIsNone(applicant_invitations.alert(self.user))

    def test_demo_recruiter_name_fallback_requires_marker_and_preserves_real_name(self):
        result = test_invitations.generate(self.user)
        record = self.records(result)[0]
        self.assertEqual(applicant_invitations._view(record)["recruiter_name"], record["test_generation"]["recruiter_name"])
        write(user_names.USER_NAMES_DIR / f"{record['recruiter_id']}.json", {"first_name": "Настоящее", "last_name": "Имя"})
        self.assertEqual(applicant_invitations._view(record)["recruiter_name"], "Настоящее Имя")
        record["recruiter_id"] = str(uuid.uuid4())
        del record["test_generation"]
        self.assertIsNone(applicant_invitations._view(record)["recruiter_name"])


if __name__ == "__main__":
    unittest.main()
