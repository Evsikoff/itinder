"""Тестовые проекты кнопки окон «Проекты и вакансии» (8) и «Соискатели» (9).

Используется обычный путь projects.create → projects.approve: проекты принадлежат
рекрутёру, вакансии связаны с ними, утверждены, имеют вилку и готовый стек из
справочников. Набор — два проекта по четыре вакансии (все IT-специализации).
Каждый запрос добавляет новый набор с отдельными идентификаторами проектов и
вакансий. Прежние проекты, их копии и приглашения сохраняются. Незавершённое
создание можно продолжить, только если черновик ещё в точности соответствует
шаблону генератора.
"""

import threading

import projects

VERSION = 1
MARKER = "test_generation"
COMPANY = "ITinder — тестовая компания"
_lock = threading.Lock()  # двойное нажатие и параллельные запросы одного сервера

# position, grade, salary_from, salary_to, task, requirements, assignments.
# requirement: kind, item_id, importance. Степень required берётся из анкеты.
TEMPLATES = (
    {
        "id": "store",
        "name": "Тестовый проект: интернет-магазин",
        "description": "Веб-магазин: каталог товаров, корзина, оформление заказа и кабинет покупателя.",
        "domain": "retail",
        "duration": "3to6",
        "qa_focus": ["logic", "web_ui", "data"],
        "vacancies": (
            ("backend_main", "Middle", 160_000, 220_000,
             "Разработать API каталога, корзины и заказов, спроектировать схему PostgreSQL и обработку ошибок.",
             (("languages", "python", "required"), ("databases", "postgresql", "required"),
              ("integrations", "rest", "required"), ("databases", "redis", "plus")), ()),
            ("frontend_web", "Junior", 80_000, 120_000,
             "Реализовать страницы каталога и корзины, подключить REST API и обработать загрузку и ошибки.",
             (("languages", "typescript", "required"), ("integrations", "rest", "required"),
              ("integrations", "oidc", "plus")), ()),
            ("qa", "Junior", 70_000, 110_000,
             "Проверить оформление заказа, подготовить граничные сценарии и автотесты API.",
             (("languages", "python", "required"), ("testing", "test_design", "required"),
              ("testing", "pytest", "required"), ("testing", "playwright", "plus")),
             ("Составьте пять проверок оформления заказа, включая граничные и негативные случаи.",)),
            ("analyst", "Middle", 130_000, 190_000,
             "Описать жизненный цикл заказа, модель данных и контракт API для команды разработки.",
             (("languages", "sql", "required"), ("databases", "postgresql", "required"),
              ("integrations", "rest", "required")), ()),
        ),
    },
    {
        "id": "analytics",
        "name": "Тестовый проект: платформа аналитики",
        "description": "Платформа сбора событий и отчётов: загрузка данных, показатели и веб-панель аналитики.",
        "domain": "internal",
        "duration": "6to12",
        "qa_focus": ["data", "reports", "load"],
        "vacancies": (
            ("backend_main", "Senior", 250_000, 350_000,
             "Спроектировать приём событий через Kafka, хранение данных и надёжное API отчётов.",
             (("languages", "python", "required"), ("databases", "postgresql", "required"),
              ("integrations", "kafka", "required"), ("databases", "clickhouse", "plus")),
             ("Опишите, как обработать повторную доставку события и восстановить обработку после сбоя.",)),
            ("frontend_web", "Middle", 170_000, 240_000,
             "Создать веб-панель с фильтрами отчётов и графиками, подключить API и обновление показателей.",
             (("languages", "typescript", "required"), ("integrations", "rest", "required"),
              ("integrations", "websocket", "plus")), ()),
            ("qa", "Middle", 130_000, 190_000,
             "Автоматизировать проверки веб-панели и отчётов, проверить корректность данных и нагрузку.",
             (("languages", "python", "required"), ("testing", "test_design", "required"),
              ("testing", "playwright", "required"), ("testing", "k6", "plus")), ()),
            ("analyst", "Senior", 210_000, 290_000,
             "Согласовать бизнес-показатели, структуру событий и модель аналитических данных с заказчиком.",
             (("languages", "sql", "required"), ("databases", "clickhouse", "required"),
              ("integrations", "kafka", "required")), ()),
        ),
    },
)


