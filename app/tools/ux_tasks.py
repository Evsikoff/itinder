"""Задачи на грейд для фронтендеров: задания из app/db/ux_problems.json
(формат — app/db/README.md). Собирает их app/tools/grade_tests.py.

Интерфейс — экран из компонентов (живой поиск, таблица, модальное окно…)
с чертами (traits) и связями между ними. Проблема бывает трёх видов (scope):
    component — внутри одного компонента; симптом написан для каждого
        компонента, к которому проблема применима;
    link — во взаимодействии двух компонентов: применима к паре узлов экрана
        с нужными чертами и связью; симптом — шаблон, в который подставляются
        формы названий компонентов;
    side_effect — кандидату не показывается: её порождает решение другой
        проблемы на этом экране (портал в <body> внутри окна с ловушкой
        фокуса, виртуализация у тех, кто ищет по Ctrl+F…).
Контекст продукта (мобильный банк, CRM…) задаёт теги и число строк в таблицах:
от них зависит, какие проблемы применимы и какие решения не подходят (bad_in).

По грейду:
    Junior — один компонент в одном из контекстов, где он встречается на
        экранах, и одна его проблема;
    Middle — экран не больше чем из MIDDLE_MAX_NODES компонентов, хотя бы
        одна проблема во взаимодействии;
    Senior — экран от SENIOR_MIN_NODES компонентов, хотя бы одна проблема во
        взаимодействии и ловушка: у решения какой-то из проблем на этом экране
        есть побочный эффект.
Сколько проблем — решает grade_tests.py. Похожие проблемы (confusable_with)
вместе не попадают, одна проблема — один раз. Проблема, которую нельзя
решить без неустранимого побочного эффекта, в задание не попадает.

В ключе задания ресурс — «контекст:экран» (у Junior — «контекст:компонент»),
проблема — «проблема@узел» или «проблема@узел+узел» (узлы экрана; у Junior
узел — сам компонент).

Проверка справочника и число возможных заданий:
    python app/tools/ux_tasks.py
"""

import itertools
import json
import random
import sys
from functools import lru_cache
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
UX_PROBLEMS = ROOT / "app" / "db" / "ux_problems.json"
TABLES = ("tags", "contexts", "traits", "relations", "components", "screens", "solutions", "problems")
COMPONENT, LINK, SIDE_EFFECT = "component", "link", "side_effect"
JUNIOR, MIDDLE, SENIOR = "Junior", "Middle", "Senior"
MIDDLE_MAX_NODES = 3
SENIOR_MIN_NODES = 4
POOL_MIN = 20  # решений в списке выбора: сколько не хватает — добираются случайные
FORMS = ("name", "gen", "acc", "prep")  # формы названия, которые есть у каждого компонента
# Условия when: у проблем — применима ли она, у побочных эффектов — возникает ли.
# Узел — тот, к которому применено решение: у проблемы компонента — сам компонент,
# у проблемы взаимодействия — узел a.
CONDITIONS = (
    "tags_any",  # у контекста есть хотя бы один из тегов
    "tags_none",  # у контекста нет ни одного из тегов
    "rows_min", "rows_max",  # строк в таблицах контекста не меньше / не больше
    "ancestor_trait",  # узел внутри компонента с этой чертой
    "no_ancestor_trait",  # узел не внутри компонента с этой чертой
    "contains_trait",  # внутри узла есть компонент с этой чертой
    "screen_trait",  # на экране есть компонент с этой чертой
    "screen_min",  # {черта: n}: на экране не меньше n компонентов с этой чертой
)


def load():
    """Справочник: {таблица: {id: запись}}."""
    raw = json.loads(UX_PROBLEMS.read_text(encoding="utf-8"))
    return {name: {row["id"]: row for row in raw[name]} for name in TABLES}


class Screen:
    """Экран: узлы (ключ → id компонента) и связи [{"a", "rel", "b"}]."""

    def __init__(self, data, nodes, edges=()):
        self.components = data["components"]
        self.nodes = dict(nodes)
        self.edges = list(edges)
        self.parent = {edge["a"]: edge["b"] for edge in self.edges if edge["rel"] == "inside"}

    @classmethod
    def single(cls, data, component_id):
        """Один компонент — экран заданий Junior."""
        return cls(data, {component_id: component_id})

    def traits(self, key):
        return set(self.components[self.nodes[key]]["traits"])

    def ancestors(self, key):
        """Узлы, внутри которых находится этот, от ближнего к дальнему."""
        chain = []
        while key in self.parent and self.parent[key] not in chain:
            key = self.parent[key]
            chain.append(key)
        return chain

    def descendants(self, key):
        return [other for other in self.nodes if key in self.ancestors(other)]

    def pairs(self, rel):
        """Пары узлов (a, b) со связью rel. inside — и через промежуточные узлы,
        у каждого a ближние b первыми."""
        if rel == "inside":
            return [(a, b) for a in self.nodes for b in self.ancestors(a)]
        return [(edge["a"], edge["b"]) for edge in self.edges if edge["rel"] == rel]

    def count(self, trait):
        return sum(trait in self.traits(key) for key in self.nodes)


