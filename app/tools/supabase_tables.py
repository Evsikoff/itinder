"""Общее для обмена данными с Supabase: настройки, запросы и список таблиц,
копии которых лежат в app/db (supabase_pull.py выгружает, supabase_push.py
отправляет обратно).

Настройки берутся из .env.local в корне проекта (образец — .env.example)
или из переменных окружения SUPABASE_URL и SUPABASE_KEY.
"""

import json
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent.parent.parent
DB = ROOT / "app" / "db"
ENV_FILE = ROOT / ".env.local"
KEY = "id"  # первичный ключ: по нему строки сортируются в файле и сверяются с таблицей
PAGE_SIZE = 1000  # Supabase по умолчанию отдаёт не больше 1000 строк за запрос


@dataclass(frozen=True)
class Table:
    name: str                  # таблица в Supabase
    file: Path                 # её копия в app/db
    parent: str | None = None  # колонка со ссылкой на id строки той же таблицы

    @property
    def path(self):
        return self.file.relative_to(ROOT) if self.file.is_relative_to(ROOT) else self.file


TABLES = [
    Table("itinder_ui_scheme", DB / "ui_scheme.json", parent="anchor_point_id"),
    Table("itinder_hat_replicas", DB / "hat_replicas.json"),
    Table("itinder_additional_desktop_icons", DB / "additional_desktop_icons.json"),
]


def select_tables(names):
    """Таблицы по именам из командной строки — имя таблицы или файла
    (ui_scheme, hat_replicas, additional_desktop_icons). Без имён — все."""
    if not names:
        return TABLES
    found = []
    for name in names:
        table = next((t for t in TABLES if name in (t.name, t.file.stem, t.file.name)), None)
        if table is None:
            sys.exit(f"Ошибка: таблицы «{name}» нет в списке. Есть: {', '.join(t.file.stem for t in TABLES)}")
        if table not in found:
            found.append(table)
    return found


class SupabaseError(Exception):
    def __init__(self, message, code=None):
        super().__init__(message)
        self.code = code


def load_env_file(path):
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        os.environ.setdefault(name.strip(), value.strip().strip("\"'"))


def load_config():
    load_env_file(ENV_FILE)
    url = os.environ.get("SUPABASE_URL", "").strip().rstrip("/")
    url = re.sub(r"/rest/v1$", "", url)
    key = os.environ.get("SUPABASE_KEY", "").strip()
    if not url or not key:
        sys.exit("Ошибка: не заданы SUPABASE_URL и SUPABASE_KEY. "
                 "Скопируй .env.example в .env.local и заполни оба значения.")
    return url, key


def request_headers(key):
    headers = {"apikey": key, "Accept": "application/json"}
    # Legacy-ключи anon/service_role — это JWT, их нужно передать и в Authorization;
    # новые ключи sb_publishable_/sb_secret_ передаются только как apikey.
    if re.fullmatch(r"eyJ[\w-]*\.[\w-]+\.[\w-]+", key):
        headers["Authorization"] = f"Bearer {key}"
    return headers


def request(url, key, method, table, query="", body=None):
    """Запрос к REST API таблицы; ответ — разобранный JSON. Ошибка — SupabaseError
    с сообщением Supabase и кодом Postgres (23502 и т. п.)."""
    headers = {**request_headers(key), "Content-Type": "application/json", "Prefer": "return=representation"}
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = Request(f"{url}/rest/v1/{table.name}{query}", data=data, headers=headers, method=method)
    try:
        with urlopen(req, timeout=30) as response:
            return json.load(response)
    except HTTPError as error:
        text = error.read().decode("utf-8", "replace")
        try:
            data = json.loads(text)
        except ValueError:
            data = None
        data = data if isinstance(data, dict) else {}
        message = " — ".join(filter(None, (data.get("message"), data.get("details"), data.get("hint")))) or text or error.reason
        raise SupabaseError(f"Supabase ответил {error.code}: {message}", data.get("code")) from None
    except URLError as error:
        raise SupabaseError(f"{error.reason}. Проверь SUPABASE_URL и подключение к интернету.") from None


def fetch_rows(url, key, table):
    rows = []
    offset = 0
    while True:
        query = urlencode({"select": "*", "order": f"{KEY}.asc", "limit": PAGE_SIZE, "offset": offset})
        try:
            page = request(url, key, "GET", table, f"?{query}")
        except SupabaseError as error:
            sys.exit(f"Ошибка ({table.name}): {error}")
        rows.extend(page)
        if len(page) < PAGE_SIZE:
            return rows
        offset += PAGE_SIZE


def to_json(rows):
    # Как в остальных файлах app/db: массив, одна запись на строку.
    lines = ",\n".join("  " + json.dumps(row, ensure_ascii=False) for row in rows)
    return f"[\n{lines}\n]\n" if rows else "[]\n"


def write_rows(table, rows):
    """Записать строки в файл таблицы по возрастанию id. Возвращает False, если файл не изменился."""
    content = to_json(sorted(rows, key=lambda row: row[KEY]))
    if table.file.exists() and table.file.read_text(encoding="utf-8") == content:
        return False
    temporary = table.file.with_suffix(".json.tmp")
    temporary.write_text(content, encoding="utf-8", newline="\n")
    temporary.replace(table.file)
    return True
