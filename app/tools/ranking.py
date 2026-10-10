"""Ранжирование соискателей для рекрутёра. Два вида запроса:

    by_vacancy — по вакансии из app/db/projects_jobopenings (или черновику того же
        формата, vacancy в project_questionnaire.json);
    by_specialization — по специализации и грейду; любое из них можно не задавать.

Отбор жёсткий только по специализации: в выдачу попадают соискатели, у которых
в app/db/user_specializations есть запись со специализацией запроса. Других
специализаций у соискателя может быть сколько угодно — в поиске считается
нужная; записей нужной несколько — та, где грейд выше; грейд одинаковый —
любая (_preference). Нет записи в users/ или есть файл в user_blocks/ — не
попадает. Каждому попавшему — релевантность от 0 до 100:

    relevance = 100 × (вес грейда × грейд + вес стека × стек),

грейд и стек — от 0 до 1, веса — WEIGHTS: в поиске по вакансии стек важнее,
в поиске по грейду — поровну.

Грейд (grade_fit). Свидетельств два: тест — высший пройденный тест «Задачи на
грейд» этой специализации (app/db/user_tests), и заявленный грейд — из той же
записи user_specializations. Заявленному доверяют меньше (GRADE_TRUST): по
резюме (LLM) больше, чем выбранному самим (Manual). Заявленный опровергнут и не
считается, если тест на этот грейд или ниже провален, а на этот или выше не
сдан. Свидетельство даёт GRADE_FIT по разнице с запрошенным грейдом (на ступень
выше — лучше, чем на ступень ниже: дорого, но справится) × доверие; берётся
лучшее — неудачная попытка сдать тест выше не отменяет сданного.

Стек по вакансии (requirements_fit) — насколько требования вакансии закрыты
компетенциями из app/db/user_fsp. За каждую компетенцию требования:

    credit(d, m) = 0,8 × min(d, m) / m + 0,2 × d / 3,

d — степень подтверждения у соискателя (1–3), m — min_degree требования:
основное — выполнено ли требование по степени, остальное — сама степень, так что
подтверждённое сильнее ценится и сверх требования. Нет самой компетенции —
лучшая из близких со скидкой: rules.adjacent анкеты (Java ↔ Kotlin, PostgreSQL ↔
Postgres Pro…) — ADJACENT, та же модель СУБД или та же область тестирования
в fsp_stack.json — SIMILAR. Требование match all — среднее по своим
компетенциям, any — лучшая. Требования складываются с весами IMPORTANCE.
У вакансии нет требований — стек считается как в поиске по грейду.

Стек в поиске по грейду (profile_fit) — сумма весов всех компетенций: вес —
степень / 3; внутри вида стека компетенции по убыванию степени, и каждая
следующая весит в DECAY раз меньше (пятнадцать инструментов тестирования не
перевешивают языки, глубина важнее ширины); сумма вида делится на наибольшую
возможную — все компетенции вида, доступные роли, на высшей степени; итог —
среднее по видам, которые роль подтверждает в ФСП (rules.role_scope анкеты).
Компетенции вне role_scope не считаются: их не с чем сравнить в вакансиях.

Соискатели без связки с ФСП: их стек неизвестен, а не пуст, — они идут отдельным
списком unconfirmed: стек 0, порядок по грейду (vacancy.matching анкеты).

При равной релевантности выше тот, у кого лучше грейд, сильнее профиль ФСП
(profile_fit) и больше баллов ФСП; дальше — по user_id, чтобы порядок не прыгал.
Папки читаются по разу на запрос.

Командная строка:
    python app/tools/ranking.py --vacancy <id или путь к JSON> [--top N] [--json]
    python app/tools/ranking.py [--specialization Backend] [--grade Middle] [--top N] [--json]
        (без специализации — все, без грейда — любой: грейд считается по тому, насколько
        подтверждён собственный грейд соискателя)
"""

import argparse
import json
import sys
import uuid
from pathlib import Path

from data_paths import mutable_dir

import grade_tests
import projects
import specializations
from user_names import USER_NAMES_DIR
from users import USERS_DIR, UserError

ROOT = Path(__file__).resolve().parent.parent.parent
DB = ROOT / "app" / "db"
USER_FSP_DIR = mutable_dir("user_fsp")
USER_BLOCKS_DIR = mutable_dir("user_blocks")
VACANCIES_DIR = projects.VACANCIES_DIR