def holds(when, context, screen, subject):
    """Выполнено ли условие when (CONDITIONS) для узла subject экрана в контексте."""
    tags = set(context["tags"])
    rows = context["rows"]
    checks = {
        "tags_any": lambda value: bool(tags & set(value)),
        "tags_none": lambda value: not tags & set(value),
        "rows_min": lambda value: rows >= value,
        "rows_max": lambda value: rows <= value,
        "ancestor_trait": lambda value: any(value in screen.traits(key) for key in screen.ancestors(subject)),
        "no_ancestor_trait": lambda value: not any(value in screen.traits(key) for key in screen.ancestors(subject)),
        "contains_trait": lambda value: any(value in screen.traits(key) for key in screen.descendants(subject)),
        "screen_trait": lambda value: screen.count(value) > 0,
        "screen_min": lambda value: all(screen.count(trait) >= n for trait, n in value.items()),
    }
    return all(checks[name](value) for name, value in when.items())


def instances(data, context, screen):
    """Проблемы, применимые на экране в контексте: [(id проблемы, узлы)];
    узлы — (узел,) у проблемы компонента и (a, b) у проблемы взаимодействия.
    У взаимодействия на каждый узел a — одна пара, с ближайшим подходящим b."""
    found = []
    for problem in data["problems"].values():
        when = problem.get("when", {})
        if problem["scope"] == COMPONENT:
            found += [
                (problem["id"], (key,)) for key, component_id in screen.nodes.items()
                if component_id in problem["symptoms"] and holds(when, context, screen, key)
            ]
        elif problem["scope"] == LINK:
            applies, paired = problem["applies"], set()
            for a, b in screen.pairs(applies["rel"]):
                if (
                    a not in paired
                    and set(applies["a"]) <= screen.traits(a)
                    and set(applies["b"]) <= screen.traits(b)
                    and holds(when, context, screen, a)
                ):
                    paired.add(a)
                    found.append((problem["id"], (a, b)))
    return found


def _forms(component):
    """Формы названия компонента для шаблона; с заглавной — те же ключи с заглавной: Name, Layer."""
    forms = dict(component["forms"])
    forms.update({key.capitalize(): value[:1].upper() + value[1:] for key, value in component["forms"].items()})
    return forms


def _rows(context):
    return f"{context['rows']:,}".replace(",", " ")


def symptom(data, context, screen, problem_id, nodes):
    """Что видит кандидат: симптом компонента или заполненный шаблон взаимодействия."""
    problem = data["problems"][problem_id]
    if problem["scope"] == COMPONENT:
        text = problem["symptoms"][screen.nodes[nodes[0]]].format(rows=_rows(context))
    else:
        a, b = (_forms(data["components"][screen.nodes[key]]) for key in nodes)
        text = problem["symptom"].format(a=a, b=b, rows=_rows(context))
    return text[:1].upper() + text[1:]


def unsuitable(data, context, solution_id):
    """Теги контекста, из-за которых решение здесь не подходит."""
    return [tag for tag in data["solutions"][solution_id].get("bad_in", []) if tag in context["tags"]]


def _usable(data, context, ids):
    return [solution_id for solution_id in ids if not unsuitable(data, context, solution_id)]


def resolve(data, context, screen, problem_id, nodes):
    """Проблема в задании: что видит кандидат и эталон для проверки.
    fixes и mitigates — только решения, которые подходят в контексте; не
    подходящие — в unsuitable с названиями тегов-причин. side_effects — какие
    побочные эффекты дают её решения на этом экране: {"solution", "with",
    "problem"}; with — эффект возникает, только если выбрано и это решение."""
    problem = data["problems"][problem_id]
    usable = _usable(data, context, problem["fixes"] + problem["mitigates"])
    side_effects = [
        {"solution": solution_id, "with": effect.get("with"), "problem": effect["problem"]}
        for solution_id in usable
        for effect in data["solutions"][solution_id].get("side_effects", [])
        if holds(effect.get("when", {}), context, screen, nodes[0])
    ]
    return {
        "id": problem_id,
        "instance": f"{problem_id}@{'+'.join(nodes)}",
        "scope": problem["scope"],
        "name": problem["name"],
        "symptom": symptom(data, context, screen, problem_id, nodes),
        "fixes": _usable(data, context, problem["fixes"]),
        "mitigates": _usable(data, context, problem["mitigates"]),
        "unsuitable": [
            {"solution": solution_id, "reasons": [data["tags"][tag]["name"] for tag in tags]}
            for solution_id in problem["fixes"] + problem["mitigates"]
            if (tags := unsuitable(data, context, solution_id))
        ],
        "side_effects": side_effects,
    }


