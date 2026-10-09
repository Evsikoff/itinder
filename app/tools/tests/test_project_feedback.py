"""Дерево, проверка экспертом и закрытие вакансий в изолированной БД."""

import concurrent.futures
import copy
import http.client
import json
import sys
import threading
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import applicant_invitations
import invitations
import project_feedback
import project_news
import projects
import ranking
import serve
import test_project_news as fixtures
import users


class ProjectFeedback(unittest.TestCase):
    def setUp(self):
        self.case = fixtures.ProjectNews()
        self.case.setUp()
        self.addCleanup(self.case.doCleanups)
        self.user, self.project = self.case.user, self.case.project_id

    def record(self, state, assignment=True, direction=invitations.RECRUITER_TO_APPLICANT, **fields):
        return self.case.record(direction, state, assignment=assignment, **fields)

    def tree(self):
        return project_feedback.tree(self.user, self.project)

    def entry(self, record):
        return next(r for v in self.tree()["vacancies"] for r in v["invitations"] if r["id"] == record["id"])

    def saved(self, record):
        return projects._load(invitations.INVITATIONS_DIR / f"{record['id']}.json")

    def review(self, record, action, email="expert@example.invalid", revision=None):
        return project_feedback.review(self.user, self.project, record["id"], action, email,
                                       len(record["status_history"]) if revision is None else revision)

    def test_tree_matches_app9_ranking_and_only_accepted_records_expose_email(self):
        incoming = self.record("task_sent_for_review", assignment_answers=["Решение"], relevance=-1)
        outgoing = self.record("sent", direction="Соискатель - Рекрутёр")
        accepted = self.record("accepted", assignment=False, direction="Рекрутёр - Соискатель")
        before = self.case.fixture._snapshot()
        code, tree, _ = serve.api_project_feedback({"user_id": self.user, "project_id": self.project})
        self.assertEqual(code, 200)
        self.assertEqual(before, self.case.fixture._snapshot())
        ranked = ranking.by_vacancy(self.case.assignment)
        expected = next(c["relevance"] for c in ranked["candidates"] + ranked["unconfirmed"]
                        if c["user_id"] == incoming["applicant_id"])
        self.assertEqual(self.entry(incoming)["relevance"], expected)
        self.assertEqual(self.entry(incoming)["kind"], "invitation")
        self.assertEqual(self.entry(outgoing)["kind"], "application")
        self.assertEqual(self.entry(incoming)["assignment_answers"], ["Решение"])
        self.assertIsNone(self.entry(incoming)["email"])
        self.assertIsNone(self.entry(outgoing)["email"])
        self.assertEqual(self.entry(accepted)["email"], f"{accepted['applicant_id']}@example.invalid")
        self.assertEqual(len(tree["vacancies"]), 4)
        vacancy = next(v for v in tree["vacancies"] if v["id"] == self.case.plain["id"])
        self.assertEqual((vacancy["count"], vacancy["accepted"], vacancy["can_close"]), (1, 1, True))

    def test_send_and_both_expert_verdicts_preserve_snapshot_solutions_and_old_history(self):
        for action, state in (("approve", "accepted"), ("reject", "solution_rejected")):
            with self.subTest(action=action):
                record = self.record("task_sent_for_review", assignment_answers=["Ответ\nВторая строка"])
                record["applicant_seen"] = applicant_invitations._seen_marker(record)
                self.case.save(record)
                sent = self.review(record, "send", " Expert@example.invalid ")
                self.assertEqual(sent["status"], "task_needs_review")
                saved = self.saved(record)
                self.assertEqual(saved["expert_review"]["email"], "Expert@example.invalid")
                self.assertTrue(saved["expert_review"]["simulated"])
                result = self.review(saved, action)
                self.assertEqual(result["status"], state)
                saved = self.saved(record)
                self.assertEqual(saved["status_history"][:-2], record["status_history"])
                self.assertEqual(saved["vacancy"], record["vacancy"])
                self.assertEqual(saved["assignment_answers"], record["assignment_answers"])
                self.assertEqual(saved["applicant_seen"], record["applicant_seen"])
                self.assertEqual(saved["expert_review"]["decision"], action)
                self.assertFalse(self.entry(record)["can_decide"])
                self.assertEqual(self.entry(record)["email"] is not None, action == "approve")
        self.assertEqual(project_news.summaries(self.user)[self.project]["assignments_to_review"], 0)

    def test_outgoing_application_supports_expert_workflow_too(self):
        record = self.record("task_sent_for_review", direction=invitations.APPLICANT_TO_RECRUITER,
                             assignment_answers=["Решение"])
        self.review(record, "send")
        result = self.review(self.saved(record), "approve")
        self.assertEqual(result["status"], "accepted")
        self.assertEqual(self.entry(record)["kind"], "application")
        self.assertIsNotNone(self.entry(record)["email"])

    def test_invalid_email_and_revision_never_mutate_invitation(self):
        record = self.record("task_sent_for_review")
        before = self.case.fixture._snapshot()
        for email in (None, "", "no-at", "a@", "first@domain", "x" * 255 + "@example.invalid", []):
            with self.subTest(email=email), self.assertRaises(users.UserError) as raised:
                self.review(record, "send", email)
            self.assertEqual(raised.exception.status, 400)
        for revision, expected in ((True, 400), (0, 400), (None, 400), (1, 409)):
            with self.subTest(revision=revision), self.assertRaises(users.UserError) as raised:
                project_feedback.review(self.user, self.project, record["id"], "send", "a@b.invalid", revision)
            self.assertEqual(raised.exception.status, expected)
        self.assertEqual(before, self.case.fixture._snapshot())

    def test_illegal_status_transitions_are_rejected(self):
        for state, action, assignment in (("sent", "send", True), ("task_needs_review", "send", True),
                ("task_sent_for_review", "approve", True), ("accepted", "reject", True),
                ("solution_rejected", "approve", True), ("declined", "send", True), ("sent", "send", False)):
            with self.subTest(state=state, action=action):
                record = self.record(state, assignment=assignment)
                before = self.case.fixture._snapshot()
                with self.assertRaises(users.UserError) as raised:
                    self.review(record, action)
                self.assertEqual(raised.exception.status, 409)
                self.assertEqual(before, self.case.fixture._snapshot())

    def test_foreign_deleted_or_unlinked_records_cannot_be_seen_or_changed(self):
        record = self.record("task_sent_for_review")
        before = self.case.fixture._snapshot()
        for user, project, code in ((self.case.fixture.another, self.project, 404),
                (self.case.fixture.non_recruiter, self.project, 403), (self.user, self.case.other_project, 404)):
            with self.assertRaises(users.UserError) as raised:
                project_feedback.review(user, project, record["id"], "send", "a@b.invalid", 2)
            self.assertEqual(raised.exception.status, code)
        self.assertEqual(before, self.case.fixture._snapshot())
        foreign = self.record("accepted", recruiter_id=self.case.fixture.another)
        broken = self.record("sent", applicant_id="../secret")
        ids = {r["id"] for v in self.tree()["vacancies"] for r in v["invitations"]}
        self.assertTrue({foreign["id"], broken["id"]}.isdisjoint(ids))
        projects._vacancy_path(self.case.assignment["id"]).unlink()
        self.assertFalse(any(v["id"] == self.case.assignment["id"] for v in self.tree()["vacancies"]))
        with self.assertRaises(users.UserError) as raised:
            self.review(record, "send")
        self.assertEqual(raised.exception.status, 404)

    def test_concurrent_verdicts_allow_only_one_status_change(self):
        record = self.record("task_needs_review")

        def decide(action):
            try:
                return self.review(record, action)["status"]
            except users.UserError as error:
                return error.status

        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(decide, ("approve", "reject")))
        self.assertEqual(results.count(409), 1)
        self.assertIn(invitations.status(self.saved(record)), ("accepted", "solution_rejected"))
        self.assertEqual(len(self.saved(record)["status_history"]), len(record["status_history"]) + 1)

    def test_vacancy_close_requires_all_places_and_preserves_invitation_files(self):
        vacancy = copy.deepcopy(self.case.plain)
        vacancy["count"] = 2
        projects._write(projects._vacancy_path(vacancy["id"]), vacancy)
        self.record("accepted", assignment=False)
        before = self.case.fixture._snapshot()
        with self.assertRaises(users.UserError) as raised:
            project_feedback.close_vacancy(self.user, self.project, vacancy["id"])
        self.assertEqual(raised.exception.status, 409)
        self.assertEqual(before, self.case.fixture._snapshot())
        self.record("accepted", assignment=False, direction=invitations.APPLICANT_TO_RECRUITER)
        before = self.case.fixture._snapshot()
        code, closed, _ = serve.api_project_feedback_close(json.dumps({
            "user_id": self.user, "project_id": self.project, "vacancy_id": vacancy["id"],
        }).encode())
        self.assertEqual(code, 200)
        self.assertTrue(closed["closed_at"])
        for path, content in before.items():
            if path != projects._vacancy_path(vacancy["id"]):
                self.assertEqual(path.read_bytes(), content)
        self.assertTrue(invitations.is_closed(projects._load(projects._vacancy_path(vacancy["id"])), {}))
        after = self.case.fixture._snapshot()
        self.assertEqual(project_feedback.close_vacancy(self.user, self.project, vacancy["id"]), closed)
        self.assertEqual(after, self.case.fixture._snapshot())

    def test_closed_flag_survives_editing_and_is_not_inherited_by_copy(self):
        self.record("accepted", assignment=False)
        project_feedback.close_vacancy(self.user, self.project, self.case.plain["id"])
        project = projects.get_project(self.user, self.project)
        closed_at = projects._load(projects._vacancy_path(self.case.plain["id"]))["closed_at"]
        projects.approve(self.user, self.project, project["vacancies_list"], [])
        self.assertEqual(projects._load(projects._vacancy_path(self.case.plain["id"]))["closed_at"], closed_at)
        copied = projects.copy(self.user, self.project, "Копия")
        projects.approve(self.user, copied["id"], copied["vacancies_list"], [])
        self.assertTrue(all(not v.get("closed_at") for v in projects.get_project(self.user, copied["id"])["vacancies_list"]))

    def test_failed_write_keeps_original_invitation_and_vacancy(self):
        record = self.record("task_sent_for_review")
        self.record("accepted", assignment=False)
        before = self.case.fixture._snapshot()
        with patch.object(invitations, "_write", side_effect=OSError("Write failed")), self.assertRaises(OSError):
            self.review(record, "send")
        with patch.object(projects, "_write", side_effect=OSError("Write failed")), self.assertRaises(OSError):
            project_feedback.close_vacancy(self.user, self.project, self.case.plain["id"])
        self.assertEqual(before, self.case.fixture._snapshot())

    def test_http_routes_send_approve_and_close_without_email_delivery(self):
        record = self.record("task_sent_for_review", assignment_answers=["Решение"])

        class Handler(serve.Handler):
            def log_message(self, *args):
                pass

        server = serve.Server(("127.0.0.1", 0), Handler)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        self.addCleanup(server.server_close)
        self.addCleanup(worker.join)
        self.addCleanup(server.shutdown)

        def request(method, path, payload=None):
            connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)
            headers = {"Content-Type": "application/json", "Origin": f"http://127.0.0.1:{server.server_port}"}
            connection.request(method, path, json.dumps(payload) if payload else None, headers)
            response = connection.getresponse()
            result = response.status, json.load(response)
            connection.close()
            return result

        query = f"/api/projects/feedback?user_id={self.user}&project_id={self.project}"
        self.assertEqual(request("GET", query)[0], 200)
        base = {"user_id": self.user, "project_id": self.project, "invitation_id": record["id"],
                "expected_revision": len(record["status_history"])}
        code, sent = request("POST", "/api/projects/feedback/review", {**base, "action": "send", "email": "expert@example.invalid"})
        self.assertEqual((code, sent["status"]), (200, "task_needs_review"))
        code, approved = request("POST", "/api/projects/feedback/review", {**base, "action": "approve", "expected_revision": sent["revision"]})
        self.assertEqual((code, approved["status"]), (200, "accepted"))
        code, closed = request("POST", "/api/projects/feedback/close", {
            "user_id": self.user, "project_id": self.project, "vacancy_id": self.case.assignment["id"],
        })
        self.assertEqual(code, 200)
        self.assertTrue(closed["closed_at"])
        application = self.record("sent", assignment=False, direction=invitations.APPLICANT_TO_RECRUITER)
        code, answered = request("POST", "/api/projects/feedback/respond", {
            "user_id": self.user, "project_id": self.project, "invitation_id": application["id"],
            "action": "accept", "expected_revision": len(application["status_history"]),
        })
        self.assertEqual((code, answered["status"]), (200, "accepted"))

    def test_positive_and_negative_application_responses_change_status_and_news(self):
        for assignment in (False, True):
            for direction in (invitations.APPLICANT_TO_RECRUITER, "Соискатель - Рекрутёр"):
                for action, state in (("accept", "accepted"), ("decline", "declined")):
                    with self.subTest(assignment=assignment, direction=direction, action=action):
                        record = self.record("sent", assignment=assignment, direction=direction)
                        record["applicant_seen"] = applicant_invitations._seen_marker(record)
                        self.case.save(record)
                        self.assertTrue(self.entry(record)["can_respond_application"])
                        before_news = project_news.summaries(self.user)[self.project]["new_applications"]
                        before = self.case.fixture._snapshot()
                        result = project_feedback.respond_application(self.user, self.project, record["id"], action, 1)
                        self.assertEqual((result["status"], result["revision"]), (state, 2))
                        saved = self.saved(record)
                        self.assertEqual(saved["status_history"][:-1], record["status_history"])
                        self.assertEqual(saved["vacancy"], record["vacancy"])
                        self.assertEqual(saved["applicant_seen"], record["applicant_seen"])
                        self.assertFalse(self.entry(record)["can_respond_application"])
                        self.assertEqual(self.entry(record)["email"] is not None, action == "accept")
                        self.assertEqual(project_news.summaries(self.user)[self.project]["new_applications"], before_news - 1)
                        for path, content in before.items():
                            if path.stem != record["id"]:
                                self.assertEqual(path.read_bytes(), content)
                        view = applicant_invitations.list_for_user(record["applicant_id"])
                        candidate_entry = next(r for r in view["invitations"] if r["id"] == record["id"])
                        self.assertEqual(candidate_entry["status"], state)
                        self.assertTrue(candidate_entry["unseen"])

    def test_plain_read_application_can_be_answered_without_changing_snapshot_or_answers(self):
        record = self.record("read", assignment=False, direction=invitations.APPLICANT_TO_RECRUITER,
                             assignment_answers=["Прежний текст"])
        result = project_feedback.respond_application(self.user, self.project, record["id"], "accept", 2)
        self.assertEqual(result["status"], "accepted")
        self.assertEqual(self.saved(record)["assignment_answers"], record["assignment_answers"])

    def test_invitation_final_application_and_review_stage_cannot_receive_initial_response(self):
        for state, assignment, direction in (("sent", False, invitations.RECRUITER_TO_APPLICANT),
                ("sent", True, invitations.RECRUITER_TO_APPLICANT),
                ("accepted", False, invitations.APPLICANT_TO_RECRUITER),
                ("declined", False, invitations.APPLICANT_TO_RECRUITER),
                ("task_sent_for_review", True, invitations.APPLICANT_TO_RECRUITER),
                ("task_needs_review", True, invitations.APPLICANT_TO_RECRUITER),
                ("solution_rejected", True, invitations.APPLICANT_TO_RECRUITER)):
            with self.subTest(state=state, direction=direction):
                record = self.record(state, assignment=assignment, direction=direction)
                self.assertFalse(self.entry(record)["can_respond_application"])
                before = self.case.fixture._snapshot()
                for action in ("accept", "decline"):
                    with self.assertRaises(users.UserError) as raised:
                        project_feedback.respond_application(self.user, self.project, record["id"], action, len(record["status_history"]))
                    self.assertEqual(raised.exception.status, 409)
                self.assertEqual(before, self.case.fixture._snapshot())

    def test_invalid_application_response_and_foreign_links_never_write(self):
        record = self.record("sent", assignment=False, direction=invitations.APPLICANT_TO_RECRUITER)
        before = self.case.fixture._snapshot()
        for user, project, action, revision, code in (
                (self.user, self.project, "unknown", 1, 400),
                (self.user, self.project, "accept", True, 400),
                (self.user, self.project, "accept", None, 400),
                (self.user, self.project, "decline", 2, 409),
                (self.case.fixture.another, self.project, "accept", 1, 404),
                (self.case.fixture.non_recruiter, self.project, "accept", 1, 403),
                (self.user, self.case.other_project, "accept", 1, 404)):
            with self.subTest(user=user, action=action, revision=revision), self.assertRaises(users.UserError) as raised:
                project_feedback.respond_application(user, project, record["id"], action, revision)
            self.assertEqual(raised.exception.status, code)
            self.assertEqual(before, self.case.fixture._snapshot())
        projects._vacancy_path(self.case.plain["id"]).unlink()
        before = self.case.fixture._snapshot()
        with self.assertRaises(users.UserError) as raised:
            project_feedback.respond_application(self.user, self.project, record["id"], "accept", 1)
        self.assertEqual(raised.exception.status, 404)
        self.assertEqual(before, self.case.fixture._snapshot())

    def test_concurrent_and_repeated_application_responses_append_only_one_status(self):
        record = self.record("sent", assignment=False, direction=invitations.APPLICANT_TO_RECRUITER)

        def respond(action):
            try:
                return project_feedback.respond_application(self.user, self.project, record["id"], action, 1)["status"]
            except users.UserError as error:
                return error.status

        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            result = list(executor.map(respond, ("accept", "decline")))
        self.assertEqual(result.count(409), 1)
        self.assertEqual(len(self.saved(record)["status_history"]), 2)
        before = self.case.fixture._snapshot()
        with self.assertRaises(users.UserError) as raised:
            project_feedback.respond_application(self.user, self.project, record["id"], "accept", 2)
        self.assertEqual(raised.exception.status, 409)
        self.assertEqual(before, self.case.fixture._snapshot())

    def test_application_response_write_failure_preserves_exact_original_bytes(self):
        record = self.record("sent", assignment=True, direction=invitations.APPLICANT_TO_RECRUITER)
        before = self.case.fixture._snapshot()
        with patch.object(invitations, "_write", side_effect=OSError("Write failed")), self.assertRaises(OSError):
            project_feedback.respond_application(self.user, self.project, record["id"], "accept", 1)
        self.assertEqual(before, self.case.fixture._snapshot())


if __name__ == "__main__":
    unittest.main(verbosity=2)