GRADES = grade_tests.GRADES  # по возрастанию
WEIGHTS = {
    "vacancy": {"grade": 0.35, "stack": 0.65},
    "specialization": {"grade": 0.5, "stack": 0.5},
}
# Грейд соискателя минус запрошенный, в ступенях → совпадение.
GRADE_FIT = {0: 1.0, 1: 0.6, -1: 0.4, 2: 0.15, -2: 0.0}
# Доверие свидетельству грейда: тест; заявленный — по source.type записи.
GRADE_TRUST = {"test": 1.0, "LLM": 0.8, "Manual": 0.7}
MAX_DEGREE = 3
DEGREE_SHARE = 0.2  # доля самой степени в credit; остальное — выполнение min_degree
ADJACENT = 0.5  # близкая компетенция из rules.adjacent
SIMILAR = 0.3  # та же модель СУБД, та же область тестирования
SIMILAR_FIELDS = {"databases": "model", "testing": "area"}
IMPORTANCE = {"required": 3, "plus": 1}
DECAY = 0.7


def _load(path):
    return json.loads(path.read_text(encoding="utf-8"))


def _read_dir(folder):
    """Записи папки по одной; битый файл пропускается."""
    for path in sorted(folder.glob("*.json")) if folder.is_dir() else ():
        try:
            yield _load(path)
        except (OSError, ValueError):
            continue


def _stems(folder):
    return {path.stem for path in folder.glob("*.json")} if folder.is_dir() else set()


# --- Справочники ----------------------------------------------------------------

class Reference:
    """Стек, роли и правила анкеты, а ещё близость компетенций и что доступно роли."""

    def __init__(self):
        self.catalog = projects.Catalog()
        self.role_of = {r["specialization"]: r["id"] for r in self.catalog.roles.values()}
        # (kind, id) → {близкая id: (скидка, "adjacent" | "similar")}, лучшая связь пары.
        self.related = {}
        for group in self.catalog.questionnaire["rules"]["adjacent"]:
            self._relate(group["kind"], group["ids"], ADJACENT, "adjacent")
        for kind, field in SIMILAR_FIELDS.items():
            groups = {}
            for item_id, item in self.catalog.items[kind].items():
                groups.setdefault(item[field], []).append(item_id)
            for ids in groups.values():
                self._relate(kind, ids, SIMILAR, "similar")

    def _relate(self, kind, ids, factor, relation):
        for a in ids:
            for b in ids:
                if a != b:
                    links = self.related.setdefault((kind, a), {})
                    if links.get(b, (0,))[0] < factor:
                        links[b] = (factor, relation)

    def kinds(self, role_id):
        """Виды стека, которые роль подтверждает в ФСП, с доступными ей компетенциями: {kind: [id]}."""
        return {
            kind: [i for i in self.catalog.items[kind] if self.catalog.in_scope(role_id, kind, i)]
            for kind in self.catalog.scope["kinds"][role_id]
        }

    def name(self, kind, item_id):
        return self.catalog.name(kind, item_id)


# --- Соискатели -----------------------------------------------------------------

def applicants(specialization=None, also=None):
    """Соискатели специализации (None — всех специализаций, кроме Recruiter):
    [{"user_id", "name", "specialization", "declared", "source", "passed", "failed",
    "fsp"}] — у кого есть запись user_specializations с этой специализацией, другие
    их специализации не мешают; у кого их несколько, без specialization — по
    соискателю на каждую. declared — грейд записи (их несколько — _preference),
    source — её source.type; passed и failed — грейды пройденных и проваленных
    тестов этой специализации; fsp — None (профиль не связан с ФСП) или
    {"competencies": {(kind, id): {"degree", "points"}}, "points"} — баллы всех
    соревнований. also — user_id, который попадает, даже если спрятался
    (user_blocks): соискатель сам смотрит вакансии (vacancy_ranking.py).
    Порядок — по user_id и специализации."""
    users = _stems(USERS_DIR)
    blocked = _stems(USER_BLOCKS_DIR) - {also}
    chosen = {}  # (user_id, специализация) → запись
    for record in _read_dir(specializations.SPECIALIZATIONS_DIR):
        user_id, own = record.get("user_id"), record.get("specialization")
        if own == specializations.RECRUITER or (specialization is not None and own != specialization):
            continue
        if user_id not in users or user_id in blocked:
            continue
        key = (user_id, own)
        if key not in chosen or _preference(record) > _preference(chosen[key]):
            chosen[key] = record
    tests = {}
    for record in _read_dir(grade_tests.TESTS_DIR):
        key = (record.get("user_id"), record.get("specialization"))
        if key in chosen and record.get("grade") in GRADES:
            entry = tests.setdefault(key, {"passed": set(), "failed": set()})
            entry["passed" if record.get("passed") else "failed"].add(record["grade"])
    names, fsp_records, found = {}, {}, []
    for (user_id, own), record in sorted(chosen.items()):
        if user_id not in names:
            names[user_id] = _name(user_id)
            fsp_records[user_id] = _fsp(user_id)
        result = tests.get((user_id, own), {"passed": set(), "failed": set()})
        found.append({
            "user_id": user_id,
            "name": names[user_id],
            "specialization": own,
            "declared": record.get("grade") if record.get("grade") in GRADES else None,
            "source": (record.get("source") or {}).get("type"),
            "passed": result["passed"],
            "failed": result["failed"],
            "fsp": fsp_records[user_id],
        })
    return found


