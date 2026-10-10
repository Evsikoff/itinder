"""Локальный сервер для интерфейса ITinder.

Отдаёт папку app/ из корня проекта, поэтому пути вида \\app\\assets\\... из
app/db/ui_scheme.json открываются как есть, и сборки внутренних приложений
(MOUNTS): /resume3/ — комната resume3, в неё ведёт поезд, и /os/ —
portfolio-inner-site, «операционная система» на мониторе в этой комнате
(resume3 открывает её в iframe). Остальное
(.env.local, брендбук, tmp, исходники приложений) наружу не отдаётся, записи
пользователей app/db/users, app/db/user_specializations, app/db/user_names,
app/db/user_tests и app/db/user_fsp, компании, проекты и вакансии рекрутёров
(app/db/companies, app/db/user_project_company, app/db/projects_jobopenings), приглашения соискателям
(app/db/invitations), справочники теста app/db/api_problems.json,
app/db/ux_problems.json и app/db/qa_problems.json (в них ответы)
и код app/tools — тоже. Файлы отдаются и по частям
(Range): без этого Safari не проигрывает видео.

API (только с этой же страницы). Ошибка — код 4xx/5xx и {"error"}: что сказать
пользователю; подробности для консоли браузера — в "failures" (что случилось
с каждой нейросетью) или "detail" (исключение на сервере, код 500).
    POST /api/users {"email", "password"} создаёт запись пользователя
        (app/tools/users.py) и отвечает {"id", "email"}.
    POST /api/login {"email", "password"} — вход (app/tools/users.py): отвечает
        {"id", "email", "has_specialization"} — есть ли у пользователя запись
        в app/db/user_specializations; почта или пароль не подходят — 401.
    POST /api/resume, тело — файл PDF (Content-Type: application/pdf, до 5 МБ),
        распознаёт резюме (app/tools/resume.py) и отвечает
        {"id", "result", "specialization", "grade", "reason", "source", "failures"};
        нейросети не ответили — 502 и {"error", "failures"}.
    POST /api/user_specializations записывает пользователю специализацию и грейд
        (app/tools/specializations.py) и отвечает записью: {"user_id",
        "recognition_id"} — из распознавания резюме, {"user_id", "element_id"} —
        его собственный выбор, нажатый элемент схемы экранов.
    GET /api/user_names?user_id=<id> — введено ли имя (app/tools/user_names.py):
        {"record": запись или null}. Без имени portfolio-inner-site не пускает
        на рабочий стол.
    POST /api/user_names {"user_id", "first_name", "last_name"} записывает имя
        и фамилию и отвечает записью; имя уже есть — 409.
    GET /api/desktop_icons?user_id=<id> — дополнительные значки рабочего стола
        portfolio-inner-site (app/tools/desktop_icons.py): {"modes", "icons"} —
        режимы пользователя (Applicant, Recruiter) по его специализациям и
        значки этих режимов из app/db/additional_desktop_icons.json; "alert"
        значка — о чём красный восклицательный знак рядом с ним, или null.
    GET /api/grade_profile?user_id=<id> — что известно о пользователе для теста
        «Задачи на грейд» (app/tools/grade_tests.py, profile): заявленные
        специализация и грейд, итоги его тестов, вычисленный грейд и какой
        тест предложить, из каких специализаций и грейдов выбирать.
    POST /api/grade_tasks {"user_id", "specialization", "grade"} — новое
        задание теста на любые специализацию и грейд из профиля: ресурс,
        симптомы, как отвечать, список решений и языков, у QA — документы.
    POST /api/user_tests {"user_id", "task_id", "solutions" | "text",
        "language"?, "code"?} проверяет ответ, записывает итог
        в app/db/user_tests и отвечает {"id", "passed", "next_grade",
        "problems", …}; нейросеть не ответила — 502, ответ можно отправить снова.
    POST /api/user_tests/credit {"user_id", "test_id"} — только в тестовой
        версии (grade_tests.TEST_VERSION): засчитывает непройденный тест,
        будто кандидат его сдал, — новая запись в app/db/user_tests с
        "credited_from"; отвечает {"id", "passed", "next_grade", …}.
    GET /api/fsp?user_id=<id> — связка с ФСП для окна «Достижения в ФСП»
        (app/tools/fsp.py, state): связан ли профиль, ФСП ID, соревнования
        и компетенции в профиле, новые соревнования после связки (pending)
        и через сколько секунд созреет следующее (recheck_after).
    POST /api/fsp/link {"user_id", "fsp_id"} — ФСП ID по маске: черновик,
        что «нашёл» реестр — {"draft_id", "fsp_id", "role", "competitions",
        "changes"}; ФСП ID не по маске — 400, профиль уже связан — 409.
    POST /api/fsp/save {"user_id", "draft_id"} — пользователь дополняет
        профиль: запись в app/db/user_fsp, отвечает как GET /api/fsp;
        черновик устарел (перезапуск сервера, 6 часов) — 410.
    POST /api/fsp/decide {"user_id", "competition_ids", "add"} — новые
        соревнования после связки: добавить в профиль или отклонить;
        отвечает как GET /api/fsp; список устарел — 409.
    Окно «Проекты и вакансии» рекрутёра (app/tools/projects.py); не рекрутёру — 403,
    чужой или удалённый проект — 404:
    GET /api/projects/catalog?user_id=<id> — для анкеты проекта: {"questionnaire",
        "stack", "roles", "companies", "market"}; market — соискатели без имён:
        роль, грейд, компетенции из ФСП.
    GET /api/projects?user_id=<id> — {"projects"}: проекты рекрутёра, новые первыми.
        valid_vacancies в строке — число существующих связанных вакансий,
        ещё не заполненных наймом (accepted < count).
    GET /api/project?user_id=<id>&project_id=<id> — проект с ответами анкеты
        и вакансиями (утверждёнными или черновиками).
        В списке и проекте news — счётчики новостей; в проекте accepted_news —
        версии непросмотренных принятий приглашений без задания.
    POST /api/projects/news/read {"user_id", "project_id", "accepted_news"} —
        отметка просмотра этих версий при открытии проекта рекрутёром.
    POST /api/projects/test-feedback {"user_id"} — отклики, принятия приглашений
        и решения заданий от уже созданных seed_applicants на вакансии, не
        заполненные наймом; отвечает счётчиками и invitation_ids.
    GET /api/projects/feedback?user_id=<id>&project_id=<id> — дерево вакансий
        и приглашений с релевантностью, решениями и почтой принятых кандидатов.
    POST /api/projects/feedback/review {"user_id", "project_id", "invitation_id",
        "action", "email"?, "expected_revision"} — send: имитация отправки
        эксперту, approve: accepted, reject: solution_rejected. Версия устарела — 409.
    POST /api/projects/feedback/close {"user_id", "project_id", "vacancy_id"} —
        закрытие наймом после accepted >= count; сохраняет файл и приглашения.
    POST /api/projects/feedback/respond {"user_id", "project_id", "invitation_id",
        "action", "expected_revision"} — accept/decline: ответ рекрутёра на
        новый отклик, accepted/declined. История и решения сохраняются.
    POST /api/projects {"user_id", "name", "company": {"id"} | {"name"}, "answers",
        "summary", "vacancies"} — анкета заполнена: файл проекта
        в app/db/user_project_company (новая компания — в app/db/companies).
    POST /api/projects/vacancies {"user_id", "project_id", "vacancies",
        "open_questions"} — утверждённые вакансии с зарплатными вилками: файлы
        в app/db/projects_jobopenings; набор завершён — 409.
    POST /api/projects/copy {"user_id", "project_id", "name"} — копия проекта.
    POST /api/projects/complete {"user_id", "project_id", "completed"} — набор
        завершён или возобновлён; вакансии не утверждены — 409.
    POST /api/projects/delete {"user_id", "project_id"} — удаляет проект и его вакансии.
    Окно «Соискатели» рекрутёра (app/tools/applicant_search.py, ранжирование —
    app/tools/ranking.py); не рекрутёру — 403:
    GET /api/applicants/profile?user_id=<id>&applicant_id=<id> — профиль кандидата:
        все специализации/грейды, сохранённый ФСП, история тестов и заданий
        своих вакансий. Контакт — после собственного принятого приглашения/отклика.
    GET /api/applicants/profile/pdf?user_id=<id>&applicant_id=<id> — PDF этого профиля,
        attachment; та же вёрстка и те же права, что у окна «PDF-профиль»
        (app/tools/profile_pdf.py): только сданные тесты, без заданий вакансий.
    GET /api/applicants/overview?user_id=<id> — проекты, в которых можно искать
        (вакансии утверждены, набор не завершён), их вакансии и справочники.
    GET /api/applicants/team?user_id=<id>&project_id=<id> — граф команды: к каждой
        открытой вакансии проекта два самых релевантных соискателя.
    GET /api/applicants/vacancy?user_id=<id>&vacancy_id=<id> — все соискатели
        специализации вакансии по релевантности, с приглашениями на неё.
    GET /api/applicants/search?user_id=<id>&specialization=<…>&grade=<…> — все
        соискатели по специализации и грейду (пусто — любые).
    POST /api/applicants/test-projects {"user_id"} — тестовые проекты с
        утверждёнными открытыми вакансиями для окон «Проекты и вакансии» и
        «Соискатели»; каждый запрос добавляет два проекта и восемь вакансий.
    POST /api/invitations {"user_id", "vacancy_id", "applicant_id", "source"} —
        приглашение со снимком вакансии в app/db/invitations (app/tools/invitations.py);
        повторное на ту же вакансию — 409.
    GET /api/applicant/profile?user_id=<id> — собственный профиль: тот же формат,
        свой контакт и задания из всех собственных приглашений/откликов.
    GET /api/applicant/profile/pdf?user_id=<id> — PDF этого профиля, attachment;
        ReportLab и Consolas (Windows) или DejaVu Sans Mono (Linux). В PDF идут
        только сданные тесты на грейд; задания вакансий в него не попадают.
    GET /api/applicant/visibility?user_id=<id> — скрыт ли профиль от рекрутёров:
        {"hidden", "hidden_at"} (app/tools/profile_visibility.py).
    POST /api/applicant/visibility {"user_id", "hidden"} — тумблер окна «PDF-профиль»:
        true кладёт app/db/user_blocks/<id>.json, и окно «Соискатели» перестаёт
        показывать соискателя, false удаляет файл; отвечает как GET.
    GET /api/applicant/invitations?user_id=<id> — приглашения и отклики соискателя,
        наборы статусов и справочники (app/tools/applicant_invitations.py).
    POST /api/applicant/invitations/read {"user_id", "invitation_id", "expected_revision"}
        — просмотр выбранного приглашения и подтверждение уведомления.
    POST /api/applicant/invitations/dismiss-alert {"user_id", "shown": [{"id", "revision"}]}
        — вход в окно: гасит восклицательный знак значка 4 для показанных версий.
    POST /api/applicant/invitations/respond {"user_id", "invitation_id", "action",
        "answers"?, "expected_revision"} — accept или decline входящего приглашения;
        с заданиями accept отправляет заполненные answers на проверку.
    POST /api/applicant/invitations/test-data {"user_id"} — 20 тестовых приглашений
        и откликов с полными историями, без изменения существующих записей.
    Окно «Вакансии» соискателя (app/tools/vacancy_search.py, ранжирование —
    app/tools/vacancy_ranking.py); нет специализации соискателя — 403:
    GET /api/vacancies?user_id=<id> — открытые вакансии его специализаций по
        релевантности для него, с его откликом или приглашением на каждую.
    POST /api/vacancies/apply {"user_id", "vacancy_id", "answers"?} — отклик
        со снимком вакансии в app/db/invitations; у вакансии есть задания —
        answers обязательны (решение каждого); повторный — 409.

Запуск из корня проекта:
    python app/tools/serve.py          # http://127.0.0.1:8770/
    python app/tools/serve.py 9000     # другой порт
"""

