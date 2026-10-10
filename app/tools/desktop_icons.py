"""Дополнительные значки рабочего стола portfolio-inner-site — «операционной
системы» на мониторе в комнате resume3. Список — app/db/additional_desktop_icons.json
(копия таблицы Supabase itinder_additional_desktop_icons), запись —
{"id", "created_at", "mode", "name", "image"}; mode — кому значок:
Recruiter — рекрутеру, Applicant — соискателю.

Кто пользователь, видно по его записям в app/db/user_specializations: хотя бы
одна со специализацией Recruiter — рекрутер, хотя бы одна с другой — соискатель.
Бывает и то и другое: тогда на столе значки обоих режимов.
У значка может быть тревога — красный восклицательный знак рядом с ним:
у «Задач на грейд» (GRADE_TASKS), пока пользователь не прошёл ни одного теста
(app/tools/grade_tests.py, has_confirmed_grade); у «Достижений в ФСП»
(FSP_ACHIEVEMENTS), пока профиль не связан с ФСП или когда после связки
нашлись новые соревнования (app/tools/fsp.py, alert). Новые соревнования
появляются сами, по времени. У «Приглашений» соискателя (CANDIDATE_INVITATIONS)
тревога — новое приглашение или ещё не просмотренный статус приглашения/отклика;
вход в окно гасит её до следующего нового приглашения или смены статуса
(app/tools/applicant_invitations.py, dismiss_alert).
recheck_after в ответе — через сколько секунд спросить значки снова.
GET /api/desktop_icons?user_id=<id> (app/tools/serve.py) вызывает for_user.
"""

import json
from pathlib import Path

import fsp
import applicant_invitations
import grade_tests
import specializations

ROOT = Path(__file__).resolve().parent.parent.parent
ICONS = ROOT / "app" / "db" / "additional_desktop_icons.json"
APPLICANT = "Applicant"
RECRUITER = "Recruiter"
MODES = (APPLICANT, RECRUITER)  # в этом порядке значки идут на рабочем столе
GRADE_TASKS = 2  # id значка «Задачи на грейд»
FSP_ACHIEVEMENTS = 1  # id значка «Достижения в ФСП»
CANDIDATE_INVITATIONS = 4  # id значка «Приглашения» соискателя
INVITATIONS_RECHECK = 15  # уведомления приходят и при закрытом окне
GRADE_ALERT = "Грейд ещё не подтверждён: пройдите тест"


def modes(user_id):
    """Режимы пользователя из MODES, в их порядке; специализации нет — пусто."""
    found = {
        RECRUITER if record.get("specialization") == specializations.RECRUITER else APPLICANT
        for record in specializations.records(user_id)
    }
    return [mode for mode in MODES if mode in found]


def image_url(path):
    """Адрес картинки на сервере. В таблице путь от корня проекта в стиле
    Windows, как в схеме экранов: \\app\\assets\\fsp.png → /app/assets/fsp.png."""
    clean = str(path or "").strip().replace("\\", "/").lstrip("/")
    return f"/{clean}" if clean else None


def for_user(user_id):
    """{"modes": режимы пользователя, "icons": его значки, "recheck_after"} —
    сначала значки соискателя, потом рекрутера, внутри режима по порядку из
    таблицы. Значок — {"id", "mode", "name", "image": адрес картинки или None,
    "alert": о чём тревога (подсказка у восклицательного знака) или None}.
    recheck_after — через сколько секунд тревога может появиться сама, или None."""
    user_id = specializations.check_user(user_id)
    user_modes = modes(user_id)
    rows = json.loads(ICONS.read_text(encoding="utf-8"))
    alerts = {GRADE_TASKS: None if grade_tests.has_confirmed_grade(user_id) else GRADE_ALERT}
    recheck_after = None
    if APPLICANT in user_modes:  # значок ФСП — у соискателя
        alerts[FSP_ACHIEVEMENTS], recheck_after = fsp.alert(user_id)
        alerts[CANDIDATE_INVITATIONS] = applicant_invitations.alert(user_id)
        recheck_after = (min(recheck_after, INVITATIONS_RECHECK)
                         if recheck_after is not None else INVITATIONS_RECHECK)
    icons = [
        {
            "id": row["id"],
            "mode": mode,
            "name": row["name"],
            "image": image_url(row.get("image")),
            "alert": alerts.get(row["id"]),
        }
        for mode in user_modes
        for row in rows
        if row.get("mode") == mode
    ]
    return {"modes": user_modes, "icons": icons, "recheck_after": recheck_after}