def side_problem(data, context, problem_id):
    """Побочный эффект в задании: суть и решения, которые подходят в контексте."""
    problem = data["problems"][problem_id]
    return {
        "id": problem_id,
        "name": problem["name"],
        "description": problem["description"],
        "fixes": _usable(data, context, problem["fixes"]),
        "mitigates": _usable(data, context, problem["mitigates"]),
    }


def solvable(view, sides):
    """Есть ли у проблемы решение, каждый побочный эффект которого (без
    условия with) тоже чем-то устраняется."""
    return any(
        all(sides[effect["problem"]]["fixes"] for effect in view["side_effects"]
            if effect["solution"] == fix and effect["with"] is None)
        for fix in view["fixes"]
    )


def has_trap(views):
    """Есть ли у решения какой-то из проблем побочный эффект на этом экране.
    Эффект с условием with считается, если второе решение тоже из эталона задания."""
    applied = {solution_id for view in views for solution_id in view["fixes"] + view["mitigates"]}
    return any(
        effect["with"] is None or effect["with"] in applied
        for view in views for effect in view["side_effects"] if effect["solution"] in view["fixes"]
    )


def _fits(data, combo, grade):
    ids = [view["id"] for view in combo]
    if len(set(ids)) < len(ids):
        return False
    if any(b in data["problems"][a]["confusable_with"] for a, b in itertools.combinations(ids, 2)):
        return False
    if grade != JUNIOR and not any(view["scope"] == LINK for view in combo):
        return False
    return grade != SENIOR or has_trap(combo)


def _screen(data, grade, token):
    if grade == JUNIOR:
        return Screen.single(data, token)
    row = data["screens"][token]
    return Screen(data, row["nodes"], row["edges"])


def _sized(row, grade):
    size = len(row["nodes"])
    return size <= MIDDLE_MAX_NODES if grade == MIDDLE else size >= SENIOR_MIN_NODES


def _views(data, context, screen):
    """Решаемые проблемы экрана в задании: [resolve(…)]."""
    views = [resolve(data, context, screen, problem_id, nodes) for problem_id, nodes in instances(data, context, screen)]
    sides = {
        effect["problem"]: side_problem(data, context, effect["problem"])
        for view in views for effect in view["side_effects"]
    }
    return [view for view in views if solvable(view, sides)]


@lru_cache(maxsize=8)
def _options(grade, count, version):
    """Все задания грейда: [(контекст, экран или компонент, [наборы instance])].
    version — время изменения справочника: поменялся — пересчитывается."""
    data = load()
    options = []
    if grade == JUNIOR:
        pairs = sorted({
            (context_id, component_id)
            for row in data["screens"].values() for context_id in row["contexts"] for component_id in row["nodes"].values()
        })
    else:
        pairs = [
            (context_id, row["id"])
            for row in data["screens"].values() if _sized(row, grade) for context_id in row["contexts"]
        ]
    for context_id, token in pairs:
        views = _views(data, data["contexts"][context_id], _screen(data, grade, token))
        sets = [
            tuple(view["instance"] for view in combo)
            for combo in itertools.combinations(views, count) if _fits(data, combo, grade)
        ]
        if sets:
            options.append((context_id, token, sets))
    return options


def task(data, specialization, grade, context_id, token, instance_ids):
    """Задание: ключ, ресурс (как его видит кандидат), проблемы с эталоном,
    побочные эффекты их решений, весь справочник решений и список выбора (pool)."""
    context = data["contexts"][context_id]
    screen = _screen(data, grade, token)
    available = {f"{problem_id}@{'+'.join(nodes)}": (problem_id, nodes) for problem_id, nodes in instances(data, context, screen)}
    views = [resolve(data, context, screen, *available[instance_id]) for instance_id in instance_ids]
    key = "/".join([specialization, grade, f"{context_id}:{token}", ",".join(instance_ids)])
    if grade == JUNIOR:
        component = data["components"][token]
        label, name, description = "Компонент", component["name"], component["description"]
    else:
        row = data["screens"][token]
        label, name, description = "Экран", row["name"], row["description"]
    return {
        "key": key,
        "specialization": specialization,
        "grade": grade,
        "resource": {
            "kind": "ui",
            "label": label,
            "name": name,
            "description": description,
            "context": context["name"],
            "context_description": context["description"],
            "constraints": [data["tags"][tag]["name"] for tag in context["tags"]],
        },
        "problems": views,
        "side_problems": {
            effect["problem"]: side_problem(data, context, effect["problem"])
            for view in views for effect in view["side_effects"]
        },
        "solutions": data["solutions"],
        "pool": _pool(data, context, screen, key),
    }


