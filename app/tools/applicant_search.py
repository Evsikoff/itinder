"""Окно «Соискатели» рекрутёра (значок 9 на рабочем столе portfolio-inner-site,
режим Recruiter): что показать на его экранах. Ранжирует app/tools/ranking.py,
приглашения пишет app/tools/invitations.py.

Экраны:
    overview — проекты рекрутёра, в которых можно искать (вакансии утверждены,
        набор не завершён), их вакансии и справочники для подписей; по нему окно
        решает, какие кнопки меню доступны.
    team — граф проекта: к каждой открытой вакансии по TEAM_SLOTS самых
        релевантных соискателей. Открытая — готова (status ready) и не закрыта
        (принятых приглашений меньше count). Один человек — одно место в команде:
        пары «вакансия — соискатель» разбираются по убыванию релевантности, кто уже
        занял место, дальше не идёт. Кто отказался от приглашения на вакансию или
        чьё решение задания отклонено, на неё больше не предлагается.
    vacancy — все соискатели специализации вакансии по релевантности, с разбором
        требований и приглашением на эту вакансию.
    search — все соискатели по специализации и грейду (любое можно не задавать),
        с приглашениями этого рекрутёра каждому.

Сам рекрутёр в выдачу не попадает, даже если он ещё и соискатель.

API — app/tools/serve.py: GET /api/applicants/overview, /api/applicants/team,
/api/applicants/vacancy, /api/applicants/search; POST /api/invitations.
"""

import grade_tests
import invitations
import projects
import ranking
from users import UserError

TEAM_SLOTS = 2  # сколько соискателей граф показывает у вакансии
TEAM_DEPTH = 30  # из скольких лучших по вакансии выбирать, чтобы места не повторялись
DEGREE_NAMES = {1: "базовая", 2: "уверенная", 3: "высокая"}  # fsp.DEGREES


def _round(value):
    return round(value, 3) if isinstance(value, float) else value


def _vacancy_view(vacancy, project, counts):
    """Вакансия для окна: что о ней показать и можно ли приглашать (open)."""
    invited = counts.get(vacancy["id"], dict.fromkeys(invitations.STATUSES, 0))
    closed = invitations.is_closed(vacancy, counts)
    return {
        "id": vacancy["id"],
        "project_id": project["id"],
        "project_name": project["name"],
        "company": vacancy.get("company"),
        "title": vacancy.get("title"),
        "position_name": vacancy.get("position_name"),
        "specialization": vacancy.get("specialization"),
        "grade": vacancy.get("grade"),
        "count": vacancy.get("count", 1),
        "task": vacancy.get("task"),
        "requirements": vacancy.get("requirements") or [],
        "assignments": vacancy.get("assignments") or [],
        "salary": vacancy.get("salary"),
        "status": vacancy.get("status"),
        "invited": invited,
        "closed": closed,
        "open": vacancy.get("status") == "ready" and not closed,
    }


def _projects(recruiter_id):
    """Проекты рекрутёра, в которых можно искать: [(проект, [вакансия])], новые первыми."""
    found = []
    for project in ranking._read_dir(projects.PROJECTS_DIR):
        if project.get("user_id") != recruiter_id or not project.get("approved_at") or project.get("completed_at"):
            continue
        vacancies = [v for v in projects._approved_vacancies(project) if v.get("specialization") in grade_tests.SPECIALIZATIONS]
        found.append((project, vacancies))
    found.sort(key=lambda pair: pair[0].get("created_at") or "", reverse=True)
    return found


def _own_project(recruiter_id, project_id):
    for project, vacancies in _projects(recruiter_id):
        if project["id"] == project_id:
            return project, vacancies
    raise UserError("Проект не найден, набор по нему завершён или вакансии не утверждены", status=404)


def _own_vacancy(recruiter_id, vacancy_id):
    for project, vacancies in _projects(recruiter_id):
        for vacancy in vacancies:
            if vacancy["id"] == vacancy_id:
                return project, vacancy
    raise UserError("Вакансия не найдена или набор по её проекту завершён", status=404)


def _pool(recruiter_id, specialization=None):
    """Соискатели без самого рекрутёра."""
    return [a for a in ranking.applicants(specialization) if a["user_id"] != recruiter_id]


def _candidate(entry):
    """Соискатель из выдачи ranking — для окна."""
    rows = entry["requirements"]
    return {
        "user_id": entry["user_id"],
        "name": entry["name"],
        "specialization": entry["specialization"],
        "rank": entry["rank"],
        "relevance": entry["relevance"],
        "grade": entry["grade"],
        "stack": entry["stack"],
        "profile": entry["profile"],
        "fsp_linked": entry["profile"] is not None,
        "fsp_points": entry["fsp_points"],
        "meets": entry["meets"],
        "competencies": [{"kind": c["kind"], "id": c["id"], "degree": c["degree"]} for c in entry["competencies"]],
        "requirements": None if rows is None else [
            {**row, "score": _round(row["score"]), "items": [{**i, "score": _round(i["score"])} for i in row["items"]]}
            for row in rows
        ],
    }


