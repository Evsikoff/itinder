"""Выгрузка таблиц Supabase в app/db: каждая таблица — в свой JSON-файл
(список — TABLES в supabase_tables.py).

Файл перезаписывается целиком: правки в нём, ещё не отправленные
supabase_push.py, пропадут. Поэтому сначала отправка, потом выгрузка.

Запуск из корня проекта:
    python app/tools/supabase_pull.py                 # все таблицы
    python app/tools/supabase_pull.py hat_replicas    # только названные
"""

import argparse
import sys

from supabase_tables import TABLES, fetch_rows, load_config, select_tables, write_rows


def pull(url, key, table):
    rows = fetch_rows(url, key, table)
    if not rows:
        print(f"{table.name}: таблица вернула 0 строк. Если ключ publishable, проверь политики RLS на чтение "
              f"или возьми secret-ключ. {table.path} не изменён.", file=sys.stderr)
        return
    if write_rows(table, rows):
        print(f"Записано: {len(rows)} строк {table.name} -> {table.path}")
    else:
        print(f"Без изменений: {len(rows)} строк {table.name} -> {table.path}")


def main():
    parser = argparse.ArgumentParser(description="Выгрузить таблицы Supabase в app/db.")
    parser.add_argument("tables", nargs="*", metavar="таблица",
                        help=f"какие таблицы выгрузить, по умолчанию все: {', '.join(t.file.stem for t in TABLES)}")
    args = parser.parse_args()
    url, key = load_config()
    for table in select_tables(args.tables):
        pull(url, key, table)


if __name__ == "__main__":
    main()
