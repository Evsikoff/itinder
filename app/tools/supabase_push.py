"""Отправка копий таблиц из app/db в Supabase — обратное к supabase_pull.py
(список таблиц — TABLES в supabase_tables.py).

Файл сравнивается с таблицей по id. Без флагов скрипт только показывает,
что изменится. С --apply записывает:
- строки, которых в таблице нет. Их id в файле временный: номер выдаёт Supabase,
  ссылки на такие строки внутри таблицы (anchor_point_id) переписываются;
- изменённые поля остальных строк;
- с --delete ещё и удаляет из таблицы строки, которых нет в файле.
После записи таблица выгружается обратно в файл, и в нём оказываются настоящие
id и created_at.

Строка в файле с тем же id, что в таблице, но с другим created_at — это разные
строки (в таблицу добавили строку после выгрузки). Скрипт остановится, чтобы
не затереть чужую строку.

Писать в таблицы может secret-ключ.

Запуск из корня проекта:
    python app/tools/supabase_push.py                          # что изменится во всех таблицах
    python app/tools/supabase_push.py hat_replicas             # только в названных
    python app/tools/supabase_push.py --apply                  # записать
    python app/tools/supabase_push.py --apply --delete         # и удалить лишние строки
"""

import argparse
import json
import re
import sys
from datetime import datetime

from supabase_pull import pull
from supabase_tables import KEY, ROOT, TABLES, SupabaseError, fetch_rows, load_config, request, select_tables, write_rows

FIXED = {KEY, "created_at"}  # не отправляются: id выдаёт Supabase, created_at — момент создания строки


def short(value, limit=70):
    text = f'"{value}"' if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    return text if len(text) <= limit else text[: limit - 1] + "…"


def same_moment(a, b):
    try:
        return datetime.fromisoformat(a) == datetime.fromisoformat(b)
    except (TypeError, ValueError):
        return a == b


# --- Проверки файла до обращения к таблице: то, на чём Supabase всё равно
# споткнётся на полпути (дубли id, ссылки в никуда), или что сломает интерфейс.

def check_rows(table, rows):
    if not isinstance(rows, list) or not rows:
        return ["файл должен содержать непустой массив строк"]
    problems = []
    ids = set()
    for i, row in enumerate(rows):
        if not isinstance(row, dict) or not isinstance(row.get(KEY), int) or isinstance(row.get(KEY), bool):
            problems.append(f"запись №{i + 1}: нужен объект с целым {KEY}")
            continue
        if row[KEY] in ids:
            problems.append(f"{KEY} {row[KEY]} встречается дважды")
        ids.add(row[KEY])
    if problems or not table.parent:
        return problems

    parent = {row[KEY]: row.get(table.parent) for row in rows}
    for row in rows:
        ref = row.get(table.parent)
        if ref is not None and ref not in parent:
            problems.append(f"строка {row[KEY]}: {table.parent} {ref} — такой строки в файле нет")
    if problems:
        return problems
    for row in rows:
        seen = {row[KEY]}
        ref = row.get(table.parent)
        while ref is not None:
            if ref in seen:
                problems.append(f"строка {row[KEY]}: {table.parent} замыкается в кольцо")
                break
            seen.add(ref)
            ref = parent[ref]
    return problems


# Схема экранов: цвета вида #RRGGBB (и #RGB) — их понимают и canvas, и three.js;
# в background_hex ещё и ##RRGGBB — неоновый стиль объекта. Layout у строки Page — JSON.
HEX = r"(?:[0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})"
UI_COLORS = {"background_hex": re.compile(f"##?{HEX}"), "title_color": re.compile(f"#{HEX}"), "text_color": re.compile(f"#{HEX}")}


def check_ui_scheme(rows):
    problems = []
    for row in rows:
        for name, pattern in UI_COLORS.items():
            value = row.get(name)
            if value is not None and not (isinstance(value, str) and pattern.fullmatch(value)):
                kinds = "#RRGGBB или ##RRGGBB (неон)" if name == "background_hex" else "#RRGGBB"
                problems.append(f"строка {row[KEY]}: {name} {json.dumps(value, ensure_ascii=False)} — нужен цвет вида {kinds}")
        if row.get("object_type") == "Page" and row.get("Layout"):
            try:
                layout = json.loads(row["Layout"])
            except ValueError as error:
                problems.append(f"строка {row[KEY]}: Layout — не JSON ({error})")
            else:
                if not isinstance(layout, dict):
                    problems.append(f"строка {row[KEY]}: Layout должен быть JSON-объектом")
    return problems