def _payload(template, catalog):
    """Ответы и сводка в формате обычной анкеты; стек известен заранее."""
    vacancies, fixed = [], {}
    rules = catalog.questionnaire["rules"]
    for position_id, grade, low, high, task, rows, assignments in template["vacancies"]:
        position = catalog.positions[position_id]
        requirements = []
        for kind, item_id, importance in rows:
            reason = "Стек тестового проекта для демонстрации поиска соискателей"
            requirements.append({
                "kind": kind, "ids": [item_id], "match": "all", "importance": importance,
                "min_degree": rules["default_min_degree"]["required"][grade]
                if importance == "required" else rules["default_min_degree"]["plus"],
                "origin": "fixed", "reasons": [reason],
            })
            item = fixed.setdefault((kind, item_id), {
                "kind": kind, "id": item_id, "positions": [], "reasons": [reason],
            })
            item["positions"].append(position_id)
        vacancies.append({
            "title": f"{position['name']} ({grade})", "position": position_id,
            "grade": grade, "count": 1, "task": task, "requirements": requirements,
            "assignments": list(assignments), "salary": {"from": low, "to": high},
            "notes": "Тестовая вакансия. Данные и зарплатная вилка приведены для демонстрации.",
        })

    # Нужна также обычная, пригодная для просмотра анкета проекта. Действующий
    # продукт с известным стеком не требует выбора технологий по рынку.
    answers = {
        "project_summary": template["description"], "domain": template["domain"],
        "stage": "active", "duration": template["duration"], "work_format": "remote",
        "clients": ["web"], "stack_limits": ["none"],
        "existing_stack": {kind: [item for k, item in fixed if k == kind]
                           for kind in ("languages", "databases", "integrations")},
        "existing_tests": {"testing": [item for k, item in fixed if k == "testing"]},
        "current_team": {role: {"Senior": 1} for role in ("backend", "frontend", "qa", "analyst")},
        "knowledge_holder": "yes", "load": "medium", "third_party_api": "no",
        "qa_mode": "own_qa", "qa_automation": "auto", "qa_focus": template["qa_focus"],
        "requirements_state": "partial",
        "team_plan": {v["position"]: {v["grade"]: v["count"]} for v in vacancies},
    }
    for item in fixed.values():
        key = f"fixed_details[{item['kind']}:{item['id']}]"
        answers[f"{key}.positions"] = item["positions"]
        # В редакторе вакансий допускаются индивидуальные уточнения требований.
        answers[f"{key}.importance"] = "required"
        answers[f"{key}.depth"] = "by_grade"
    for vacancy in vacancies:
        key = f"vacancies[{vacancy['position']}:{vacancy['grade']}]"
        for field in ("title", "task", "requirements", "assignments", "salary", "notes"):
            answers[f"{key}.{field}"] = vacancy[field]
    summary = {
        "stack_mode": "fixed", "kind_mode": {kind: "fixed" for kind in catalog.items},
        "mobile_variant": None,
        "positions": [{"id": v["position"], "role": catalog.positions[v["position"]]["role"],
                       "name": catalog.positions[v["position"]]["name"]} for v in vacancies],
        "fixed_stack": list(fixed.values()), "choices": [],
        "team_plan": answers["team_plan"], "open_questions": [],
        MARKER: {"version": VERSION, "template": template["id"]},
    }
    # Validate every template before creating the first project; Catalog is the
    # same authority the ordinary create/approve endpoints use.
    projects._vacancies(vacancies, catalog, approve=True)
    return {"name": template["name"], "company": {"name": COMPANY},
            "answers": answers, "summary": summary, "vacancies": vacancies}


def _originals(user_id, template_id):
    marker = {"version": VERSION, "template": template_id}
    found = [p for p in projects._read_dir(projects.PROJECTS_DIR)
             if p.get("user_id") == user_id and not p.get("copied_from")
             and (p.get("summary") or {}).get(MARKER) == marker]
    return sorted(found, key=lambda p: p.get("created_at") or "", reverse=True)


def _untouched_draft(project, payload, catalog):
    """Восстанавливаем только собственный неизменённый черновик после ошибки."""
    return (not project.get("approved_at") and not project.get("completed_at")
            and project.get("name") == payload["name"] and project.get("answers") == payload["answers"]
            and project.get("summary") == payload["summary"]
            and project.get("vacancies_draft") == projects._vacancies(payload["vacancies"], catalog, approve=False))


def generate(user_id):
    """Добавить набор: created_projects/created_vacancies — созданное в этом запросе,
    project_ids/vacancy_ids — новый набор, включая восстановленный после ошибки черновик.
    POST /api/applicants/test-projects. Никаких запросов к LLM или новых соискателей.
    """
    user_id = projects.check_recruiter(user_id)
    # RLock в projects позволяет использовать create/approve внутри общей
    # транзакции и защищает проверенный черновик от одновременной ручной правки.
    with _lock, projects._lock:
        catalog = projects.Catalog()
        prepared = [(template, _payload(template, catalog)) for template in TEMPLATES]
        result = {"created_projects": 0, "created_vacancies": 0, "project_ids": [], "vacancy_ids": []}
        for template, payload in prepared:
            originals = _originals(user_id, template["id"])
            project = next((p for p in originals if _untouched_draft(p, payload, catalog)), None)
            if project is None:
                view = projects.create(user_id, payload)
                project = projects._load(projects._project_path(view["id"]))
                result["created_projects"] += 1
            view = projects.approve(user_id, project["id"], payload["vacancies"], [])
            result["created_vacancies"] += len(view["vacancies_list"])
            result["project_ids"].append(view["id"])
            result["vacancy_ids"].extend(v["id"] for v in view["vacancies_list"])
        return result
