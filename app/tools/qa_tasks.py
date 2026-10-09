"""Задачи на грейд для тестировщиков (QA): задания из app/db/qa_problems.json
(формат — app/db/README.md). Собирает их app/tools/grade_tests.py.

Задание собирается процедурно, без нейросети, из четырёх сущностей:
    система (systems) — что тестируют: мобильный банк, интернет-магазин,
        умный дом, сеть клиник; её словарь (vars) подставляется в шаблоны;
    артефакт (artifacts) — с чем пришла задача: требование, тест-кейсы,
        баг-репорт, обращение клиента, код автотеста, лог CI, конфигурация
        пайплайна, метрики, разбор инцидента…;
    проблема (problems) — своего уровня (level): Junior — тест-дизайн,
        локализация и оформление багов; Middle — автоматизация, API и БД,
        флаки-тесты, тестовые окружения; Senior — стратегия тестирования,
        CI/CD, процессы (Shift-Left), пирамида, контрактное тестирование.
        Кандидат видит наблюдение — что заметила команда, без причины, —
        и документы-артефакты (evidence), по которым причину можно найти;
    решение (solutions) — для проблемы это best practice (fixes), смягчение
        (mitigates), костыль (crutches: прячет симптом, а причина остаётся)
        или ошибочный ход (wrong: противоречит тому, что видно в документах).

Сборка — как бросок кубиков: система; набор проблем уровня грейда,
применимых к ней (when), без похожих (confusable_with); зерно (seed). Из
зерна, системы и проблемы получаются числа в документах (params: номера
сборок, доли падений, время) и вариант документов, если их несколько, —
поэтому по ключу задание собирается заново таким же. Сколько проблем —
решает grade_tests.py.

В ключе задания ресурс — «система:зерно», проблемы — их id.

Шаблоны — str.format: {s[группа][поле]} — словарь системы, {имя} — params
проблемы, {имя[0]} и {имя[поле]} — элемент выборки или объекта из params.
Фигурные скобки в самом шаблоне удваиваются, поэтому код и JSON лучше
держать в словаре системы: значения повторно не форматируются.

Проверка справочника (все шаблоны во всех применимых системах) и число
возможных заданий:
    python app/tools/qa_tasks.py
"""

import itertools
import json
import random
import sys
from functools import lru_cache
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
QA_PROBLEMS = ROOT / "app" / "db" / "qa_problems.json"
TABLES = ("tags", "systems", "artifacts", "solutions", "problems")
LEVELS = ("Junior", "Middle", "Senior")
FORMATS = ("text", "code")  # text — абзацы с переносом строк; code — моноширинно, без переноса
SEED_MAX = 9999
POOL_MIN = 16  # решений в списке выбора: сколько не хватает — добираются случайные
CONDITIONS = ("tags_any", "tags_none")  # условие when: у системы есть хотя бы один из тегов / нет ни одного
PARAM_KINDS = ("int", "pick", "clock", "sample")
CHECK_SEEDS = range(1, 9)  # зёрна, на которых проверка справочника рендерит шаблоны


def load():
    """Справочник: {таблица: {id: запись}}."""
    raw = json.loads(QA_PROBLEMS.read_text(encoding="utf-8"))
    return {name: {row["id"]: row for row in raw[name]} for name in TABLES}


def applies(problem, system):
    """Применима ли проблема к системе: условие when по тегам системы."""
    when, tags = problem.get("when", {}), set(system["tags"])
    return (not when.get("tags_any") or bool(tags & set(when["tags_any"]))) and not tags & set(when.get("tags_none", []))


