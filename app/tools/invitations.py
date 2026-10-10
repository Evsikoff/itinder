"""Приглашения соискателям — их отправляет рекрутёр из окна «Соискатели» (значок 9
на рабочем столе portfolio-inner-site, режим Recruiter).

Файл app/db/invitations/<id>.json на приглашение: тип (type: «От рекрутера
кандидату» или «От кандидата рекрутеру»), рекрутёр (recruiter_id), кандидат
(applicant_id), на какую вакансию (project_id, vacancy_id) и снимок
вакансии на момент отправки (vacancy): рекрутёр может её потом поправить, а
соискатель должен увидеть то, на что его звали, вместе с заданиями. Статус —
не поле, а история смены статусов: status_history [{"status", "at"}], нынешний —
последний. Наборов статусов два (FLOWS), какой — решает отправка и пишет в flow:
у вакансии нет заданий — plain (отправлено, просмотрено, принято, отклонено), есть —
assignment (отправлено, отклонено, задание требует проверки, задание отправлено
на проверку, решение отклонено, принято). Отправка пишет «sent»; окно соискателя
меняет статусы через app/tools/applicant_invitations.py и сохраняет ответы на
задания и отметку просмотра в этом же файле приглашения.

Пригласить можно своего соискателя на свою вакансию, если:
    вакансия утверждена, готова (status ready — нет нерешённых блокирующих
        вопросов), набор по проекту не завершён и вакансия не закрыта —
        принятых приглашений меньше, чем людей в вакансии (count);
    у соискателя есть запись user_specializations со специализацией вакансии,
        он не спрятался (user_blocks) и это не сам рекрутёр;
    этого соискателя на эту вакансию ещё не приглашали — ни разу, даже если
        он отказался.

API — app/tools/serve.py: POST /api/invitations (create); что показывать
рекрутёру, собирает app/tools/applicant_search.py. Окно соискателя использует
GET /api/applicant/invitations и POST /api/applicant/invitations/read|respond.
"""

import json
import os
import tempfile
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

from data_paths import mutable_dir

import projects
import ranking
from users import UserError

ROOT = Path(__file__).resolve().parent.parent.parent
INVITATIONS_DIR = mutable_dir("invitations")

# Тип определяет направление приглашения; окно «Соискатели» отправляет от рекрутёра.
RECRUITER_TO_APPLICANT = "От рекрутера кандидату"
APPLICANT_TO_RECRUITER = "От кандидата рекрутеру"
TYPES = (RECRUITER_TO_APPLICANT, APPLICANT_TO_RECRUITER)

# Наборы статусов: flow → {статус: название в окне}, в порядке из постановки задачи.
FLOWS = {
    "plain": {"sent": "Отправлено", "read": "Просмотрено", "accepted": "Принято", "declined": "Отклонено"},
    "assignment": {
        "sent": "Отправлено",
        "declined": "Отклонено",
        "task_needs_review": "Задание требует проверки",
        "task_sent_for_review": "Задание отправлено на проверку",
        "solution_rejected": "Решение отклонено",
        "accepted": "Принято",
    },
}
STATUSES = tuple(dict.fromkeys(status for flow in FLOWS.values() for status in flow))  # все статусы
# После этих статусов соискатель вакансии больше не предлагается.
REJECTED = ("declined", "solution_rejected")
# Откуда отправлено: экраны окна «Соискатели».
SOURCES = ("team", "vacancy", "search")
# Откуда отправлен отклик соискателя: окно «Вакансии» (app/tools/vacancy_search.py).
APPLICATION_SOURCE = "vacancies"
# Поля вакансии, которые не уходят в снимок: служебные поля файла.
VACANCY_SKIP = ("user_id", "created_at", "updated_at")

_lock = threading.RLock()  # создание и изменения приглашений — одним шагом


def _now():
    return datetime.now(timezone.utc).isoformat()


def _write(path, record):
    """Атомарно заменяет файл приглашения; вызывается под общим _lock."""
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", newline="\n",
                                         prefix=f".{path.stem}.", suffix=".tmp",
                                         dir=path.parent, delete=False) as file:
            temporary = Path(file.name)
            json.dump(record, file, ensure_ascii=False, indent=2)
            file.write("\n")
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def records():
    """Все приглашения; битый файл пропускается."""
    return list(ranking._read_dir(INVITATIONS_DIR))


def status(record):
    """Нынешний статус: последний элемент истории."""
    return record["status_history"][-1]["status"]