import json
import logging
import os
import posixpath
import re
import sys
import traceback
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

import applicant_search
import applicant_invitations
import desktop_icons
import fsp
import grade_tests
import invitations
import projects
import project_news
import project_feedback
import candidate_profile
import profile_visibility
import test_feedback
import resume
import specializations
import test_projects
import test_invitations
import qa_tasks
import user_names
import ux_tasks
import vacancy_search
from llm import LLMError
from users import USERS_DIR, UserError, authenticate, create_user
from data_paths import DATA_DB, MUTABLE_NAMES, STATIC_DB, initialize_data

log = logging.getLogger("serve")

ROOT = Path(__file__).resolve().parent.parent.parent
# Папки и файлы, которые сервер не отдаёт.
PRIVATE_PATHS = (USERS_DIR, specializations.SPECIALIZATIONS_DIR, user_names.USER_NAMES_DIR, grade_tests.TESTS_DIR,
                 fsp.USER_FSP_DIR, projects.COMPANIES_DIR, projects.PROJECTS_DIR, projects.VACANCIES_DIR,
                 invitations.INVITATIONS_DIR,
                 grade_tests.PROBLEMS, ux_tasks.UX_PROBLEMS, qa_tasks.QA_PROBLEMS, ROOT / "app" / "tools",
                 *(folder / name for folder in (STATIC_DB, DATA_DB) for name in MUTABLE_NAMES))
