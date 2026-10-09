"""Сгенерированные соискатели — данные, на которых удобно делать часть
приложения для рекрутера: поиск, фильтры, карточки кандидатов.

Пишет те же файлы, что пишет сервер, когда соискатель проходит интерфейс:
    users/<id>.json — почта и хеш пароля, у всех один пароль PASSWORD;
        поле "seed": SEED_MARK отличает сгенерированных от настоящих;
    user_specializations/ — заявленная специализация и грейд: распознавание
        резюме (LLM) или ручной выбор на странице 5 (Manual, элементы из
        ui_scheme.json); у части — вторая запись позже: сменили грейд или
        специализацию, действует последняя;
    user_names/<id>.json — имя и фамилия; у части нет: «операционную систему»
        на мониторе не открывали, поэтому у них нет ни тестов, ни ФСП;
    user_tests/ — история «Задач на грейд»: ключи заданий из генератора
        grade_tests, начинают с заявленного грейда, дальше next_grade;
        «настоящий» уровень соискателя бывает ниже заявленного; часть
        непройденных засчитана кнопкой тестовой версии (credited_from);
    user_fsp/<id>.json — связка с ФСП: прошедшие до связки соревнования
        (fsp.participate), будущие — добавлены, отклонены или ждут решения;
    user_blocks/<id>.json — {"user_id", "created_at"}: не показывать рекрутёрам.

Каждый запуск сначала удаляет сгенерированных прошлым запуском (по SEED_MARK
в users/ и их user_id в остальных папках), настоящих пользователей не трогает.
С тем же --seed получаются те же люди и те же записи, меняются только даты:
они отсчитываются от момента запуска.

Запуск из корня проекта:
    python app/tools/seed_applicants.py               # COUNT соискателей
    python app/tools/seed_applicants.py --count 1000 --seed 7
    python app/tools/seed_applicants.py --clean       # только удалить
"""

import argparse
import json
import random
import sys
import uuid
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

from data_paths import mutable_dir

import fsp
import grade_tests
import llm
import specializations
import users

ROOT = Path(__file__).resolve().parent.parent.parent
DB = ROOT / "app" / "db"
USERS_DIR = users.USERS_DIR
SPECIALIZATIONS_DIR = specializations.SPECIALIZATIONS_DIR
NAMES_DIR = mutable_dir("user_names")
TESTS_DIR = grade_tests.TESTS_DIR
FSP_DIR = fsp.USER_FSP_DIR
BLOCKS_DIR = mutable_dir("user_blocks")

SEED_MARK = "seed_applicants"
PASSWORD = "Seed-Applicant-2026"  # тестовый пароль всех сгенерированных
COUNT = 500  # 4 специализации на 3 грейда: в среднем ~40 на ячейку, хватает на фильтры в сочетании
DAYS = 90  # за сколько дней до запуска «регистрировались»

GRADES = grade_tests.GRADES
SPEC_WEIGHTS = {"Backend": 30, "Frontend": 26, "QA": 24, "Syst. Analyst": 20}
GRADE_WEIGHTS = {"Junior": 38, "Middle": 40, "Senior": 22}
FEMALE_SHARE = {"Backend": 0.15, "Frontend": 0.3, "QA": 0.5, "Syst. Analyst": 0.5}
# Куда переходят, когда меняют специализацию.
SWITCHES = {
    "Backend": ("Syst. Analyst", "Frontend"),
    "Frontend": ("Backend", "QA"),
    "QA": ("Backend", "Syst. Analyst", "Frontend"),
    "Syst. Analyst": ("Backend", "QA"),
}
P_SECOND_RECORD = 0.15
P_SWITCH = 0.4  # из вторых записей — смена специализации, остальные — грейда
P_LLM_SOURCE = 0.45  # специализацию распознали по резюме, а не выбрали
P_DEEPSEEK = 0.15  # Gemini не ответила, ответила DeepSeek
P_NAME = 0.93
P_TESTS = 0.65  # из тех, у кого есть имя
P_OTHER_SPEC_TEST = 0.08
ATTEMPTS = {1: 35, 2: 25, 3: 18, 4: 12, 5: 6, 6: 4}
# Настоящий уровень относительно заявленного: завышают чаще, чем занижают.
TRUE_OFFSET = {-1: 30, 0: 55, 1: 15}
# Вероятность сдать по разнице «настоящий уровень − грейд теста».
PASS_CHANCE = {1: 0.92, 0: 0.65, -1: 0.15, -2: 0.03}
P_CREDIT = 0.15
P_FSP = {"Junior": 0.4, "Middle": 0.3, "Senior": 0.15}  # соревнования ФСП — в основном студенты
FUTURE_DECISION = {"add": 65, "decline": 15, "pending": 20}
P_BLOCK = 0.04
BACKEND_LANGUAGES = {"Python": 24, "Java": 20, "Go": 14, "Kotlin": 9, "C#": 10, "JavaScript": 4,
                     "TypeScript": 7, "PHP": 6, "C++": 3, "Rust": 2, "Ruby": 1}
