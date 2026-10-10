"""Видимость соискателя для рекрутёров: тумблер в окне «PDF-профиль» (значок 6
на рабочем столе portfolio-inner-site, режим Applicant).

Спрятаться — файл app/db/user_blocks/<user_id>.json {"user_id", "created_at"},
того же вида, что пишет генератор соискателей (seed_applicants.py); показаться
снова — файл удаляется. Файл читают по имени: ranking.applicants не отдаёт
спрятавшегося окну «Соискатели» (значок 9) — ни графу команды, ни поиску по
вакансии, ни поиску по специализации и грейду, — подсказки анкеты проекта
(projects.market) его не считают, пригласить его нельзя (invitations.create).
Его профиль открывается только рекрутёрам, с которыми уже есть приглашение или
отклик (candidate_profile.profile). Сам соискатель видит вакансии и
откликается как раньше (vacancy_ranking.py).

API — app/tools/serve.py: GET /api/applicant/visibility?user_id=<id> и
POST /api/applicant/visibility {"user_id", "hidden"}; оба отвечают
{"hidden", "hidden_at"}.
"""

import json
import threading

import invitations
import ranking
import specializations
from users import UserError

_lock = threading.Lock()  # проверка файла и его запись или удаление — одним шагом


def _path(user_id):
    return ranking.USER_BLOCKS_DIR / f"{user_id}.json"


def _view(user_id):
    """{"hidden", "hidden_at"}: битый файл всё равно прячет — ranking смотрит только на имя."""
    path = _path(user_id)
    if not path.is_file():
        return {"hidden": False, "hidden_at": None}
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        record = None
    hidden_at = record.get("created_at") if isinstance(record, dict) else None
    return {"hidden": True, "hidden_at": hidden_at if isinstance(hidden_at, str) else None}


def state(user_id):
    """Скрыт ли профиль пользователя от рекрутёров. Ничего не пишет."""
    return _view(specializations.check_user(user_id))


def update(user_id, hidden):
    """hidden=True прячет профиль от рекрутёров, False показывает снова. Повтор
    того же значения ничего не меняет: скрытый раньше сохраняет свой created_at."""
    uid = specializations.check_user(user_id)
    if type(hidden) is not bool:
        raise UserError("Не указано, скрыть профиль от рекрутёров или показать")
    with _lock:
        path = _path(uid)
        if hidden and not path.exists():
            path.parent.mkdir(parents=True, exist_ok=True)
            invitations._write(path, {"user_id": uid, "created_at": invitations._now()})
        elif not hidden:
            path.unlink(missing_ok=True)
        return _view(uid)
