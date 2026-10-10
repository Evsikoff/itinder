"""Ранжирование вакансий для соискателя — зеркало app/tools/ranking.py.

Рекрутёр спрашивает «кто подходит вакансии», соискатель — «какая вакансия
подходит мне». ITinder — это мэтч: пара хороша, только если хороши обе стороны.
Поэтому релевантность вакансии собирается из трёх частей.

Подхожу (fit) — как рекрутёр видит соискателя на этой вакансии: его релевантность
из ranking.by_vacancy / 100 — тот же грейд по доказательствам, тот же стек по ФСП
и те же требования. Соискатель видит ровно то число, что и рекрутёр, и разбор
требований: что выполнено, чего не хватает.

Подходит (appeal) — что вакансия даёт соискателю, 0…1:

    appeal = APPEAL["stack"] × strengths + APPEAL["grade"] × growth,

веса те же, что у рекрутёра в поиске по вакансии (стек 65 %, грейд 35 %), только
вопрос задаёт другая сторона.
    strengths — сильные стороны в деле: компетенции ФСП соискателя, доступные
        роли вакансии, от сильной к слабой; вес n-й — степень / 3 × DECAY^n
        (глубина важнее ширины, как в ranking.profile_fit). Каждая засчитывается
        долей: стоит в требованиях вакансии — USE по важности требования
        (обязательное — целиком, желательное — наполовину); там близкая
        (rules.adjacent анкеты) или того же рода — со скидкой ranking.ADJACENT
        и ranking.SIMILAR; не нужна — 0. strengths = Σ вес × доля / Σ вес.
        У вакансии нет требований — NO_REQUIREMENTS: стек выберет команда.
        Профиль не связан с ФСП — сильные стороны неизвестны: UNKNOWN.
    growth — ступень вакансии относительно своего грейда соискателя
        (подтверждённый тестом, иначе заявленный и не опровергнутый): GROWTH —
        зеркало ranking.GRADE_FIT. Рекрутёру лучше кандидат на ступень выше, чем
        ниже; соискателю — вакансия на ступень выше (рост), чем ниже (шаг назад).
        Своего грейда нет — UNKNOWN. Чего не знаем, то считаем серединой.

Взаимность (mutual) = √(fit × appeal) — среднее геометрическое: перекос в одну
сторону не спасает (0,9 и 0,2 дают 0,42, а 0,6 и 0,6 — 0,6).

Очередь (queue) — где соискатель в списке рекрутёра по этой вакансии (сначала
со связкой ФСП, потом без неё), 0…1: в пределах свободных мест (count минус
принятые приглашения) — 1, дальше — доля соискателей специализации, которых он
обходит: (N − место) / (N − мест). Очередь срезает не больше QUEUE: из двух
равных вакансий выше та, где конкурентов впереди меньше.

    relevance = 100 × mutual × (1 − QUEUE + QUEUE × queue)

Жёсткий отбор, как у рекрутёра, один — специализация: вакансии тех
специализаций, что есть у соискателя в user_specializations (у каждой своя
запись; записей одной несколько — с высшим грейдом, ranking._preference).
И вакансия открыта: проект утверждён, набор не завершён, вакансия готова
(status ready) и не закрыта наймом. Свои вакансии (соискатель ещё и рекрутёр)
не показываются. Спрятавшийся соискатель (user_blocks) вакансии видит: в поиске
рекрутёров его нет, но откликнуться он может сам.

При равной релевантности выше та, где больше fit, потом где вилка выше
(salary.to), дальше — по id, чтобы порядок не прыгал. Папки читаются по разу
на запрос.

Командная строка:
    python app/tools/vacancy_ranking.py <user_id> [--top N] [--json]
"""

import argparse
import json
import math
import sys

import grade_tests
import invitations
import projects
import ranking
import specializations
from users import UserError

GRADES = ranking.GRADES
APPEAL = ranking.WEIGHTS["vacancy"]  # {"grade": 0.35, "stack": 0.65}
# Грейд вакансии минус свой, в ступенях → насколько вакансия интересна.
GROWTH = {0: 1.0, 1: 0.8, -1: 0.3, 2: 0.2, -2: 0.0}
USE = {"required": 1.0, "plus": 0.5}  # доля компетенции из требования по его важности
NO_REQUIREMENTS = 0.5  # стек не задан: выберет команда
UNKNOWN = 0.5  # нет своего грейда или связки с ФСП
QUEUE = 0.2  # насколько очередь может срезать взаимность
DECAY = ranking.DECAY
NO_APPLICANT = "Вакансии подбираются соискателю: у вас нет специализации соискателя"


# --- Вакансии -----------------------------------------------------------------

