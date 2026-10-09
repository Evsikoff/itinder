"""Связка профиля ITinder с профилем участника ФСП — имитация: ни ФСП ID
(Keycloak Федерации), ни реестра результатов у нас нет. Окно «Достижения в ФСП»
(значок 1 на рабочем столе portfolio-inner-site) спрашивает ФСП ID, сервер
проверяет только формат (FSP_ID) и сам «находит» в реестре соревнования, где
пользователь мог участвовать в роли своей специализации.

Соревнования — app/db/fsp_competitions.json (прошедшие: в черновик попадают
только закончившиеся), роли — fsp_team_roles.json, стек — fsp_stack.json.
Сколько соревнований найдено, итог команды в каждом и какие технологии
стека пользователь применял — случайно (participate).

Пользователь согласился дополнить профиль — app/db/user_fsp/<user_id>.json:
ФСП ID, когда связан, соревнования и компетенции со степенью подтверждения.
Отказался — ничего не пишется, и у значка остаётся тревога (alert).

После связки «случаются» будущие соревнования (fsp_future_competitions.json):
каждое — через minutes_after_profile_link минут после linked_at, если в его
команде есть роль пользователя. Итог и технологии берутся из генератора с
зерном записи (seed): при каждом открытии окна они те же. Созревшее, но ещё
не добавленное и не отклонённое соревнование — новое (pending): у значка
снова тревога, окно предлагает добавить его в профиль или отказаться.

Степень подтверждения компетенции — по сумме баллов соревнований, где она
применялась: балл итога (RESULTS) плюс балл уровня соревнования (LEVEL_POINTS),
пороги — DEGREES.

API — app/tools/serve.py: GET /api/fsp (state), POST /api/fsp/link (draft),
POST /api/fsp/save (save), POST /api/fsp/decide (decide).
"""

import json
import random
import re
import secrets
import threading
import time
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from data_paths import mutable_dir

import specializations
from users import UserError

ROOT = Path(__file__).resolve().parent.parent.parent
DB = ROOT / "app" / "db"
COMPETITIONS = DB / "fsp_competitions.json"
FUTURE = DB / "fsp_future_competitions.json"
ROLES = DB / "fsp_team_roles.json"
STACK = DB / "fsp_stack.json"
USER_FSP_DIR = mutable_dir("user_fsp")

# ФСП ID: латинские FSP, дефис, четыре цифры, дефис, четыре цифры. Регистр
# букв и пробелы по краям не важны, записывается заглавными.
FSP_ID = re.compile(r"FSP-\d{4}-\d{4}")
FSP_ID_MASK = "FSP-0000-0000"

FOUND_MIN, FOUND_MAX = 1, 5  # сколько прошедших соревнований «находит» реестр
# Итог команды: (id, название, балл, вес при случайном выборе).
RESULTS = (
    ("solution", "Сдали работающее решение", 1, 55),
    ("prize", "Работающее решение и призовое место", 2, 30),
    ("win", "Работающее решение и победа", 3, 15),
)
LEVEL_POINTS = {"regional": 0, "interregional": 1, "national": 2, "international": 2}
# Степень подтверждения: (номер, название, от скольких баллов) — по убыванию.
DEGREES = ((3, "высокая", 6), (2, "уверенная", 3), (1, "базовая", 1))
KINDS = ("languages", "databases", "integrations", "testing")  # порядок в профиле
KIND_NAMES = {"languages": "Язык", "databases": "СУБД", "integrations": "Интеграция", "testing": "Тестирование"}
# Какие части стека соревнования подтверждает роль. Языки — только те, на
# которых пишет роль (fsp_stack.json, languages[].roles).
ROLE_KINDS = {
    "backend": ("languages", "databases", "integrations"),
    "frontend": ("languages", "integrations"),
    "qa": ("languages", "testing"),
    "analyst": ("languages", "databases", "integrations"),
}
SQL = "sql"

KEEP = 6 * 3600  # секунд черновик ждёт согласия
NOT_LINKED_ALERT = "Профиль ФСП не связан: подтвердите компетенции достижениями"
NEWS_ALERT = "Найдены новые соревнования с вашим участием"

_drafts = {}  # draft_id → черновик (draft)
_lock = threading.Lock()  # черновики и записи user_fsp: сервер многопоточный


def _load(path):
    return json.loads(path.read_text(encoding="utf-8"))


def _catalog():
    """Справочники: соревнования (прошедшие и будущие) по id, роли по id, стек {kind: {id: запись}}."""
    competitions = {c["id"]: c for c in _load(COMPETITIONS) + _load(FUTURE)}
    roles = {r["id"]: r for r in _load(ROLES)}
    stack = {kind: {item["id"]: item for item in items} for kind, items in _load(STACK).items()}
    return competitions, roles, stack