def _pool(data, context, screen, key):
    """Список выбора: решения всех проблем, применимых на экране (и их
    побочных эффектов), отвлекающие варианты для них (distracts) и случайные
    до POOL_MIN. Случайные берутся по ключу задания — по ключу список тот же."""
    problem_ids = {problem_id for problem_id, _ in instances(data, context, screen)}
    ids = set()
    for problem_id in problem_ids:
        problem = data["problems"][problem_id]
        for solution_id in problem["fixes"] + problem["mitigates"]:
            ids.add(solution_id)
            for effect in data["solutions"][solution_id].get("side_effects", []):
                side = data["problems"][effect["problem"]]
                ids.update(side["fixes"] + side["mitigates"])
    ids.update(row["id"] for row in data["solutions"].values() if problem_ids & set(row.get("distracts", [])))
    rest = sorted(set(data["solutions"]) - ids)
    ids.update(random.Random(key).sample(rest, max(0, min(len(rest), POOL_MIN - len(ids)))))
    return sorted(ids)


def generate(specialization, grade, count, rng=random):
    """Случайное задание: контекст и экран (у Junior — компонент), у которых
    есть подходящие наборы проблем, один из наборов, проблемы — в случайном порядке."""
    options = _options(grade, count, UX_PROBLEMS.stat().st_mtime_ns)
    if not options:
        raise ValueError(f"В {UX_PROBLEMS.name} нет экрана, на котором можно собрать задание {grade} из {count} проблем")
    context_id, token, sets = rng.choice(options)
    chosen = list(rng.choice(sets))
    rng.shuffle(chosen)
    return task(load(), specialization, grade, context_id, token, chosen)


def from_key(specialization, grade, resource, instance_list, count):
    """Задание по частям ключа: ресурс «контекст:экран», проблемы «a@узел,b@узел+узел».
    Негодный ключ — ValueError."""
    data = load()
    context_id, _, token = resource.partition(":")
    if context_id not in data["contexts"]:
        raise ValueError(f"нет такого контекста: {context_id!r}")
    if grade == JUNIOR:
        if token not in data["components"]:
            raise ValueError(f"нет такого компонента: {token!r}")
    elif token not in data["screens"] or context_id not in data["screens"][token]["contexts"]:
        raise ValueError(f"нет экрана {token!r} в контексте {context_id!r}")
    instance_ids = instance_list.split(",")
    if len(instance_ids) != count:
        raise ValueError(f"грейд {grade!r} не подходит к числу проблем {len(instance_ids)}")
    screen = _screen(data, grade, token)
    available = {f"{problem_id}@{'+'.join(nodes)}" for problem_id, nodes in instances(data, data["contexts"][context_id], screen)}
    for instance_id in instance_ids:
        if instance_id not in available:
            raise ValueError(f"проблема {instance_id!r} не применима: {resource}")
    return task(data, specialization, grade, context_id, token, instance_ids)


# --- Проверка справочника ---

def _check_when(when, data, where, errors):
    for name, value in when.items():
        if name not in CONDITIONS:
            errors.append(f"{where}: неизвестное условие {name!r}")
        elif name in ("tags_any", "tags_none"):
            errors += [f"{where}: нет тега {tag!r}" for tag in value if tag not in data["tags"]]
        elif name == "screen_min":
            errors += [f"{where}: нет черты {trait!r}" for trait in value if trait not in data["traits"]]
        elif name.endswith("_trait") and value not in data["traits"]:
            errors.append(f"{where}: нет черты {value!r}")