ALLOWED_PREFIX = "/app/"
START_PAGE = "/app/web/"
# Внутренние приложения: адрес → папка со сборкой.
MOUNTS = {
    "/resume3/": ROOT / "resume3" / "public",
    "/os/": ROOT / "portfolio-inner-site" / "build",  # собрана с "homepage": "/os/"
}
REDIRECTS = {
    "/": START_PAGE, "/app": START_PAGE, "/app/": START_PAGE, "/app/web": START_PAGE,
    **{prefix.rstrip("/"): prefix for prefix in MOUNTS},
}
DEFAULT_PORT = 8770
MAX_JSON = 16 * 1024
RANGE = re.compile(r"bytes=(\d*)-(\d*)")
CHUNK = 64 * 1024


def json_body(body):
    try:
        data = json.loads(body.decode("utf-8"))
    except ValueError:
        data = None
    if not isinstance(data, dict):
        raise UserError("Тело запроса — не объект JSON")
    return data


def api_users(body):
    data = json_body(body)
    user = create_user(data.get("email"), data.get("password"))
    return 201, user, f"Создан пользователь {user['id']}"


def api_login(body):
    data = json_body(body)
    user = authenticate(data.get("email"), data.get("password"))
    user["has_specialization"] = specializations.has_records(user["id"])
    note = "есть специализация" if user["has_specialization"] else "специализации нет"
    return 200, user, f"Вход пользователя {user['id']}: {note}"


def api_resume(body):
    log.info("Резюме %.0f КБ: распознаю", len(body) / 1024)
    try:
        result = resume.recognize(body)
    except LLMError as error:
        failures = [failure.to_dict() for failure in error.failures]
        # Журнал — одной строкой: log_message заменяет переводы строк на \x0a.
        note = "; ".join([f"Резюме не распознано: {error.summary}", *map(str, error.failures)])
        return 502, {"error": error.summary, "failures": failures}, note
    note = f"Резюме: {result['result']} {result['specialization']} {result['grade']} ({result['source']})"
    for failure in result["failures"]:
        note += f"; до неё не справилась {failure['llm']} ({failure['model']}): {failure['error']}"
    return 200, result, note


