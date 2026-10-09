"""Имена пользователей: app/db/user_names/<user_id>.json, один файл на
пользователя. Запись — {"user_id", "first_name", "last_name", "created_at"}.

Имя спрашивает portfolio-inner-site — «операционная система» на мониторе
в комнате resume3: пока его нет, она закрыта окном ввода имени и фамилии.
GET /api/user_names?user_id=<id> (app/tools/serve.py) вызывает find — есть ли
запись, POST /api/user_names {"user_id", "first_name", "last_name"} — save.
Имя записывается один раз: второй раз — ошибка 409.
"""

import json
from datetime import datetime, timezone
from pathlib import Path

from data_paths import mutable_dir

from specializations import check_user
from users import UserError

ROOT = Path(__file__).resolve().parent.parent.parent
USER_NAMES_DIR = mutable_dir("user_names")
MAX_NAME = 60
# Кроме букв: «Анна-Мария», «д'Артаньян», «O’Connor», «Jr.», двойная фамилия через пробел.
SEPARATORS = " -'’."


def _clean(value, field, accusative):
    """Имя или фамилия без лишних пробелов; что не так — UserError.
    field — название поля («Фамилия»), accusative — оно же в «Введите …»."""
    if not isinstance(value, str):
        raise UserError(f"{field}: нужна строка")
    value = " ".join(value.split())
    if not value:
        raise UserError(f"Введите {accusative}")
    if len(value) > MAX_NAME:
        raise UserError(f"{field}: не больше {MAX_NAME} символов")
    if not all(char.isalpha() or char in SEPARATORS for char in value) or not any(map(str.isalpha, value)):
        raise UserError(f"{field}: только буквы, пробел, дефис и апостроф")
    return value


def _path(user_id):
    return USER_NAMES_DIR / f"{user_id}.json"


def find(user_id):
    """Запись с именем пользователя или None, если имя ещё не введено."""
    path = _path(check_user(user_id))
    return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else None


def save(user_id, first_name, last_name):
    """Сохраняет имя и фамилию и возвращает запись."""
    user_id = check_user(user_id)
    record = {
        "user_id": user_id,
        "first_name": _clean(first_name, "Имя", "имя"),
        "last_name": _clean(last_name, "Фамилия", "фамилию"),
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    USER_NAMES_DIR.mkdir(parents=True, exist_ok=True)
    try:
        # "x": имя уже есть — файл не перезапишется, даже если два запроса придут разом.
        with open(_path(user_id), "x", encoding="utf-8", newline="\n") as file:
            json.dump(record, file, ensure_ascii=False, indent=2)
            file.write("\n")
    except FileExistsError:
        raise UserError("Имя уже записано", status=409) from None
    return record
