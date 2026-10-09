"""Приглашения и исходящие отклики соискателя — приложение рабочего стола 4.

Входящие приглашения без заданий получают status read при просмотре, затем
accepted или declined. При заданиях просмотр отмечается только applicant_seen,
а принятие с ответами переводит приглашение в task_sent_for_review. Исходящие
отклики доступны только для просмотра: соискатель не меняет их статус.

Снимок вакансии и история никогда не переписываются. Новый статус дописывается
в status_history того же JSON, решения — assignment_answers. applicant_seen
запоминает последний показанный статус (status, at, revision) и гасит уведомление
только до следующего изменения. Чтение списка само по себе ничего не меняет.
"""

import copy
import json
import uuid

import invitations
import projects
import ranking
import specializations
from users import UserError

MAX_ANSWER = 5000
MAX_BODY = 512 * 1024
DEGREE_NAMES = {1: "базовая", 2: "уверенная", 3: "высокая"}
OUTGOING_ALIAS = "Соискатель - Рекрутёр"


def _type(record):
    value = record.get("type")
    if value is None:
        value = invitations.RECRUITER_TO_APPLICANT
    return invitations.APPLICANT_TO_RECRUITER if value == OUTGOING_ALIAS else value


def _flow(record):
    if record.get("flow") is not None:
        return record["flow"]
    return "assignment" if record.get("vacancy", {}).get("assignments") else "plain"


def _valid_vacancy(vacancy):
    assignments = vacancy.get("assignments")
    requirements = vacancy.get("requirements")
    if assignments is not None and (not isinstance(assignments, list)
                                    or not all(isinstance(task, str) for task in assignments)):
        return False
    if requirements is not None and (not isinstance(requirements, list)
                                     or not all(isinstance(row, dict) and isinstance(row.get("kind"), str)
                                                and isinstance(row.get("ids"), list)
                                                and all(isinstance(item, (str, int)) for item in row["ids"])
                                                for row in requirements)):
        return False
    for key in ("title", "position_name", "specialization", "grade", "task", "notes"):
        if vacancy.get(key) is not None and not isinstance(vacancy[key], str):
            return False
    for key, fields in (("company", ("name",)), ("project", ("name", "summary"))):
        item = vacancy.get(key)
        if item is not None and (not isinstance(item, dict)
                                 or any(item.get(field) is not None and not isinstance(item[field], str)
                                        for field in fields)):
            return False
    return True


def _valid(record):
    """Повреждённые записи не мешают открывать остальные приглашения."""
    if not isinstance(record, dict) or _type(record) not in invitations.TYPES:
        return False
    if not isinstance(record.get("id"), str) or not isinstance(record.get("vacancy"), dict):
        return False
    if not _valid_vacancy(record["vacancy"]):
        return False
    answers = record.get("assignment_answers")
    if answers is not None and (not isinstance(answers, list) or not all(isinstance(answer, str) for answer in answers)):
        return False
    try:
        if str(uuid.UUID(record["id"])) != record["id"]:
            return False
    except ValueError:
        return False
    flow, history = _flow(record), record.get("status_history")
    return (isinstance(flow, str) and flow in invitations.FLOWS and isinstance(history, list) and bool(history)
            and (flow == "assignment") == bool(record["vacancy"].get("assignments"))
            and (record.get("created_at") is None or isinstance(record["created_at"], str))
            and all(isinstance(row, dict) and isinstance(row.get("status"), str)
                    and row["status"] in invitations.FLOWS[flow]
                    and isinstance(row.get("at"), str) for row in history))


def _seen_marker(record):
    current = record["status_history"][-1]
    return {"status": current["status"], "at": current["at"], "revision": len(record["status_history"])}


def _unseen(record):
    return record.get("applicant_seen") != _seen_marker(record)


def _can_respond(record):
    return (_type(record) == invitations.RECRUITER_TO_APPLICANT
            and invitations.status(record) in ("sent", "read")
            and invitations.status(record) in invitations.FLOWS[_flow(record)])


def _view(record):
    answers = record.get("assignment_answers")
    recruiter_name = ranking._name(record.get("recruiter_id"))
    marker = record.get("test_generation")
    # Демозаписи не создают аккаунты рекрутёров: имя хранится в их маркере.
    if (not recruiter_name and isinstance(marker, dict) and marker.get("version") == 1
            and isinstance(marker.get("recruiter_name"), str)):
        recruiter_name = marker["recruiter_name"]
    vacancy = copy.deepcopy(record["vacancy"])
    # В прежних снимках необязательные пустые массивы могли отсутствовать.
    vacancy["assignments"] = vacancy.get("assignments") or []
    vacancy["requirements"] = vacancy.get("requirements") or []
    return {
        "id": record["id"],
        "type": _type(record),
        "flow": _flow(record),
        "status": invitations.status(record),
        "status_history": copy.deepcopy(record["status_history"]),
        "revision": len(record["status_history"]),
        "created_at": record.get("created_at"),
        "recruiter_id": record.get("recruiter_id"),
        "recruiter_name": recruiter_name,
        "vacancy": vacancy,
        "assignment_answers": copy.deepcopy(answers) if isinstance(answers, list) else None,
        "unseen": _unseen(record),
        "can_respond": _can_respond(record),
    }


