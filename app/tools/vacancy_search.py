"""Окно «Вакансии» соискателя (значок 3 на рабочем столе portfolio-inner-site,
режим Applicant): открытые вакансии по релевантности для него и отклики на них.
Ранжирует app/tools/vacancy_ranking.py.

Отклик — запись в app/db/invitations того же формата, что приглашение рекрутёра
(app/tools/invitations.py): type «От кандидата рекрутеру», source «vacancies»,
снимок вакансии и история статусов. Рекрутёр видит его на вкладке «Обратная связь»
проекта окна «Проекты и вакансии» (значок 8) и в окне «Соискатели» (значок 9),
соискатель следит за статусом во вкладке «Отклики» окна «Приглашения» (значок 4).
Свой отклик соискателю не новость: applicant_seen ставится сразу.

Откликнуться можно на открытую вакансию (vacancy_ranking.open_vacancies) своей
специализации, не свою и только один раз: если на вакансию уже есть отклик или
приглашение — второй не создаётся. Задания вакансии решаются сразу, в отклике:
он уходит с ответами в статусе «Задание отправлено на проверку» (история
sent → task_sent_for_review); вакансия без заданий — «Отправлено» (sent).

API — app/tools/serve.py: GET /api/vacancies (listing), POST /api/vacancies/apply (apply).
"""

import json
import uuid

import applicant_invitations
import invitations
import projects
import ranking
import specializations
import vacancy_ranking
from users import UserError

PROJECT_FIELDS = ("summary", "domain", "stage", "duration", "start_date", "work_format", "city")


def _round(value):
    return round(value, 3) if isinstance(value, float) else value


def _record_view(record):
    """Отклик или приглашение на вакансию — коротко, для строки списка."""
    return {
        "id": record["id"],
        "type": applicant_invitations._type(record),
        "flow": applicant_invitations._flow(record),
        "status": invitations.status(record),
        "status_history": record["status_history"],
        "created_at": record.get("created_at"),
    }


def _own_records(user_id):
    """Отклики и приглашения соискателя: {vacancy_id: запись}, новая — последней."""
    found = [r for r in invitations.records()
             if isinstance(r, dict) and r.get("applicant_id") == user_id and applicant_invitations._valid(r)]
    found.sort(key=lambda r: r.get("created_at") or "")
    return {r["vacancy_id"]: r for r in found if isinstance(r.get("vacancy_id"), str)}


def _vacancy_view(entry, names):
    """Вакансия из выдачи vacancy_ranking — для окна."""
    vacancy, project = entry["vacancy"], entry["project"]
    recruiter_id = vacancy.get("user_id")
    if recruiter_id not in names:
        names[recruiter_id] = ranking._name(recruiter_id)
    fit = entry["fit"]
    rows = fit["requirements"]
    return {
        "id": vacancy["id"],
        "rank": entry["rank"],
        "relevance": entry["relevance"],
        "mutual": entry["mutual"],
        "title": vacancy.get("title"),
        "position_name": vacancy.get("position_name"),
        "specialization": entry["specialization"],
        "grade": vacancy.get("grade"),
        "count": vacancy.get("count", 1),
        "seats": entry["seats"],
        "task": vacancy.get("task"),
        "notes": vacancy.get("notes"),
        "requirements": entry["requirements"],
        "assignments": vacancy.get("assignments") or [],
        "salary": vacancy.get("salary"),
        "company": vacancy.get("company"),
        "project": {
            "id": project["id"],
            "name": project.get("name"),
            **{field: (vacancy.get("project") or {}).get(field) for field in PROJECT_FIELDS},
        },
        "recruiter_name": names[recruiter_id],
        "approved_at": vacancy.get("approved_at"),
        "fit": {
            "score": fit["score"],
            "grade": fit["grade"],
            "stack": fit["stack"],
            "meets": fit["meets"],
            "linked": fit["linked"],
            "requirements": None if rows is None else [
                {**row, "score": _round(row["score"]), "items": [{**i, "score": _round(i["score"])} for i in row["items"]]}
                for row in rows
            ],
        },
        "appeal": entry["appeal"],
        "queue": entry["queue"],
    }