def _name(user_id):
    """«Имя Фамилия» из user_names или None — имя не введено."""
    path = USER_NAMES_DIR / f"{user_id}.json"
    if not path.is_file():
        return None
    try:
        record = _load(path)
    except (OSError, ValueError):
        return None
    return f"{record.get('first_name', '')} {record.get('last_name', '')}".strip() or None


def _preference(record):
    """Какая из записей одной специализации считается: с высшим грейдом; грейд
    одинаковый — любая, для определённости — с большим доверием (GRADE_TRUST),
    потом последняя."""
    grade = record.get("grade")
    source = (record.get("source") or {}).get("type")
    return (
        _step(grade) if grade in GRADES else -1,
        GRADE_TRUST.get(source, GRADE_TRUST["Manual"]),
        record.get("created_at") or "",
    )


def _fsp(user_id):
    path = USER_FSP_DIR / f"{user_id}.json"
    if not path.is_file():
        return None
    try:
        record = _load(path)
        return {
            "competencies": {
                (c["kind"], c["id"]): {"degree": c["degree"], "points": c["points"]} for c in record.get("competencies", [])
            },
            "points": sum(item.get("points", 0) for item in record.get("competitions", [])),
        }
    except (OSError, ValueError, KeyError, TypeError):
        return None


# --- Грейд ------------------------------------------------------------------------

def _step(grade):
    return GRADES.index(grade)


def grade_fit(applicant, grade=None):
    """Насколько грейд соискателя подходит запрошенному: {"score", "basis", "grade",
    "declared", "source", "confirmed", "refuted"}. basis — какое свидетельство дало
    score: "test" или source.type заявленного (None — свидетельств нет), grade — его
    грейд; confirmed — высший сданный тест; refuted — заявленный опровергнут тестом.
    grade None — любой грейд: score — насколько подтверждён собственный грейд
    соискателя (лучшее из совпадений со всеми грейдами)."""
    if grade is None:
        return max((grade_fit(applicant, g) for g in GRADES), key=lambda view: (view["score"], view["basis"] == "test"))
    target = _step(grade)
    passed, failed, declared = applicant["passed"], applicant["failed"], applicant["declared"]
    confirmed = max(passed, key=_step) if passed else None
    refuted = declared is not None and any(_step(g) <= _step(declared) for g in failed) and not any(
        _step(g) >= _step(declared) for g in passed
    )
    options = []
    if confirmed:
        options.append((GRADE_FIT[_step(confirmed) - target] * GRADE_TRUST["test"], "test", confirmed))
    if declared and not refuted:
        trust = GRADE_TRUST.get(applicant["source"], GRADE_TRUST["Manual"])
        options.append((GRADE_FIT[_step(declared) - target] * trust, applicant["source"], declared))
    score, basis, used = max(options, key=lambda o: (o[0], o[1] == "test"), default=(0.0, None, None))
    return {
        "score": score,
        "basis": basis,
        "grade": used,
        "declared": declared,
        "source": applicant["source"],
        "confirmed": confirmed,
        "refuted": refuted,
    }


# --- Стек -------------------------------------------------------------------------

def credit(degree, min_degree):
    """Балл компетенции со степенью degree за требование степени min_degree, 0…1."""
    if not degree:
        return 0.0
    return (1 - DEGREE_SHARE) * min(degree, min_degree) / min_degree + DEGREE_SHARE * degree / MAX_DEGREE