def open_vacancies(counts):
    """Открытые вакансии всех рекрутёров: [(вакансия, проект)]. counts —
    invitations.vacancy_counts: закрытые наймом не попадают."""
    found = []
    for project in ranking._read_dir(projects.PROJECTS_DIR):
        if not project.get("approved_at") or project.get("completed_at"):
            continue
        for vacancy in projects._approved_vacancies(project):
            if (vacancy.get("user_id") != project.get("user_id") or vacancy.get("project_id") != project.get("id")
                    or vacancy.get("specialization") not in grade_tests.SPECIALIZATIONS
                    or vacancy.get("status") != "ready" or invitations.is_closed(vacancy, counts)):
                continue
            found.append((vacancy, project))
    return found


# --- Подходит -------------------------------------------------------------------

def growth(grade_view, vacancy_grade):
    """Уровень вакансии для соискателя: {"score", "own", "step"}. own — свой грейд
    (тест, иначе заявленный и не опровергнутый) или None, step — сколько ступеней
    от него до грейда вакансии."""
    own = grade_view["confirmed"] or (None if grade_view["refuted"] else grade_view["declared"])
    if own not in GRADES or vacancy_grade not in GRADES:
        return {"score": UNKNOWN, "own": None, "step": None}
    step = GRADES.index(vacancy_grade) - GRADES.index(own)
    return {"score": GROWTH[step], "own": own, "step": step}


def _use(kind, item_id, requirements, reference):
    """Нужна ли вакансии компетенция соискателя: (доля, relation, via, importance) —
    via — компетенция требования, которую она закрывает; не нужна — (0, None…)."""
    best = (0.0, None, None, None)
    links = reference.related.get((kind, item_id), {})
    for requirement in requirements:
        if requirement["kind"] != kind:
            continue
        for target in requirement["ids"]:
            if target == item_id:
                factor, relation = 1.0, "exact"
            elif target in links:
                factor, relation = links[target]
            else:
                continue
            share = USE[requirement["importance"]] * factor
            if share > best[0]:
                best = (share, relation, target, requirement["importance"])
    return best


def strengths(competencies, requirements, reference):
    """Сильные стороны в деле: {"score", "basis", "items"}. competencies —
    компетенции ФСП соискателя, доступные роли, сильные первыми (как в выдаче
    ranking), None — профиль не связан с ФСП. basis — "requirements", "free"
    (у вакансии нет требований) или "unknown" (нет связки с ФСП); items —
    каждая компетенция с весом и долей."""
    if competencies is None:
        return {"score": UNKNOWN, "basis": "unknown", "items": []}
    items, total, used = [], 0.0, 0.0
    for n, competency in enumerate(competencies):
        weight = competency["degree"] / ranking.MAX_DEGREE * DECAY ** n
        share, relation, via, importance = _use(competency["kind"], competency["id"], requirements, reference)
        items.append({
            "kind": competency["kind"], "id": competency["id"], "degree": competency["degree"],
            "weight": round(weight, 3), "share": round(share, 3),
            "relation": relation, "via": via, "importance": importance,
        })
        total += weight
        used += weight * share
    if not requirements:
        return {"score": NO_REQUIREMENTS, "basis": "free", "items": items}
    return {"score": round(used / total, 3) if total else 0.0, "basis": "requirements", "items": items}


def appeal(entry, vacancy, requirements, reference):
    """Что вакансия даёт соискателю: {"score", "strengths", "growth"}."""
    linked = entry["profile"] is not None
    own = strengths(entry["competencies"] if linked else None, requirements, reference)
    level = growth(entry["grade"], vacancy.get("grade"))
    score = APPEAL["stack"] * own["score"] + APPEAL["grade"] * level["score"]
    return {"score": round(score, 3), "strengths": own, "growth": level}


# --- Очередь --------------------------------------------------------------------

def queue(place, total, seats):
    """Место в списке рекрутёра: {"score", "place", "of", "seats"}."""
    score = 1.0 if place <= seats else (total - place) / (total - seats)
    return {"score": round(score, 3), "place": place, "of": total, "seats": seats}


# --- Выдача ---------------------------------------------------------------------

