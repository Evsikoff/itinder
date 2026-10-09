"""Профиль кандидата для рекрутёра: только чтение существующих свидетельств.

Грейды — все специализации и тесты; ФСП — только уже сохранённые достижения.
Задания из приглашений видны только рекрутёру, которому они принадлежат.
Контакт открывается после принятого приглашения/отклика этого рекрутёра.
"""

import fsp
import applicant_invitations
import grade_tests
import invitations
import project_feedback
import project_news
import projects
import ranking
import specializations
import users
from users import UserError


def _fsp_profile(uid):
    empty = {"linked": False, "linked_at": None, "competencies": [], "competitions": []}
    path = ranking.USER_FSP_DIR / f"{uid}.json"
    try:
        record = projects._load(path)
    except (OSError, ValueError):
        return empty
    if not isinstance(record, dict) or record.get("user_id") != uid:
        return empty
    catalog, roles, stack = fsp._catalog()
    competitions = []
    for item in record.get("competitions") or []:
        if not isinstance(item, dict):
            continue
        source = catalog.get(item.get("competition_id"))
        role = roles.get(item.get("role_id"))
        result = next((r for r in fsp.RESULTS if r[0] == item.get("result")), None)
        if not source or not role or not result:
            continue
        competitions.append({
            "id": source["id"], "name": source["name"], "start_date": source["start_date"],
            "end_date": source["end_date"], "level": source["level"], "role": role["name"],
            "result": result[1], "points": item.get("points", 0), "task": source["task"],
            "competencies": [stack[kind][cid]["name"] for kind in fsp.KINDS
                             for cid in (item.get("competencies") or {}).get(kind, []) if cid in stack[kind]],
        })
    accepted = {item["id"] for item in competitions}
    competencies = []
    for item in record.get("competencies") or []:
        if not isinstance(item, dict):
            continue
        kind, cid = item.get("kind"), item.get("id")
        degree = next((d for d in fsp.DEGREES if d[0] == item.get("degree")), None)
        if not degree or cid not in stack.get(kind, {}):
            continue
        competencies.append({"id": cid, "kind": kind, "name": stack[kind][cid]["name"],
                             "degree": degree[0], "degree_name": degree[1], "points": item.get("points", 0),
                             "competitions": [cid for cid in item.get("competitions", []) if cid in accepted]})
    competencies.sort(key=lambda c: (fsp.KINDS.index(c["kind"]), -c["degree"], -c["points"], c["name"]))
    competitions.sort(key=lambda c: (c["end_date"], c["id"]), reverse=True)
    return {"linked": True, "linked_at": record.get("linked_at"),
            "competencies": competencies, "competitions": competitions}


def _test_view(record, tasks):
    key = record.get("task_key")
    if key not in tasks:
        try:
            task = grade_tests.from_key(key)
            tasks[key] = {"resource": task["resource"].get("name") or task["resource"].get("title"),
                          "symptoms": [problem["symptom"] for problem in task["problems"]]}
        except (ValueError, KeyError, TypeError):
            tasks[key] = {"resource": None, "symptoms": []}
    return {"id": record["id"], "specialization": record["specialization"], "grade": record["grade"],
            "passed": record["passed"], "created_at": record.get("created_at"),
            "language": record.get("language"), "credited": bool(record.get("credited_from")),
            "procedural_check": bool(record.get("procedural_check")), "llm_check": bool(record.get("llm")),
            **tasks[key]}


def profile(user_id, applicant_id):
    user_id = projects.check_recruiter(user_id)
    uid = projects._uuid(applicant_id, "кандидат")
    if not (users.USERS_DIR / f"{uid}.json").is_file():
        raise UserError("Профиль кандидата не найден", status=404)
    with projects._lock, invitations._lock:
        owned = [p for p in projects._read_dir(projects.PROJECTS_DIR) if p.get("user_id") == user_id]
        related = [r for r in project_news._records(user_id, owned) if r.get("applicant_id") == uid]
        specs = [r for r in ranking._read_dir(specializations.SPECIALIZATIONS_DIR)
                 if isinstance(r, dict) and r.get("user_id") == uid
                 and isinstance(r.get("specialization"), str) and r["specialization"] != specializations.RECRUITER]
        if not related and (not specs or (ranking.USER_BLOCKS_DIR / f"{uid}.json").is_file()):
            raise UserError("Профиль кандидата недоступен", status=404)
        email = project_feedback._email(uid) if any(invitations.status(r) == "accepted" for r in related) else None
    return _assemble(uid, specs, related, email)


def self_profile(user_id):
    """Свой профиль: не принимает идентификатор другого кандидата, ничего не пишет."""
    uid = specializations.check_user(user_id)
    specs = [r for r in ranking._read_dir(specializations.SPECIALIZATIONS_DIR)
             if isinstance(r, dict) and r.get("user_id") == uid
             and isinstance(r.get("specialization"), str) and r["specialization"] != specializations.RECRUITER]
    with invitations._lock:
        related = [r for r in invitations.records() if isinstance(r, dict) and r.get("applicant_id") == uid
                   and applicant_invitations._valid({**r, "type": project_news._type(r)})]
    return _assemble(uid, specs, related, project_feedback._email(uid))


def _assemble(uid, specs, related, email):
    assignments = [{"id": r["id"], "title": r["vacancy"].get("title") or "Вакансия",
                        "project": (r["vacancy"].get("project") or {}).get("name") or "Проект",
                        "status": invitations.status(r),
                        "status_name": invitations.FLOWS["assignment"][invitations.status(r)],
                        "created_at": r.get("created_at"), "updated_at": r["status_history"][-1]["at"],
                        "tasks": r["vacancy"]["assignments"], "answers": r.get("assignment_answers") or []}
                   for r in related if r["vacancy"].get("assignments")]
    tests = [r for r in ranking._read_dir(grade_tests.TESTS_DIR) if isinstance(r, dict) and r.get("user_id") == uid
             and isinstance(r.get("id"), str) and r.get("specialization") in grade_tests.SPECIALIZATIONS
             and r.get("grade") in grade_tests.GRADES and type(r.get("passed")) is bool
             and (r.get("task_key") is None or isinstance(r.get("task_key"), str))]
    tests.sort(key=lambda r: (r.get("created_at") or "", r["id"]), reverse=True)
    result = []
    for spec in sorted({r["specialization"] for r in specs + tests}):
        selected = max((r for r in specs if r["specialization"] == spec), key=ranking._preference, default=None)
        own_tests = [r for r in tests if r["specialization"] == spec]
        declared = selected.get("grade") if selected and selected.get("grade") in grade_tests.GRADES else None
        source = (selected.get("source") or {}).get("type") if selected else None
        grade = ranking.grade_fit({"declared": declared, "source": source,
                                  "passed": {r["grade"] for r in own_tests if r["passed"]},
                                  "failed": {r["grade"] for r in own_tests if not r["passed"]}})
        result.append({"name": spec, "declared": declared, "source": source,
                       "confirmed": grade["confirmed"], "refuted": grade["refuted"],
                       "tests": len(own_tests), "passed": sum(r["passed"] for r in own_tests)})
    assignments.sort(key=lambda r: (r["updated_at"], r["id"]), reverse=True)
    tasks = {}
    return {"id": uid, "name": ranking._name(uid), "email": email, "specializations": result,
            "fsp": _fsp_profile(uid), "tests": [_test_view(r, tasks) for r in tests], "assignments": assignments}