def check(data):
    """Ошибки в справочнике: ссылки, симметрия похожих, шаблоны симптомов на всех экранах."""
    errors = []
    for context in data["contexts"].values():
        errors += [f"контекст {context['id']}: нет тега {tag!r}" for tag in context["tags"] if tag not in data["tags"]]
    for component in data["components"].values():
        where = f"компонент {component['id']}"
        errors += [f"{where}: нет черты {trait!r}" for trait in component["traits"] if trait not in data["traits"]]
        errors += [f"{where}: нет формы {form!r}" for form in FORMS if form not in component["forms"]]
    for row in data["screens"].values():
        where = f"экран {row['id']}"
        errors += [f"{where}: нет контекста {c!r}" for c in row["contexts"] if c not in data["contexts"]]
        errors += [f"{where}: нет компонента {c!r}" for c in row["nodes"].values() if c not in data["components"]]
        for edge in row["edges"]:
            if edge["a"] not in row["nodes"] or edge["b"] not in row["nodes"] or edge["rel"] not in data["relations"]:
                errors.append(f"{where}: негодная связь {edge}")
    for solution in data["solutions"].values():
        where = f"решение {solution['id']}"
        errors += [f"{where}: нет тега {tag!r}" for tag in solution.get("bad_in", []) if tag not in data["tags"]]
        errors += [f"{where}: нет проблемы {p!r}" for p in solution.get("distracts", []) if p not in data["problems"]]
        for effect in solution.get("side_effects", []):
            if data["problems"].get(effect["problem"], {}).get("scope") != SIDE_EFFECT:
                errors.append(f"{where}: побочный эффект {effect['problem']!r} — не проблема side_effect")
            if effect.get("with") and effect["with"] not in data["solutions"]:
                errors.append(f"{where}: нет решения {effect['with']!r}")
            _check_when(effect.get("when", {}), data, where, errors)
    produced = {effect["problem"] for s in data["solutions"].values() for effect in s.get("side_effects", [])}
    for problem in data["problems"].values():
        where = f"проблема {problem['id']}"
        scope = problem["scope"]
        for field in ("fixes", "mitigates"):
            errors += [f"{where}: нет решения {s!r}" for s in problem[field] if s not in data["solutions"]]
        if set(problem["fixes"]) & set(problem["mitigates"]):
            errors.append(f"{where}: fixes и mitigates пересекаются")
        if scope == SIDE_EFFECT:
            if problem["id"] not in produced:
                errors.append(f"{where}: её не порождает ни одно решение")
            continue
        if not problem["fixes"]:
            errors.append(f"{where}: пустой fixes")
        _check_when(problem.get("when", {}), data, where, errors)
        for other in problem["confusable_with"]:
            if problem["id"] not in data["problems"].get(other, {}).get("confusable_with", []):
                errors.append(f"{where}: похожая {other!r} не ссылается обратно")
        if scope == COMPONENT:
            errors += [f"{where}: нет компонента {c!r}" for c in problem["symptoms"] if c not in data["components"]]
        elif scope == LINK:
            applies = problem["applies"]
            if applies["rel"] not in data["relations"]:
                errors.append(f"{where}: нет связи {applies['rel']!r}")
            errors += [f"{where}: нет черты {t!r}" for t in applies["a"] + applies["b"] if t not in data["traits"]]
        else:
            errors.append(f"{where}: неизвестный scope {scope!r}")
    if errors:
        return errors
    for row in data["screens"].values():
        for context_id in row["contexts"]:
            context = data["contexts"][context_id]
            screens = [Screen(data, row["nodes"], row["edges"])]
            screens += [Screen.single(data, c) for c in set(row["nodes"].values())]
            for screen in screens:
                for problem_id, nodes in instances(data, context, screen):
                    try:
                        symptom(data, context, screen, problem_id, nodes)
                    except (KeyError, IndexError) as error:
                        errors.append(f"проблема {problem_id} на {row['id']} ({context_id}): в шаблоне нет {error}")
    return errors


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    data = load()
    errors = check(data)
    if errors:
        print("\n".join(errors))
        sys.exit(1)
    counts = {JUNIOR: 1, MIDDLE: 2, SENIOR: 4}
    for grade, count in counts.items():
        options = _options(grade, count, UX_PROBLEMS.stat().st_mtime_ns)
        print(f"{grade}: {sum(len(sets) for _, _, sets in options)} заданий")
        for context_id, token, sets in options:
            print(f"    {context_id}:{token} — {len(sets)}")
    used = {
        problem_id for grade, count in counts.items()
        for _, _, sets in _options(grade, count, UX_PROBLEMS.stat().st_mtime_ns)
        for combo in sets for problem_id in (instance.split("@")[0] for instance in combo)
    }
    unused = [p["id"] for p in data["problems"].values() if p["scope"] != SIDE_EFFECT and p["id"] not in used]
    if unused:
        print("Не попадают ни в одно задание:", ", ".join(unused))


if __name__ == "__main__":
    main()