# Значки рабочего стола: картинка — файл проекта, путь от папки app (assets\fsp.png)
# или от корня проекта (\app\assets\fsp.png). Без файла значок останется без картинки.
def check_desktop_icons(rows):
    problems = []
    for row in rows:
        image = row.get("image")
        if image in (None, ""):
            continue
        clean = str(image).strip().replace("\\", "/").lstrip("/")
        path = ROOT / clean if clean.startswith("app/") else ROOT / "app" / clean
        if not path.is_file():
            problems.append(f"строка {row[KEY]}: image {json.dumps(image, ensure_ascii=False)} — такого файла в проекте нет")
    return problems


CHECKS = {"itinder_ui_scheme": check_ui_scheme, "itinder_additional_desktop_icons": check_desktop_icons}


# --- Подписи строк в отчёте.

def describe_ui_scheme(row):
    title = row.get("title")
    return f"{row[KEY]} — стр. {row.get('page')}, {row.get('object_type')}" + (f", «{title}»" if title else "")


def describe_desktop_icon(row):
    return f"{row[KEY]} — {row.get('mode')}, «{row.get('name')}»"


def describe_any(row):
    values = [short(value, 40) for name, value in row.items() if name not in FIXED and value not in (None, "")]
    return f"{row[KEY]} — {', '.join(values[:3]) or 'пустая строка'}"


DESCRIBE = {"itinder_ui_scheme": describe_ui_scheme, "itinder_additional_desktop_icons": describe_desktop_icon}


def describe(table, row):
    return DESCRIBE.get(table.name, describe_any)(row)