def for_applicant(user_id, limit=None):
    """Открытые вакансии специализаций соискателя, лучшие для него первыми:
    {"user_id", "specializations", "fsp_linked", "found", "weights", "vacancies"}.
    Вакансия — {"rank", "relevance", "mutual", "specialization", "vacancy" (запись
    projects_jobopenings), "project", "seats", "requirements" (проверенные), "fit",
    "appeal", "queue"}. Нет специализации соискателя — UserError 403."""
    user_id = specializations.check_user(user_id)
    reference = ranking.Reference()
    pool = ranking.applicants(also=user_id)
    mine = {a["specialization"]: a for a in pool if a["user_id"] == user_id}
    if not mine:
        raise UserError(NO_APPLICANT, status=403)
    by_specialization = {}
    for applicant in pool:
        by_specialization.setdefault(applicant["specialization"], []).append(applicant)
    counts = invitations.vacancy_counts(invitations.records())
    entries = []
    for vacancy, project in open_vacancies(counts):
        specialization = vacancy["specialization"]
        recruiter_id = vacancy.get("user_id")
        if specialization not in mine or recruiter_id == user_id:
            continue
        competitors = [a for a in by_specialization[specialization] if a["user_id"] != recruiter_id]
        try:
            result = ranking.by_vacancy(vacancy, pool=competitors, reference=reference)
        except UserError:
            continue  # вакансия не проходит нынешние справочники — её не с чем сравнить
        ranked = result["candidates"] + result["unconfirmed"]
        place, entry = next((n, e) for n, e in enumerate(ranked, 1) if e["user_id"] == user_id)
        count = vacancy.get("count", 1)
        seats = max(1, count - counts.get(vacancy["id"], {}).get("accepted", 0))
        requirements = result["query"]["requirements"]
        fit = entry["relevance"] / 100
        wanted = appeal(entry, vacancy, requirements, reference)
        mutual = math.sqrt(fit * wanted["score"])
        line = queue(place, len(ranked), seats)
        entries.append({
            "rank": None,
            "relevance": round(100 * mutual * (1 - QUEUE + QUEUE * line["score"]), 1),
            "mutual": round(mutual, 3),
            "specialization": specialization,
            "vacancy": vacancy,
            "project": project,
            "seats": seats,
            "requirements": requirements,
            "fit": {
                "score": round(fit, 3),
                "grade": entry["grade"],
                "stack": entry["stack"],
                "requirements": entry["requirements"],
                "meets": entry["meets"],
                "linked": entry["profile"] is not None,
            },
            "appeal": wanted,
            "queue": line,
        })
    entries.sort(key=lambda e: (
        -e["relevance"],
        -e["fit"]["score"],
        -((e["vacancy"].get("salary") or {}).get("to") or 0),
        e["vacancy"]["id"],
    ))
    for n, entry in enumerate(entries, 1):
        entry["rank"] = n
    return {
        "user_id": user_id,
        "specializations": sorted(mine),
        "fsp_linked": any(a["fsp"] is not None for a in mine.values()),
        "found": len(entries),
        "weights": {"appeal": APPEAL, "queue": QUEUE},
        "vacancies": entries[:limit] if limit else entries,
    }


# --- Командная строка ---------------------------------------------------------------

def describe(result):
    """Выдача текстом для командной строки."""
    lines = [
        f"Соискатель {result['user_id']} · {', '.join(result['specializations'])} · "
        f"{'профиль ФСП связан' if result['fsp_linked'] else 'без связки с ФСП: стек не с чем сравнить'}",
        f"Открытых вакансий его специализаций: {result['found']}",
        "",
    ]
    for entry in result["vacancies"]:
        vacancy, level, own = entry["vacancy"], entry["appeal"]["growth"], entry["appeal"]["strengths"]
        salary = vacancy.get("salary") or {}
        company = (vacancy.get("company") or {}).get("name")
        strong = f"{own['score']:.2f}" + {"requirements": "", "free": " без требований", "unknown": " неизвестны"}[own["basis"]]
        start = "" if level["own"] is None else f" от {level['own']}"
        lines.append(
            f"{entry['rank']:>4}. {entry['relevance']:5.1f}  {vacancy.get('title')} · {company}"
            f"  {salary.get('from')}–{salary.get('to')}"
        )
        lines.append(
            f"        подхожу {entry['fit']['score']:.2f} · подходит {entry['appeal']['score']:.2f} "
            f"(сильные стороны {strong}, уровень {level['score']:.2f}{start}) · "
            f"очередь {entry['queue']['place']}/{entry['queue']['of']} → {entry['queue']['score']:.2f}"
        )
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Ранжирование открытых вакансий для соискателя.")
    parser.add_argument("user_id", help="id соискателя в app/db/users")
    parser.add_argument("--top", type=int, default=10, help="сколько показать, 0 — все")
    parser.add_argument("--json", action="store_true", help="выдача целиком в JSON")
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    try:
        result = for_applicant(args.user_id, args.top)
    except UserError as error:
        sys.exit(f"Ошибка: {error}")
    print(json.dumps(result, ensure_ascii=False, indent=2) if args.json else describe(result))


if __name__ == "__main__":
    main()
