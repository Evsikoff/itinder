"""Проекты и вакансии рекрутёра — окно «Проекты и вакансии» (значок 8 на рабочем
столе portfolio-inner-site, режим Recruiter).

Рекрутёр заводит проект: название, компания (из app/db/companies или новая),
потом анкета по app/db/project_questionnaire.json. Анкету целиком считает окно
(portfolio-inner-site, src/projectQuestionnaire.ts): какие вопросы показать,
что из ответов следует, какие вакансии получаются. Сервер отдаёт ему всё нужное
одним запросом (catalog) и проверяет то, что записывает: вакансии — по
справочникам стека, ролей и правилам анкеты (rules.positions, rules.role_scope).

Файлы:
    app/db/companies/<id>.json — компании, общие для всех рекрутёров:
        {"id", "name", "industry", "city", "description", "created_at", "created_by"}.
        Новую создаёт сохранение проекта с названием компании, которой ещё нет.
    app/db/user_project_company/<id>.json — проект: кто завёл (user_id),
        компания, ответы анкеты, сводка, черновики вакансий до утверждения,
        потом — ссылки на файлы вакансий.
    app/db/projects_jobopenings/<id>.json — утверждённые вакансии, по файлу
        на вакансию (формат — vacancy в project_questionnaire.json).

Проект живёт так: анкета заполнена — файл проекта с черновиками вакансий,
которые сформировало окно (status draft); рекрутёр правит список, у каждой
вакансии — зарплатная вилка, утверждает — файлы вакансий (open); набор закончен —
completed, вакансии остаются, но правятся только после «Возобновить набор».

Рынок для подсказок анкеты (market) — соискатели без имён и идентификаторов:
роль, грейд (подтверждённый тестом, иначе заявленный) и компетенции из
app/db/user_fsp со степенью подтверждения. Папки читаются по разу на запрос.

API — app/tools/serve.py: GET /api/projects/catalog (catalog), GET /api/projects
(list_projects), GET /api/project (get_project), POST /api/projects (create),
POST /api/projects/delete|copy|complete|vacancies.
"""

import json
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

from data_paths import mutable_dir

import grade_tests
import specializations
from users import USERS_DIR, UserError

ROOT = Path(__file__).resolve().parent.parent.parent
DB = ROOT / "app" / "db"
QUESTIONNAIRE = DB / "project_questionnaire.json"
STACK = DB / "fsp_stack.json"
ROLES = DB / "fsp_team_roles.json"
COMPANIES_DIR = mutable_dir("companies")
PROJECTS_DIR = mutable_dir("user_project_company")
VACANCIES_DIR = mutable_dir("projects_jobopenings")
USER_FSP_DIR = mutable_dir("user_fsp")
USER_BLOCKS_DIR = mutable_dir("user_blocks")

GRADES = grade_tests.GRADES
MAX_NAME = 120
MAX_TEXT = 2000
MAX_REASON = 300
MAX_VACANCIES = 50
MAX_REQUIREMENTS = 40
MAX_ASSIGNMENTS = 20
MAX_ASSIGNMENT = 4000
MAX_COUNT = 99
MAX_SALARY = 10_000_000
MAX_BODY = 512 * 1024
CURRENCY = "RUB"
IMPORTANCE = ("required", "plus")
MATCH = ("all", "any")
ORIGINS = ("fixed", "market", "legacy", "rule", "manual")
DEGREES = (1, 2, 3)
# Поля раздела «Проект» анкеты, которые переходят в вакансию (vacancy.project).
PROJECT_FIELDS = ("project_summary", "domain", "stage", "duration", "start_date", "work_format", "city")

_lock = threading.RLock()  # записи и составное создание/утверждение: сервер многопоточный


def _now():
    return datetime.now(timezone.utc).isoformat()


def _load(path):
    return json.loads(path.read_text(encoding="utf-8"))


def _read_dir(folder):
    """Записи папки по одной; битый файл пропускается."""
    for path in sorted(folder.glob("*.json")) if folder.is_dir() else ():
        try:
            yield _load(path)
        except (OSError, ValueError):
            continue


