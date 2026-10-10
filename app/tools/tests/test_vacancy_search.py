"""Изолированные проверки окна «Вакансии» соискателя; рабочая app/db не меняется.

Запуск: python app/tools/tests/test_vacancy_search.py
"""

import json
import math
import sys
import unittest
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import applicant_invitations
import applicant_search
import invitations
import project_feedback
import projects
import ranking
import serve
import specializations
import test_projects
import test_test_projects as fixtures
import users
import vacancy_ranking
import vacancy_search
from users import UserError


class Vacancies(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.TestGeneration()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.recruiter = self.fixture.recruiter
        generated = test_projects.generate(self.recruiter)
        self.project_ids = generated["project_ids"]
        self.vacancies = [projects._load(projects._vacancy_path(vid)) for vid in generated["vacancy_ids"]]
        self.backend = self.fixture.candidates["Backend"]
        self.middle = self.find("Backend", "Middle")  # без заданий
        self.senior = self.find("Backend", "Senior")  # с заданием

    def find(self, specialization, grade):
        return next(v for v in self.vacancies if v["specialization"] == specialization and v["grade"] == grade)

    def user(self, specialization, grade="Middle", source="Manual"):
        user_id = str(uuid.uuid4())
        fixtures.write(users.USERS_DIR / f"{user_id}.json", {"id": user_id, "email": f"{user_id}@example.invalid"})
        specializations.write(user_id, specialization, grade, {"type": source})
        return user_id

    def link_fsp(self, user_id, competencies):
        fixtures.write(ranking.USER_FSP_DIR / f"{user_id}.json", {
            "user_id": user_id,
            "competitions": [{"points": 3}],
            "competencies": [{"kind": kind, "id": item_id, "degree": degree, "points": degree * 2}
                             for kind, item_id, degree in competencies],
        })

    def listed(self, user_id):
        return {v["id"]: v for v in vacancy_search.listing(user_id)["vacancies"]}

    def test_only_open_vacancies_of_own_specialization_ranked_by_formula(self):
        result = vacancy_ranking.for_applicant(self.backend)
        self.assertEqual(result["specializations"], ["Backend"])
        self.assertFalse(result["fsp_linked"])
        self.assertEqual([e["vacancy"]["id"] for e in result["vacancies"]], [self.middle["id"], self.senior["id"]])
        for entry in result["vacancies"]:
            appeal = entry["appeal"]
            self.assertEqual(appeal["strengths"]["basis"], "unknown")
            self.assertEqual(appeal["strengths"]["score"], vacancy_ranking.UNKNOWN)
            expected = 0.65 * vacancy_ranking.UNKNOWN + 0.35 * appeal["growth"]["score"]
            self.assertAlmostEqual(appeal["score"], round(expected, 3))
            mutual = math.sqrt(entry["fit"]["score"] * appeal["score"])
            queue = entry["queue"]["score"]
            self.assertAlmostEqual(entry["relevance"], round(100 * mutual * (0.8 + 0.2 * queue), 1))
        middle, senior = result["vacancies"]
        self.assertEqual((middle["appeal"]["growth"]["step"], senior["appeal"]["growth"]["step"]), (0, 1))
        self.assertEqual(senior["appeal"]["growth"]["score"], vacancy_ranking.GROWTH[1])
        # Подхожу — ровно то, что видит рекрутёр.
        seen = applicant_search.vacancy(self.recruiter, self.middle["id"])["unconfirmed"]
        self.assertEqual(middle["fit"]["score"], next(c for c in seen if c["user_id"] == self.backend)["relevance"] / 100)

    def test_strengths_count_exact_and_close_competencies_by_depth(self):
        self.link_fsp(self.backend, [("languages", "python", 3), ("databases", "mysql", 2), ("integrations", "rest", 1)])
        entry = next(e for e in vacancy_ranking.for_applicant(self.backend)["vacancies"]
                     if e["vacancy"]["id"] == self.middle["id"])
        strengths = entry["appeal"]["strengths"]
        self.assertEqual(strengths["basis"], "requirements")
        items = {i["id"]: i for i in strengths["items"]}
        self.assertEqual([i["id"] for i in strengths["items"]], ["python", "mysql", "rest"])
        self.assertEqual((items["python"]["relation"], items["python"]["share"]), ("exact", 1.0))
        self.assertEqual((items["mysql"]["via"], items["mysql"]["share"]), ("postgresql", ranking.ADJACENT))
        weights = [3 / 3, 2 / 3 * 0.7, 1 / 3 * 0.7 ** 2]
        shares = [1.0, ranking.ADJACENT, 1.0]
        self.assertAlmostEqual(strengths["score"], round(sum(w * s for w, s in zip(weights, shares)) / sum(weights), 3))
        self.assertTrue(entry["fit"]["linked"])

    def test_queue_place_and_seats(self):
        rival = self.user("Backend", "Middle", "LLM")
        self.link_fsp(rival, [("languages", "python", 3), ("databases", "postgresql", 3), ("integrations", "rest", 3)])
        entry = next(e for e in vacancy_ranking.for_applicant(self.backend)["vacancies"]
                     if e["vacancy"]["id"] == self.middle["id"])
        self.assertEqual({k: entry["queue"][k] for k in ("place", "of", "seats", "score")},
                         {"place": 2, "of": 2, "seats": 1, "score": 0.0})
        mutual = math.sqrt(entry["fit"]["score"] * entry["appeal"]["score"])
        self.assertAlmostEqual(entry["relevance"], round(100 * mutual * 0.8, 1))
        first = next(e for e in vacancy_ranking.for_applicant(rival)["vacancies"] if e["vacancy"]["id"] == self.middle["id"])
        self.assertEqual((first["queue"]["place"], first["queue"]["score"]), (1, 1.0))

    def test_own_completed_and_closed_vacancies_are_hidden(self):
        specializations.write(self.recruiter, "Backend", "Middle", {"type": "Manual"})
        self.assertEqual(vacancy_ranking.for_applicant(self.recruiter)["found"], 0)
        # Рекрутёр вакансии не соперник своим соискателям.
        self.assertEqual(vacancy_ranking.for_applicant(self.backend)["vacancies"][0]["queue"]["of"], 1)
        hired = self.user("Backend")
        invitations.create(self.recruiter, self.middle["id"], hired, "search")
        record = next(r for r in invitations.records() if r["applicant_id"] == hired)
        record["status_history"].append({"status": "accepted", "at": invitations._now()})
        invitations._write(invitations.INVITATIONS_DIR / f"{record['id']}.json", record)
        self.assertEqual(list(self.listed(self.backend)), [self.senior["id"]])
        projects.set_completed(self.recruiter, self.senior["project_id"], True)
        self.assertEqual(self.listed(self.backend), {})

    def test_only_applicants_get_vacancies(self):
        with self.assertRaises(UserError) as caught:
            vacancy_search.listing(self.fixture.another)
        self.assertEqual(caught.exception.status, 403)

    def test_blocked_applicant_still_sees_and_applies(self):
        fixtures.write(ranking.USER_BLOCKS_DIR / f"{self.backend}.json", {"user_id": self.backend})
        self.assertNotIn(self.backend, {a["user_id"] for a in ranking.applicants("Backend")})
        self.assertEqual(len(self.listed(self.backend)), 2)
        self.assertEqual(vacancy_search.apply(self.backend, self.middle["id"])["status"], "sent")

    def test_application_without_assignments_reaches_recruiter(self):
        view = vacancy_search.apply(self.backend, self.middle["id"])
        self.assertEqual((view["type"], view["status"], view["unseen"], view["can_respond"]),
                         (invitations.APPLICANT_TO_RECRUITER, "sent", False, False))
        record = projects._load(invitations.INVITATIONS_DIR / f"{view['id']}.json")
        self.assertEqual((record["recruiter_id"], record["source"], record["flow"]),
                         (self.recruiter, invitations.APPLICATION_SOURCE, "plain"))
        self.assertNotIn("user_id", record["vacancy"])
        self.assertIsNone(applicant_invitations.alert(self.backend))
        row = self.listed(self.backend)[self.middle["id"]]
        self.assertEqual((row["can_apply"], row["record"]["status"]), (False, "sent"))
        with self.assertRaises(UserError) as caught:
            vacancy_search.apply(self.backend, self.middle["id"])
        self.assertEqual(caught.exception.status, 409)
        with self.assertRaises(UserError):
            invitations.create(self.recruiter, self.middle["id"], self.backend, "search")
        seen = applicant_search.vacancy(self.recruiter, self.middle["id"])["unconfirmed"]
        self.assertEqual(next(c for c in seen if c["user_id"] == self.backend)["invitation"]["id"], view["id"])
        tree = project_feedback.tree(self.recruiter, self.middle["project_id"])
        shown = next(i for v in tree["vacancies"] for i in v["invitations"] if i["id"] == view["id"])
        self.assertEqual((shown["kind"], shown["can_respond_application"]), ("application", True))
        project_feedback.respond_application(self.recruiter, self.middle["project_id"], view["id"], "accept", 1)
        self.assertEqual(applicant_invitations.alert(self.backend), "Новые приглашения или изменения статуса: 1")

    def test_application_with_assignments_carries_solutions(self):
        with self.assertRaises(UserError):
            vacancy_search.apply(self.backend, self.senior["id"])
        with self.assertRaises(UserError):
            vacancy_search.apply(self.backend, self.middle["id"], ["Лишнее решение"])
        view = vacancy_search.apply(self.backend, self.senior["id"], ["  Идемпотентный приём по ключу события.  "])
        self.assertEqual([h["status"] for h in view["status_history"]], ["sent", "task_sent_for_review"])
        self.assertEqual((view["flow"], view["assignment_answers"]), ("assignment", ["Идемпотентный приём по ключу события."]))
        tree = project_feedback.tree(self.recruiter, self.senior["project_id"])
        shown = next(i for v in tree["vacancies"] for i in v["invitations"] if i["id"] == view["id"])
        self.assertTrue(shown["can_send_to_expert"])

    def test_wrong_specialization_and_own_vacancy_are_rejected(self):
        with self.assertRaises(UserError) as caught:
            vacancy_search.apply(self.backend, self.find("Frontend", "Junior")["id"])
        self.assertEqual(caught.exception.status, 403)
        specializations.write(self.recruiter, "Backend", "Middle", {"type": "Manual"})
        with self.assertRaises(UserError) as caught:
            vacancy_search.apply(self.recruiter, self.middle["id"])
        self.assertEqual(caught.exception.status, 409)
        self.assertEqual(invitations.records(), [])

    def test_api_handlers(self):
        code, data, _ = serve.api_vacancies({"user_id": self.backend})
        self.assertEqual((code, data["found"], data["fsp_linked"]), (200, 2, False))
        self.assertEqual(data["vacancies"][0]["project"]["name"], "Тестовый проект: интернет-магазин")
        self.assertIn("python", data["stack"]["languages"])
        body = json.dumps({"user_id": self.backend, "vacancy_id": self.middle["id"]}).encode()
        code, result, _ = serve.api_vacancies_apply(body)
        self.assertEqual((code, result["status"]), (201, "sent"))
        self.assertIn("/api/vacancies", serve.GET_API)
        self.assertIn("/api/vacancies/apply", serve.API)


if __name__ == "__main__":
    unittest.main()