def by_recruiter(recruiter_id, found=None):
    """Приглашения рекрутёра: {(vacancy_id, applicant_id): запись}."""
    found = records() if found is None else found
    return {(r["vacancy_id"], r["applicant_id"]): r for r in found if r.get("recruiter_id") == recruiter_id}


def vacancy_counts(found):
    """{vacancy_id: {статус: сколько приглашений сейчас в нём}}."""
    counts = {}
    for record in found:
        entry = counts.setdefault(record["vacancy_id"], dict.fromkeys(STATUSES, 0))
        entry[status(record)] += 1
    return counts


def is_closed(vacancy, counts):
    """Вакансия закрыта: принятых приглашений не меньше, чем людей в ней."""
    return bool(vacancy.get("closed_at")) or counts.get(vacancy["id"], {}).get("accepted", 0) >= vacancy.get("count", 1)


def view(record):
    """Приглашение для окна рекрутёра: без снимка вакансии."""
    return {
        "id": record["id"],
        "type": record["type"],
        "applicant_id": record["applicant_id"],
        "vacancy_id": record["vacancy_id"],
        "project_id": record["project_id"],
        "title": record["vacancy"].get("title"),
        "flow": record["flow"],
        "status": status(record),
        "status_history": record["status_history"],
        "relevance": record.get("relevance"),
        "created_at": record["created_at"],
    }


def _vacancy(recruiter_id, vacancy_id):
    """Вакансия рекрутёра, в которую можно приглашать, и её проект."""
    vacancy = ranking.load_vacancy(vacancy_id)
    if vacancy.get("user_id") != recruiter_id:
        raise UserError("Вакансия не найдена", status=404)
    path = projects.PROJECTS_DIR / f"{vacancy.get('project_id')}.json"
    project = projects._load(path) if path.is_file() else None
    if project is None or vacancy["id"] not in (project.get("vacancy_ids") or []):
        raise UserError("Проект вакансии удалён", status=404)
    if project.get("completed_at"):
        raise UserError("Набор по проекту завершён", status=409)
    if vacancy.get("status") != "ready":
        raise UserError("У вакансии есть нерешённые блокирующие вопросы — сначала решите их в «Проектах и вакансиях»", status=409)
    return vacancy, project


def create(recruiter_id, vacancy_id, applicant_id, source):
    """Отправляет приглашение и возвращает его view. Повторное — 409."""
    recruiter_id = projects.check_recruiter(recruiter_id)
    if source not in SOURCES:
        raise UserError("Неизвестно, откуда отправлено приглашение")
    try:
        applicant_id = str(uuid.UUID(str(applicant_id)))
    except ValueError:
        raise UserError("Нет идентификатора соискателя") from None
    if applicant_id == recruiter_id:
        raise UserError("Себя пригласить нельзя")
    vacancy, project = _vacancy(recruiter_id, vacancy_id)
    pool = [a for a in ranking.applicants(vacancy["specialization"]) if a["user_id"] == applicant_id]
    if not pool:
        raise UserError(f"Соискатель не ищет работу по специализации {vacancy['specialization']}", status=404)
    result = ranking.by_vacancy(vacancy, pool=pool)
    entry = (result["candidates"] + result["unconfirmed"])[0]
    with _lock:
        found = records()
        if (vacancy["id"], applicant_id) in by_recruiter(recruiter_id, found):
            raise UserError("Этого соискателя на эту вакансию уже приглашали", status=409)
        if is_closed(vacancy, vacancy_counts(found)):
            raise UserError("Вакансия закрыта: приглашения приняли все, кого искали", status=409)
        now = _now()
        record = {
            "id": str(uuid.uuid4()),
            "type": RECRUITER_TO_APPLICANT,
            "recruiter_id": recruiter_id,
            "applicant_id": applicant_id,
            "project_id": project["id"],
            "vacancy_id": vacancy["id"],
            "vacancy": {key: value for key, value in vacancy.items() if key not in VACANCY_SKIP},
            "relevance": entry["relevance"],
            "source": source,
            "flow": "assignment" if vacancy.get("assignments") else "plain",
            "status_history": [{"status": "sent", "at": now}],
            "created_at": now,
        }
        INVITATIONS_DIR.mkdir(parents=True, exist_ok=True)
        # "x": файл с таким именем не перезапишется, даже если uuid совпадёт.
        with open(INVITATIONS_DIR / f"{record['id']}.json", "x", encoding="utf-8", newline="\n") as file:
            json.dump(record, file, ensure_ascii=False, indent=2)
            file.write("\n")
    return view(record)