def _write(path, record, create=False):
    """Записывает целиком: create — только новый файл, иначе замена через временный."""
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(record, ensure_ascii=False, indent=2) + "\n"
    if create:
        with open(path, "x", encoding="utf-8", newline="\n") as file:
            file.write(text)
        return
    temporary = path.with_suffix(".tmp")
    temporary.write_text(text, encoding="utf-8", newline="\n")
    temporary.replace(path)


def _uuid(value, what):
    try:
        return str(uuid.UUID(str(value)))
    except ValueError:
        raise UserError(f"Нет идентификатора: {what}") from None


def _text(value, field, limit, required=True):
    """Строка без лишних пробелов по краям; пустая и необязательная — None."""
    if value is None:
        value = ""
    if not isinstance(value, str):
        raise UserError(f"{field}: нужна строка")
    value = value.strip()
    if not value:
        if required:
            raise UserError(f"{field}: заполните")
        return None
    if len(value) > limit:
        raise UserError(f"{field}: не больше {limit} символов")
    return value


def check_recruiter(user_id):
    """Идентификатор пользователя-рекрутёра; не рекрутёр — UserError 403."""
    user_id = specializations.check_user(user_id)
    if not any(r.get("specialization") == specializations.RECRUITER for r in specializations.records(user_id)):
        raise UserError("Проекты и вакансии доступны только рекрутёру", status=403)
    return user_id


# --- Справочники --------------------------------------------------------------

class Catalog:
    """Анкета, стек и роли для проверки вакансий."""

    def __init__(self):
        self.questionnaire = _load(QUESTIONNAIRE)
        self.stack = _load(STACK)
        self.roles = {r["id"]: r for r in _load(ROLES)}
        self.items = {kind: {i["id"]: i for i in items} for kind, items in self.stack.items()}
        rules = self.questionnaire["rules"]
        self.positions = {p["id"]: p for p in rules["positions"]}
        self.scope = rules["role_scope"]

    def in_scope(self, role_id, kind, item_id):
        """Может ли компетенция стоять в требованиях роли (rules.role_scope)."""
        if kind not in self.scope["kinds"].get(role_id, ()):
            return False
        if kind == "languages" and role_id not in self.items[kind][item_id]["roles"]:
            return False
        only = self.scope.get("only", {}).get(role_id, {}).get(kind)
        return only is None or item_id in only

    def name(self, kind, item_id):
        return self.items[kind][item_id]["name"]


def market():
    """Соискатели для подсказок анкеты: [{"role", "grade", "competencies"}] без
    имён и идентификаторов. Соискатель — у кого есть специализация не Recruiter
    и нет файла в user_blocks; роль — по последней такой специализации
    (fsp_team_roles.json), грейд — высший пройденный тест этой специализации,
    иначе заявленный. competencies — {"kind:id": степень} из user_fsp или None,
    если профиль не связан с ФСП. Порядок — по роли и грейду."""
    role_of = {r["specialization"]: r["id"] for r in _load(ROLES)}
    users = {path.stem for path in USERS_DIR.glob("*.json")} if USERS_DIR.is_dir() else set()
    blocked = {path.stem for path in USER_BLOCKS_DIR.glob("*.json")} if USER_BLOCKS_DIR.is_dir() else set()
    latest = {}
    for record in _read_dir(specializations.SPECIALIZATIONS_DIR):
        if record.get("specialization") == specializations.RECRUITER:
            continue
        user_id = record.get("user_id")
        if user_id not in latest or (record.get("created_at") or "") > (latest[user_id].get("created_at") or ""):
            latest[user_id] = record
    passed = {}  # (user_id, специализация) → высший пройденный грейд
    for record in _read_dir(grade_tests.TESTS_DIR):
        if record.get("passed") and record.get("grade") in GRADES:
            key = (record.get("user_id"), record.get("specialization"))
            if key not in passed or GRADES.index(record["grade"]) > GRADES.index(passed[key]):
                passed[key] = record["grade"]
    applicants = []
    for user_id, record in latest.items():
        role = role_of.get(record.get("specialization"))
        if user_id not in users or user_id in blocked or role is None:
            continue
        grade = passed.get((user_id, record["specialization"]), record.get("grade"))
        if grade not in GRADES:
            continue
        competencies = None
        fsp_path = USER_FSP_DIR / f"{user_id}.json"
        if fsp_path.is_file():
            try:
                competencies = {f"{c['kind']}:{c['id']}": c["degree"] for c in _load(fsp_path).get("competencies", [])}
            except (OSError, ValueError, KeyError, TypeError):
                competencies = None
        applicants.append({"role": role, "grade": grade, "competencies": competencies})
    applicants.sort(key=lambda a: (a["role"], GRADES.index(a["grade"])))
    return applicants