def _now():
    return datetime.now(timezone.utc)


def _path(user_id):
    return USER_FSP_DIR / f"{user_id}.json"


def check_fsp_id(value):
    """ФСП ID в каноническом виде или UserError, если он не по маске."""
    fsp_id = value.strip().upper() if isinstance(value, str) else ""
    if not FSP_ID.fullmatch(fsp_id):
        raise UserError(f"ФСП ID не по маске {FSP_ID_MASK}: латинские FSP, дефис, четыре цифры, дефис, четыре цифры")
    return fsp_id


def user_role(user_id, roles):
    """Роль в команде по последней специализации соискателя: роль, у которой
    та же specialization (fsp_team_roles.json). Нет такой — UserError."""
    own = [r for r in specializations.records(user_id) if r.get("specialization") != specializations.RECRUITER]
    latest = max(own, key=lambda r: r.get("created_at") or "", default=None)
    if latest is None:
        raise UserError("Сначала выберите специализацию соискателя", status=409)
    for role in roles.values():
        if role["specialization"] == latest.get("specialization"):
            return role
    raise UserError(f"Для специализации {latest.get('specialization')} в соревнованиях ФСП нет роли", status=409)


def _has_role(competition, role_id):
    return any(r["role_id"] == role_id for r in competition["team"]["roles"])


def participate(competition, role_id, stack, rng):
    """Участие пользователя: итог команды и технологии, которые он применял.
    Из языков роли — один (и SQL, если он есть в стеке и роль на нём пишет),
    из СУБД — одна, способы интеграции и тестирования — все, что требовал кейс."""
    result_id = rng.choices([r[0] for r in RESULTS], weights=[r[3] for r in RESULTS])[0]
    used = {}
    for kind in ROLE_KINDS[role_id]:
        ids = competition["stack"].get(kind, [])
        if kind == "languages":
            own = [i for i in ids if role_id in stack[kind][i]["roles"]]
            main = [i for i in own if i != SQL]
            chosen = ([rng.choice(main)] if main else []) + ([SQL] if SQL in own else [])
        elif kind == "databases":
            chosen = [rng.choice(ids)] if ids else []
        else:
            chosen = list(ids)
        if chosen:
            used[kind] = chosen
    return {
        "competition_id": competition["id"],
        "role_id": role_id,
        "result": result_id,
        "points": _result(result_id)[2] + LEVEL_POINTS[competition["level"]],
        "competencies": used,
    }


def _result(result_id):
    return next(r for r in RESULTS if r[0] == result_id)


def _degree(points):
    return next((number, name) for number, name, low in DEGREES if points >= low)


def _overlaps(a, b):
    return a["start_date"] <= b["end_date"] and b["start_date"] <= a["end_date"]


def _found(role_id, stack, rng):
    """Участия, которые «нашёл» реестр: от FOUND_MIN до FOUND_MAX закончившихся
    соревнований с ролью пользователя, без пересечения по датам — на двух
    сразу не бывают. По возрастанию даты."""
    today = date.today().isoformat()
    held = [c for c in _load(COMPETITIONS) if c["end_date"] < today and _has_role(c, role_id)]
    rng.shuffle(held)
    count = rng.randint(FOUND_MIN, max(FOUND_MIN, min(FOUND_MAX, len(held))))
    chosen = []
    for competition in held:
        if len(chosen) == count:
            break
        if not any(_overlaps(competition, other) for other in chosen):
            chosen.append(competition)
    chosen.sort(key=lambda c: c["start_date"])
    return [participate(c, role_id, stack, rng) for c in chosen]


def competencies(participations):
    """Компетенции по участиям: [{"kind", "id", "points", "degree", "competitions"}]
    в порядке KINDS, внутри — по убыванию баллов."""
    found = {}
    for item in participations:
        for kind, ids in item["competencies"].items():
            for competency_id in ids:
                entry = found.setdefault((kind, competency_id), {"kind": kind, "id": competency_id, "points": 0, "competitions": []})
                entry["points"] += item["points"]
                entry["competitions"].append(item["competition_id"])
    for entry in found.values():
        entry["degree"] = _degree(entry["points"])[0]
    return sorted(found.values(), key=lambda e: (KINDS.index(e["kind"]), -e["points"], e["id"]))


def _future_participation(record, competition, stack):
    """Участие в будущем соревновании: то же при каждом вызове (зерно записи)."""
    rng = random.Random(f"{record['seed']}:{competition['id']}")
    return participate(competition, record["role_id"], stack, rng)


