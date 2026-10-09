"""Записи пользователей: app/db/users/<id>.json, один файл на пользователя.

Запись создаёт элемент интерфейса с additional action «Creating a user record»
(app/db/ui_scheme.json): сцена отправляет почту и пароль на POST /api/users,
сервер app/tools/serve.py вызывает create_user. Вход — additional action
«Authorization»: POST /api/login, authenticate.

Пароль в открытом виде не хранится: в файле лежит его хеш PBKDF2-SHA256 с солью
в формате pbkdf2_sha256$<итерации>$<соль>$<хеш> (base64), проверка — verify_password.
"""

import base64
import hashlib
import hmac
import json
import re
import secrets
import threading
import uuid
from pathlib import Path

from data_paths import mutable_dir

ROOT = Path(__file__).resolve().parent.parent.parent
USERS_DIR = mutable_dir("users")
EMAIL = re.compile(r"[^@\s]+@[^@\s]+\.[^@\s]+")
MAX_EMAIL = 254  # RFC 5321
ITERATIONS = 600_000  # PBKDF2-SHA256, рекомендация OWASP
SCHEME = "pbkdf2_sha256"

# Проверка, что почта свободна, и запись файла — один шаг: сервер многопоточный.
_lock = threading.Lock()


class UserError(ValueError):
    """Данные не годятся для записи. Текст показывается пользователю."""

    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def _b64(data):
    return base64.b64encode(data).decode("ascii")


def hash_password(password, salt=None, iterations=ITERATIONS):
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return f"{SCHEME}${iterations}${_b64(salt)}${_b64(digest)}"


def verify_password(password, stored):
    scheme, iterations, salt, _ = stored.split("$")
    if scheme != SCHEME:
        raise ValueError(f"Неизвестная схема хеша: {scheme}")
    expected = hash_password(password, base64.b64decode(salt), int(iterations))
    return hmac.compare_digest(expected, stored)


def find_by_email(email):
    key = email.casefold()
    for path in sorted(USERS_DIR.glob("*.json")):
        user = json.loads(path.read_text(encoding="utf-8"))
        if str(user.get("email", "")).casefold() == key:
            return user
    return None


def authenticate(email, password):
    """Вход: возвращает {"id", "email"} пользователя с этой почтой и паролем."""
    if not isinstance(email, str) or not isinstance(password, str):
        raise UserError("Почта и пароль должны быть строками")
    email = email.strip()
    if not email:
        raise UserError("Введите электронную почту")
    if not password:
        raise UserError("Введите пароль")
    user = find_by_email(email)
    if user is None:
        # Хеш считается и без пользователя: по времени ответа не понять, есть ли такая почта.
        hash_password(password)
    elif verify_password(password, user["password_hash"]):
        return {"id": user["id"], "email": user["email"]}
    raise UserError("Неверная почта или пароль", status=401)


def create_user(email, password):
    """Создаёт запись и возвращает её без хеша пароля: {"id", "email"}."""
    if not isinstance(email, str) or not isinstance(password, str):
        raise UserError("Почта и пароль должны быть строками")
    email = email.strip()
    if not email:
        raise UserError("Введите электронную почту")
    if len(email) > MAX_EMAIL or not EMAIL.fullmatch(email):
        raise UserError("Электронная почта введена с ошибкой")
    if not password:
        raise UserError("Введите пароль")

    password_hash = hash_password(password)
    with _lock:
        USERS_DIR.mkdir(parents=True, exist_ok=True)
        if find_by_email(email):
            raise UserError("Эта почта уже зарегистрирована", status=409)
        user_id = str(uuid.uuid4())
        user = {"id": user_id, "email": email, "password_hash": password_hash}
        # "x": файл с таким именем не перезапишется, даже если uuid совпадёт.
        with open(USERS_DIR / f"{user_id}.json", "x", encoding="utf-8", newline="\n") as file:
            json.dump(user, file, ensure_ascii=False, indent=2)
            file.write("\n")
    return {"id": user_id, "email": email}