# --- Компании -------------------------------------------------------------------

def _company_view(record):
    return {field: record.get(field) for field in ("id", "name", "industry", "city", "description")}


def companies():
    """Компании по алфавиту."""
    return sorted((_company_view(c) for c in _read_dir(COMPANIES_DIR)), key=lambda c: (c["name"] or "").casefold())


def _company(user_id, value):
    """Компания проекта: {"id"} — из списка, {"name"} — новая. Новая с названием,
    которое уже есть (без учёта регистра и пробелов), — та, что есть.
    Вызывается под _lock."""
    if not isinstance(value, dict):
        raise UserError("Не указана компания")
    if value.get("id") is not None:
        company_id = _uuid(value["id"], "компания")
        path = COMPANIES_DIR / f"{company_id}.json"
        if not path.is_file():
            raise UserError("Компания не найдена — выберите её из списка заново", status=404)
        return _load(path)
    name = " ".join((_text(value.get("name"), "Название компании", MAX_NAME) or "").split())
    for record in _read_dir(COMPANIES_DIR):
        if " ".join((record.get("name") or "").split()).casefold() == name.casefold():
            return record
    record = {
        "id": str(uuid.uuid4()),
        "name": name,
        "industry": None,
        "city": None,
        "description": None,
        "created_at": _now(),
        "created_by": user_id,
    }
    _write(COMPANIES_DIR / f"{record['id']}.json", record, create=True)
    return record


def _company_by_id(company_id):
    path = COMPANIES_DIR / f"{company_id}.json"
    return _company_view(_load(path)) if path.is_file() else {"id": company_id, "name": "Компания удалена"}


# --- Вакансии ------------------------------------------------------------------

def _salary(value, required, label):
    """Зарплатная вилка {"from", "to", "currency"} или None, если её нет и она не обязательна."""
    if value in (None, {}):
        value = {}
    if not isinstance(value, dict):
        raise UserError(f"{label}: зарплатная вилка — не объект")
    low, high = value.get("from"), value.get("to")
    if low is None and high is None and not required:
        return None
    for bound, word in ((low, "от"), (high, "до")):
        if bound is None:
            raise UserError(f"{label}: укажите зарплату «{word}» — вилка обязательна")
        if not isinstance(bound, int) or isinstance(bound, bool) or not 1 <= bound <= MAX_SALARY:
            raise UserError(f"{label}: зарплата «{word}» — целое число рублей от 1 до {MAX_SALARY:,}".replace(",", " "))
    if low > high:
        raise UserError(f"{label}: зарплата «от» больше, чем «до»")
    return {"from": low, "to": high, "currency": CURRENCY}


def _requirement(raw, role_id, catalog, label):
    if not isinstance(raw, dict):
        raise UserError(f"{label}: требование — не объект")
    kind = raw.get("kind")
    if kind not in catalog.items:
        raise UserError(f"{label}: неизвестный вид стека {kind!r}")
    ids = raw.get("ids")
    if not isinstance(ids, list) or not ids or not all(isinstance(i, str) for i in ids) or len(set(ids)) != len(ids):
        raise UserError(f"{label}: в требовании нет компетенций")
    for item_id in ids:
        if item_id not in catalog.items[kind]:
            raise UserError(f"{label}: нет такой компетенции {item_id!r}")
        if not catalog.in_scope(role_id, kind, item_id):
            raise UserError(f"{label}: «{catalog.name(kind, item_id)}» не проверяется у этой роли")
    match = raw.get("match", "all")
    if match not in MATCH:
        raise UserError(f"{label}: match — all или any")
    importance = raw.get("importance")
    if importance not in IMPORTANCE:
        raise UserError(f"{label}: обязательность требования — required или plus")
    degree = raw.get("min_degree")
    if degree not in DEGREES or isinstance(degree, bool):
        raise UserError(f"{label}: степень подтверждения — 1, 2 или 3")
    origin = raw.get("origin", "manual")
    if origin not in ORIGINS:
        raise UserError(f"{label}: неизвестное происхождение требования {origin!r}")
    reasons = raw.get("reasons") or []
    if not isinstance(reasons, list) or len(reasons) > 10:
        raise UserError(f"{label}: причины требования — список до 10 строк")
    return {
        "kind": kind,
        "ids": ids,
        "match": match if len(ids) > 1 else "all",
        "importance": importance,
        "min_degree": degree,
        "origin": origin,
        "reasons": [_text(r, f"{label}: причина", MAX_REASON) for r in reasons],
    }