def _value(spec, system, rng):
    """Значение одного params: int — целое из [от, до] (step — шаг), pick — один
    из вариантов (число, строка, список или объект), clock — время «ЧЧ:ММ:СС»
    с часом из [от, до], sample — k разных элементов списка из словаря системы."""
    if "int" in spec:
        low, high = spec["int"]
        return rng.randrange(low, high + 1, spec.get("step", 1))
    if "pick" in spec:
        return rng.choice(spec["pick"])
    if "clock" in spec:
        low, high = spec["clock"]
        return f"{rng.randint(low, high):02d}:{rng.randint(0, 59):02d}:{rng.randint(0, 59):02d}"
    return rng.sample(system["vars"][spec["sample"]], spec.get("k", 1))


def params(system, seed, problem):
    """params проблемы в задании и номер варианта её документов. Зависят только
    от системы, зерна и самой проблемы — не от других проблем задания."""
    rng = random.Random(f"{system['id']}:{seed}:{problem['id']}")
    values = {name: _value(spec, system, rng) for name, spec in problem.get("params", {}).items()}
    return values, rng.randrange(len(problem["evidence"]))


def render(template, system, values):
    """Шаблон с подстановками: {s[…]} — словарь системы, {имя} — params."""
    return template.format_map({**values, "s": system["vars"]})


def _capital(text):
    return text[:1].upper() + text[1:]


def documents(data, system, problem, values, variant):
    """Документы проблемы, как их видит кандидат: [{"kind", "name", "title", "format", "text"}]."""
    found = []
    for doc in problem["evidence"][variant]:
        artifact = data["artifacts"][doc["artifact"]]
        found.append({
            "kind": artifact["id"],
            "name": artifact["name"],
            "title": render(doc["title"], system, values),
            "format": artifact["format"],
            "text": "\n".join(render(line, system, values) for line in doc["lines"]),
        })
    return found


def _traps(items, system, values):
    return [{"solution": item["solution"], "why": render(item["why"], system, values)} for item in items]


def resolve(data, system, seed, problem_id):
    """Проблема в задании: наблюдение и документы для кандидата, эталон для
    проверки. crutches и wrong — [{"solution", "why"}]: костыли и ошибочные
    ходы с объяснением, почему они не годятся."""
    problem = data["problems"][problem_id]
    values, variant = params(system, seed, problem)
    return {
        "id": problem_id,
        "instance": problem_id,
        "level": problem["level"],
        "name": problem["name"],
        "symptom": _capital(render(problem["observation"], system, values)),
        "documents": documents(data, system, problem, values, variant),
        "fixes": list(problem["fixes"]),
        "mitigates": list(problem["mitigates"]),
        "crutches": _traps(problem.get("crutches", []), system, values),
        "wrong": _traps(problem.get("wrong", []), system, values),
        "unsuitable": [],
        "side_effects": [],
    }


def task(data, specialization, grade, system_id, seed, problem_ids):
    """Задание: ключ, система (как её видит кандидат), проблемы с эталоном,
    документы (artifacts) и какие из них к какой проблеме (attachments),
    весь справочник решений и список выбора (pool)."""
    system = data["systems"][system_id]
    views = [resolve(data, system, seed, problem_id) for problem_id in problem_ids]
    artifacts, attachments = [], []
    for view in views:
        ids = []
        for doc in view.pop("documents"):
            doc["id"] = len(artifacts) + 1
            artifacts.append(doc)
            ids.append(doc["id"])
        attachments.append(ids)
    key = "/".join([specialization, grade, f"{system_id}:{seed}", ",".join(problem_ids)])
    return {
        "key": key,
        "specialization": specialization,
        "grade": grade,
        "resource": {
            "kind": "qa",
            "label": "Система",
            "name": system["name"],
            "description": system["description"],
            "constraints": [data["tags"][tag]["name"] for tag in system["tags"]],
        },
        "problems": views,
        "side_problems": {},
        "artifacts": artifacts,
        "attachments": attachments,
        "solutions": data["solutions"],
        "pool": _pool(data, system, grade, key),
    }