def api_user_specializations(body):
    data = json_body(body)
    if "element_id" in data:
        record = specializations.save_selection(data.get("user_id"), data.get("element_id"))
    else:
        record = resume.save_specialization(data.get("user_id"), data.get("recognition_id"))
    note = f"Специализация {record['id']} пользователя {record['user_id']}: {record['specialization']} {record['grade']}"
    return 201, record, f"{note} ({record['source']['type']})"


def api_user_names(body):
    data = json_body(body)
    record = user_names.save(data.get("user_id"), data.get("first_name"), data.get("last_name"))
    return 201, record, f"Имя пользователя {record['user_id']}: {record['first_name']} {record['last_name']}"


def api_user_name(query):
    record = user_names.find(query.get("user_id"))
    return 200, {"record": record}, f"Имя пользователя {query.get('user_id')}: {'есть' if record else 'не введено'}"


def api_grade_tasks(body):
    data = json_body(body)
    task, key = grade_tests.create(data.get("user_id"), data.get("specialization"), data.get("grade"))
    return 201, task, f"Задание {task['task_id']} пользователю {data.get('user_id')}: {key}"


def api_user_tests(body):
    data = json_body(body)
    try:
        result, record = grade_tests.check(data.get("user_id"), data.get("task_id"), data)
    except LLMError as error:
        failures = [failure.to_dict() for failure in error.failures]
        note = "; ".join([f"Тест не проверен: {error.summary}", *map(str, error.failures)])
        return 502, {"error": f"Проверка не удалась: {error.summary}", "failures": failures}, note
    checks = ", ".join(filter(None, [
        "процедурная" if record["procedural_check"] else "",
        f"{record['llm']['llm']} ({record['llm']['model']})" if record["llm"] else "",
    ]))
    verdict = "пройден" if record["passed"] else "не пройден"
    return 201, result, f"Тест {record['id']} пользователя {record['user_id']}: {verdict}, {record['task_key']} ({checks})"


def api_user_tests_credit(body):
    data = json_body(body)
    result, record = grade_tests.credit(data.get("user_id"), data.get("test_id"))
    note = f"Тест {record['credited_from']} пользователя {record['user_id']} засчитан записью {record['id']}"
    return 201, result, f"{note}: {record['specialization']} {record['grade']}, {record['task_key']}"


def api_grade_profile(query):
    data = grade_tests.profile(query.get("user_id"))
    computed = data["computed"]
    found = f"{computed['specialization']} {computed['grade']}" if computed else "специализации нет"
    recommended = data["recommended"]
    note = f"Профиль теста пользователя {query.get('user_id')}: {found}, тестов {len(data['tests'])}"
    return 200, data, f"{note}, предлагаем {recommended['specialization']} {recommended['grade']} ({recommended['basis']})"


def api_desktop_icons(query):
    data = desktop_icons.for_user(query.get("user_id"))
    modes = ", ".join(data["modes"]) or "специализации нет"
    return 200, data, f"Значки рабочего стола пользователя {query.get('user_id')}: {modes}, значков {len(data['icons'])}"


def api_fsp(query):
    data = fsp.state(query.get("user_id"))
    if not data["linked"]:
        return 200, data, f"ФСП пользователя {query.get('user_id')}: не связан"
    pending = len(data["pending"]["competitions"]) if data["pending"] else 0
    note = f"ФСП пользователя {query.get('user_id')}: {data['fsp_id']}, соревнований {len(data['competitions'])}"
    return 200, data, f"{note}, новых {pending}"


def api_fsp_link(body):
    data = json_body(body)
    result = fsp.draft(data.get("user_id"), data.get("fsp_id"))
    found = ", ".join(f"{c['id']} ({c['result']['id']})" for c in result["competitions"])
    return 201, result, f"Черновик ФСП {result['draft_id']} пользователя {data.get('user_id')}, {result['fsp_id']}: {found}"


def api_fsp_save(body):
    data = json_body(body)
    result = fsp.save(data.get("user_id"), data.get("draft_id"))
    note = f"ФСП пользователя {data.get('user_id')} связан: {result['fsp_id']}"
    return 201, result, f"{note}, соревнований {len(result['competitions'])}, компетенций {len(result['competencies'])}"


def api_fsp_decide(body):
    data = json_body(body)
    result = fsp.decide(data.get("user_id"), data.get("competition_ids"), data.get("add"))
    verdict = "добавлены" if data.get("add") else "отклонены"
    return 200, result, f"Новые соревнования ФСП пользователя {data.get('user_id')} {verdict}: {data.get('competition_ids')}"


def api_projects_catalog(query):
    data = projects.catalog(query.get("user_id"))
    note = f"Анкета проекта для {query.get('user_id')}: компаний {len(data['companies'])}"
    return 200, data, f"{note}, соискателей на рынке {len(data['market'])}"