def _item_fit(kind, item_id, min_degree, competencies, reference):
    """Как соискатель закрывает одну компетенцию требования: {"id", "via", "relation",
    "degree", "score"}; via — чем закрыл (сама или близкая), relation — "exact",
    "adjacent", "similar" или None — нечем."""
    own = competencies.get((kind, item_id))
    if own:
        return {"id": item_id, "via": item_id, "relation": "exact", "degree": own["degree"],
                "score": credit(own["degree"], min_degree)}
    best = {"id": item_id, "via": None, "relation": None, "degree": 0, "score": 0.0}
    for other, (factor, relation) in reference.related.get((kind, item_id), {}).items():
        found = competencies.get((kind, other))
        score = factor * credit(found["degree"], min_degree) if found else 0.0
        if score > best["score"]:
            best = {"id": item_id, "via": other, "relation": relation, "degree": found["degree"], "score": score}
    return best


def requirement_fit(requirement, competencies, reference):
    """Требование вакансии у соискателя: оно же и {"score", "meets", "items"}.
    meets — выполнено как написано: сама компетенция со степенью не ниже min_degree
    (all — каждая, any — хоть одна); близкие в meets не идут, только в score."""
    m = requirement["min_degree"]
    items = [_item_fit(requirement["kind"], i, m, competencies, reference) for i in requirement["ids"]]
    exact = [i["relation"] == "exact" and i["degree"] >= m for i in items]
    if requirement["match"] == "any":
        score, meets = max(i["score"] for i in items), any(exact)
    else:
        score, meets = sum(i["score"] for i in items) / len(items), all(exact)
    fields = ("kind", "ids", "match", "importance", "min_degree")
    return {**{f: requirement[f] for f in fields}, "score": score, "meets": meets, "items": items}


def requirements_fit(requirements, competencies, reference):
    """Стек по вакансии: (score 0…1, [requirement_fit]) — среднее требований с весами IMPORTANCE."""
    rows = [requirement_fit(r, competencies, reference) for r in requirements]
    weight = sum(IMPORTANCE[r["importance"]] for r in rows)
    return sum(IMPORTANCE[r["importance"]] * r["score"] for r in rows) / weight, rows


def profile_fit(role_id, competencies, reference):
    """Стек в поиске по грейду — профиль ФСП целиком: {"score", "weight", "kinds"}.
    weight — простая сумма весов (степень / 3) компетенций, доступных роли; kinds —
    {kind: {"score", "count"}}, score вида — сумма весов с затуханием DECAY,
    делённая на наибольшую возможную."""
    kinds, weight = {}, 0.0
    for kind, available in reference.kinds(role_id).items():
        own = sorted(
            (competencies[(kind, i)] for i in available if (kind, i) in competencies),
            key=lambda c: (-c["degree"], -c["points"]),
        )
        total = sum(c["degree"] / MAX_DEGREE * DECAY ** n for n, c in enumerate(own))
        best = sum(DECAY ** n for n in range(len(available)))
        kinds[kind] = {"score": round(total / best, 3) if best else 0.0, "count": len(own)}
        weight += sum(c["degree"] for c in own) / MAX_DEGREE
    return {
        "score": round(sum(k["score"] for k in kinds.values()) / len(kinds), 3) if kinds else 0.0,
        "weight": round(weight, 2),
        "kinds": kinds,
    }


# --- Выдача -----------------------------------------------------------------------