def _assignments(value, label):
    """Задания вакансии: суть каждого — текстом рекрутёра."""
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > MAX_ASSIGNMENTS:
        raise UserError(f"{label}: заданий — не больше {MAX_ASSIGNMENTS}")
    return [_text(text, f"{label}: задание {n}", MAX_ASSIGNMENT) for n, text in enumerate(value, 1)]


def _vacancy(raw, catalog, approve):
    """Вакансия из запроса, проверенная. approve — утверждение: задача и вилка обязательны."""
    if not isinstance(raw, dict):
        raise UserError("Вакансия — не объект")
    position = catalog.positions.get(raw.get("position"))
    if position is None:
        raise UserError("Неизвестная позиция вакансии")
    role = catalog.roles[position["role"]]
    title = _text(raw.get("title"), "Название вакансии", MAX_NAME)
    label = f"«{title}»"
    grade = raw.get("grade")
    if grade not in GRADES:
        raise UserError(f"{label}: грейд — Junior, Middle или Senior")
    count = raw.get("count")
    if not isinstance(count, int) or isinstance(count, bool) or not 1 <= count <= MAX_COUNT:
        raise UserError(f"{label}: сколько человек — от 1 до {MAX_COUNT}")
    rows = raw.get("requirements") or []
    if not isinstance(rows, list) or len(rows) > MAX_REQUIREMENTS:
        raise UserError(f"{label}: требований — не больше {MAX_REQUIREMENTS}")
    requirements, seen = [], set()
    for row in rows:
        requirement = _requirement(row, role["id"], catalog, label)
        key = (requirement["kind"], frozenset(requirement["ids"]))
        if key in seen:
            names = ", ".join(catalog.name(requirement["kind"], i) for i in requirement["ids"])
            raise UserError(f"{label}: требование «{names}» указано дважды")
        seen.add(key)
        requirements.append(requirement)
    return {
        "id": raw.get("id"),
        "title": title,
        "position": position["id"],
        "position_name": _text(raw.get("position_name"), f"{label}: позиция", MAX_NAME, required=False)
        or position["name"],
        "role_id": role["id"],
        "specialization": role["specialization"],
        "grade": grade,
        "count": count,
        "task": _text(raw.get("task"), f"{label}: чем займётся", MAX_TEXT, required=approve),
        "requirements": requirements,
        "assignments": _assignments(raw.get("assignments"), label),
        "salary": _salary(raw.get("salary"), approve, label),
        "notes": _text(raw.get("notes"), f"{label}: что ещё сказать", MAX_TEXT, required=False),
    }


def _vacancies(value, catalog, approve):
    if not isinstance(value, list) or len(value) > MAX_VACANCIES:
        raise UserError(f"Вакансии — список до {MAX_VACANCIES}")
    if approve and not value:
        raise UserError("Утверждать нечего: добавьте хотя бы одну вакансию")
    return [_vacancy(raw, catalog, approve) for raw in value]


# --- Проекты -------------------------------------------------------------------

def _project_path(project_id):
    return PROJECTS_DIR / f"{project_id}.json"


def _vacancy_path(vacancy_id):
    return VACANCIES_DIR / f"{vacancy_id}.json"


def _own_project(user_id, project_id):
    """Запись проекта рекрутёра; чужой или несуществующий — 404."""
    path = _project_path(_uuid(project_id, "проект"))
    record = _load(path) if path.is_file() else None
    if record is None or record.get("user_id") != user_id:
        raise UserError("Проект не найден — обновите список", status=404)
    return record


def _approved_vacancies(project):
    found = []
    for vacancy_id in project.get("vacancy_ids") or []:
        path = _vacancy_path(vacancy_id)
        if path.is_file():
            found.append(_load(path))
    return found


def _status(project):
    if project.get("completed_at"):
        return "completed"
    return "open" if project.get("approved_at") else "draft"