def api_projects_list(query):
    data = projects.list_projects(query.get("user_id"))
    news = project_news.summaries(query.get("user_id"))
    available = test_feedback.availability(query.get("user_id"))
    for project in data["projects"]:
        project["news"] = news.get(project["id"], dict.fromkeys(project_news.KINDS, 0))
        project["valid_vacancies"] = available.get(project["id"], 0)
    return 200, data, f"Проекты рекрутёра {query.get('user_id')}: {len(data['projects'])}"


def api_project(query):
    data = projects.get_project(query.get("user_id"), query.get("project_id"))
    data.update(project_news.snapshot(query.get("user_id"), query.get("project_id")))
    return 200, data, f"Проект {data['id']} рекрутёра {query.get('user_id')}: {data['status']}"


def api_projects_news_read(body):
    data = json_body(body)
    result = project_news.read(data.get("user_id"), data.get("project_id"), data.get("accepted_news"))
    return 200, result, f"Просмотр новостей проекта {result['project_id']}"


def api_test_feedback(body):
    data = json_body(body)
    result = test_feedback.generate(data.get("user_id"))
    return 201, result, f"Тестовая обратная связь рекрутёра {data.get('user_id')}: {len(result['invitation_ids'])} записей"


def api_project_feedback(query):
    result = project_feedback.tree(query.get("user_id"), query.get("project_id"))
    return 200, result, f"Обратная связь проекта {result['project_id']}: вакансий {len(result['vacancies'])}"


def api_candidate_profile(query):
    result = candidate_profile.profile(query.get("user_id"), query.get("applicant_id"))
    return 200, result, "Профиль кандидата"


def api_candidate_profile_pdf(query):
    import profile_pdf
    return 200, profile_pdf.export_candidate(query.get("user_id"), query.get("applicant_id")), "PDF профиля кандидата"


def api_self_profile(query):
    return 200, candidate_profile.self_profile(query.get("user_id")), "Собственный профиль соискателя"


def api_self_profile_pdf(query):
    import profile_pdf
    return 200, profile_pdf.export(query.get("user_id")), "PDF собственного профиля соискателя"


def api_profile_visibility(query):
    data = profile_visibility.state(query.get("user_id"))
    return 200, data, f"Видимость профиля {query.get('user_id')} для рекрутёров: {'скрыт' if data['hidden'] else 'виден'}"


def api_profile_visibility_update(body):
    data = json_body(body)
    result = profile_visibility.update(data.get("user_id"), data.get("hidden"))
    verdict = "скрыт от рекрутёров" if result["hidden"] else "снова виден рекрутёрам"
    return 200, result, f"Профиль {data.get('user_id')} {verdict}"


def api_project_feedback_review(body):
    data = json_body(body)
    result = project_feedback.review(data.get("user_id"), data.get("project_id"), data.get("invitation_id"),
                                     data.get("action"), data.get("email"), data.get("expected_revision"))
    return 200, result, f"Проверка приглашения {result['id']}: {result['status']}"


def api_project_feedback_close(body):
    data = json_body(body)
    result = project_feedback.close_vacancy(data.get("user_id"), data.get("project_id"), data.get("vacancy_id"))
    return 200, result, f"Вакансия {result['id']} закрыта наймом"


def api_project_feedback_respond(body):
    data = json_body(body)
    result = project_feedback.respond_application(data.get("user_id"), data.get("project_id"), data.get("invitation_id"),
                                                  data.get("action"), data.get("expected_revision"))
    return 200, result, f"Ответ рекрутёра на отклик {result['id']}: {result['status']}"


def api_projects_create(body):
    data = json_body(body)
    result = projects.create(data.get("user_id"), data)
    note = f"Проект {result['id']} «{result['name']}» ({result['company']['name']}) рекрутёра {data.get('user_id')}"
    return 201, result, f"{note}: черновиков вакансий {result['vacancies']}"


def api_projects_vacancies(body):
    data = json_body(body)
    result = projects.approve(data.get("user_id"), data.get("project_id"), data.get("vacancies"),
                              data.get("open_questions") or [])
    return 200, result, f"Вакансии проекта {result['id']} утверждены: {result['vacancies']}, людей {result['people']}"


def api_projects_copy(body):
    data = json_body(body)
    result = projects.copy(data.get("user_id"), data.get("project_id"), data.get("name"))
    return 201, result, f"Проект {data.get('project_id')} скопирован в {result['id']} «{result['name']}»"


def api_projects_complete(body):
    data = json_body(body)
    result = projects.set_completed(data.get("user_id"), data.get("project_id"), data.get("completed"))
    verdict = "завершён" if result["completed_at"] else "возобновлён"
    return 200, result, f"Набор по проекту {result['id']} {verdict}"


def api_projects_delete(body):
    data = json_body(body)
    result = projects.delete(data.get("user_id"), data.get("project_id"))
    return 200, result, f"Проект {result['deleted']} «{result['name']}» удалён с вакансиями"


def api_applicants_overview(query):
    data = applicant_search.overview(query.get("user_id"))
    vacancies = sum(len(p["vacancies"]) for p in data["projects"])
    return 200, data, f"Соискатели, рекрутёр {query.get('user_id')}: проектов {len(data['projects'])}, вакансий {vacancies}"