def _rank(applicants_, grade, weights, reference, requirements=None):
    """Два списка, лучшие первыми: со связкой ФСП и без неё (unconfirmed).
    grade None — любой; requirements — требования вакансии, None или пусто — стек
    по профилю ФСП. competencies в выдаче — компетенции ФСП, доступные роли
    соискателя, сильные первыми."""
    linked, unconfirmed = [], []
    for applicant in applicants_:
        role_id = reference.role_of[applicant["specialization"]]
        grade_view = grade_fit(applicant, grade)
        fsp = applicant["fsp"]
        profile = stack = rows = None
        meets_required = None
        competencies = []
        if fsp is not None:
            competencies = sorted(
                (
                    {"kind": kind, "id": item_id, "degree": c["degree"], "points": c["points"]}
                    for (kind, item_id), c in fsp["competencies"].items()
                    if kind in reference.catalog.items
                    and item_id in reference.catalog.items[kind]
                    and reference.catalog.in_scope(role_id, kind, item_id)
                ),
                key=lambda c: (-c["degree"], -c["points"], c["kind"], c["id"]),
            )
            profile = profile_fit(role_id, fsp["competencies"], reference)
            if requirements:
                score, rows = requirements_fit(requirements, fsp["competencies"], reference)
                meets_required = all(r["meets"] for r in rows if r["importance"] == "required")
                stack = {"score": score, "basis": "requirements"}
            else:
                stack = {"score": profile["score"], "basis": "profile"}
        relevance = 100 * (weights["grade"] * grade_view["score"] + weights["stack"] * (stack["score"] if stack else 0.0))
        entry = {
            "rank": None,
            "user_id": applicant["user_id"],
            "name": applicant["name"],
            "specialization": applicant["specialization"],
            "relevance": round(relevance, 1),
            "grade": {**grade_view, "score": round(grade_view["score"], 3)},
            "stack": None if stack is None else {**stack, "score": round(stack["score"], 3)},
            "requirements": rows,
            "profile": profile,
            "competencies": competencies,
            "fsp_points": fsp["points"] if fsp else None,
            "meets": {
                "grade": grade_view["grade"] is not None and (grade is None or _step(grade_view["grade"]) >= _step(grade)),
                "required": meets_required,
            },
        }
        (linked if fsp is not None else unconfirmed).append(entry)
    for group in (linked, unconfirmed):
        group.sort(key=lambda e: (
            -e["relevance"],
            -e["grade"]["score"],
            -(e["profile"]["score"] if e["profile"] else 0.0),
            -(e["fsp_points"] or 0),
            e["user_id"],
            e["specialization"],
        ))
        for n, entry in enumerate(group, 1):
            entry["rank"] = n
    return linked, unconfirmed


def _result(query, weights, linked, unconfirmed, limit):
    return {
        "query": query,
        "weights": weights,
        "found": len(linked) + len(unconfirmed),
        "linked": len(linked),
        "meet_all": sum(1 for e in linked if e["meets"]["grade"] and e["meets"]["required"] is not False),
        "candidates": linked[:limit] if limit else linked,
        "unconfirmed": unconfirmed[:limit] if limit else unconfirmed,
    }


def _check_specialization(specialization, reference):
    role_id = reference.role_of.get(specialization)
    if role_id is None:
        raise UserError(f"Специализация — {', '.join(reference.role_of)}")
    return role_id


def _check_grade(grade):
    if grade not in GRADES:
        raise UserError(f"Грейд — {', '.join(GRADES)}")
    return grade


def by_specialization(specialization=None, grade=None, limit=None, pool=None):
    """Соискатели специализации (None — всех), лучшие для грейда (None — любого)
    первыми: стек — профиль ФСП целиком. pool — соискатели, уже прочитанные
    applicants(); по умолчанию читаются здесь."""
    reference = Reference()
    if specialization is not None:
        _check_specialization(specialization, reference)
    if grade is not None:
        _check_grade(grade)
    weights = WEIGHTS["specialization"]
    found = applicants(specialization) if pool is None else pool
    found = [a for a in found if specialization is None or a["specialization"] == specialization]
    linked, unconfirmed = _rank(found, grade, weights, reference)
    query = {"type": "specialization", "specialization": specialization, "grade": grade}
    return _result(query, weights, linked, unconfirmed, limit)


def by_vacancy(vacancy, limit=None, pool=None, reference=None):
    """Соискатели специализации вакансии, лучшие для неё первыми. vacancy — запись
    формата projects_jobopenings; требования проверяются, как при утверждении.
    pool — соискатели, уже прочитанные applicants(); по умолчанию читаются здесь.
    reference — уже прочитанные справочники (Reference): много вакансий подряд."""
    if not isinstance(vacancy, dict):
        raise UserError("Вакансия — не объект")
    reference = reference or Reference()
    specialization = vacancy.get("specialization")
    role_id = _check_specialization(specialization, reference)
    grade = _check_grade(vacancy.get("grade"))
    label = f"«{vacancy.get('title') or 'Вакансия'}»"
    raw = vacancy.get("requirements") or []
    if not isinstance(raw, list):
        raise UserError(f"{label}: требования — не список")
    requirements = [projects._requirement(r, role_id, reference.catalog, label) for r in raw]
    weights = WEIGHTS["vacancy"]
    found = applicants(specialization) if pool is None else pool
    found = [a for a in found if a["specialization"] == specialization]
    linked, unconfirmed = _rank(found, grade, weights, reference, requirements)
    query = {
        "type": "vacancy",
        "vacancy_id": vacancy.get("id"),
        "title": vacancy.get("title"),
        "specialization": specialization,
        "grade": grade,
        "requirements": requirements,
    }
    return _result(query, weights, linked, unconfirmed, limit)