def overview(user_id):
    """Что нужно меню и выбору проекта или вакансии: {"projects", "stack",
    "kind_names", "degree_names", "flows", "specializations", "grades", "weights"}.
    flows — наборы статусов приглашений (invitations.FLOWS)."""
    recruiter_id = projects.check_recruiter(user_id)
    counts = invitations.vacancy_counts(invitations.records())
    reference = ranking.Reference()
    listed = []
    for project, vacancies in _projects(recruiter_id):
        company = projects._company_by_id(project["company_id"])
        listed.append({
            "id": project["id"],
            "name": project["name"],
            "company": {"id": company["id"], "name": company["name"]},
            "approved_at": project.get("approved_at"),
            "vacancies": [_vacancy_view(v, project, counts) for v in vacancies],
        })
    return {
        "projects": listed,
        "stack": {kind: {i: item["name"] for i, item in items.items()} for kind, items in reference.catalog.items.items()},
        "kind_names": reference.catalog.questionnaire["rules"]["kind_names"],
        "degree_names": DEGREE_NAMES,
        "flows": invitations.FLOWS,
        "specializations": list(grade_tests.SPECIALIZATIONS),
        "grades": list(ranking.GRADES),
        "weights": ranking.WEIGHTS,
    }


def team(user_id, project_id):
    """Граф проекта: {"project", "vacancies": [вакансия + "candidates", "declined"],
    "skipped": {"closed", "draft"}} — открытые вакансии по порядку проекта."""
    recruiter_id = projects.check_recruiter(user_id)
    project, vacancies = _own_project(recruiter_id, project_id)
    found = invitations.records()
    counts = invitations.vacancy_counts(found)
    sent = invitations.by_recruiter(recruiter_id, found)
    views = [_vacancy_view(v, project, counts) for v in vacancies]
    open_ = [(v, view) for v, view in zip(vacancies, views) if view["open"]]
    pool = _pool(recruiter_id)
    pairs = []  # (релевантность, порядок вакансии, место в выдаче, вакансия, запись выдачи)
    for order, (vacancy, _) in enumerate(open_):
        result = ranking.by_vacancy(vacancy, pool=pool)
        ranked = (result["candidates"] + result["unconfirmed"])[:TEAM_DEPTH]
        pairs += [(-entry["relevance"], order, place, vacancy["id"], entry) for place, entry in enumerate(ranked)]
    pairs.sort(key=lambda pair: pair[:3])
    chosen, used = {v["id"]: [] for v, _ in open_}, set()
    for _, _, _, vacancy_id, entry in pairs:
        invitation = sent.get((vacancy_id, entry["user_id"]))
        if len(chosen[vacancy_id]) >= TEAM_SLOTS or entry["user_id"] in used:
            continue
        if invitation and invitations.status(invitation) in invitations.REJECTED:
            continue
        chosen[vacancy_id].append({**_candidate(entry), "invitation": invitation and invitations.view(invitation)})
        used.add(entry["user_id"])
    company = projects._company_by_id(project["company_id"])
    return {
        "project": {"id": project["id"], "name": project["name"], "company": {"id": company["id"], "name": company["name"]}},
        "vacancies": [
            {
                **view,
                "candidates": sorted(chosen[vacancy["id"]], key=lambda c: -c["relevance"]),
                "declined": sum(view["invited"][s] for s in invitations.REJECTED),
            }
            for vacancy, view in open_
        ],
        "skipped": {
            "closed": sum(1 for view in views if view["closed"]),
            "draft": sum(1 for view in views if not view["closed"] and view["status"] != "ready"),
        },
    }


def vacancy(user_id, vacancy_id):
    """Соискатели вакансии: {"vacancy", "found", "linked", "meet_all", "weights",
    "candidates", "unconfirmed"} — у каждого приглашение на эту вакансию или None."""
    recruiter_id = projects.check_recruiter(user_id)
    project, record = _own_vacancy(recruiter_id, vacancy_id)
    found = invitations.records()
    sent = invitations.by_recruiter(recruiter_id, found)
    result = ranking.by_vacancy(record, pool=_pool(recruiter_id, record["specialization"]))

    def with_invitation(entry):
        invitation = sent.get((record["id"], entry["user_id"]))
        return {**_candidate(entry), "invitation": invitation and invitations.view(invitation)}

    return {
        "vacancy": _vacancy_view(record, project, invitations.vacancy_counts(found)),
        "found": result["found"],
        "linked": result["linked"],
        "meet_all": result["meet_all"],
        "weights": result["weights"],
        "candidates": [with_invitation(e) for e in result["candidates"]],
        "unconfirmed": [with_invitation(e) for e in result["unconfirmed"]],
    }


def search(user_id, specialization=None, grade=None):
    """Соискатели по специализации и грейду (None или "" — любые): {"query", "found",
    "linked", "meet_all", "weights", "candidates", "unconfirmed"} — у каждого
    приглашения этого рекрутёра (invitations)."""
    recruiter_id = projects.check_recruiter(user_id)
    specialization = specialization or None
    grade = grade or None
    result = ranking.by_specialization(specialization, grade, pool=_pool(recruiter_id, specialization))
    own = {}
    for invitation in invitations.by_recruiter(recruiter_id).values():
        own.setdefault(invitation["applicant_id"], []).append(invitations.view(invitation))

    def with_invitations(entry):
        return {**_candidate(entry), "invitations": own.get(entry["user_id"], [])}

    return {
        **{key: result[key] for key in ("query", "found", "linked", "meet_all", "weights")},
        "candidates": [with_invitations(e) for e in result["candidates"]],
        "unconfirmed": [with_invitations(e) for e in result["unconfirmed"]],
    }


def invite(user_id, vacancy_id, applicant_id, source):
    """Отправляет приглашение (invitations.create) и отвечает его view."""
    return invitations.create(user_id, vacancy_id, applicant_id, source)
