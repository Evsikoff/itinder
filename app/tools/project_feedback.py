"""Дерево обратной связи проекта и решения рекрутёра в окне 8.

Релевантность — ranking.by_vacancy, как в окне 9. Почта кандидата возвращается
только после accepted. Передача эксперту имитируется: сохраняются адрес и статус,
никакой почтовый сервис не вызывается. История, снимок и ответы не переписываются.
"""

import copy
import math

import applicant_invitations
import invitations
import project_news
import projects
import ranking
import users
from users import UserError


def _vacancies(user_id, project):
    return [v for v in projects._approved_vacancies(project)
            if isinstance(v, dict) and v.get("user_id") == user_id
            and v.get("project_id") == project["id"] and isinstance(v.get("id"), str)]


def _records(user_id, project):
    records = project_news._records(user_id, [project])
    result = []
    for record in records:
        uid = record.get("applicant_id")
        try:
            if isinstance(uid, str) and projects._uuid(uid, "соискатель") == uid:
                result.append(record)
        except UserError:
            continue
    return result


def _email(applicant_id):
    try:
        uid = projects._uuid(applicant_id, "соискатель")
        record = projects._load(users.USERS_DIR / f"{uid}.json")
    except (OSError, ValueError):
        return None
    return record.get("email") if isinstance(record, dict) and record.get("id") == uid and isinstance(record.get("email"), str) else None


def _relevance(value):
    return value if type(value) in (int, float) and math.isfinite(value) and 0 <= value <= 100 else None


def _can_respond_application(record):
    return (project_news._type(record) == invitations.APPLICANT_TO_RECRUITER
            and invitations.status(record) in ("sent", "read"))


def _view(record, relevance, name):
    state = invitations.status(record)
    flow = applicant_invitations._flow(record)
    expert = record.get("expert_review")
    return {
        "id": record["id"], "applicant_id": record["applicant_id"], "name": name,
        "type": project_news._type(record),
        "kind": "application" if project_news._type(record) == invitations.APPLICANT_TO_RECRUITER else "invitation",
        "flow": flow, "status": state, "status_name": invitations.FLOWS[flow][state],
        "revision": len(record["status_history"]), "status_history": record["status_history"],
        "relevance": _relevance(relevance), "created_at": record.get("created_at"),
        "email": _email(record["applicant_id"]) if state == "accepted" else None,
        "assignments": record["vacancy"].get("assignments") or [],
        "assignment_answers": record.get("assignment_answers") or [],
        "expert_email": expert.get("email") if isinstance(expert, dict) else None,
        "can_send_to_expert": flow == "assignment" and state == "task_sent_for_review",
        "can_decide": flow == "assignment" and state == "task_needs_review",
        "can_respond_application": _can_respond_application(record),
    }


def tree(user_id, project_id):
    user_id = projects.check_recruiter(user_id)
    with projects._lock, invitations._lock:
        project = projects._own_project(user_id, project_id)
        vacancies, records = _vacancies(user_id, project), _records(user_id, project)
        needed = {r["applicant_id"] for r in records}
        pool = [candidate for candidate in ranking.applicants() if candidate["user_id"] in needed] if needed else []
        result = []
        for vacancy in vacancies:
            own = [r for r in records if r["vacancy_id"] == vacancy["id"]]
            scores, names = {}, {}
            candidates = [candidate for candidate in pool if candidate["specialization"] == vacancy.get("specialization")]
            if candidates:
                ranked = ranking.by_vacancy(vacancy, pool=candidates)
                for candidate in ranked["candidates"] + ranked["unconfirmed"]:
                    scores[candidate["user_id"]] = candidate["relevance"]
                    names[candidate["user_id"]] = candidate["name"]
            own.sort(key=lambda r: (r.get("created_at") or "", r["id"]), reverse=True)
            accepted = sum(invitations.status(r) == "accepted" for r in own)
            count = vacancy.get("count", 1)
            result.append({
                "id": vacancy["id"], "title": vacancy.get("title") or vacancy.get("position_name") or "Вакансия",
                "count": count, "accepted": accepted, "closed_at": vacancy.get("closed_at"),
                "can_close": accepted >= count and not vacancy.get("closed_at"),
                "invitations": [_view(r, scores.get(r["applicant_id"], r.get("relevance")),
                                      names.get(r["applicant_id"]) or ranking._name(r["applicant_id"])) for r in own],
            })
        return {"project_id": project["id"], "vacancies": result}