def listing(user_id):
    """Что показать окну: {"specializations", "fsp_linked", "found", "weights",
    "growth", "vacancies", "stack", "kind_names", "degree_names", "flows", "grades"}.
    У вакансии — record: отклик или приглашение на неё (или None), can_apply."""
    result = vacancy_ranking.for_applicant(user_id)
    own = _own_records(result["user_id"])
    names, views = {}, []
    for entry in result["vacancies"]:
        view = _vacancy_view(entry, names)
        record = own.get(view["id"])
        view["record"] = record and _record_view(record)
        view["can_apply"] = record is None
        views.append(view)
    catalog = projects.Catalog()
    return {
        "specializations": result["specializations"],
        "fsp_linked": result["fsp_linked"],
        "found": result["found"],
        "weights": {**result["weights"], "fit": ranking.WEIGHTS["vacancy"]},
        "growth": {str(step): score for step, score in vacancy_ranking.GROWTH.items()},
        "vacancies": views,
        "stack": {kind: {i: item["name"] for i, item in items.items()} for kind, items in catalog.items.items()},
        "kind_names": catalog.questionnaire["rules"]["kind_names"],
        "degree_names": applicant_invitations.DEGREE_NAMES,
        "flows": invitations.FLOWS,
        "grades": list(ranking.GRADES),
    }


def _open_vacancy(user_id, vacancy_id):
    """Вакансия, на которую соискатель может откликнуться, и её проект."""
    vacancy = ranking.load_vacancy(vacancy_id)
    if vacancy.get("user_id") == user_id:
        raise UserError("На свою вакансию откликнуться нельзя", status=409)
    path = projects._project_path(vacancy.get("project_id"))
    project = projects._load(path) if path.is_file() else None
    if (project is None or not project.get("approved_at") or project.get("user_id") != vacancy.get("user_id")
            or vacancy["id"] not in (project.get("vacancy_ids") or [])):
        raise UserError("Вакансия больше не опубликована", status=404)
    if project.get("completed_at"):
        raise UserError("Набор по проекту завершён", status=409)
    if vacancy.get("status") != "ready":
        raise UserError("Вакансия ещё не опубликована: у рекрутёра остались открытые вопросы", status=409)
    return vacancy, project


def apply(user_id, vacancy_id, answers=None):
    """Отклик на вакансию; отвечает видом записи, как окно «Приглашения»
    (applicant_invitations._view). Повторный — 409."""
    user_id = specializations.check_user(user_id)
    vacancy, project = _open_vacancy(user_id, vacancy_id)
    specialization = vacancy.get("specialization")
    pool = [a for a in ranking.applicants(specialization, also=user_id) if a["user_id"] == user_id]
    if not pool:
        raise UserError(f"Откликнуться можно по своей специализации, а у вас нет {specialization}", status=403)
    assignments = vacancy.get("assignments") or []
    if assignments:
        answers = applicant_invitations._answers(answers, len(assignments))
    elif answers:
        raise UserError("У вакансии нет заданий — решения не нужны")
    result = ranking.by_vacancy(vacancy, pool=pool)
    entry = (result["candidates"] + result["unconfirmed"])[0]
    with invitations._lock:
        found = invitations.records()
        if any(r.get("vacancy_id") == vacancy["id"] and r.get("applicant_id") == user_id for r in found):
            raise UserError("На эту вакансию у вас уже есть отклик или приглашение — статус в «Приглашениях»", status=409)
        if invitations.is_closed(vacancy, invitations.vacancy_counts(found)):
            raise UserError("Вакансия закрыта: все места уже заняты", status=409)
        now = invitations._now()
        history = [{"status": "sent", "at": now}]
        if assignments:
            history.append({"status": "task_sent_for_review", "at": invitations._now()})
        record = {
            "id": str(uuid.uuid4()),
            "type": invitations.APPLICANT_TO_RECRUITER,
            "recruiter_id": vacancy["user_id"],
            "applicant_id": user_id,
            "project_id": project["id"],
            "vacancy_id": vacancy["id"],
            "vacancy": {key: value for key, value in vacancy.items() if key not in invitations.VACANCY_SKIP},
            "relevance": entry["relevance"],
            "source": invitations.APPLICATION_SOURCE,
            "flow": "assignment" if assignments else "plain",
            "status_history": history,
            "created_at": now,
        }
        if assignments:
            record["assignment_answers"] = answers
        record["applicant_seen"] = applicant_invitations._seen_marker(record)
        invitations.INVITATIONS_DIR.mkdir(parents=True, exist_ok=True)
        # "x": файл с таким именем не перезапишется, даже если uuid совпадёт.
        with open(invitations.INVITATIONS_DIR / f"{record['id']}.json", "x", encoding="utf-8", newline="\n") as file:
            json.dump(record, file, ensure_ascii=False, indent=2)
            file.write("\n")
    return applicant_invitations._view(record)
