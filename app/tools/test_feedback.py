"""Обратная связь уже созданных seed_applicants для вакансий рекрутёра.

Не создаёт пользователей. Для существующих, не заполненных наймом вакансий
добавляет отклик и ответ тестового соискателя. При наличии ожидающего приглашения
отвечает на него, сохраняя снимок вакансии и всю прежнюю историю. Обычные аккаунты
и их приглашения не меняются. Принятие без задания считается наймом.
"""

import copy
import json
import os
import tempfile
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import applicant_invitations
import invitations
import project_news
import projects
import ranking
import users
from users import UserError

SEED_MARK = "seed_applicants"


def _valid_records(found):
    return [r for r in found if isinstance(r, dict)
            and all(isinstance(r.get(key), str) for key in ("applicant_id", "project_id", "vacancy_id"))
            and applicant_invitations._valid({**r, "type": project_news._type(r)})]


def _vacancies(user_id, found):
    """Не удалены, принадлежат проекту пользователя и не заполнены наймом.
    completed_at и status вакансии не добавляют ограничений к этому определению.
    """
    countable = [r for r in found if isinstance(r, dict) and isinstance(r.get("vacancy_id"), str)
                 and isinstance(r.get("status_history"), list) and r["status_history"]
                 and isinstance(r["status_history"][-1], dict)
                 and isinstance(r["status_history"][-1].get("status"), str)
                 and r["status_history"][-1]["status"] in invitations.STATUSES]
    counts = invitations.vacancy_counts(countable)
    result, seen = [], set()
    for project in projects._read_dir(projects.PROJECTS_DIR):
        if not isinstance(project, dict) or project.get("user_id") != user_id:
            continue
        for vacancy_id in project.get("vacancy_ids") or []:
            try:
                if projects._uuid(vacancy_id, "вакансия") != vacancy_id:
                    continue
                vacancy = projects._load(projects._vacancy_path(vacancy_id))
            except (OSError, ValueError, UserError):
                continue
            if (isinstance(vacancy, dict) and vacancy.get("id") == vacancy_id
                    and vacancy.get("user_id") == user_id and vacancy.get("project_id") == project.get("id")
                    and type(vacancy.get("count")) is int and vacancy["count"] > 0
                    and vacancy_id not in seen and not invitations.is_closed(vacancy, counts)):
                result.append(vacancy)
                seen.add(vacancy_id)
    return result


def availability(user_id):
    user_id = projects.check_recruiter(user_id)
    with projects._lock, invitations._lock:
        result = {}
        for vacancy in _vacancies(user_id, invitations.records()):
            result[vacancy["project_id"]] = result.get(vacancy["project_id"], 0) + 1
        return result


def _time_after(history):
    moment = datetime.now(timezone.utc)
    if history:
        try:
            previous = datetime.fromisoformat(history[-1]["at"].replace("Z", "+00:00"))
            if previous.tzinfo is None:
                previous = previous.replace(tzinfo=timezone.utc)
            moment = max(moment, previous + timedelta(microseconds=1))
        except (KeyError, TypeError, ValueError):
            pass
    return moment.isoformat()


def _new(user_id, vacancy, candidate, direction, batch):
    ranked = ranking.by_vacancy(vacancy, pool=[candidate])
    entry = (ranked["candidates"] + ranked["unconfirmed"])[0]
    now = _time_after([])
    return {
        "id": str(uuid.uuid4()), "type": direction,
        "recruiter_id": user_id, "applicant_id": candidate["user_id"],
        "project_id": vacancy["project_id"], "vacancy_id": vacancy["id"],
        "vacancy": copy.deepcopy({key: value for key, value in vacancy.items() if key not in invitations.VACANCY_SKIP}),
        "relevance": entry["relevance"], "source": "vacancy",
        "flow": "assignment" if vacancy.get("assignments") else "plain",
        "status_history": [{"status": "sent", "at": now}], "created_at": now,
        "test_feedback": {"version": 1, "batch": batch},
    }


def _reply(record, batch, forward):
    result = copy.deepcopy(record)
    assignments = result["vacancy"].get("assignments") or []
    state = "task_sent_for_review" if assignments else "accepted"
    if assignments:
        result["assignment_answers"] = [
            f"Тестовое решение задания {index}:\n{task}\n\n"
            "План решения: уточнить условия, подготовить реализацию и проверить результат.\n"
            "Проверки: основной сценарий, граничные значения и обработка ошибок."
            for index, task in enumerate(assignments, 1)
        ]
    result["status_history"].append({"status": state, "at": _time_after(result["status_history"])})
    result["applicant_seen"] = applicant_invitations._seen_marker(result)
    if assignments and forward:
        result["status_history"].append({"status": "task_needs_review", "at": _time_after(result["status_history"])})
    result["test_feedback"] = {"version": 1, "batch": batch}
    return result


