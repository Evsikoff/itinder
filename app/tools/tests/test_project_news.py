"""Новости и просмотр рекрутёром; рабочая app/db не меняется."""

import copy
import json
import sys
import unittest
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import invitations
import project_news
import projects
import serve
import test_invitations
import test_projects
import test_test_projects as fixtures
from users import UserError


class ProjectNews(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.TestGeneration()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.user = self.fixture.recruiter
        generated = test_projects.generate(self.user)
        self.project_id = generated["project_ids"][0]
        self.other_project = generated["project_ids"][1]
        vacancies = [projects._load(projects._vacancy_path(vid)) for vid in generated["vacancy_ids"]]
        self.plain = next(v for v in vacancies if not v["assignments"])
        self.assignment = next(v for v in vacancies if v["assignments"])

    def record(self, direction, status, assignment=False, **fields):
        vacancy = copy.deepcopy(self.assignment if assignment else self.plain)
        flow = "assignment" if assignment else "plain"
        record = {
            "id": str(uuid.uuid4()), "type": direction, "flow": flow,
            "recruiter_id": self.user, "applicant_id": self.fixture.candidates[vacancy["specialization"]],
            "project_id": vacancy["project_id"], "vacancy_id": vacancy["id"], "vacancy": vacancy,
            "created_at": "2026-10-09T10:00:00+00:00",
            "status_history": [{"status": state, "at": f"2026-10-09T10:0{index}:00+00:00"}
                               for index, state in enumerate(test_invitations.HISTORIES[flow][status])],
            **fields,
        }
        self.save(record)
        return record

    def save(self, record):
        path = invitations.INVITATIONS_DIR / f"{record['id']}.json"
        path.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
        return path

    def news(self):
        return project_news.summaries(self.user)[self.project_id]

    def test_types_statuses_and_both_review_stages_are_counted(self):
        for direction in (invitations.APPLICANT_TO_RECRUITER, "Соискатель - Рекрутёр"):
            self.record(direction, "sent")
        self.record(invitations.APPLICANT_TO_RECRUITER, "sent", assignment=True)
        for direction in (invitations.RECRUITER_TO_APPLICANT, "Рекрутёр - Соискатель"):
            self.record(direction, "accepted")
        for state in ("task_sent_for_review", "task_needs_review"):
            self.record(invitations.RECRUITER_TO_APPLICANT, state, assignment=True)
            self.record(invitations.APPLICANT_TO_RECRUITER, state, assignment=True)
        self.record(invitations.RECRUITER_TO_APPLICANT, "sent")
        self.record(invitations.APPLICANT_TO_RECRUITER, "accepted")
        self.record(invitations.RECRUITER_TO_APPLICANT, "accepted", assignment=True)
        self.record(invitations.RECRUITER_TO_APPLICANT, "declined")
        self.record(invitations.RECRUITER_TO_APPLICANT, "solution_rejected", assignment=True)
        self.assertEqual(self.news(), {"new_applications": 3, "accepted_invitations": 2, "assignments_to_review": 4})
        self.assertEqual(project_news.summaries(self.user)[self.other_project], dict.fromkeys(project_news.KINDS, 0))
        projects.set_completed(self.user, self.project_id, True)
        self.assertEqual(self.news()["assignments_to_review"], 4)

    def test_lists_do_not_acknowledge_and_candidate_seen_is_independent(self):
        record = self.record(invitations.RECRUITER_TO_APPLICANT, "accepted")
        record["applicant_seen"] = {**record["status_history"][-1], "revision": len(record["status_history"])}
        self.save(record)
        before = self.fixture._snapshot()
        _, listed, _ = serve.api_projects_list({"user_id": self.user})
        row = next(p for p in listed["projects"] if p["id"] == self.project_id)
        self.assertEqual(row["news"]["accepted_invitations"], 1)
        _, opened, _ = serve.api_project({"user_id": self.user, "project_id": self.project_id})
        self.assertEqual(opened["accepted_news"], [{"id": record["id"], "revision": len(record["status_history"])}])
        self.assertEqual(before, self.fixture._snapshot())
        code, result, _ = serve.api_projects_news_read(json.dumps({
            "user_id": self.user, "project_id": self.project_id, "accepted_news": opened["accepted_news"],
        }).encode("utf-8"))
        self.assertEqual((code, result["news"]["accepted_invitations"]), (200, 0))
        saved = projects._load(invitations.INVITATIONS_DIR / f"{record['id']}.json")
        self.assertEqual(saved.pop("recruiter_seen"), record["applicant_seen"])
        self.assertEqual(saved, record)
        after = self.fixture._snapshot()
        project_news.read(self.user, self.project_id, opened["accepted_news"])
        self.assertEqual(after, self.fixture._snapshot())

    def test_opening_project_acknowledges_only_accepted_snapshot_and_keeps_other_news(self):
        self.record(invitations.APPLICANT_TO_RECRUITER, "sent")
        self.record(invitations.RECRUITER_TO_APPLICANT, "task_sent_for_review", assignment=True,
                    assignment_answers=["Решение\nВторая строка"])
        first = self.record(invitations.RECRUITER_TO_APPLICANT, "accepted")
        snapshot = project_news.snapshot(self.user, self.project_id)
        second = self.record(invitations.RECRUITER_TO_APPLICANT, "accepted")
        result = project_news.read(self.user, self.project_id, snapshot["accepted_news"])
        self.assertEqual(result["news"], {"new_applications": 1, "accepted_invitations": 1, "assignments_to_review": 1})
        self.assertEqual(project_news.snapshot(self.user, self.project_id)["accepted_news"],
                         [{"id": second["id"], "revision": len(second["status_history"])}])
        first = projects._load(invitations.INVITATIONS_DIR / f"{first['id']}.json")
        first["status_history"].append({"status": "accepted", "at": "2026-10-09T11:00:00+00:00"})
        self.save(first)
        project_news.read(self.user, self.project_id, snapshot["accepted_news"])
        self.assertEqual(self.news()["accepted_invitations"], 2)

    def test_seen_before_acceptance_does_not_suppress_new_acceptance(self):
        record = self.record(invitations.RECRUITER_TO_APPLICANT, "sent")
        record["recruiter_seen"] = {**record["status_history"][-1], "revision": 1}
        record["status_history"].append({"status": "accepted", "at": "2026-10-09T11:00:00+00:00"})
        self.save(record)
        self.assertEqual(self.news()["accepted_invitations"], 1)

    def test_foreign_broken_or_deleted_links_and_invalid_records_are_excluded(self):
        self.record(invitations.RECRUITER_TO_APPLICANT, "accepted", recruiter_id=self.fixture.another)
        self.record(invitations.RECRUITER_TO_APPLICANT, "accepted", project_id=self.other_project)
        self.record(invitations.RECRUITER_TO_APPLICANT, "accepted", vacancy_id=str(uuid.uuid4()))
        self.record(invitations.RECRUITER_TO_APPLICANT, "accepted", status_history=[])
        self.record("unknown", "accepted")
        self.record([], "accepted")
        self.record(invitations.RECRUITER_TO_APPLICANT, "accepted", vacancy_id=[])
        self.record(invitations.RECRUITER_TO_APPLICANT, "accepted", project_id={})
        self.assertEqual(self.news(), dict.fromkeys(project_news.KINDS, 0))
        self.record(invitations.RECRUITER_TO_APPLICANT, "accepted")
        projects._vacancy_path(self.plain["id"]).unlink()
        self.assertEqual(self.news()["accepted_invitations"], 0)

    def test_foreign_projects_and_invalid_read_requests_cannot_change_records(self):
        record = self.record(invitations.RECRUITER_TO_APPLICANT, "accepted")
        before = self.fixture._snapshot()
        for user_id, project_id, tokens, status in (
            (self.fixture.another, self.project_id, [{"id": record["id"], "revision": 2}], 404),
            (self.user, self.other_project, [{"id": record["id"], "revision": 2}], 404),
            (self.fixture.non_recruiter, self.project_id, [], 403),
            (self.user, self.project_id, None, 400),
            (self.user, self.project_id, [{"id": record["id"], "revision": True}], 400),
            (self.user, self.project_id, [{"id": record["id"], "revision": 0}], 400),
            (self.user, self.project_id, [{"id": record["id"], "revision": 2},
                                         {"id": str(uuid.uuid4()), "revision": 1}], 404),
        ):
            with self.subTest(user=user_id, project=project_id, tokens=tokens):
                with self.assertRaises(UserError) as raised:
                    project_news.read(user_id, project_id, tokens)
                self.assertEqual(raised.exception.status, status)
                self.assertEqual(before, self.fixture._snapshot())


if __name__ == "__main__":
    unittest.main(verbosity=2)