def _schedule(record, now):
    """Будущие соревнования записи: (созревшие и не решённые — новые, через сколько
    секунд созреет следующее или None)."""
    linked_at = datetime.fromisoformat(record["linked_at"])
    decided = {c["competition_id"] for c in record["competitions"]} | {d["competition_id"] for d in record["declined"]}
    pending, waits = [], []
    for competition in _load(FUTURE):
        if competition["id"] in decided or not _has_role(competition, record["role_id"]):
            continue
        due = linked_at + timedelta(minutes=competition["minutes_after_profile_link"])
        if due <= now:
            pending.append(competition)
        else:
            waits.append((due - now).total_seconds())
    return pending, (min(waits) if waits else None)


# --- Что отдаётся окну ----------------------------------------------------------

def _competency_view(entry, stack):
    number, name = _degree(entry["points"])
    return {
        "kind": entry["kind"],
        "kind_name": KIND_NAMES[entry["kind"]],
        "id": entry["id"],
        "name": stack[entry["kind"]][entry["id"]]["name"],
        "points": entry["points"],
        "degree": number,
        "degree_name": name,
        "competitions": entry["competitions"],
    }


def _participation_view(item, catalog):
    competitions, roles, stack = catalog
    competition = competitions[item["competition_id"]]
    team_role = next(r for r in competition["team"]["roles"] if r["role_id"] == item["role_id"])
    _, result_name, result_points, _ = _result(item["result"])
    fields = ("id", "name", "format", "level", "venue", "city", "start_date", "end_date", "teams", "case_partner", "task")
    return {
        **{field: competition[field] for field in fields},
        "role": {"id": item["role_id"], "name": roles[item["role_id"]]["name"], "task": team_role["task"]},
        "result": {"id": item["result"], "name": result_name, "points": result_points},
        "level_points": LEVEL_POINTS[competition["level"]],
        "points": item["points"],
        "competencies": [
            {"kind": kind, "kind_name": KIND_NAMES[kind], "id": i, "name": stack[kind][i]["name"]}
            for kind in KINDS
            for i in item["competencies"].get(kind, [])
        ],
        "added_at": item.get("added_at"),
    }


def _changes(before, after, stack):
    """Как изменятся компетенции: [{"kind", "kind_name", "id", "name", "before", "after"}],
    before — {"points", "degree", "degree_name"} или None (новая); только затронутые."""
    old = {(e["kind"], e["id"]): e for e in competencies(before)}
    result = []
    for entry in competencies(after):
        previous = old.get((entry["kind"], entry["id"]))
        if previous and previous["points"] == entry["points"]:
            continue
        view = _competency_view(entry, stack)
        result.append({
            "kind": view["kind"],
            "kind_name": view["kind_name"],
            "id": view["id"],
            "name": view["name"],
            "before": None if previous is None else {
                "points": previous["points"], "degree": previous["degree"], "degree_name": _degree(previous["points"])[1],
            },
            "after": {"points": view["points"], "degree": view["degree"], "degree_name": view["degree_name"]},
        })
    return result


def _role_view(role):
    return {"id": role["id"], "name": role["name"], "specialization": role["specialization"]}


# --- Записи user_fsp ---------------------------------------------------------------

def find(user_id):
    """Запись пользователя или None: профиль не связан."""
    path = _path(user_id)
    return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else None


def _write(record, create=False):
    """Записывает целиком: create — только новый файл, иначе замена через временный."""
    USER_FSP_DIR.mkdir(parents=True, exist_ok=True)
    path = _path(record["user_id"])
    if create:
        try:
            # "x": профиль уже связан (например, из другой вкладки) — не перезапишется.
            with open(path, "x", encoding="utf-8", newline="\n") as file:
                json.dump(record, file, ensure_ascii=False, indent=2)
                file.write("\n")
        except FileExistsError:
            raise UserError("Профиль уже связан с ФСП", status=409) from None
        return
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    temporary.replace(path)


def _with_competencies(record):
    record["competencies"] = competencies(record["competitions"])
    record["updated_at"] = _now().isoformat()
    return record


# --- API ------------------------------------------------------------------------