EMAIL_DOMAINS = {"gmail.com": 34, "yandex.ru": 28, "mail.ru": 18, "ya.ru": 6, "bk.ru": 4,
                 "outlook.com": 4, "icloud.com": 4, "inbox.ru": 2}

MALE_NAMES = (
    "Александр Алексей Андрей Антон Арсений Артём Богдан Вадим Виктор Владимир Владислав Глеб "
    "Григорий Даниил Денис Дмитрий Евгений Егор Захар Иван Игорь Илья Кирилл Константин Лев "
    "Максим Марк Матвей Михаил Никита Николай Олег Павел Роман Руслан Семён Сергей Станислав "
    "Степан Тимофей Тимур Фёдор Филипп Юрий Ярослав Эмиль Ринат Артур"
).split()
FEMALE_NAMES = (
    "Александра Алина Алиса Анастасия Анна Валерия Варвара Вера Вероника Виктория Дарья Диана "
    "Ева Екатерина Елена Елизавета Злата Ирина Карина Кира Ксения Мария Марина Милана Надежда "
    "Наталья Олеся Ольга Полина Светлана София Таисия Ульяна Юлия Яна Камила Эльвира"
).split()
# В мужской форме; женскую даёт _female_surname.
SURNAMES = (
    "Иванов Смирнов Кузнецов Попов Васильев Петров Соколов Михайлов Новиков Фёдоров Морозов "
    "Волков Алексеев Лебедев Семёнов Егоров Павлов Козлов Степанов Николаев Орлов Андреев "
    "Макаров Никитин Захаров Зайцев Соловьёв Борисов Яковлев Григорьев Романов Воробьёв Сергеев "
    "Кузьмин Фролов Александров Дмитриев Королёв Гусев Киселёв Ильин Максимов Поляков Сорокин "
    "Виноградов Ковалёв Белов Медведев Антонов Тарасов Жуков Баранов Филиппов Комаров Давыдов "
    "Беляев Герасимов Богданов Осипов Сидоров Матвеев Титов Марков Миронов Крылов Куликов "
    "Карпов Власов Мельников Денисов Гаврилов Тихонов Казаков Афанасьев Данилов Тимофеев Фомин "
    "Чернов Абрамов Мартынов Ефимов Щербаков Назаров Калинин Исаев Быков Маслов Родионов "
    "Коновалов Лазарев Воронин Климов Пономарёв Голубев Кудрявцев Прохоров Наумов Потапов "
    "Журавлёв Трофимов Леонов Соболев Ермаков Колесников Гончаров Никифоров Котов Громов "
    "Кириллов Малышев Румянцев Акимов Горбунов Галкин Скворцов Юдин Нестеров Симонов Князев "
    "Цветков Левин Воронцов Мальцев Логинов Краснов Демидов Елисеев Рыбаков Плотников Мухин "
    "Вишневский Островский Покровский Высоцкий Луговской Шевченко Ткаченко Бондаренко Черных "
    "Седых Ким Цой Хабибуллин Гарипов Сафин Ахметов Алиев Юсупов Галиев Нуриев Мамедов"
).split()
TRANSLIT = dict(zip(
    "абвгдеёжзийклмнопрстуфхцчшщъыьэюя",
    "a b v g d e e zh z i y k l m n o p r s t u f kh ts ch sh shch - y - e yu ya".split(),
))


def _pick(rng, weights):
    return rng.choices(list(weights), weights=list(weights.values()))[0]


def _uuid(rng):
    return str(uuid.UUID(int=rng.getrandbits(128), version=4))


def _female_surname(surname):
    if surname.endswith(("ский", "цкий", "ской")):
        return surname[:-2] + "ая"
    if surname.endswith(("ов", "ев", "ёв", "ин", "ын")):
        return surname + "а"
    return surname  # Шевченко, Черных, Ким