def load_vacancy(vacancy_id):
    """Утверждённая вакансия: app/db/projects_jobopenings/<id>.json."""
    try:
        vacancy_id = str(uuid.UUID(str(vacancy_id)))
    except ValueError:
        raise UserError("Нет идентификатора вакансии") from None
    path = VACANCIES_DIR / f"{vacancy_id}.json"
    if not path.is_file():
        raise UserError("Вакансия не найдена", status=404)
    return _load(path)


# --- Командная строка ---------------------------------------------------------------

def _grade_text(grade):
    if grade["basis"] is None:
        return "грейд не подтверждён"
    text = f"{grade['grade']} {'тест' if grade['basis'] == 'test' else 'заявлен'}"
    if grade["refuted"]:
        text += f", заявленный {grade['declared']} не сдан"
    return text


def _requirement_text(row, reference):
    items = row["items"]
    if row["match"] == "any":
        items = [max(items, key=lambda i: i["score"])]
    marks = []
    for item in items:
        name = reference.name(row["kind"], item["id"])
        if item["relation"] == "exact":
            marks.append(f"{name} {item['degree']}/{row['min_degree']}")
        elif item["relation"]:
            marks.append(f"{name} ≈ {reference.name(row['kind'], item['via'])} {item['degree']}")
        else:
            marks.append(f"{name} —")
    sign = "✓" if row["meets"] else ("✗" if row["importance"] == "required" else "·")
    return f"{sign} {', '.join(marks)}"


def describe(result):
    """Выдача текстом для командной строки."""
    reference = Reference()
    query = result["query"]
    if query["type"] == "vacancy":
        head = f"Вакансия «{query['title']}» · {query['specialization']} · {query['grade']} · требований {len(query['requirements'])}"
    else:
        head = f"Поиск: {query['specialization'] or 'все специализации'} · {query['grade'] or 'любой грейд'}"
    lines = [
        head,
        f"Соискателей специализации: {result['found']}, со связкой ФСП: {result['linked']}, "
        f"подходят по грейду{' и обязательным требованиям' if query['type'] == 'vacancy' else ''}: {result['meet_all']}",
        "",
        "Со связкой ФСП:",
    ]
    for entry in result["candidates"]:
        who = entry["name"] or "без имени"
        lines.append(
            f"{entry['rank']:>4}. {entry['relevance']:5.1f}  {who} [{entry['user_id'][:8]}] {entry['specialization']}  "
            f"грейд {entry['grade']['score']:.2f} ({_grade_text(entry['grade'])})  "
            f"стек {entry['stack']['score']:.2f}"
            + (f"  профиль ФСП {entry['profile']['score']:.2f}" if entry["stack"]["basis"] == "requirements" else "")
        )
        if entry["requirements"]:
            lines.append("        " + "; ".join(_requirement_text(r, reference) for r in entry["requirements"]))
    lines += ["", "Без связки с ФСП (стек не подтверждён):"]
    for entry in result["unconfirmed"]:
        who = entry["name"] or "без имени"
        lines.append(
            f"{entry['rank']:>4}. {entry['relevance']:5.1f}  {who} [{entry['user_id'][:8]}]  "
            f"грейд {entry['grade']['score']:.2f} ({_grade_text(entry['grade'])})"
        )
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Ранжирование соискателей по вакансии или по специализации и грейду.")
    parser.add_argument("--vacancy", help="id вакансии в app/db/projects_jobopenings или путь к JSON вакансии")
    parser.add_argument("--specialization", choices=grade_tests.SPECIALIZATIONS)
    parser.add_argument("--grade", choices=GRADES)
    parser.add_argument("--top", type=int, default=10, help="сколько показать в каждом списке, 0 — всех")
    parser.add_argument("--json", action="store_true", help="выдача целиком в JSON")
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    try:
        if args.vacancy:
            path = Path(args.vacancy)
            vacancy = _load(path) if path.is_file() else load_vacancy(args.vacancy)
            result = by_vacancy(vacancy, args.top)
        else:
            result = by_specialization(args.specialization, args.grade, args.top)
    except UserError as error:
        sys.exit(f"Ошибка: {error}")
    print(json.dumps(result, ensure_ascii=False, indent=2) if args.json else describe(result))


if __name__ == "__main__":
    main()