def api_applicants_team(query):
    data = applicant_search.team(query.get("user_id"), query.get("project_id"))
    placed = sum(len(v["candidates"]) for v in data["vacancies"])
    note = f"Команда проекта {data['project']['id']}: вакансий {len(data['vacancies'])}, соискателей {placed}"
    return 200, data, note


def api_applicants_vacancy(query):
    data = applicant_search.vacancy(query.get("user_id"), query.get("vacancy_id"))
    note = f"Соискатели вакансии {data['vacancy']['id']}: {data['found']}, со связкой ФСП {data['linked']}"
    return 200, data, note


def api_applicants_search(query):
    data = applicant_search.search(query.get("user_id"), query.get("specialization"), query.get("grade"))
    found = f"{data['query']['specialization'] or 'все'} · {data['query']['grade'] or 'любой'}"
    return 200, data, f"Поиск соискателей рекрутёра {query.get('user_id')} ({found}): {data['found']}"


def api_invitations(body):
    data = json_body(body)
    result = applicant_search.invite(data.get("user_id"), data.get("vacancy_id"), data.get("applicant_id"), data.get("source"))
    note = f"Приглашение {result['id']}: рекрутёр {data.get('user_id')} → {result['applicant_id']}"
    return 201, result, f"{note}, вакансия {result['vacancy_id']} ({result['flow']})"


def api_applicant_invitations(query):
    result = applicant_invitations.list_for_user(query.get("user_id"))
    return 200, result, f"Приглашения соискателя {query.get('user_id')}: {len(result['invitations'])}"


def api_applicant_invitations_read(body):
    data = json_body(body)
    result = applicant_invitations.read(data.get("user_id"), data.get("invitation_id"),
                                         data.get("expected_revision"))
    return 200, result, f"Приглашение {result['id']} просмотрено соискателем: {result['status']}"


def api_applicant_invitations_dismiss_alert(body):
    data = json_body(body)
    result = applicant_invitations.dismiss_alert(data.get("user_id"), data.get("shown"))
    return 200, result, f"Соискатель {data.get('user_id')} открыл приглашения: погашено версий {result['dismissed']}"


def api_applicant_invitations_respond(body):
    data = json_body(body)
    result = applicant_invitations.respond(data.get("user_id"), data.get("invitation_id"),
                                            data.get("action"), data.get("answers"),
                                            data.get("expected_revision"))
    return 200, result, f"Ответ соискателя на приглашение {result['id']}: {result['status']}"


def api_test_invitations(body):
    data = json_body(body)
    result = test_invitations.generate(data.get("user_id"))
    return 201, result, f"Тестовые приглашения соискателя {data.get('user_id')}: {result['created_invitations']}"


def api_vacancies(query):
    data = vacancy_search.listing(query.get("user_id"))
    return 200, data, f"Вакансии соискателя {query.get('user_id')}: {data['found']}"


def api_vacancies_apply(body):
    data = json_body(body)
    result = vacancy_search.apply(data.get("user_id"), data.get("vacancy_id"), data.get("answers"))
    note = f"Отклик {result['id']}: соискатель {data.get('user_id')} → вакансия {data.get('vacancy_id')}"
    return 201, result, f"{note} ({result['status']})"


def api_test_projects(body):
    data = json_body(body)
    result = test_projects.generate(data.get("user_id"))
    note = f"Тестовый набор рекрутёра {data.get('user_id')}: создано проектов {result['created_projects']}, вакансий {result['created_vacancies']}"
    return (201 if result["created_projects"] else 200), result, note


