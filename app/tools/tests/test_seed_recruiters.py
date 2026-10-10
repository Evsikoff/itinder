"""Генератор рекрутёров с проектами и вакансиями; реальная app/db не меняется.

Запуск: python app/tools/tests/test_seed_recruiters.py
"""

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

import fsp
import grade_tests
import invitations
import projects
import ranking
import seed_recruiters
import specializations
import user_names
import users
import vacancy_ranking

NOW = datetime(2026, 10, 10, 12, 0, tzinfo=timezone.utc)
IDEAS = sum(len(company["projects"]) for company in seed_recruiters.COMPANIES)
EXISTING = "Сеть клиник «Семейный доктор Поволжья»"


def write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")


def load(folder):
    return [json.loads(path.read_text(encoding="utf-8")) for path in sorted(folder.glob("*.json"))]


class SeedRecruiters(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="itinder-seed-recruiters-")
        self.addCleanup(temporary.cleanup)
        self.db = Path(temporary.name)
        for module in (projects, ranking, specializations, grade_tests, invitations, users, user_names, fsp):
            for name, value in list(vars(module).items()):
                if name.endswith("_DIR") and isinstance(value, Path):
                    target = self.db / value.name
                    target.mkdir(exist_ok=True)
                    replacement = patch.object(module, name, target)
                    replacement.start()
                    self.addCleanup(replacement.stop)
        # Настоящие пользователи: рекрутёр со своим проектом и соискатель-бэкендер.
        self.recruiter, self.applicant = str(uuid.uuid4()), str(uuid.uuid4())
        for user_id in (self.recruiter, self.applicant):
            write(users.USERS_DIR / f"{user_id}.json", {"id": user_id, "email": f"{user_id}@example.invalid"})
        specializations.write(self.recruiter, "Recruiter", "Middle", {"type": "Manual"})
        specializations.write(self.applicant, "Backend", "Middle", {"type": "Manual"})
        self.company = str(uuid.uuid4())
        write(projects.COMPANIES_DIR / f"{self.company}.json", {
            "id": self.company, "name": EXISTING, "industry": "health", "city": "Самара",
            "description": "Тестовая", "created_at": NOW.isoformat(), "created_by": None})

    def seeded(self):
        return {r["id"] for r in load(users.USERS_DIR) if r.get("seed") == seed_recruiters.SEED_MARK}

    def content(self):
        """Что сгенерировано, без идентификаторов проектов и вакансий."""
        names = {p["id"]: p["name"] for p in load(projects.PROJECTS_DIR)}
        return sorted((v["user_id"], names[v["project_id"]], v["title"], v["task"], v["salary"]["from"],
                       v["salary"]["to"], json.dumps(v["requirements"], ensure_ascii=False), tuple(v["assignments"]),
                       v["created_at"]) for v in load(projects.VACANCIES_DIR))

    def test_recruiters_get_named_accounts_and_valid_open_vacancies(self):
        seed_recruiters.generate(5, seed=1, now=NOW)
        ids = self.seeded()
        self.assertEqual(len(ids), 5)
        names = {r["user_id"]: r for r in load(user_names.USER_NAMES_DIR)}
        for user_id in ids:
            self.assertEqual(projects.check_recruiter(user_id), user_id)
            self.assertTrue(names[user_id]["first_name"] and names[user_id]["last_name"])
            self.assertEqual([r["specialization"] for r in specializations.records(user_id)], ["Recruiter"])

        owned = [p for p in load(projects.PROJECTS_DIR) if p["user_id"] in ids]
        self.assertEqual(len(owned), IDEAS)
        self.assertEqual(set(Counter(p["user_id"] for p in owned)), ids)  # у каждого хотя бы один проект
        self.assertEqual(len({p["name"] for p in owned}), IDEAS)
        vacancies = {v["id"]: v for v in load(projects.VACANCIES_DIR)}
        catalog = projects.Catalog()
        for project in owned:
            self.assertLessEqual(project["created_at"], project["approved_at"])
            self.assertLess(project["approved_at"], NOW.isoformat())
            self.assertGreater(project["created_at"], names[project["user_id"]]["created_at"])
            self.assertIsNone(project["vacancies_draft"])
            self.assertTrue(project["vacancy_ids"])
            for vacancy_id in project["vacancy_ids"]:
                vacancy = vacancies.pop(vacancy_id)
                self.assertEqual((vacancy["project_id"], vacancy["user_id"]), (project["id"], project["user_id"]))
                self.assertEqual(vacancy["status"], "ready")
                self.assertLess(vacancy["salary"]["from"], vacancy["salary"]["to"])
                self.assertTrue(vacancy["requirements"])
                projects._vacancies([vacancy], catalog, approve=True)  # те же проверки, что у окна
        self.assertEqual(vacancies, {})
        specs = Counter(v["specialization"] for v in load(projects.VACANCIES_DIR))
        self.assertEqual(set(specs), set(grade_tests.SPECIALIZATIONS))

        # Компания с тем же названием не дублируется; новые — с отраслью и городом.
        companies = load(projects.COMPANIES_DIR)
        self.assertEqual(len({c["name"] for c in companies}), len(companies))
        self.assertEqual(len(companies), len(seed_recruiters.COMPANIES))
        self.assertTrue(all(c["industry"] and c["city"] for c in companies))
        self.assertIn(self.company, {p["company_id"] for p in owned})

        found = vacancy_ranking.for_applicant(self.applicant)
        self.assertGreater(found["found"], 5)
        self.assertEqual({entry["specialization"] for entry in found["vacancies"]}, {"Backend"})

    def test_same_seed_gives_same_people_and_vacancies(self):
        seed_recruiters.generate(3, seed=7, now=NOW)
        first, people = self.content(), self.seeded()
        removed = seed_recruiters.clean()
        self.assertEqual((removed["recruiters"], removed["projects"]), (3, IDEAS))
        seed_recruiters.generate(3, seed=7, now=NOW)
        self.assertEqual(self.seeded(), people)
        self.assertEqual(self.content(), first)
        seed_recruiters.clean()
        seed_recruiters.generate(3, seed=8, now=NOW)
        self.assertNotEqual(self.content(), first)

    def test_clean_removes_only_generated_records(self):
        seed_recruiters.generate(2, seed=3, now=NOW)
        ids = self.seeded()
        vacancy = next(v for v in load(projects.VACANCIES_DIR) if v["user_id"] in ids)
        new_company = next(c for c in load(projects.COMPANIES_DIR) if c["created_by"] in ids)
        unused_company = next(c for c in load(projects.COMPANIES_DIR)
                              if c["created_by"] in ids and c["id"] != new_company["id"])
        # Настоящий рекрутёр тоже завёл проект у компании, которую создал генератор.
        own = {"id": str(uuid.uuid4()), "user_id": self.recruiter, "company_id": new_company["id"], "name": "Свой"}
        write(projects.PROJECTS_DIR / f"{own['id']}.json", own)
        mine = {"id": str(uuid.uuid4()), "recruiter_id": vacancy["user_id"], "applicant_id": self.applicant,
                "vacancy_id": vacancy["id"]}
        theirs = {"id": str(uuid.uuid4()), "recruiter_id": self.recruiter, "applicant_id": self.applicant}
        for record in (mine, theirs):
            write(invitations.INVITATIONS_DIR / f"{record['id']}.json", record)

        removed = seed_recruiters.clean()
        self.assertEqual((removed["recruiters"], removed["invitations"]), (2, 1))
        self.assertEqual(self.seeded(), set())
        self.assertEqual({r["id"] for r in load(users.USERS_DIR)}, {self.recruiter, self.applicant})
        self.assertEqual({r["user_id"] for r in load(specializations.SPECIALIZATIONS_DIR)}, {self.recruiter, self.applicant})
        self.assertEqual(load(user_names.USER_NAMES_DIR), [])
        self.assertEqual([p["id"] for p in load(projects.PROJECTS_DIR)], [own["id"]])
        self.assertEqual(load(projects.VACANCIES_DIR), [])
        self.assertEqual([r["id"] for r in load(invitations.INVITATIONS_DIR)], [theirs["id"]])
        companies = {c["id"] for c in load(projects.COMPANIES_DIR)}
        self.assertEqual(companies, {self.company, new_company["id"]})
        self.assertNotIn(unused_company["id"], companies)
        self.assertEqual(sum(seed_recruiters.clean().values()), 0)


if __name__ == "__main__":
    unittest.main()