def _latin(text):
    return "".join(TRANSLIT.get(char, char) for char in text.lower()).replace("-", "")


def _email(rng, first, last, taken):
    f, l = _latin(first), _latin(last)
    year = rng.randint(1985, 2006)
    local = rng.choice((f"{f}.{l}", f"{f[0]}.{l}", f"{l}.{f}", f"{f}{l}", f"{l}{year % 100:02d}",
                        f"{f}.{l}{year}", f"{f[0]}{l}{rng.randint(1, 99)}", f"{l}_{f}"))
    domain = _pick(rng, EMAIL_DOMAINS)
    email, n = f"{local}@{domain}", 1
    while email.casefold() in taken:
        n += 1
        email = f"{local}{n}@{domain}"
    taken.add(email.casefold())
    return email


def _write(path, record):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "x", encoding="utf-8", newline="\n") as file:
        json.dump(record, file, ensure_ascii=False, indent=2)
        file.write("\n")


def _iso(moment):
    return moment.isoformat()


def clean():
    """Удаляет сгенерированных: их записи во всех папках. Возвращает, сколько людей удалено."""
    ids = set()
    for path in USERS_DIR.glob("*.json"):
        if json.loads(path.read_text(encoding="utf-8")).get("seed") == SEED_MARK:
            ids.add(path.stem)
            path.unlink()
    for folder in (NAMES_DIR, FSP_DIR, BLOCKS_DIR):
        for user_id in ids:
            (folder / f"{user_id}.json").unlink(missing_ok=True)
    for folder in (SPECIALIZATIONS_DIR, TESTS_DIR):
        for path in folder.glob("*.json"):
            if json.loads(path.read_text(encoding="utf-8")).get("user_id") in ids:
                path.unlink()
    return len(ids)