def _pool(data, system, grade, key):
    """Список выбора: решения, смягчения, костыли и ошибочные ходы всех проблем
    уровня, применимых к системе, отвлекающие варианты для них (distracts)
    и случайные до POOL_MIN. Случайные берутся по ключу — по ключу список тот же."""
    problems = [p for p in data["problems"].values() if p["level"] == grade and applies(p, system)]
    ids = set()
    for problem in problems:
        ids.update(problem["fixes"] + problem["mitigates"])
        ids.update(item["solution"] for item in problem.get("crutches", []) + problem.get("wrong", []))
    problem_ids = {problem["id"] for problem in problems}
    ids.update(row["id"] for row in data["solutions"].values() if problem_ids & set(row.get("distracts", [])))
    rest = sorted(set(data["solutions"]) - ids)
    ids.update(random.Random(key).sample(rest, max(0, min(len(rest), POOL_MIN - len(ids)))))
    return sorted(ids)


def _applicable(data, system, grade):
    return sorted(p["id"] for p in data["problems"].values() if p["level"] == grade and applies(p, system))


@lru_cache(maxsize=8)
def _options(grade, count, version):
    """Все наборы проблем грейда: [(система, [наборы id])]. version — время
    изменения справочника: поменялся — пересчитывается."""
    data = load()
    options = []
    for system in data["systems"].values():
        sets = [
            combo for combo in itertools.combinations(_applicable(data, system, grade), count)
            if not any(b in data["problems"][a]["confusable_with"] for a, b in itertools.combinations(combo, 2))
        ]
        if sets:
            options.append((system["id"], sets))
    return options


def generate(specialization, grade, count, rng=random):
    """Случайное задание: система, у которой есть подходящие наборы проблем,
    один из наборов в случайном порядке и случайное зерно."""
    options = _options(grade, count, QA_PROBLEMS.stat().st_mtime_ns)
    if not options:
        raise ValueError(f"В {QA_PROBLEMS.name} нет системы, для которой можно собрать задание {grade} из {count} проблем")
    system_id, sets = rng.choice(options)
    chosen = list(rng.choice(sets))
    rng.shuffle(chosen)
    return task(load(), specialization, grade, system_id, rng.randint(1, SEED_MAX), chosen)


def from_key(specialization, grade, resource, problem_list, count):
    """Задание по частям ключа: ресурс «система:зерно», проблемы «a,b». Негодный ключ — ValueError."""
    data = load()
    system_id, _, seed = resource.partition(":")
    system = data["systems"].get(system_id)
    if system is None:
        raise ValueError(f"нет такой системы: {system_id!r}")
    if not (seed.isascii() and seed.isdigit() and 1 <= int(seed) <= SEED_MAX):
        raise ValueError(f"зерно — целое от 1 до {SEED_MAX}: {seed!r}")
    problem_ids = problem_list.split(",")
    if len(problem_ids) != count:
        raise ValueError(f"грейд {grade!r} не подходит к числу проблем {len(problem_ids)}")
    if len(set(problem_ids)) < len(problem_ids):
        raise ValueError("проблема в ключе повторяется")
    for problem_id in problem_ids:
        problem = data["problems"].get(problem_id)
        if problem is None or problem["level"] != grade or not applies(problem, system):
            raise ValueError(f"проблема {problem_id!r} не годится для {grade} в системе {system_id!r}")
    return task(data, specialization, grade, system_id, int(seed), problem_ids)


# --- Проверка справочника ---

def _check_params(problem, system, where, errors):
    for name, spec in problem.get("params", {}).items():
        kinds = [kind for kind in PARAM_KINDS if kind in spec]
        if name == "s" or len(kinds) != 1:
            errors.append(f"{where}: негодный params {name!r}")
        elif kinds == ["sample"] and len(system["vars"].get(spec["sample"], [])) < spec.get("k", 1):
            errors.append(f"{where}: в словаре {system['id']} нет списка {spec['sample']!r} из {spec.get('k', 1)}")