def state(user_id):
    """Что показать в окне: {"linked", "fsp_id", "linked_at", "role", "competitions",
    "competencies", "declined", "pending", "recheck_after", "mask"}.
    pending — {"competitions", "changes"} новых соревнований или None;
    recheck_after — через сколько секунд созреет следующее будущее соревнование."""
    user_id = specializations.check_user(user_id)
    catalog = _catalog()
    competitions, roles, stack = catalog
    record = find(user_id)
    if record is None:
        try:
            role = _role_view(user_role(user_id, roles))
        except UserError:
            role = None
        return {
            "linked": False, "fsp_id": None, "linked_at": None, "role": role, "competitions": [],
            "competencies": [], "declined": [], "pending": None, "recheck_after": None, "mask": FSP_ID_MASK,
        }
    pending, recheck_after = _schedule(record, _now())
    news = [_future_participation(record, c, stack) for c in pending]
    return {
        "linked": True,
        "fsp_id": record["fsp_id"],
        "linked_at": record["linked_at"],
        "role": _role_view(roles[record["role_id"]]),
        "competitions": [_participation_view(item, catalog) for item in record["competitions"]],
        "competencies": [_competency_view(entry, stack) for entry in competencies(record["competitions"])],
        "declined": [
            {"id": d["competition_id"], "name": competitions[d["competition_id"]]["name"]} for d in record["declined"]
        ],
        "pending": {
            "competitions": [_participation_view(item, catalog) for item in news],
            "changes": _changes(record["competitions"], record["competitions"] + news, stack),
        } if news else None,
        "recheck_after": recheck_after,
        "mask": FSP_ID_MASK,
    }


def draft(user_id, fsp_id):
    """ФСП ID по маске — черновик связки: что «нашёл» реестр. {"draft_id", "fsp_id",
    "role", "competitions", "changes"}; changes — все компетенции новые."""
    user_id = specializations.check_user(user_id)
    fsp_id = check_fsp_id(fsp_id)
    if find(user_id) is not None:
        raise UserError("Профиль уже связан с ФСП", status=409)
    catalog = _catalog()
    _, roles, stack = catalog
    role = user_role(user_id, roles)
    found = _found(role["id"], stack, random.Random())
    draft_id = str(uuid.uuid4())
    with _lock:
        expired = [key for key, value in _drafts.items() if time.time() - value["created"] > KEEP]
        for key in expired:
            del _drafts[key]
        _drafts[draft_id] = {
            "user_id": user_id, "fsp_id": fsp_id, "role": role, "participations": found, "created": time.time(),
        }
    return {
        "draft_id": draft_id,
        "fsp_id": fsp_id,
        "role": _role_view(role),
        "competitions": [_participation_view(item, catalog) for item in found],
        "changes": _changes([], found, stack),
    }


def save(user_id, draft_id):
    """Пользователь согласился дополнить профиль: черновик становится записью
    user_fsp, с этого момента (linked_at) идут минуты будущих соревнований."""
    user_id = specializations.check_user(user_id)
    with _lock:
        found = _drafts.get(draft_id) if isinstance(draft_id, str) else None
        if found is None or found["user_id"] != user_id:
            raise UserError("Черновик связки устарел — введите ФСП ID заново", status=410)
        now = _now().isoformat()
        record = _with_competencies({
            "user_id": user_id,
            "fsp_id": found["fsp_id"],
            "role_id": found["role"]["id"],
            "specialization": found["role"]["specialization"],
            "linked_at": now,
            "seed": secrets.randbits(32),
            "competitions": [{**item, "source": "registry", "added_at": now} for item in found["participations"]],
            "declined": [],
        })
        _write(record, create=True)
        del _drafts[draft_id]
    return state(user_id)


def decide(user_id, competition_ids, add):
    """Новые соревнования после связки: add — в профиль, иначе — отклонены.
    competition_ids — те, что пользователь видел; все должны быть новыми."""
    user_id = specializations.check_user(user_id)
    if not isinstance(add, bool):
        raise UserError("Не сказано, добавлять ли соревнования")
    if not isinstance(competition_ids, list) or not competition_ids or not all(isinstance(i, str) for i in competition_ids):
        raise UserError("Нет списка соревнований")
    _, _, stack = _catalog()
    with _lock:
        record = find(user_id)
        if record is None:
            raise UserError("Профиль ещё не связан с ФСП", status=409)
        pending, _ = _schedule(record, _now())
        pending = {c["id"]: c for c in pending}
        if any(i not in pending for i in competition_ids):
            raise UserError("Список новых соревнований изменился — откройте его заново", status=409)
        now = _now().isoformat()
        for competition_id in dict.fromkeys(competition_ids):
            if add:
                item = _future_participation(record, pending[competition_id], stack)
                record["competitions"].append({**item, "source": "after_link", "added_at": now})
            else:
                record["declined"].append({"competition_id": competition_id, "declined_at": now})
        _write(_with_competencies(record))
    return state(user_id)


def alert(user_id):
    """Тревога у значка «Достижения в ФСП»: (текст или None, через сколько секунд
    она может появиться сама — созреет будущее соревнование — или None)."""
    record = find(user_id)
    if record is None:
        return NOT_LINKED_ALERT, None
    pending, recheck_after = _schedule(record, _now())
    return (NEWS_ALERT if pending else None), recheck_after
