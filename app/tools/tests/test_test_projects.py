"""Изолированные проверки генератора; реальная app/db не меняется.

Запуск: python app/tools/tests/test_test_projects.py
"""

import concurrent.futures
import json
import sys
import tempfile
import threading
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import applicant_search
import grade_tests
import invitations
import projects
import ranking
import specializations
import test_projects
import user_names
import users


def write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")


class TestGeneration(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="ittinder-generator-")
        self.addCleanup(temporary.cleanup)
        self.db = Path(temporary.name)
        for module in (projects, ranking, specializations, grade_tests, invitations, users, user_names):
            for name, value in list(vars(module).items()):
                if name.endswith("_DIR") and isinstance(value, Path):
                    target = self.db / value.name
                    target.mkdir(exist_ok=True)
                    replacement = patch.object(module, name, target)
                    replacement.start()
                    self.addCleanup(replacement.stop)
        self.recruiter, self.another, self.non_recruiter = (str(uuid.uuid4()) for _ in range(3))
        self.candidates = {role: str(uuid.uuid4()) for role in grade_tests.SPECIALIZATIONS}
        for user_id in [self.recruiter, self.another, self.non_recruiter, *self.candidates.values()]:
            write(users.USERS_DIR / f"{user_id}.json", {"id": user_id, "email": f"{user_id}@example.invalid"})
        for user_id in (self.recruiter, self.another):
            specializations.write(user_id, "Recruiter", "Middle", {"type": "Manual"})
        for role, user_id in self.candidates.items():
            specializations.write(user_id, role, "Middle", {"type": "Manual"})

    def _snapshot(self):
        return {path: path.read_bytes() for path in self.db.rglob("*.json")}

    def _interrupted_draft(self, user_id):
        with patch.object(projects, "approve", side_effect=users.UserError("Simulated failure")):
            with self.assertRaises(users.UserError):
                test_projects.generate(user_id)
        drafts = [p for p in projects._read_dir(projects.PROJECTS_DIR) if p["user_id"] == user_id]
        self.assertEqual(len(drafts), 1)
        self.assertIsNone(drafts[0]["approved_at"])
        return drafts[0]

    def test_generated_vacancies_are_valid_and_open(self):
        first = test_projects.generate(self.recruiter)
        self.assertEqual((first["created_projects"], first["created_vacancies"]), (2, 8))
        self.assertEqual(len(set(first["project_ids"])), 2)
        self.assertEqual(len(set(first["vacancy_ids"])), 8)
        specializations_found = set()
        expected_assignments = {
            ("store", "qa", "Junior"): [
                "Составьте пять проверок оформления заказа, включая граничные и негативные случаи."
            ],
            ("analytics", "backend_main", "Senior"): [
                "Опишите, как обработать повторную доставку события и восстановить обработку после сбоя."
            ],
        }
        saved_assignments, without_assignments = {}, 0
        for project_id in first["project_ids"]:
            project = projects._load(projects._project_path(project_id))
            self.assertEqual(project["user_id"], self.recruiter)
            self.assertTrue(project["approved_at"])
            self.assertFalse(project["completed_at"])
            self.assertEqual(project["questionnaire"]["id"], projects.Catalog().questionnaire["id"])
            for vacancy in projects._approved_vacancies(project):
                self.assertEqual(vacancy["project_id"], project_id)
                self.assertEqual(vacancy["user_id"], self.recruiter)
                self.assertEqual(vacancy["status"], "ready")
                self.assertFalse(vacancy["open_questions"])
                self.assertTrue(projects._vacancy(vacancy, projects.Catalog(), approve=True))
                specializations_found.add(vacancy["specialization"])
                assignment_key = (project["summary"][test_projects.MARKER]["template"],
                                  vacancy["position"], vacancy["grade"])
                self.assertEqual(vacancy["assignments"], expected_assignments.get(assignment_key, []))
                if vacancy["assignments"]:
                    saved_assignments[assignment_key] = vacancy["assignments"]
                else:
                    without_assignments += 1
        self.assertEqual(specializations_found, set(grade_tests.SPECIALIZATIONS))
        self.assertEqual(saved_assignments, expected_assignments)
        self.assertEqual(without_assignments, 6)
        self.assertEqual(sum(v["open"] for p in applicant_search.overview(self.recruiter)["projects"]
                             for v in p["vacancies"]), 8)

    def test_repeated_requests_add_projects_and_preserve_existing_records(self):
        first = test_projects.generate(self.recruiter)
        before = self._snapshot()
        second = test_projects.generate(self.recruiter)
        self.assertEqual((second["created_projects"], second["created_vacancies"]), (2, 8))
        self.assertTrue(set(first["project_ids"]).isdisjoint(second["project_ids"]))
        self.assertTrue(set(first["vacancy_ids"]).isdisjoint(second["vacancy_ids"]))
        for path, content in before.items():
            self.assertEqual(path.read_bytes(), content)
        self.assertEqual(len(projects.list_projects(self.recruiter)["projects"]), 4)
        self.assertEqual(sum(v["open"] for p in applicant_search.overview(self.recruiter)["projects"]
                             for v in p["vacancies"]), 16)

    def test_concurrent_requests_each_add_a_separate_batch(self):
        first = test_projects.generate(self.recruiter)
        before = self._snapshot()
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
            repeated = list(executor.map(test_projects.generate, [self.recruiter] * 8))
        project_ids, vacancy_ids = set(first["project_ids"]), set(first["vacancy_ids"])
        for result in repeated:
            self.assertEqual((result["created_projects"], result["created_vacancies"]), (2, 8))
            self.assertEqual(len(set(result["project_ids"])), 2)
            self.assertEqual(len(set(result["vacancy_ids"])), 8)
            self.assertTrue(project_ids.isdisjoint(result["project_ids"]))
            self.assertTrue(vacancy_ids.isdisjoint(result["vacancy_ids"]))
            project_ids.update(result["project_ids"])
            vacancy_ids.update(result["vacancy_ids"])
        for path, content in before.items():
            self.assertEqual(path.read_bytes(), content)
        self.assertEqual(len(projects.list_projects(self.recruiter)["projects"]), 18)
        self.assertEqual(sum(v["open"] for p in applicant_search.overview(self.recruiter)["projects"]
                             for v in p["vacancies"]), 72)

    def test_non_recruiter_is_rejected_before_writing(self):
        before = self._snapshot()
        with self.assertRaises(users.UserError) as raised:
            test_projects.generate(self.non_recruiter)
        self.assertEqual(raised.exception.status, 403)
        self.assertEqual(before, self._snapshot())

    def test_invitations_work_and_generation_preserves_closed_and_open_vacancies(self):
        first = test_projects.generate(self.recruiter)
        store = projects._load(projects._project_path(first["project_ids"][0]))
        before = projects._project_path(store["id"]).read_bytes()
        flows_seen = set()
        for project_id in first["project_ids"]:
            project = projects._load(projects._project_path(project_id))
            for vacancy in projects._approved_vacancies(project):
                invited = invitations.create(self.recruiter, vacancy["id"],
                                             self.candidates[vacancy["specialization"]], "search")
                self.assertEqual(invited["type"], invitations.RECRUITER_TO_APPLICANT)
                self.assertEqual(invited["status"], "sent")
                expected_flow = "assignment" if vacancy["assignments"] else "plain"
                self.assertEqual(invited["flow"], expected_flow)
                flows_seen.add(invited["flow"])
                path = invitations.INVITATIONS_DIR / f"{invited['id']}.json"
                record = projects._load(path)
                self.assertEqual(record["flow"], expected_flow)
                self.assertEqual(record["vacancy"]["assignments"], vacancy["assignments"])
                if project_id == store["id"]:
                    record["status_history"].append({"status": "accepted", "at": "2026-10-09T00:00:00Z"})
                    write(path, record)
        self.assertEqual(flows_seen, {"plain", "assignment"})
        snapshot = self._snapshot()
        replacement = test_projects.generate(self.recruiter)
        self.assertEqual((replacement["created_projects"], replacement["created_vacancies"]), (2, 8))
        self.assertTrue(set(first["project_ids"]).isdisjoint(replacement["project_ids"]))
        self.assertTrue(set(first["vacancy_ids"]).isdisjoint(replacement["vacancy_ids"]))
        self.assertEqual(projects._project_path(store["id"]).read_bytes(), before)
        for path, content in snapshot.items():
            self.assertEqual(path.read_bytes(), content)
        vacancy = projects._load(projects._vacancy_path(replacement["vacancy_ids"][0]))
        invited = invitations.create(self.recruiter, vacancy["id"],
                                     self.candidates[vacancy["specialization"]], "search")
        self.assertEqual(invited["status"], "sent")

    def test_completed_original_and_manual_copy_stay_unchanged(self):
        first = test_projects.generate(self.recruiter)
        project_id = first["project_ids"][1]
        copied = projects.copy(self.recruiter, project_id, "My customized copy")
        projects.approve(self.recruiter, copied["id"], copied["vacancies_list"], [])
        projects.set_completed(self.recruiter, project_id, True)
        before = {pid: projects._project_path(pid).read_bytes() for pid in (project_id, copied["id"])}
        replacement = test_projects.generate(self.recruiter)
        self.assertEqual((replacement["created_projects"], replacement["created_vacancies"]), (2, 8))
        self.assertNotIn(replacement["project_ids"][1], before)
        for pid, content in before.items():
            self.assertEqual(projects._project_path(pid).read_bytes(), content)

    def test_interrupted_approval_is_recovered_without_touching_another_recruiter(self):
        test_projects.generate(self.recruiter)
        before = self._snapshot()
        draft = self._interrupted_draft(self.another)
        recovered = test_projects.generate(self.another)
        self.assertEqual((recovered["created_projects"], recovered["created_vacancies"]), (1, 8))
        self.assertEqual(recovered["project_ids"][0], draft["id"])
        for path, content in before.items():
            self.assertEqual(path.read_bytes(), content)
        self.assertEqual(sum(v["open"] for p in applicant_search.overview(self.another)["projects"]
                             for v in p["vacancies"]), 8)

    def test_customized_draft_is_preserved(self):
        draft = self._interrupted_draft(self.recruiter)
        draft["vacancies_draft"][0]["title"] = "Custom vacancy"
        path = projects._project_path(draft["id"])
        write(path, draft)
        before = path.read_bytes()
        generated = test_projects.generate(self.recruiter)
        self.assertNotIn(draft["id"], generated["project_ids"])
        self.assertEqual(path.read_bytes(), before)

    def test_manual_approval_cannot_be_overwritten_between_draft_check_and_generation(self):
        draft = self._interrupted_draft(self.recruiter)
        manual_vacancies = draft["vacancies_draft"]
        manual_vacancies[0]["title"] = "Manually approved title"
        checked, manual_started, release = threading.Event(), threading.Event(), threading.Event()
        original = test_projects._untouched_draft

        def checked_draft(project, payload, catalog):
            untouched = original(project, payload, catalog)
            if untouched:
                checked.set()
                if not release.wait(5):
                    raise AssertionError("Timed out waiting to continue generation")
            return untouched

        def manual_approval():
            manual_started.set()
            return projects.approve(self.recruiter, draft["id"], manual_vacancies, [])

        with patch.object(test_projects, "_untouched_draft", side_effect=checked_draft):
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
                generation = executor.submit(test_projects.generate, self.recruiter)
                try:
                    self.assertTrue(checked.wait(5))
                    manual = executor.submit(manual_approval)
                    self.assertTrue(manual_started.wait(5))
                    self.assertFalse(manual.done())
                finally:
                    release.set()
                generation.result(timeout=5)
                manual.result(timeout=5)
        project = projects.get_project(self.recruiter, draft["id"])
        self.assertEqual(project["vacancies_list"][0]["title"], "Manually approved title")


if __name__ == "__main__":
    unittest.main(verbosity=2)