# Адрес → (Content-Type тела, наибольший размер тела, обработчик). Обработчик
# получает тело и возвращает (код, ответ, строка в журнал) или бросает UserError.
API = {
    "/api/users": ("application/json", MAX_JSON, api_users),
    "/api/login": ("application/json", MAX_JSON, api_login),
    "/api/resume": ("application/pdf", resume.MAX_PDF, api_resume),
    "/api/user_specializations": ("application/json", MAX_JSON, api_user_specializations),
    "/api/user_names": ("application/json", MAX_JSON, api_user_names),
    "/api/grade_tasks": ("application/json", MAX_JSON, api_grade_tasks),
    "/api/user_tests": ("application/json", grade_tests.MAX_BODY, api_user_tests),
    "/api/user_tests/credit": ("application/json", MAX_JSON, api_user_tests_credit),
    "/api/fsp/link": ("application/json", MAX_JSON, api_fsp_link),
    "/api/fsp/save": ("application/json", MAX_JSON, api_fsp_save),
    "/api/fsp/decide": ("application/json", MAX_JSON, api_fsp_decide),
    "/api/projects": ("application/json", projects.MAX_BODY, api_projects_create),
    "/api/projects/news/read": ("application/json", projects.MAX_BODY, api_projects_news_read),
    "/api/projects/test-feedback": ("application/json", MAX_JSON, api_test_feedback),
    "/api/projects/feedback/review": ("application/json", MAX_JSON, api_project_feedback_review),
    "/api/projects/feedback/close": ("application/json", MAX_JSON, api_project_feedback_close),
    "/api/projects/feedback/respond": ("application/json", MAX_JSON, api_project_feedback_respond),
    "/api/projects/vacancies": ("application/json", projects.MAX_BODY, api_projects_vacancies),
    "/api/projects/copy": ("application/json", MAX_JSON, api_projects_copy),
    "/api/projects/complete": ("application/json", MAX_JSON, api_projects_complete),
    "/api/projects/delete": ("application/json", MAX_JSON, api_projects_delete),
    "/api/invitations": ("application/json", MAX_JSON, api_invitations),
    "/api/applicant/visibility": ("application/json", MAX_JSON, api_profile_visibility_update),
    "/api/applicant/invitations/read": ("application/json", MAX_JSON, api_applicant_invitations_read),
    "/api/applicant/invitations/dismiss-alert": ("application/json", applicant_invitations.MAX_BODY, api_applicant_invitations_dismiss_alert),
    "/api/applicant/invitations/respond": ("application/json", applicant_invitations.MAX_BODY, api_applicant_invitations_respond),
    "/api/applicant/invitations/test-data": ("application/json", MAX_JSON, api_test_invitations),
    "/api/applicants/test-projects": ("application/json", MAX_JSON, api_test_projects),
    "/api/vacancies/apply": ("application/json", applicant_invitations.MAX_BODY, api_vacancies_apply),
}
# GET: адрес → обработчик. Он получает параметры запроса {имя: значение},
# отвечает так же, как обработчик POST.
GET_API = {
    "/api/user_names": api_user_name,
    "/api/desktop_icons": api_desktop_icons,
    "/api/grade_profile": api_grade_profile,
    "/api/fsp": api_fsp,
    "/api/projects/catalog": api_projects_catalog,
    "/api/projects": api_projects_list,
    "/api/project": api_project,
    "/api/projects/feedback": api_project_feedback,
    "/api/applicants/profile": api_candidate_profile,
    "/api/applicants/profile/pdf": api_candidate_profile_pdf,
    "/api/applicant/profile": api_self_profile,
    "/api/applicant/profile/pdf": api_self_profile_pdf,
    "/api/applicant/visibility": api_profile_visibility,
    "/api/applicants/overview": api_applicants_overview,
    "/api/applicants/team": api_applicants_team,
    "/api/applicants/vacancy": api_applicants_vacancy,
    "/api/applicants/search": api_applicants_search,
    "/api/applicant/invitations": api_applicant_invitations,
    "/api/vacancies": api_vacancies,
}