def _render_all(data, system, problem, errors):
    """Рендерит наблюдение, все варианты документов и объяснения на нескольких зёрнах."""
    where = f"проблема {problem['id']} в {system['id']}"
    for seed in CHECK_SEEDS:
        values, _ = params(system, seed, problem)
        try:
            render(problem["observation"], system, values)
            for variant in range(len(problem["evidence"])):
                documents(data, system, problem, values, variant)
            _traps(problem.get("crutches", []) + problem.get("wrong", []), system, values)
        except (KeyError, IndexError, ValueError, TypeError) as error:
            errors.append(f"{where}: шаблон не собирается ({type(error).__name__}: {error})")
            return


def check(data):
    """Ошибки в справочнике: ссылки, взаимность похожих, все шаблоны во всех применимых системах."""
    errors = []
    for system in data["systems"].values():
        errors += [f"система {system['id']}: нет тега {tag!r}" for tag in system["tags"] if tag not in data["tags"]]
    for artifact in data["artifacts"].values():
        if artifact["format"] not in FORMATS:
            errors.append(f"артефакт {artifact['id']}: неизвестный format {artifact['format']!r}")
    for solution in data["solutions"].values():
        errors += [f"решение {solution['id']}: нет проблемы {p!r}" for p in solution.get("distracts", []) if p not in data["problems"]]
    for problem in data["problems"].values():
        where = f"проблема {problem['id']}"
        if problem["level"] not in LEVELS:
            errors.append(f"{where}: неизвестный level {problem['level']!r}")
        traps = problem.get("crutches", []) + problem.get("wrong", [])
        groups = [problem["fixes"], problem["mitigates"], [item["solution"] for item in traps]]
        for ids in groups:
            errors += [f"{where}: нет решения {s!r}" for s in ids if s not in data["solutions"]]
        flat = [s for ids in groups for s in ids]
        if len(set(flat)) < len(flat):
            errors.append(f"{where}: решение повторяется в fixes, mitigates, crutches или wrong")
        if not problem["fixes"]:
            errors.append(f"{where}: пустой fixes")
        errors += [f"{where}: у {item['solution']!r} нет why" for item in traps if not str(item.get("why", "")).strip()]
        for name, value in problem.get("when", {}).items():
            if name not in CONDITIONS:
                errors.append(f"{where}: неизвестное условие {name!r}")
            else:
                errors += [f"{where}: нет тега {tag!r}" for tag in value if tag not in data["tags"]]
        for other in problem["confusable_with"]:
            if problem["id"] not in data["problems"].get(other, {}).get("confusable_with", []):
                errors.append(f"{where}: похожая {other!r} не ссылается обратно")
        if not problem["evidence"] or not all(problem["evidence"]):
            errors.append(f"{where}: нет документов")
        for variant in problem["evidence"]:
            errors += [f"{where}: нет артефакта {doc['artifact']!r}" for doc in variant if doc["artifact"] not in data["artifacts"]]
    if errors:
        return errors
    for problem in data["problems"].values():
        systems = [system for system in data["systems"].values() if applies(problem, system)]
        if not systems:
            errors.append(f"проблема {problem['id']}: не применима ни к одной системе")
        for system in systems:
            before = len(errors)
            _check_params(problem, system, f"проблема {problem['id']} в {system['id']}", errors)
            if len(errors) == before:
                _render_all(data, system, problem, errors)
    return errors


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    data = load()
    errors = check(data)
    if errors:
        print("\n".join(errors))
        sys.exit(1)
    for grade, count in {"Junior": 1, "Middle": 2, "Senior": 4}.items():
        options = _options(grade, count, QA_PROBLEMS.stat().st_mtime_ns)
        print(f"{grade} — наборов проблем: {sum(len(sets) for _, sets in options)}, зёрен у каждого: {SEED_MAX}")
        for system_id, sets in options:
            print(f"    {system_id} — {len(sets)}")


if __name__ == "__main__":
    main()
