"""Новости проектов рекрутёра (колонка окна 8).

Список не отмечает просмотр. Открытие проекта подтверждает только показанные
версии принятых приглашений без задания: recruiter_seen хранится отдельно от
applicant_seen, история и решения не меняются.
"""

import applicant_invitations
import invitations
import projects
from users import UserError

KINDS = ("new_applications", "accepted_invitations", "assignments_to_review")
TYPE_ALIASES = {
    "Соискатель - Рекрутёр": invitations.APPLICANT_TO_RECRUITER,
    "Рекрутёр - Соискатель": invitations.RECRUITER_TO_APPLICANT,
}


def _type(record):
    value = record.get("type")
    if value is None:
        value = invitations.RECRUITER_TO_APPLICANT
    return TYPE_ALIASES.get(value, value) if isinstance(value, str) else value


def _records(user_id, owned):
    """Только действующие связи приглашение → вакансия → собственный проект."""
    vacancy_projects = {}
    for project in owned:
        for vacancy in projects._approved_vacancies(project):
            if (isinstance(vacancy.get("id"), str)
                    and vacancy.get("user_id") == user_id and vacancy.get("project_id") == project["id"]
                    and vacancy.get("id") in (project.get("vacancy_ids") or [])):
                vacancy_projects[vacancy["id"]] = project["id"]
    return [record for record in invitations.records()
            if isinstance(record, dict) and record.get("recruiter_id") == user_id
            and isinstance(record.get("vacancy_id"), str) and isinstance(record.get("project_id"), str)
            and record.get("vacancy_id") in vacancy_projects
            and record.get("project_id") == vacancy_projects[record["vacancy_id"]]
            and applicant_invitations._valid({**record, "type": _type(record)})]


def _kind(record):
    current = invitations.status(record)
    if _type(record) == invitations.APPLICANT_TO_RECRUITER and current == "sent":
        return "new_applications"
    if (record["vacancy"].get("assignments")
            and current in ("task_sent_for_review", "task_needs_review")):
        return "assignments_to_review"
    if (_type(record) == invitations.RECRUITER_TO_APPLICANT
            and not record["vacancy"].get("assignments") and current == "accepted"
            and record.get("recruiter_seen") != applicant_invitations._seen_marker(record)):
        return "accepted_invitations"
    return None


def _counts(records):
    result = dict.fromkeys(KINDS, 0)
    for record in records:
        kind = _kind(record)
        if kind:
            result[kind] += 1
    return result


def summaries(user_id):
    user_id = projects.check_recruiter(user_id)
    with projects._lock, invitations._lock:
        owned = [p for p in projects._read_dir(projects.PROJECTS_DIR) if p.get("user_id") == user_id]
        result = {p["id"]: dict.fromkeys(KINDS, 0) for p in owned}
        for record in _records(user_id, owned):
            kind = _kind(record)
            if kind:
                result[record["project_id"]][kind] += 1
        return result


def snapshot(user_id, project_id):
    """Версии принятий на момент открытия: последующий ответ не будет погашен."""
    user_id = projects.check_recruiter(user_id)
    with projects._lock, invitations._lock:
        project = projects._own_project(user_id, project_id)
        records = _records(user_id, [project])
        return {
            "news": _counts(records),
            "accepted_news": [{"id": r["id"], "revision": len(r["status_history"])}
                              for r in records if _kind(r) == "accepted_invitations"],
        }


def read(user_id, project_id, accepted_news):
    """Подтвердить открытие проекта, сохранив новые ответы после снимка."""
    user_id = projects.check_recruiter(user_id)
    if not isinstance(accepted_news, list) or len(accepted_news) > 1000:
        raise UserError("Нет списка просмотренных принятий приглашений")
    checked = {}
    for item in accepted_news:
        if not isinstance(item, dict):
            raise UserError("Неверная отметка просмотра")
        invitation_id = projects._uuid(item.get("id"), "приглашение")
        revision = item.get("revision")
        if type(revision) is not int or revision < 1 or invitation_id in checked:
            raise UserError("Неверная версия приглашения")
        checked[invitation_id] = revision
    with projects._lock, invitations._lock:
        project = projects._own_project(user_id, project_id)
        records = _records(user_id, [project])
        by_id = {r["id"]: r for r in records}
        # Проверяем принадлежность всего запроса до первой записи.
        if any(invitation_id not in by_id for invitation_id in checked):
            raise UserError("Приглашение не найдено в проекте", status=404)
        for invitation_id, revision in checked.items():
            record = by_id[invitation_id]
            if len(record["status_history"]) == revision and _kind(record) == "accepted_invitations":
                record["recruiter_seen"] = applicant_invitations._seen_marker(record)
                invitations._write(invitations.INVITATIONS_DIR / f"{invitation_id}.json", record)
        return {"project_id": project["id"], "news": _counts(records)}