def _restore(path, data):
    """Вернуть точные байты изменённого приглашения при ошибке пакета."""
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="wb", dir=path.parent, delete=False,
                                         prefix=f".{path.stem}.", suffix=".tmp") as file:
            temporary = Path(file.name)
            file.write(data)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def _commit(new, updates):
    created, originals = [], {}
    invitations.INVITATIONS_DIR.mkdir(parents=True, exist_ok=True)
    try:
        for record in new:
            path = invitations.INVITATIONS_DIR / f"{record['id']}.json"
            with open(path, "x", encoding="utf-8", newline="\n") as file:
                created.append(path)
                json.dump(record, file, ensure_ascii=False, indent=2)
                file.write("\n")
        for record in updates:
            path = invitations.INVITATIONS_DIR / f"{record['id']}.json"
            originals[path] = path.read_bytes()
            invitations._write(path, record)
    except Exception:
        for path, data in originals.items():
            _restore(path, data)
        for path in created:
            path.unlink(missing_ok=True)
        raise


def generate(user_id):
    user_id = projects.check_recruiter(user_id)
    with projects._lock, invitations._lock:
        found = invitations.records()
        vacancies = _vacancies(user_id, found)
        if not vacancies:
            raise UserError("Нет существующих вакансий, не закрытых наймом", status=409)
        seeded = {record["id"] for record in projects._read_dir(users.USERS_DIR)
                  if isinstance(record, dict) and record.get("seed") == SEED_MARK and isinstance(record.get("id"), str)}
        candidates = {}
        for candidate in ranking.applicants():
            if candidate["user_id"] in seeded and candidate["user_id"] != user_id:
                candidates.setdefault(candidate["specialization"], []).append(candidate)
        if not candidates:
            raise UserError("Нет доступных тестовых соискателей из уже созданного набора", status=409)
        used = {(record["vacancy_id"], record["applicant_id"]) for record in found
                if isinstance(record, dict) and record.get("recruiter_id") == user_id
                and isinstance(record.get("vacancy_id"), str) and isinstance(record.get("applicant_id"), str)}
        valid_records = _valid_records(found)
        new, updates, assignment_index = [], [], 0
        batch = str(uuid.uuid4())
        result = {"created_applications": 0, "accepted_invitations": 0,
                  "submitted_assignments": 0, "forwarded_assignments": 0}
        for vacancy in vacancies:
            pool = candidates.get(vacancy.get("specialization"), [])
            pool_ids = {candidate["user_id"] for candidate in pool}
            pending = next((r for r in valid_records if r.get("recruiter_id") == user_id
                            and r.get("project_id") == vacancy["project_id"] and r.get("vacancy_id") == vacancy["id"]
                            and r.get("applicant_id") in pool_ids
                            and project_news._type(r) == invitations.RECRUITER_TO_APPLICANT
                            and invitations.status(r) in ("sent", "read")), None)

            def unused():
                return next((candidate for candidate in pool
                             if (vacancy["id"], candidate["user_id"]) not in used), None)

            applicant = unused()
            if applicant:
                application = _new(user_id, vacancy, applicant, invitations.APPLICANT_TO_RECRUITER, batch)
                application["applicant_seen"] = applicant_invitations._seen_marker(application)
                new.append(application)
                used.add((vacancy["id"], applicant["user_id"]))
                result["created_applications"] += 1
            incoming = pending
            if incoming is None:
                applicant = unused()
                if applicant:
                    incoming = _new(user_id, vacancy, applicant, invitations.RECRUITER_TO_APPLICANT, batch)
                    used.add((vacancy["id"], applicant["user_id"]))
            if incoming is not None:
                assignment = bool(incoming["vacancy"].get("assignments"))
                forward = assignment and assignment_index % 2 == 1
                answered = _reply(incoming, batch, forward)
                (updates if pending is not None else new).append(answered)
                result["submitted_assignments" if assignment else "accepted_invitations"] += 1
                if assignment:
                    assignment_index += 1
                    result["forwarded_assignments"] += int(forward)
        if not new and not updates:
            raise UserError("Нет новых тестовых соискателей подходящих специализаций или ожидающих приглашений", status=409)
        _commit(new, updates)
        return {**result, "created_invitations": len(new), "updated_invitations": len(updates),
                "invitation_ids": [record["id"] for record in [*new, *updates]]}