class Handler(SimpleHTTPRequestHandler):
    # На Windows mimetypes читает реестр, и .js иногда приходит как text/plain:
    # браузер такой модуль не исполнит.
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".json": "application/json",
        ".map": "application/json",
        ".wasm": "application/wasm",
        ".png": "image/png",
        ".svg": "image/svg+xml",
        ".woff2": "font/woff2",
        ".jpg": "image/jpeg",
        ".mp3": "audio/mpeg",
        ".wav": "audio/wav",
        ".mp4": "video/mp4",
        ".html": "text/html",
        ".css": "text/css",
        ".ico": "image/x-icon",
        ".glb": "model/gltf-binary",
    }

    def do_GET(self):
        url = urlsplit(self.path)
        if url.path == "/healthz":
            self.send_json(200, {"status": "ok"})
            return
        if url.path in GET_API:
            query = {key: values[0] for key, values in parse_qs(url.query).items()}
            self.answer(GET_API[url.path], query)
            return
        if not self.allowed():
            return
        if self.headers.get("Range") and self.send_range():
            return
        super().do_GET()

    def do_HEAD(self):
        if urlsplit(self.path).path == "/healthz":
            self.send_json(200, {"status": "ok"}, head=True)
            return
        if not self.allowed():
            return
        super().do_HEAD()

    def allowed(self):
        path = unquote(urlsplit(self.path).path)
        if path in REDIRECTS:
            self.send_response(302)
            self.send_header("Location", REDIRECTS[path])
            self.end_headers()
            return False
        # Части пути с точкой в начале — скрытые файлы и .. — не отдаются вовсе.
        hidden = any(part.startswith(".") for part in path.split("/"))
        public = path.startswith((ALLOWED_PREFIX, *MOUNTS))
        if not public or hidden or self.private():
            self.send_error(404)
            return False
        return True

    # Адрес внутреннего приложения — файл в его папке: /resume3/x → resume3/public/x.
    def translate_path(self, path):
        route = posixpath.normpath(unquote(urlsplit(path).path))
        for prefix, folder in MOUNTS.items():
            if (route + "/").startswith(prefix):
                parts = [part for part in route[len(prefix):].split("/") if part not in ("", ".", "..")]
                target = folder.joinpath(*parts)
                # BrowserRouter pages must survive a direct link or browser refresh.
                if prefix == "/os/" and not target.exists() and not target.suffix:
                    target = folder / "index.html"
                return str(target)
        return super().translate_path(path)

    # Путь сверяется после разбора, как его откроет сервер: /app/db/./Users/
    # и %2e%2e ведут туда же.
    def private(self):
        target = Path(self.translate_path(self.path)).resolve()
        return any(target.is_relative_to(path.resolve()) for path in PRIVATE_PATHS)

    # Часть файла по заголовку Range, одним куском: видео браузер грузит так.
    # False — заголовок не разобран, файл отдаётся целиком обычным путём.
    def send_range(self):
        match = RANGE.fullmatch(self.headers["Range"].strip())
        path = Path(self.translate_path(self.path))
        if not match or not path.is_file():
            return False
        size = path.stat().st_size
        start, end = match.groups()
        if start:
            first, last = int(start), min(int(end), size - 1) if end else size - 1
        elif end:
            first, last = max(0, size - int(end)), size - 1  # последние end байт
        else:
            return False
        if first > last:
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{size}")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return True
        length = last - first + 1
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(str(path)))
        self.send_header("Content-Range", f"bytes {first}-{last}/{size}")
        self.send_header("Content-Length", str(length))
        self.end_headers()
        try:
            with open(path, "rb") as file:
                file.seek(first)
                while length > 0:
                    chunk = file.read(min(length, CHUNK))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    length -= len(chunk)
        except ConnectionError:
            pass  # браузер взял, что хотел, и оборвал загрузку — для видео обычное дело
        return True

    def do_POST(self):
        route = API.get(urlsplit(self.path).path)
        if route is None:
            self.send_json(404, {"error": "Нет такого адреса"})
            return
        content_type, max_body, handle = route
        # Чужая страница в браузере не должна создавать записи: Origin только свой,
        # а JSON и PDF заставляют браузер спрашивать разрешение (CORS), которого сервер не даёт.
        origin = self.headers.get("Origin")
        if origin is not None and not self.same_origin(origin):
            self.send_json(403, {"error": "Запрос с чужой страницы"})
            return
        if self.headers.get_content_type() != content_type:
            self.send_json(415, {"error": f"Нужен Content-Type: {content_type}"})
            return
        length = int(self.headers.get("Content-Length") or 0)
        if length > max_body:
            self.send_json(413, {"error": f"Слишком большой запрос: больше {max_body // 1024} КБ"})
            return
        self.answer(handle, self.rfile.read(length))

    def same_origin(self, origin):
        # The HTTPS ingress forwards the public Host even though the container uses HTTP.
        # An explicit origin also supports ingress configurations that rewrite Host.
        expected = os.environ.get("PUBLIC_ORIGIN", "").strip().rstrip("/")
        if expected:
            return origin == expected
        try:
            parsed = urlsplit(origin)
            return (parsed.scheme in ("http", "https") and not parsed.username
                    and not parsed.password and not parsed.path and not parsed.query
                    and not parsed.fragment and parsed.netloc.lower() == self.headers.get("Host", "").lower())
        except ValueError:
            return False

    # Ответ API: handle(request) возвращает (код, ответ, строка в журнал) или бросает UserError.
    def answer(self, handle, request):
        try:
            status, data, note = handle(request)
        except UserError as error:
            self.send_json(error.status, {"error": str(error)})
            return
        except Exception as error:  # ошибка в коде сервера: ответ с причиной, а не оборванное соединение
            self.log_error("Ошибка в обработчике %s %s:", self.command, urlsplit(self.path).path)
            traceback.print_exc()
            self.send_json(500, {"error": "Ошибка на сервере", "detail": f"{type(error).__name__}: {error}"})
            return
        self.log_message("%s", note)
        if isinstance(data, bytes):
            self.send_response(status)
            self.send_header("Content-Type", "application/pdf")
            self.send_header("Content-Disposition", 'attachment; filename="itinder-profile.pdf"')
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        self.send_json(status, data)

    def send_json(self, status, data, head=False):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if not head:
            self.wfile.write(body)

    def end_headers(self):
        # Во время разработки браузер не должен держать старые модули и JSON.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


class Server(ThreadingHTTPServer):
    # На Windows SO_REUSEADDR пускает второй сервер на занятый порт, и запросы
    # достаются то одному, то другому — старому коду вперемешку с новым.
    # Пусть второй запуск сразу скажет, что порт занят.
    allow_reuse_address = sys.platform != "win32"


def main():
    # Журнал по-русски: без этого на Windows вывод в pipe идёт в cp1251 и читается кракозябрами.
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    # Попытки нейросетей (llm.py): куда, сколько КБ, через прокси или напрямую, за сколько секунд.
    logging.basicConfig(level=logging.INFO, format="[%(asctime)s] %(message)s", datefmt="%d/%b/%Y %H:%M:%S")
    port = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get("PORT", DEFAULT_PORT))
    host = os.environ.get("HOST", "127.0.0.1")
    initialize_data()
    handler = partial(Handler, directory=str(ROOT))
    try:
        server = Server((host, port), handler)
    except OSError as error:
        sys.exit(f"Порт {port} занят — сервер уже запущен? Остановите его или выберите другой порт: "
                 f"python app/tools/serve.py {port + 1} ({error.strerror or error})")
    print(f"ITinder: http://{host}:{port}{START_PAGE}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