def load_local(table):
    try:
        rows = json.loads(table.file.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        sys.exit(f"Ошибка: не удалось прочитать {table.path}: {error}. Выгрузить таблицу: python app/tools/supabase_pull.py {table.file.stem}")
    problems = check_rows(table, rows) or CHECKS.get(table.name, lambda _: [])(rows)
    if problems:
        sys.exit(f"Ошибка в {table.path}:\n" + "\n".join(f"  {problem}" for problem in problems))
    return rows


# План: что добавить, что изменить (строка, она же в таблице, изменённые поля),
# чего в файле нет.
def make_plan(table, local, remote):
    if not remote:
        sys.exit(f"Ошибка: {table.name} вернула 0 строк — у ключа нет доступа на чтение или таблица пуста. "
                 f"Сравнивать не с чем, все строки ушли бы как новые.")
    columns = set(remote[0])
    theirs_by_id = {row[KEY]: row for row in remote}
    problems = []
    inserts, updates = [], []
    for row in local:
        extra = set(row) - columns
        if extra:
            problems.append(f"строка {row[KEY]}: в таблице нет полей {', '.join(sorted(extra))}")
        theirs = theirs_by_id.get(row[KEY])
        if theirs is None:
            inserts.append(row)
        elif row.get("created_at") and not same_moment(row["created_at"], theirs["created_at"]):
            problems.append(f"строка {row[KEY]}: в таблице под этим id другая строка "
                            f"(created_at {theirs['created_at']}, в файле {row['created_at']}). "
                            f"Похоже, её добавили после выгрузки: дайте своей строке id, которого нет в таблице")
        else:
            changes = {name: value for name, value in row.items() if name not in FIXED and theirs.get(name) != value}
            if changes:
                updates.append((row, theirs, changes))
    if problems:
        sys.exit(f"Ошибка ({table.path}):\n" + "\n".join(f"  {problem}" for problem in problems))
    local_ids = {row[KEY] for row in local}
    deletes = [row for row in remote if row[KEY] not in local_ids]
    return inserts, updates, deletes


def show_plan(table, local, plan, delete):
    inserts, updates, deletes = plan
    print(f"{table.path} -> Supabase {table.name}")
    if inserts:
        print(f"  Добавить ({len(inserts)}), id выдаст Supabase:")
        for row in inserts:
            print(f"    + {describe(table, row)}")
    if updates:
        print(f"  Изменить ({len(updates)}):")
        for row, theirs, changes in updates:
            print(f"    ~ {describe(table, row)}")
            for name, value in changes.items():
                print(f"        {name}: {short(theirs.get(name))} -> {short(value)}")
    if deletes:
        print(f"  Удалить ({len(deletes)}):" if delete else f"  Есть только в таблице ({len(deletes)}), останутся; удалить — флаг --delete:")
        for row in deletes:
            print(f"    - {describe(table, row)}")
    print(f"  Без изменений: {len(local) - len(inserts) - len(updates)}")


# Новые строки — родители раньше детей: внешний ключ на id той же таблицы
# не даст сослаться на строку, которой ещё нет.
def insertion_order(table, rows):
    pending = {row[KEY]: row for row in rows}
    order = []
    while pending:
        ready = [row for row in pending.values() if not table.parent or row.get(table.parent) not in pending]
        for row in ready:
            order.append(row)
            del pending[row[KEY]]
    return order


# Удаление — дети раньше родителей.
def deletion_order(table, rows):
    if not table.parent:
        return list(rows)
    pending = {row[KEY]: row for row in rows}
    order = []
    while pending:
        parents = {row.get(table.parent) for row in pending.values()}
        leaves = [row for row_id, row in pending.items() if row_id not in parents] or list(pending.values())
        for row in leaves:
            order.append(row)
            del pending[row[KEY]]
    return order


def apply(url, key, table, local, plan):
    inserts, updates, deletes = plan
    created = {}  # id из файла -> строка, которую вернул Supabase

    def resolve(ref):
        return created[ref][KEY] if ref in created else ref

    done = []
    try:
        for row in insertion_order(table, inserts):
            body = {name: value for name, value in row.items() if name not in FIXED}
            if table.parent and table.parent in body:
                body[table.parent] = resolve(body[table.parent])
            try:
                [result] = request(url, key, "POST", table, "", body)
            except SupabaseError as error:
                # 23502 — NOT NULL: id в таблице не выдаётся сам, берём id из файла.
                if error.code != "23502" or f'"{KEY}"' not in str(error):
                    raise
                [result] = request(url, key, "POST", table, "", {**body, KEY: row[KEY]})
            created[row[KEY]] = result
            note = f" (в файле был {row[KEY]})" if result[KEY] != row[KEY] else ""
            done.append(f"    + {describe(table, result)}{note}")

        for row, _, changes in updates:
            body = {name: resolve(value) if name == table.parent else value for name, value in changes.items()}
            result = request(url, key, "PATCH", table, f"?{KEY}=eq.{row[KEY]}", body)
            if len(result) != 1:
                raise SupabaseError(f"строка {row[KEY]} не обновилась: её нет в таблице или ключу запрещена запись")
            done.append(f"    ~ {describe(table, row)}")

        for row in deletion_order(table, deletes):
            result = request(url, key, "DELETE", table, f"?{KEY}=eq.{row[KEY]}")
            if len(result) != 1:
                raise SupabaseError(f"строка {row[KEY]} не удалилась: её уже нет или ключу запрещено удаление")
            done.append(f"    - {describe(table, row)}")
    except SupabaseError as error:
        if done:
            print(f"{table.name}, записано до ошибки:\n" + "\n".join(done))
        save_progress(table, local, created)
        sys.exit(f"Ошибка ({table.name}): {error}")
    print(f"{table.name}, записано:\n" + "\n".join(done))


# Запись оборвалась: добавленные строки уже в таблице под своими id. Файл
# получает эти id, иначе повторный запуск добавил бы их второй раз. Остальные
# правки в файле остаются, повторный запуск отправит их.
def save_progress(table, local, created):
    if not created:
        return
    rows = []
    for row in local:
        if row[KEY] in created:
            rows.append(created[row[KEY]])
        elif table.parent and row.get(table.parent) in created:
            rows.append({**row, table.parent: created[row[table.parent]][KEY]})
        else:
            rows.append(row)
    ids = [row[KEY] for row in rows]
    if len(ids) != len(set(ids)):
        mapping = ", ".join(f"{old} -> {row[KEY]}" for old, row in created.items())
        print(f"{table.path} не изменён: новые id совпали с временными id других строк. Добавлены: {mapping}. "
              f"Поправьте id и ссылки в файле вручную перед повторным запуском.", file=sys.stderr)
        return
    write_rows(table, rows)
    print(f"В {table.path} записаны id добавленных строк, повторный запуск их не задублирует.", file=sys.stderr)


def main():
    parser = argparse.ArgumentParser(description="Отправить копии таблиц из app/db в Supabase.")
    parser.add_argument("tables", nargs="*", metavar="таблица",
                        help=f"какие таблицы отправить, по умолчанию все: {', '.join(t.file.stem for t in TABLES)}")
    parser.add_argument("--apply", action="store_true", help="записать изменения в таблицы (без него — только показать)")
    parser.add_argument("--delete", action="store_true", help="удалить из таблиц строки, которых нет в файлах")
    args = parser.parse_args()

    url, key = load_config()
    tables = select_tables(args.tables)
    work = []
    for table in tables:
        local = load_local(table)
        plan = make_plan(table, local, fetch_rows(url, key, table))
        show_plan(table, local, plan, args.delete)
        inserts, updates, deletes = plan
        if inserts or updates or (deletes and args.delete):
            work.append((table, local, (inserts, updates, deletes if args.delete else [])))
    if not work:
        print("Таблицы уже совпадают с файлами.")
        return
    if not args.apply:
        names = " ".join(table.file.stem for table in tables) + " " if args.tables else ""
        flags = "--apply --delete" if args.delete else "--apply"
        print(f"Это только просмотр. Записать: python app/tools/supabase_push.py {names}{flags}")
        return
    for table, local, plan in work:
        apply(url, key, table, local, plan)
        pull(url, key, table)


if __name__ == "__main__":
    main()
