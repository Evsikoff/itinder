"""Демонстрационные приглашения и отклики для приложения соискателя (значок 4).

Каждый вызов создаёт новый пакет из 20 файлов: два направления приглашения,
по одному примеру каждого из четырёх plain и шести assignment статусов. Истории
начинаются с sent и содержат весь путь до текущего статуса; после отправки
заданий сохранены многострочные ответы по числу заданий.

Вакансии — самостоятельные снимки из проверенных шаблонов проектов. Рекрутёры,
компании, проекты и вакансии получают синтетические UUID: генерация не пишет
эти сущности в БД и не влияет на закрытие настоящих вакансий. Все новые записи
принадлежат выбранному существующему пользователю и имеют test_generation.
Пакет записывается под общей блокировкой приглашений. При ошибке удаляются
только созданные в этом вызове файлы; существующие записи не меняются.
"""

import copy
import json
import os
import uuid
from datetime import datetime, timedelta, timezone

import invitations
import projects
import specializations
import test_projects

VERSION = 1
MARKER = "test_generation"
COUNT = 20

# Полные пути до каждого статуса. Задания сперва отправляются кандидатом,
# затем требуют проверки рекрутёром, после чего принимаются или отклоняются.
HISTORIES = {
    "plain": {
        "sent": ("sent",),
        "read": ("sent", "read"),
        "accepted": ("sent", "read", "accepted"),
        "declined": ("sent", "read", "declined"),
    },
    "assignment": {
        "sent": ("sent",),
        "declined": ("sent", "declined"),
        "task_needs_review": ("sent", "task_sent_for_review", "task_needs_review"),
        "task_sent_for_review": ("sent", "task_sent_for_review"),
        "solution_rejected": ("sent", "task_sent_for_review", "task_needs_review", "solution_rejected"),
        "accepted": ("sent", "task_sent_for_review", "task_needs_review", "accepted"),
    },
}

RECRUITER_NAMES = ("Анна Миронова (тест)", "Михаил Соколов (тест)")


def _bases(catalog):
    """Только готовим проверенные снимки, не создаём проекты или вакансии."""
    result = []
    for template in test_projects.TEMPLATES:
        payload = test_projects._payload(template, catalog)
        for vacancy in projects._vacancies(payload["vacancies"], catalog, approve=True):
            result.append((template, vacancy))
    return result


def _assignments(vacancy, count):
    return [
        f"Опишите план решения задачи по позиции «{vacancy['position_name']}»: {vacancy['task']}",
        "Перечислите граничные случаи и обработку ошибок. Объясните, как проверить результат.",
        "Опишите альтернативный подход и его ограничения. Укажите, как организовать работу команды.",
    ][:count]


def _records(user_id, catalog, batch_id):
    bases = _bases(catalog)
    # Последний переход каждого примера уже произошёл: история не содержит
    # будущих дат и допускает обычные действия соискателя сразу после генерации.
    anchor = datetime.now(timezone.utc) - timedelta(hours=1)
    recruiters = [(str(uuid.uuid4()), name) for name in RECRUITER_NAMES]
    companies = {template["id"]: str(uuid.uuid4()) for template in test_projects.TEMPLATES}
    project_ids = {template["id"]: str(uuid.uuid4()) for template in test_projects.TEMPLATES}
    result = []
    for direction, type in enumerate(invitations.TYPES):
        for flow, statuses in invitations.FLOWS.items():
            for scenario_index, status in enumerate(statuses):
                index = len(result)
                template, base = bases[index % len(bases)]
                vacancy = copy.deepcopy(base)
                recruiter_id, recruiter_name = recruiters[index % len(recruiters)]
                project_id = project_ids[template["id"]]
                vacancy_id = str(uuid.uuid4())
                history = [{"status": step, "at": (anchor + timedelta(minutes=index * 2 + offset)).isoformat()}
                           for offset, step in enumerate(HISTORIES[flow][status])]
                vacancy.update({
                    "id": vacancy_id,
                    "project_id": project_id,
                    "title": f"[Тест] {base['title']}",
                    "company": {"id": companies[template["id"]], "name": test_projects.COMPANY},
                    "project": {
                        "name": template["name"], "summary": template["description"],
                        "domain": template["domain"], "stage": "active",
                        "duration": template["duration"], "work_format": "remote",
                    },
                    "assignments": _assignments(vacancy, 1 + scenario_index % 3) if flow == "assignment" else [],
                    "status": "ready", "stack_origin": "fixed", "open_questions": [],
                    "approved_at": history[0]["at"],
                    "notes": "Демонстрационная вакансия. Снимок предназначен для проверки приглашений и откликов.",
                })
                # Повторная проверка уже с заданным количеством заданий.
                projects._vacancy(vacancy, catalog, approve=True)
                record = {
                    "id": str(uuid.uuid4()), "type": type, "applicant_id": user_id,
                    "recruiter_id": recruiter_id, "project_id": project_id, "vacancy_id": vacancy_id,
                    "vacancy": vacancy, "flow": flow, "status_history": history,
                    "created_at": history[0]["at"], "source": "search", "relevance": None,
                    MARKER: {
                        "version": VERSION, "batch_id": batch_id,
                        "scenario": f"{'incoming' if direction == 0 else 'outgoing'}:{flow}:{status}",
                        "template": template["id"], "recruiter_name": recruiter_name,
                    },
                }
                if flow == "assignment" and "task_sent_for_review" in HISTORIES[flow][status]:
                    record["assignment_answers"] = [
                        f"Демонстрационный ответ на задание {number}.\n"
                        "План: уточнить условия, подготовить решение и проверить граничные случаи.\n"
                        "Результат и ограничения описаны для проверки интерфейса."
                        for number in range(1, len(vacancy["assignments"]) + 1)
                    ]
                result.append(record)
    return result


def _create(path, record):
    """Создаёт только новый файл; при сбое убирает собственную неполную запись."""
    opened = False
    try:
        with open(path, "x", encoding="utf-8", newline="\n") as file:
            opened = True
            json.dump(record, file, ensure_ascii=False, indent=2)
            file.write("\n")
            file.flush()
            os.fsync(file.fileno())
    except BaseException:
        if opened:
            path.unlink(missing_ok=True)
        raise


def generate(user_id):
    """Новый пакет из 20 примеров для существующего пользователя."""
    user_id = specializations.check_user(user_id)
    records = _records(user_id, projects.Catalog(), str(uuid.uuid4()))
    written = []
    with invitations._lock:
        invitations.INVITATIONS_DIR.mkdir(parents=True, exist_ok=True)
        try:
            for record in records:
                path = invitations.INVITATIONS_DIR / f"{record['id']}.json"
                _create(path, record)
                written.append(path)
        except BaseException:
            for path in reversed(written):
                path.unlink(missing_ok=True)
            raise
    return {"created_invitations": len(records), "invitation_ids": [record["id"] for record in records]}