def _summary_view(project):
    """Строка списка проектов."""
    vacancies = _approved_vacancies(project) if project.get("approved_at") else project.get("vacancies_draft") or []
    return {
        "id": project["id"],
        "name": project["name"],
        "company": _company_by_id(project["company_id"]),
        "status": _status(project),
        "vacancies": len(vacancies),
        "people": sum(v.get("count", 0) for v in vacancies),
        "created_at": project["created_at"],
        "updated_at": project["updated_at"],
        "approved_at": project.get("approved_at"),
        "completed_at": project.get("completed_at"),
        "copied_from": project.get("copied_from"),
    }


def _full_view(project):
    """Проект целиком: строка списка, ответы анкеты, сводка и вакансии —
    утверждённые из файлов или черновики."""
    approved = bool(project.get("approved_at"))
    return {
        **_summary_view(project),
        "questionnaire": project["questionnaire"],
        "answers": project["answers"],
        "summary": project["summary"],
        "approved": approved,
        "vacancies_list": _approved_vacancies(project) if approved else project.get("vacancies_draft") or [],
    }


def catalog(user_id):
    """Всё, что окну нужно для анкеты: {"questionnaire", "stack", "roles",
    "companies", "market"}."""
    check_recruiter(user_id)
    return {
        "questionnaire": _load(QUESTIONNAIRE),
        "stack": _load(STACK),
        "roles": _load(ROLES),
        "companies": companies(),
        "market": market(),
    }


def list_projects(user_id):
    """Проекты рекрутёра, новые первыми."""
    user_id = check_recruiter(user_id)
    own = [p for p in _read_dir(PROJECTS_DIR) if p.get("user_id") == user_id]
    own.sort(key=lambda p: p.get("created_at") or "", reverse=True)
    return {"projects": [_summary_view(p) for p in own]}


def get_project(user_id, project_id):
    user_id = check_recruiter(user_id)
    return _full_view(_own_project(user_id, project_id))


def _open_questions(value):
    if not isinstance(value, list) or len(value) > 100:
        raise UserError("Открытые вопросы — список")
    result = []
    for item in value:
        if not isinstance(item, dict):
            raise UserError("Открытый вопрос — не объект")
        result.append({
            "text": _text(item.get("text"), "Открытый вопрос", MAX_TEXT),
            "blocking": bool(item.get("blocking")),
            "origin": _text(item.get("origin"), "Откуда вопрос", MAX_NAME, required=False),
            "resolved": bool(item.get("resolved")),
        })
    return result


def create(user_id, data):
    """Анкета заполнена: файл проекта с ответами, сводкой и черновиками вакансий,
    которые сформировало окно. Новая компания записывается здесь же."""
    user_id = check_recruiter(user_id)
    catalog_ = Catalog()
    name = _text(data.get("name"), "Название проекта", MAX_NAME)
    answers = data.get("answers")
    summary = data.get("summary")
    if not isinstance(answers, dict) or not isinstance(summary, dict):
        raise UserError("Нет ответов анкеты")
    summary = {**summary, "open_questions": _open_questions(summary.get("open_questions") or [])}
    drafts = _vacancies(data.get("vacancies"), catalog_, approve=False)
    for draft in drafts:
        draft["id"] = None
    questionnaire = catalog_.questionnaire
    with _lock:
        company = _company(user_id, data.get("company"))
        now = _now()
        record = {
            "id": str(uuid.uuid4()),
            "user_id": user_id,
            "company_id": company["id"],
            "name": name,
            "questionnaire": {"id": questionnaire["id"], "version": questionnaire["version"]},
            "answers": answers,
            "summary": summary,
            "vacancies_draft": drafts,
            "vacancy_ids": [],
            "approved_at": None,
            "completed_at": None,
            "copied_from": None,
            "created_at": now,
            "updated_at": now,
        }
        _write(_project_path(record["id"]), record, create=True)
    return _full_view(record)


def delete(user_id, project_id):
    """Удаляет проект и файлы его вакансий."""
    user_id = check_recruiter(user_id)
    with _lock:
        project = _own_project(user_id, project_id)
        for vacancy_id in project.get("vacancy_ids") or []:
            _vacancy_path(vacancy_id).unlink(missing_ok=True)
        _project_path(project["id"]).unlink()
    return {"deleted": project["id"], "name": project["name"]}


