"""Специализации и грейды пользователей: app/db/user_specializations/<id>.json,
один файл на запись. Запись — {"id", "user_id", "specialization", "grade",
"created_at", "source"}; source — откуда выбор:
    {"type": "LLM", "llm", "model"} — пользователь согласился с распознаванием
        резюме (app/tools/resume.py, save_specialization);
    {"type": "Manual", "page", "elements"} — пользователь выбрал сам: нажал
        элемент с additional action «Save selection and enter the room»
        (save_selection). elements — выбранные элементы схемы экранов
        [{"id", "title"}]: карточка специализации и кнопка грейда под ней
        (на странице 6 вместо карточки — вопрос, специализация — Recruiter).

Обе записи создаёт POST /api/user_specializations (app/tools/serve.py).
Специализацию и грейд сервер берёт не из запроса, а из своего распознавания
или из app/db/ui_scheme.json: записать можно только то, что предлагал интерфейс.
"""

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path

from data_paths import mutable_dir

from users import USERS_DIR, UserError

ROOT = Path(__file__).resolve().parent.parent.parent
SPECIALIZATIONS_DIR = mutable_dir("user_specializations")
SCHEME = ROOT / "app" / "db" / "ui_scheme.json"
SELECT_ACTION = "Save selection and enter the room"
RECRUITER = "Recruiter"
# Страницы, где специализация не выбирается карточкой, а задана самой страницей:
# на них над кнопками грейда висит вопрос, а не карточка специализации.
PAGE_SPECIALIZATIONS = {6: RECRUITER}


def check_user(user_id):
    """Идентификатор существующего пользователя в каноническом виде."""
    try:
        user_id = str(uuid.UUID(str(user_id)))
    except ValueError:
        raise UserError("Нет идентификатора пользователя — войдите в профиль") from None
    if not (USERS_DIR / f"{user_id}.json").is_file():
        raise UserError("Пользователь не найден — войдите в профиль заново", status=404)
    return user_id


def write(user_id, specialization, grade, source):
    """Сохраняет запись и возвращает её. user_id уже проверен check_user."""
    record = {
        "id": str(uuid.uuid4()),
        "user_id": user_id,
        "specialization": specialization,
        "grade": grade,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "source": source,
    }
    SPECIALIZATIONS_DIR.mkdir(parents=True, exist_ok=True)
    # "x": файл с таким именем не перезапишется, даже если uuid совпадёт.
    with open(SPECIALIZATIONS_DIR / f"{record['id']}.json", "x", encoding="utf-8", newline="\n") as file:
        json.dump(record, file, ensure_ascii=False, indent=2)
        file.write("\n")
    return record


def records(user_id):
    """Записи пользователя по одной, в любом порядке."""
    for path in SPECIALIZATIONS_DIR.glob("*.json"):
        record = json.loads(path.read_text(encoding="utf-8"))
        if record.get("user_id") == user_id:
            yield record


def has_records(user_id):
    """Есть ли у пользователя хотя бы одна запись: после входа он сразу идёт в комнату."""
    return next(records(user_id), None) is not None


def _title(row):
    return str(row.get("title") or "").strip() if row else ""


def save_selection(user_id, element_id):
    """Ручной выбор: element_id — нажатая кнопка грейда (элемент с additional
    action «Save selection and enter the room»), специализация — заголовок
    элемента, под которым она висит (anchor_point_id), а на страницах из
    PAGE_SPECIALIZATIONS — специализация страницы."""
    user_id = check_user(user_id)
    if not isinstance(element_id, int) or isinstance(element_id, bool):
        raise UserError("Нет идентификатора выбранного элемента")
    rows = {row.get("id"): row for row in json.loads(SCHEME.read_text(encoding="utf-8"))}
    element = rows.get(element_id)
    if element is None or element.get("additional action") != SELECT_ACTION:
        raise UserError("Такого выбора нет в схеме экранов — обновите страницу", status=404)
    parent = rows.get(element.get("anchor_point_id"))
    specialization = PAGE_SPECIALIZATIONS.get(element.get("page")) or _title(parent)
    grade = _title(element)
    if not specialization or not grade:
        # Ошибка в схеме, а не в запросе: кнопка грейда должна висеть под карточкой специализации.
        raise ValueError(f"Элемент {element_id}: у выбора нет заголовка грейда или карточки специализации над ним")
    elements = [{"id": element_id, "title": grade}]
    if parent:
        elements.insert(0, {"id": parent["id"], "title": _title(parent)})
    source = {"type": "Manual", "page": element.get("page"), "elements": elements}
    return write(user_id, specialization, grade, source)