class Generator:
    def __init__(self, seed, now):
        self.rng = random.Random(seed)
        self.now = now
        self.password_hash = users.hash_password(PASSWORD)  # один хеш на всех: 600 000 итераций — это долго
        self.taken = {
            str(json.loads(p.read_text(encoding="utf-8")).get("email", "")).casefold()
            for p in USERS_DIR.glob("*.json")
        }
        self.fsp_ids = set()
        self.manual = self._manual_elements()
        self.catalog = fsp._catalog()
        self.held = fsp._load(fsp.COMPETITIONS)
        self.future = fsp._load(fsp.FUTURE)
        self.stats = Counter()
        self.cells = Counter()

    @staticmethod
    def _manual_elements():
        """(специализация, грейд) → элементы ручного выбора на странице 5: карточка и кнопка грейда."""
        rows = {r["id"]: r for r in json.loads(specializations.SCHEME.read_text(encoding="utf-8"))}
        found = {}
        for row in rows.values():
            parent = rows.get(row.get("anchor_point_id"))
            if row.get("additional action") == specializations.SELECT_ACTION and row.get("page") == 5 and parent:
                found[(parent["title"].strip(), row["title"].strip())] = (row["page"], [
                    {"id": parent["id"], "title": parent["title"].strip()},
                    {"id": row["id"], "title": row["title"].strip()},
                ])
        return found

    def _later(self, moment, low, high):
        """Момент через случайное число минут из [low, high] или None, если он ещё не наступил."""
        moment += timedelta(minutes=self.rng.uniform(low, high), seconds=self.rng.random())
        return moment if moment < self.now else None

    def _llm(self):
        return ("DeepSeek", llm.DEEPSEEK_MODEL) if self.rng.random() < P_DEEPSEEK else ("Gemini", llm.GEMINI_MODEL)

    def _specialization(self, user_id, specialization, grade, moment):
        rng = self.rng
        if rng.random() < P_LLM_SOURCE:
            name, model = self._llm()
            source = {"type": "LLM", "llm": name, "model": model}
        else:
            page, elements = self.manual[(specialization, grade)]
            source = {"type": "Manual", "page": page, "elements": elements}
        record = {"id": _uuid(rng), "user_id": user_id, "specialization": specialization, "grade": grade,
                  "created_at": _iso(moment), "source": source}
        _write(SPECIALIZATIONS_DIR / f"{record['id']}.json", record)

    def _test(self, user_id, specialization, grade, passed, language, moment, procedural_failed=False):
        rng = self.rng
        mode = grade_tests.answer_mode(specialization, grade)
        # Нейросеть зовут на описание решений и на код, но код — только если выбор решений прошёл.
        asked = mode["text"] or (mode["code"] and not procedural_failed)
        record = {
            "id": _uuid(rng),
            "user_id": user_id,
            "specialization": specialization,
            "grade": grade,
            "passed": passed,
            "task_key": grade_tests.generate(specialization, grade, rng)["key"],
            "language": language if mode["code"] else None,
            "llm": dict(zip(("llm", "model"), self._llm())) if asked else None,
            "procedural_check": mode["select"],
            "created_at": _iso(moment),
        }
        _write(TESTS_DIR / f"{record['id']}.json", record)
        self.stats["tests"] += 1
        return record

    def _tests(self, user_id, specialization, declared, moment):
        """История тестов одной специализации: с заявленного грейда, дальше — next_grade."""
        rng = self.rng
        level = GRADES.index(declared) + _pick(rng, TRUE_OFFSET)
        level = min(max(level, 0), len(GRADES) - 1)
        language = _pick(rng, BACKEND_LANGUAGES)
        grade, confirmed = declared, False
        for _ in range(_pick(rng, ATTEMPTS)):
            # Между попытками — минуты, часы или дни.
            moment = self._later(moment, *rng.choice(((3, 40), (60, 600), (1440, 10080))))
            if moment is None:
                break
            difference = max(level - GRADES.index(grade), -2)
            passed = rng.random() < PASS_CHANCE[min(difference, 1)]
            # Провал при выборе из списка — чаще ещё до нейросети.
            select = grade_tests.answer_mode(specialization, grade)["select"]
            procedural_failed = not passed and select and rng.random() < 0.6
            record = self._test(user_id, specialization, grade, passed, language, moment, procedural_failed)
            if not passed and rng.random() < P_CREDIT:
                credit_moment = self._later(moment, 0.05, 2)
                if credit_moment:
                    # Как grade_tests.credit: нейросеть и справочник запись не проверяли.
                    credited = {key: value for key, value in record.items() if key != "created_at"}
                    credited.update(id=_uuid(rng), passed=True, llm=None, procedural_check=False,
                                    credited_from=record["id"], created_at=_iso(credit_moment))
                    _write(TESTS_DIR / f"{credited['id']}.json", credited)
                    self.stats["credited"] += 1
                    passed, moment = True, credit_moment
            confirmed = confirmed or passed
            if passed and grade == GRADES[-1] and rng.random() < 0.7:
                break
            grade = grade_tests.next_grade(grade, passed)
        return confirmed

    def _fsp(self, user_id, specialization, moment):
        rng = self.rng
        _, roles, stack = self.catalog
        role = next(r for r in roles.values() if r["specialization"] == specialization)
        day = moment.date().isoformat()
        held = [c for c in self.held if c["end_date"] < day and fsp._has_role(c, role["id"])]
        if not held:
            return False
        rng.shuffle(held)
        count = rng.randint(fsp.FOUND_MIN, min(fsp.FOUND_MAX, len(held)))
        chosen = []
        for competition in held:  # как fsp._found, только «сегодня» — день связки
            if len(chosen) == count:
                break
            if not any(fsp._overlaps(competition, other) for other in chosen):
                chosen.append(competition)
        chosen.sort(key=lambda c: c["start_date"])
        while (fsp_id := f"FSP-{rng.randint(0, 9999):04d}-{rng.randint(0, 9999):04d}") in self.fsp_ids:
            pass
        self.fsp_ids.add(fsp_id)
        linked_at = _iso(moment)
        record = {
            "user_id": user_id,
            "fsp_id": fsp_id,
            "role_id": role["id"],
            "specialization": specialization,
            "linked_at": linked_at,
            "seed": rng.getrandbits(32),
            "competitions": [
                {**fsp.participate(c, role["id"], stack, rng), "source": "registry", "added_at": linked_at}
                for c in chosen
            ],
            "declined": [],
        }
        updated = moment
        # Будущие соревнования созревают через minutes_after_profile_link после связки.
        for competition in self.future:
            if not fsp._has_role(competition, role["id"]):
                continue
            due = moment + timedelta(minutes=competition["minutes_after_profile_link"])
            decision = _pick(rng, FUTURE_DECISION)
            at = self._later(due, 0, 2880)
            if at is None or decision == "pending":
                continue
            if decision == "add":
                item = fsp._future_participation(record, competition, stack)
                record["competitions"].append({**item, "source": "after_link", "added_at": _iso(at)})
            else:
                record["declined"].append({"competition_id": competition["id"], "declined_at": _iso(at)})
            updated = max(updated, at)
        record["competencies"] = fsp.competencies(record["competitions"])
        record["updated_at"] = _iso(updated)
        _write(FSP_DIR / f"{user_id}.json", record)
        return True

    def applicant(self):
        rng = self.rng
        user_id = _uuid(rng)
        specialization = _pick(rng, SPEC_WEIGHTS)
        grade = _pick(rng, GRADE_WEIGHTS)
        female = rng.random() < FEMALE_SHARE[specialization]
        first = rng.choice(FEMALE_NAMES if female else MALE_NAMES)
        last = rng.choice(SURNAMES)
        last = _female_surname(last) if female else last
        _write(USERS_DIR / f"{user_id}.json", {
            "id": user_id, "email": _email(rng, first, last, self.taken),
            "password_hash": self.password_hash, "seed": SEED_MARK,
        })

        # Регистрация чаще недавняя: степень сдвигает к сегодняшнему дню.
        registered = self.now - timedelta(days=DAYS * rng.random() ** 1.5, hours=2)
        moment = self._later(registered, 1, 20)
        self._specialization(user_id, specialization, grade, moment)
        if rng.random() < P_SECOND_RECORD and (later := self._later(moment, 1440, 30 * 1440)):
            if rng.random() < P_SWITCH:
                specialization = rng.choice(SWITCHES[specialization])
            else:
                grade = GRADES[min(GRADES.index(grade) + 1, len(GRADES) - 1)]
            moment = later
            self._specialization(user_id, specialization, grade, moment)
            self.stats["second_record"] += 1

        named_at = self._later(moment, 2, 90)
        if named_at is None or rng.random() >= P_NAME:
            self.cells[(specialization, grade, "no_name")] += 1
            return
        _write(NAMES_DIR / f"{user_id}.json", {
            "user_id": user_id, "first_name": first, "last_name": last, "created_at": _iso(named_at),
        })
        self.stats["named"] += 1

        confirmed = False
        if rng.random() < P_TESTS:
            if rng.random() < P_OTHER_SPEC_TEST:
                other = rng.choice([s for s in grade_tests.SPECIALIZATIONS if s != specialization])
                self._tests(user_id, other, grade, named_at)
            confirmed = self._tests(user_id, specialization, grade, named_at)
            self.stats["tested"] += 1
        self.cells[(specialization, grade, "confirmed" if confirmed else "declared")] += 1

        if rng.random() < P_FSP[grade] and (linked := self._later(named_at, 5, 20 * 1440)):
            if self._fsp(user_id, specialization, linked):
                self.stats["fsp"] += 1
        if rng.random() < P_BLOCK and (blocked := self._later(named_at, 10, 30 * 1440)):
            _write(BLOCKS_DIR / f"{user_id}.json", {"user_id": user_id, "created_at": _iso(blocked)})
            self.stats["blocked"] += 1

    def report(self, count):
        print(f"Соискателей: {count}; с именем {self.stats['named']}, со второй записью специализации "
              f"{self.stats['second_record']}, проходили тесты {self.stats['tested']} "
              f"(записей тестов {self.stats['tests']}, засчитано кнопкой {self.stats['credited']}), "
              f"связаны с ФСП {self.stats['fsp']}, скрыты от рекрутёров {self.stats['blocked']}.")
        print("\nПоследняя заявленная специализация, грейд: есть пройденный тест / нет / без имени")
        for specialization in SPEC_WEIGHTS:
            cells = [f"{grade} {self.cells[(specialization, grade, 'confirmed')]:>3}/"
                     f"{self.cells[(specialization, grade, 'declared')]:>3}/"
                     f"{self.cells[(specialization, grade, 'no_name')]:>2}" for grade in GRADES]
            print(f"  {specialization:<14}" + "   ".join(cells))


def main():
    parser = argparse.ArgumentParser(description="Генерирует соискателей для разработки части рекрутера")
    parser.add_argument("--count", type=int, default=COUNT)
    parser.add_argument("--seed", type=int, default=2026)
    parser.add_argument("--clean", action="store_true", help="только удалить сгенерированных")
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    removed = clean()
    if removed:
        print(f"Удалены сгенерированные прошлым запуском: {removed}")
    if args.clean:
        return
    generator = Generator(args.seed, datetime.now(timezone.utc))
    for _ in range(args.count):
        generator.applicant()
    generator.report(args.count)


if __name__ == "__main__":
    main()
