"""Изолированные проверки обратной связи; рабочая app/db не меняется."""

import concurrent.futures
import copy
import json
import sys
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import applicant_invitations
import invitations
import project_news
import projects
import ranking
import serve
import specializations
import test_feedback
import test_projects
import test_test_projects as fixtures
import users


class TestFeedback(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.TestGeneration()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.user = self.fixture.recruiter
        generated = test_projects.generate(self.user)
        self.project_ids = generated["project_ids"]
        self.vacancies = [projects._load(projects._vacancy_path(vid)) for vid in generated["vacancy_ids"]]
        self.plain = next(v for v in self.vacancies if not v["assignments"])
        self.assignment = next(v for v in self.vacancies if v["assignments"])
        self.seeded = {}
        for role in self.fixture.candidates:
            self.seeded[role] = []
            for _ in range(12):
                user_id = str(uuid.uuid4())
                fixtures.write(users.USERS_DIR / f"{user_id}.json", {
                    "id": user_id, "email": f"{user_id}@example.invalid", "seed": test_feedback.SEED_MARK,
                })
                specializations.write(user_id, role, "Middle", {"type": "Manual"})
                self.seeded[role].append(user_id)

    def save(self, record):
        path = invitations.INVITATIONS_DIR / f"{record['id']}.json"
        fixtures.write(path, record)
        return path

    def invite(self, vacancy, applicant=None, state="sent"):
        applicant = applicant or self.seeded[vacancy["specialization"]][0]
        created = invitations.create(self.user, vacancy["id"], applicant, "search")
        record = projects._load(invitations.INVITATIONS_DIR / f"{created['id']}.json")
        if state != "sent":
            record["status_history"].append({"status": state, "at": "2026-10-09T10:00:00+00:00"})
            self.save(record)
        return record

    def keep_only(self, vacancy):
        for other in self.vacancies:
            if other["id"] != vacancy["id"]:
                projects._vacancy_path(other["id"]).unlink()

    def test_generation_uses_existing_seed_users_and_populates_all_news(self):
        before = self.fixture._snapshot()
        code, result, _ = serve.api_test_feedback(json.dumps({"user_id": self.user}).encode())
        self.assertEqual(code, 201)
        self.assertEqual({key: result[key] for key in (
            "created_applications", "accepted_invitations", "submitted_assignments", "forwarded_assignments",
            "created_invitations", "updated_invitations",
        )}, dict(created_applications=8, accepted_invitations=6, submitted_assignments=2,
                forwarded_assignments=1, created_invitations=16, updated_invitations=0))
        records = invitations.records()
        self.assertEqual(len(records), len(result["invitation_ids"]))
        seed_ids = {uid for group in self.seeded.values() for uid in group}
        pairs, states = set(), set()
        by_id = {vacancy["id"]: vacancy for vacancy in self.vacancies}
        for record in records:
            self.assertIn(record["applicant_id"], seed_ids)
            self.assertEqual(record["recruiter_id"], self.user)
            vacancy = by_id[record["vacancy_id"]]
            self.assertEqual(record["project_id"], vacancy["project_id"])
            self.assertEqual(record["vacancy"], {k: v for k, v in vacancy.items() if k not in invitations.VACANCY_SKIP})
            self.assertTrue(applicant_invitations._valid(record))
            pair = record["vacancy_id"], record["applicant_id"]
            self.assertNotIn(pair, pairs)
            pairs.add(pair)
            state = invitations.status(record)
            states.add(state)
            if state in ("task_sent_for_review", "task_needs_review"):
                self.assertEqual(len(record["assignment_answers"]), len(vacancy["assignments"]))
                self.assertTrue(all("Тестовое решение" in answer for answer in record["assignment_answers"]))
            self.assertEqual(record["test_feedback"]["version"], 1)
        self.assertEqual(states, {"sent", "accepted", "task_sent_for_review", "task_needs_review"})
        totals = {key: sum(news[key] for news in project_news.summaries(self.user).values()) for key in project_news.KINDS}
        self.assertEqual(totals, dict(new_applications=8, accepted_invitations=6, assignments_to_review=2))
        self.assertEqual(sum(test_feedback.availability(self.user).values()), 2)
        for path, content in before.items():
            self.assertEqual(path.read_bytes(), content)

    def test_deleted_filled_unlinked_and_foreign_vacancies_are_excluded(self):
        deleted, filled, unlinked = self.vacancies[:3]
        projects._vacancy_path(deleted["id"]).unlink()
        self.invite(filled, state="accepted")
        project = projects._load(projects._project_path(unlinked["project_id"]))
        project["vacancy_ids"].remove(unlinked["id"])
        fixtures.write(projects._project_path(project["id"]), project)
        foreign = test_projects.generate(self.fixture.another)
        before = self.fixture._snapshot()
        self.assertEqual(sum(test_feedback.availability(self.user).values()), 5)
        _, listed, _ = serve.api_projects_list({"user_id": self.user})
        self.assertEqual(sum(p["valid_vacancies"] for p in listed["projects"]), 5)
        self.assertEqual(before, self.fixture._snapshot())
        result = test_feedback.generate(self.user)
        excluded = {deleted["id"], filled["id"], unlinked["id"], *foreign["vacancy_ids"]}
        affected = {r["vacancy_id"] for r in invitations.records() if r["id"] in result["invitation_ids"]}
        self.assertTrue(excluded.isdisjoint(affected))
        self.assertEqual(result["created_applications"], 5)
        for path, content in before.items():
            self.assertEqual(path.read_bytes(), content)

    def test_completed_project_and_blocked_vacancy_still_meet_user_definition(self):
        self.keep_only(self.plain)
        projects.set_completed(self.user, self.plain["project_id"], True)
        vacancy = copy.deepcopy(self.plain)
        vacancy["status"] = "blocked"
        fixtures.write(projects._vacancy_path(vacancy["id"]), vacancy)
        self.assertEqual(test_feedback.availability(self.user), {vacancy["project_id"]: 1})
        result = test_feedback.generate(self.user)
        self.assertEqual((result["created_applications"], result["accepted_invitations"]), (1, 1))

    def test_pending_seed_invitation_is_answered_preserving_snapshot_and_history(self):
        pending = self.invite(self.assignment)
        pending["vacancy"]["assignments"] = ["Условия на момент отправки"]
        pending["applicant_seen"] = applicant_invitations._seen_marker(pending)
        self.save(pending)
        ordinary = self.invite(self.plain, self.fixture.candidates[self.plain["specialization"]], "read")
        ordinary_path = invitations.INVITATIONS_DIR / f"{ordinary['id']}.json"
        original_bytes = ordinary_path.read_bytes()
        before = self.fixture._snapshot()
        result = test_feedback.generate(self.user)
        self.assertEqual(result["updated_invitations"], 1)
        saved = projects._load(invitations.INVITATIONS_DIR / f"{pending['id']}.json")
        self.assertEqual(saved["vacancy"], pending["vacancy"])
        self.assertEqual(saved["status_history"][:len(pending["status_history"])], pending["status_history"])
        self.assertIn("Условия на момент отправки", saved["assignment_answers"][0])
        self.assertEqual(ordinary_path.read_bytes(), original_bytes)
        for path, content in before.items():
            if path.stem != pending["id"]:
                self.assertEqual(path.read_bytes(), content)

    def test_repeated_and_concurrent_requests_add_new_pairs_without_over_hiring(self):
        first = test_feedback.generate(self.user)
        before = self.fixture._snapshot()
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            repeated = list(executor.map(test_feedback.generate, [self.user] * 2))
        for result in repeated:
            self.assertEqual((result["created_applications"], result["accepted_invitations"],
                              result["submitted_assignments"]), (2, 0, 2))
            self.assertTrue(set(first["invitation_ids"]).isdisjoint(result["invitation_ids"]))
        records = invitations.records()
        self.assertEqual(len(records), len({(r["vacancy_id"], r["applicant_id"]) for r in records}))
        counts = invitations.vacancy_counts(records)
        self.assertTrue(all(counts[v["id"]]["accepted"] <= v["count"] for v in self.vacancies))
        for path, content in before.items():
            self.assertEqual(path.read_bytes(), content)

    def test_partially_hired_vacancy_closes_at_capacity_and_button_availability_disappears(self):
        self.keep_only(self.plain)
        vacancy = copy.deepcopy(self.plain)
        vacancy["count"] = 2
        fixtures.write(projects._vacancy_path(vacancy["id"]), vacancy)
        self.invite(vacancy, state="accepted")
        self.assertEqual(sum(test_feedback.availability(self.user).values()), 1)
        self.assertEqual(test_feedback.generate(self.user)["accepted_invitations"], 1)
        self.assertEqual(test_feedback.availability(self.user), {})
        _, listed, _ = serve.api_projects_list({"user_id": self.user})
        self.assertTrue(all(p["valid_vacancies"] == 0 for p in listed["projects"]))
        before = self.fixture._snapshot()
        with self.assertRaises(users.UserError) as raised:
            test_feedback.generate(self.user)
        self.assertEqual(raised.exception.status, 409)
        self.assertEqual(before, self.fixture._snapshot())

    def test_only_unblocked_seed_users_of_matching_specialization_are_used(self):
        self.keep_only(self.plain)
        role = self.plain["specialization"]
        blocked, missing = self.seeded[role][:2]
        fixtures.write(ranking.USER_BLOCKS_DIR / f"{blocked}.json", {"user_id": blocked})
        (users.USERS_DIR / f"{missing}.json").unlink()
        test_feedback.generate(self.user)
        used = {r["applicant_id"] for r in invitations.records()}
        self.assertEqual(len(used), 2)
        self.assertTrue(used <= set(self.seeded[role][2:]))

    def test_exhausted_or_absent_seed_users_and_non_recruiter_do_not_write(self):
        self.keep_only(self.assignment)
        role = self.assignment["specialization"]
        for candidate in self.seeded[role]:
            self.invite(self.assignment, candidate, "declined")
        before = self.fixture._snapshot()
        with self.assertRaises(users.UserError) as raised:
            test_feedback.generate(self.user)
        self.assertEqual(raised.exception.status, 409)
        self.assertEqual(before, self.fixture._snapshot())
        for user_id in (self.fixture.non_recruiter, self.fixture.another):
            with self.assertRaises(users.UserError):
                test_feedback.generate(user_id)
            self.assertEqual(before, self.fixture._snapshot())
        with patch.object(ranking, "applicants", return_value=[]):
            with self.assertRaises(users.UserError) as raised:
                test_feedback.generate(self.user)
            self.assertEqual(raised.exception.status, 409)
            self.assertEqual(before, self.fixture._snapshot())

    def test_write_failure_rolls_back_created_files_and_exact_pending_invitation_bytes(self):
        for vacancy in self.vacancies[:2]:
            self.invite(vacancy)
        before = self.fixture._snapshot()
        original_write = invitations._write
        writes = 0

        def fail_after_write(path, record):
            nonlocal writes
            original_write(path, record)
            writes += 1
            if writes == 2:
                raise OSError("Simulated write failure")

        with patch.object(invitations, "_write", side_effect=fail_after_write):
            with self.assertRaises(OSError):
                test_feedback.generate(self.user)
        self.assertEqual(writes, 2)
        self.assertEqual(before, self.fixture._snapshot())
        self.assertEqual(list(invitations.INVITATIONS_DIR.glob("*.tmp")), [])

    def test_uuid_collision_never_overwrites_existing_invitation(self):
        existing = self.invite(self.plain)
        before = self.fixture._snapshot()
        with patch.object(test_feedback.uuid, "uuid4", return_value=uuid.UUID(existing["id"])):
            with self.assertRaises(FileExistsError):
                test_feedback.generate(self.user)
        self.assertEqual(before, self.fixture._snapshot())

    def test_malformed_record_and_duplicate_vacancy_link_do_not_break_or_overhire(self):
        self.keep_only(self.plain)
        project = projects._load(projects._project_path(self.plain["project_id"]))
        project["vacancy_ids"].append(self.plain["id"])
        fixtures.write(projects._project_path(project["id"]), project)
        record = self.invite(self.plain)
        record["applicant_id"] = []
        self.save(record)
        result = test_feedback.generate(self.user)
        self.assertEqual((result["created_applications"], result["accepted_invitations"]), (1, 1))
        self.assertEqual(test_feedback.availability(self.user), {})


if __name__ == "__main__":
    unittest.main(verbosity=2)