def _own_records(user_id):
    return [record for record in invitations.records()
            if isinstance(record, dict) and record.get("applicant_id") == user_id and _valid(record)]


def list_for_user(user_id):
    """Список обеих направлений и справочники. Не подтверждает просмотр."""
    user_id = specializations.check_user(user_id)
    with invitations._lock:
        records = _own_records(user_id)
        records.sort(key=lambda record: (record.get("created_at") or "", record["id"]), reverse=True)
        views = [_view(record) for record in records]
    catalog = projects.Catalog()
    return {
        "invitations": views,
        "flows": invitations.FLOWS,
        "stack": {kind: {item_id: item["name"] for item_id, item in items.items()}
                  for kind, items in catalog.items.items()},
        "kind_names": catalog.questionnaire["rules"]["kind_names"],
        "degree_names": DEGREE_NAMES,
    }


def _own(user_id, invitation_id):
    try:
        invitation_id = str(uuid.UUID(str(invitation_id)))
    except ValueError:
        raise UserError("Приглашение не найдено", status=404) from None
    path = invitations.INVITATIONS_DIR / f"{invitation_id}.json"
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise UserError("Приглашение не найдено", status=404) from None
    if (not _valid(record) or record["id"] != invitation_id
            or record.get("applicant_id") != user_id):
        raise UserError("Приглашение не найдено", status=404)
    return path, record


def _revision(record, expected_revision):
    if not isinstance(expected_revision, int) or isinstance(expected_revision, bool) or expected_revision < 1:
        raise UserError("Нет версии приглашения — обновите список")
    if expected_revision != len(record["status_history"]):
        raise UserError("Статус приглашения изменился — обновите список", status=409)


def _append(record, status):
    record["status_history"].append({"status": status, "at": invitations._now()})


def read(user_id, invitation_id, expected_revision):
    """Показывает приглашение и подтверждает ровно эту версию его статуса."""
    user_id = specializations.check_user(user_id)
    with invitations._lock:
        path, record = _own(user_id, invitation_id)
        _revision(record, expected_revision)
        changed = False
        if (_type(record) == invitations.RECRUITER_TO_APPLICANT
                and _flow(record) == "plain" and invitations.status(record) == "sent"):
            _append(record, "read")
            changed = True
        if _unseen(record):
            record["applicant_seen"] = _seen_marker(record)
            changed = True
        if changed:
            invitations._write(path, record)
        return _view(record)


def _answers(value, count):
    if not isinstance(value, list) or len(value) != count:
        raise UserError("Заполните ответ на каждое задание")
    checked = []
    for index, answer in enumerate(value, 1):
        if not isinstance(answer, str) or not answer.strip():
            raise UserError(f"Задание {index}: заполните ответ")
        if len(answer) > MAX_ANSWER:
            raise UserError(f"Задание {index}: не больше {MAX_ANSWER} символов")
        checked.append(answer.strip())
    return checked


def respond(user_id, invitation_id, action, answers, expected_revision):
    """Принимает/отклоняет входящее приглашение; один переход на одну версию."""
    user_id = specializations.check_user(user_id)
    if action not in ("accept", "decline"):
        raise UserError("Неизвестное действие с приглашением")
    with invitations._lock:
        path, record = _own(user_id, invitation_id)
        _revision(record, expected_revision)
        if _type(record) == invitations.APPLICANT_TO_RECRUITER:
            raise UserError("Отклики доступны только для просмотра статуса", status=403)
        if not _can_respond(record):
            raise UserError("На это приглашение уже нельзя ответить", status=409)
        next_status = "declined"
        if action == "accept":
            if _flow(record) == "assignment":
                assignments = record["vacancy"].get("assignments") or []
                if not isinstance(assignments, list) or not assignments:
                    raise UserError("В приглашении отсутствуют задания", status=409)
                record["assignment_answers"] = _answers(answers, len(assignments))
                next_status = "task_sent_for_review"
            else:
                next_status = "accepted"
        _append(record, next_status)
        record["applicant_seen"] = _seen_marker(record)
        invitations._write(path, record)
        return _view(record)


def alert(user_id):
    """Подпись для восклицательного знака иконки: пока есть непоказанная версия."""
    user_id = specializations.check_user(user_id)
    with invitations._lock:
        count = sum(_unseen(record) for record in _own_records(user_id))
    return f"Новые приглашения или изменения статуса: {count}" if count else None