def copy(user_id, project_id, name):
    """Копия проекта под новым названием: та же компания и ответы анкеты, вакансии
    с теми же вилками — черновиком, их нужно утвердить заново; набор не завершён."""
    user_id = check_recruiter(user_id)
    name = _text(name, "Название копии", MAX_NAME)
    with _lock:
        source = _own_project(user_id, project_id)
        vacancies = _approved_vacancies(source) if source.get("approved_at") else source.get("vacancies_draft") or []
        fields = ("title", "position", "position_name", "role_id", "specialization", "grade", "count", "task",
                  "requirements", "assignments", "salary", "notes")
        now = _now()
        record = {
            **source,
            "id": str(uuid.uuid4()),
            "name": name,
            "vacancies_draft": [{"id": None, **{field: v.get(field) for field in fields}} for v in vacancies],
            "vacancy_ids": [],
            "approved_at": None,
            "completed_at": None,
            "copied_from": source["id"],
            "created_at": now,
            "updated_at": now,
        }
        _write(_project_path(record["id"]), record, create=True)
    return _full_view(record)


def set_completed(user_id, project_id, completed):
    """Набор по проекту завершён (completed) или возобновлён."""
    user_id = check_recruiter(user_id)
    if not isinstance(completed, bool):
        raise UserError("Не сказано, завершён ли набор")
    with _lock:
        project = _own_project(user_id, project_id)
        if completed and not project.get("approved_at"):
            raise UserError("Сначала утвердите вакансии проекта", status=409)
        project["completed_at"] = _now() if completed else None
        project["updated_at"] = _now()
        _write(_project_path(project["id"]), project)
    return _full_view(project)


def _project_block(project):
    """vacancy.project: что о проекте знать соискателю — из ответов анкеты."""
    answers = project.get("answers") or {}
    block = {"name": project["name"]}
    for field in PROJECT_FIELDS:
        value = answers.get(field)
        block["summary" if field == "project_summary" else field] = value if isinstance(value, str) and value else None
    return block


def approve(user_id, project_id, vacancies, open_questions):
    """Рекрутёр утвердил список вакансий: у каждой — зарплатная вилка. Вакансии
    записываются файлами в projects_jobopenings (прежние файлы проекта, которых
    нет в списке, удаляются), проект запоминает их id. open_questions — открытые
    вопросы с отметкой «решён»; хоть один нерешённый блокирующий — вакансии
    в статусе draft."""
    user_id = check_recruiter(user_id)
    catalog_ = Catalog()
    checked = _vacancies(vacancies, catalog_, approve=True)
    questions = _open_questions(open_questions)
    with _lock:
        project = _own_project(user_id, project_id)
        if project.get("completed_at"):
            raise UserError("Набор по проекту завершён — сначала возобновите его", status=409)
        old_ids = set(project.get("vacancy_ids") or [])
        company = _company_by_id(project["company_id"])
        status = "draft" if any(q["blocking"] and not q["resolved"] for q in questions) else "ready"
        now = _now()
        project["summary"]["open_questions"] = questions
        written = []
        for vacancy in checked:
            known = vacancy["id"] if vacancy["id"] in old_ids else None
            previous = _load(_vacancy_path(known)) if known and _vacancy_path(known).is_file() else None
            record = {
                **vacancy,
                "id": known or str(uuid.uuid4()),
                "project_id": project["id"],
                "user_id": user_id,
                "company": {"id": company["id"], "name": company["name"]},
                "project": _project_block(project),
                "stack_origin": project["summary"].get("stack_mode"),
                "open_questions": [q for q in questions if not q["resolved"]],
                "status": status,
                "approved_at": now,
                "created_at": previous["created_at"] if previous else now,
                "updated_at": now,
            }
            if previous and previous.get("closed_at"):
                record["closed_at"] = previous["closed_at"]
            _write(_vacancy_path(record["id"]), record)
            written.append(record["id"])
        for vacancy_id in old_ids - set(written):
            _vacancy_path(vacancy_id).unlink(missing_ok=True)
        project.update({"vacancy_ids": written, "vacancies_draft": None, "approved_at": now, "updated_at": now})
        _write(_project_path(project["id"]), project)
    return _full_view(project)