def review(user_id, project_id, invitation_id, action, email, expected_revision):
    user_id = projects.check_recruiter(user_id)
    invitation_id = projects._uuid(invitation_id, "приглашение")
    with projects._lock, invitations._lock:
        project = projects._own_project(user_id, project_id)
        record = next((r for r in _records(user_id, project) if r["id"] == invitation_id), None)
        if record is None:
            raise UserError("Приглашение не найдено в этом проекте", status=404)
        applicant_invitations._revision(record, expected_revision)
        if applicant_invitations._flow(record) != "assignment":
            raise UserError("У этого приглашения нет заданий", status=409)
        state = invitations.status(record)
        result = copy.deepcopy(record)
        if action == "send":
            if state != "task_sent_for_review":
                raise UserError("Решение ещё не отправлено кандидатом или уже передано эксперту", status=409)
            if not isinstance(email, str) or len(email.strip()) > users.MAX_EMAIL or not users.EMAIL.fullmatch(email.strip()):
                raise UserError("Введите корректный e-mail эксперта")
            state = "task_needs_review"
            result["expert_review"] = {"email": email.strip(), "sent_at": invitations._now(), "simulated": True}
        elif action in ("approve", "reject"):
            if state != "task_needs_review":
                raise UserError("Сначала отправьте решение эксперту на проверку", status=409)
            state = "accepted" if action == "approve" else "solution_rejected"
            expert = result.get("expert_review")
            if not isinstance(expert, dict):
                expert = {}
            result["expert_review"] = {**expert, "decision": action, "decision_at": invitations._now()}
        else:
            raise UserError("Неизвестное действие проверки")
        applicant_invitations._append(result, state)
        invitations._write(invitations.INVITATIONS_DIR / f"{result['id']}.json", result)
        return {"id": result["id"], "status": state, "revision": len(result["status_history"])}


def respond_application(user_id, project_id, invitation_id, action, expected_revision):
    """Первый ответ рекрутёра на отклик: accept → accepted, decline → declined."""
    user_id = projects.check_recruiter(user_id)
    invitation_id = projects._uuid(invitation_id, "отклик")
    if action not in ("accept", "decline"):
        raise UserError("Ответ на отклик — принять или отклонить")
    with projects._lock, invitations._lock:
        project = projects._own_project(user_id, project_id)
        record = next((r for r in _records(user_id, project) if r["id"] == invitation_id), None)
        if record is None:
            raise UserError("Отклик не найден в этом проекте", status=404)
        applicant_invitations._revision(record, expected_revision)
        if not _can_respond_application(record):
            raise UserError("Ответить можно только на новый отклик соискателя", status=409)
        result = copy.deepcopy(record)
        state = "accepted" if action == "accept" else "declined"
        applicant_invitations._append(result, state)
        invitations._write(invitations.INVITATIONS_DIR / f"{result['id']}.json", result)
        return {"id": result["id"], "status": state, "revision": len(result["status_history"])}


def close_vacancy(user_id, project_id, vacancy_id):
    user_id = projects.check_recruiter(user_id)
    vacancy_id = projects._uuid(vacancy_id, "вакансия")
    with projects._lock, invitations._lock:
        project = projects._own_project(user_id, project_id)
        vacancy = next((v for v in _vacancies(user_id, project) if v["id"] == vacancy_id), None)
        if vacancy is None:
            raise UserError("Вакансия не найдена в этом проекте", status=404)
        accepted = sum(r["vacancy_id"] == vacancy_id and invitations.status(r) == "accepted"
                       for r in _records(user_id, project))
        if accepted < vacancy.get("count", 1):
            raise UserError("Закрыть вакансию можно, когда приглашения приняты на все места", status=409)
        if not vacancy.get("closed_at"):
            vacancy["closed_at"] = invitations._now()
            vacancy["updated_at"] = vacancy["closed_at"]
            projects._write(projects._vacancy_path(vacancy_id), vacancy)
        return {"id": vacancy_id, "closed_at": vacancy["closed_at"]}
