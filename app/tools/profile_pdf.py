"""PDF собственного профиля: окно командной строки, векторный текст и пагинация."""

import io
import math
import os
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path

from reportlab.lib.colors import HexColor
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

import candidate_profile
from users import UserError

KINDS = {'languages': 'ЯЗЫКИ', 'databases': 'БАЗЫ ДАННЫХ', 'integrations': 'ИНТЕГРАЦИИ', 'testing': 'ТЕСТИРОВАНИЕ'}
LEVELS = {'regional': 'Региональное', 'interregional': 'Межрегиональное', 'national': 'Всероссийское', 'international': 'Международное'}
WHITE, MUTED, CYAN, GREEN, RED, YELLOW = '#E6EDF3', '#96A4B3', '#74D7EB', '#91DA9B', '#F5A4A4', '#EFCE88'
WIDTH, HEIGHT = A4
FONT_SIZE, LINE_HEIGHT = 9.5, 13.8
TOP, BOTTOM, LEFT = HEIGHT - 104, 48, 34
CAPACITY = math.floor((TOP - BOTTOM) / LINE_HEIGHT)
_font_lock = threading.Lock()


def _fonts():
    with _font_lock:
        if 'ITinderConsole' not in pdfmetrics.getRegisteredFontNames():
            windows = Path(os.environ.get('WINDIR', 'C:/Windows')) / 'Fonts'
            options = [(windows / 'consola.ttf', windows / 'consolab.ttf'),
                       (Path('/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf'),
                        Path('/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf'))]
            pair = next(((regular, bold) for regular, bold in options if regular.is_file() and bold.is_file()), None)
            if pair is None:
                raise UserError('Для PDF нужен шрифт Consolas или DejaVu Sans Mono', status=503)
            pdfmetrics.registerFont(TTFont('ITinderConsole', str(pair[0])))
            pdfmetrics.registerFont(TTFont('ITinderConsoleBold', str(pair[1])))
    return max(30, int((WIDTH - 2 * LEFT) / pdfmetrics.stringWidth('M', 'ITinderConsole', FONT_SIZE)))


def _clean(value):
    value = str(value or '').replace('\r\n', '\n').replace('\r', '\n').replace('\t', '    ')
    value = value.translate(str.maketrans({'—': '-', '–': '-', '‑': '-', '…': '...', '•': '*'}))
    glyphs = pdfmetrics.getFont('ITinderConsole').face.charToGlyph
    return ''.join(character if character == '\n' or ord(character) in glyphs else '?' for character in value
                   if character == '\n' or ord(character) >= 32)


def _lines(value, columns, color=WHITE, bold=False, indent=''):
    """Перенос слов и длинных токенов; исходные абзацы и пустые строки сохраняются."""
    rows = []
    available = columns - len(indent)
    for paragraph in _clean(value).split('\n'):
        while len(paragraph) > available:
            cut = paragraph.rfind(' ', 0, available + 1)
            if cut < available // 2:
                cut = available
            rows.append((indent + paragraph[:cut], color, bold))
            paragraph = paragraph[cut:].lstrip()
        rows.append((indent + paragraph, color, bold))
    return rows


def _date(value):
    try:
        dt = datetime.fromisoformat(value)
        if dt.tzinfo:
            dt = dt.astimezone(timezone(timedelta(hours=3)))
        return dt.strftime('%d.%m.%Y')
    except (TypeError, ValueError):
        return 'дата не указана'


def _blocks(profile, columns):
    blocks = []
    line = lambda text, color=WHITE, bold=False: _lines(text, columns, color, bold)
    heading = lambda text: line('[' + text + ']', CYAN, True) + line('-' * columns, MUTED)
    blank = line('')
    blocks.append(line(profile['name'] or 'Имя не указано', CYAN, True)
                  + line(' / '.join(s['name'] for s in profile['specializations']) or 'Специализация не указана')
                  + line('E-mail: ' + (profile['email'] or 'не указан'), MUTED)
                  + line(f"ФСП: {len(profile['fsp']['competencies'])} компетенций | "
                         f"Тесты: {sum(t['passed'] for t in profile['tests'])}/{len(profile['tests'])} пройдено | "
                         f"Соревнования: {len(profile['fsp']['competitions'])}", MUTED) + blank)

    section = heading('01 / СПЕЦИАЛИЗАЦИИ И ГРЕЙДЫ')
    for spec in profile['specializations']:
        rows = line(spec['name'], WHITE, True)
        rows += line('  Подтверждён тестом: ' + (spec['confirmed'] or 'нет'), GREEN if spec['confirmed'] else MUTED)
        source = 'из резюме' if spec['source'] == 'LLM' else 'выбран кандидатом' if spec['source'] == 'Manual' else 'источник не указан'
        rows += line('  Заявлен: ' + (spec['declared'] or 'не указан') + (' (' + source + ')' if spec['declared'] else ''), MUTED)
        if spec['refuted']:
            rows += line('  [!] Заявленный грейд не подтверждается результатами тестов.', YELLOW)
        blocks.append(section + rows + blank); section = []
    if section:
        blocks.append(section + line('Специализации пока не указаны.', MUTED) + blank)

    section = heading('02 / КОМПЕТЕНЦИИ ФСП')
    for kind, label in KINDS.items():
        skills = [c for c in profile['fsp']['competencies'] if c['kind'] == kind]
        if not skills:
            continue
        group = line(label, YELLOW, True)
        for skill in skills:
            meter = '[' + '#' * skill['degree'] + '.' * (3 - skill['degree']) + ']'
            rows = line(f"  {meter} {skill['name']} - {skill['degree_name']}, {skill['points']} б.", GREEN)
            evidence = [c['name'] for c in profile['fsp']['competitions'] if c['id'] in skill['competitions']]
            if evidence:
                rows += _lines('Подтверждение: ' + '; '.join(evidence), columns, MUTED, indent='        ')
            blocks.append(section + group + rows); section = []; group = []
        blocks.append(blank)
    if section:
        blocks.append(section + line('Компетенции пока не подтверждены соревнованиями.', MUTED) + blank)

    section = heading('03 / ИСТОРИЯ ТЕСТОВ НА ГРЕЙД')
    for test in profile['tests']:
        status = '[CREDIT] Засчитан в тестовой версии' if test['credited'] else '[PASS] Пройден' if test['passed'] else '[FAIL] Не пройден'
        rows = line(f"{_date(test['created_at'])} | {test['specialization']} / {test['grade']}", WHITE, True)
        rows += line(status, GREEN if test['passed'] else RED)
        if test['resource']:
            rows += line('  ' + test['resource'], YELLOW)
        for index, symptom in enumerate(test['symptoms'], 1):
            rows += _lines(f'{index}. {symptom}', columns, indent='  ')
        if not test['symptoms']:
            rows += line('  Условие задания недоступно.', MUTED)
        methods = 'тестовый зачёт' if test['credited'] else ' и '.join(
            name for enabled, name in ((test['procedural_check'], 'по правилам'), (test['llm_check'], 'нейросетью')) if enabled)
        rows += line(('  Язык: ' + test['language'] + '. ' if test['language'] else '  ') + 'Проверка: ' + (methods or 'способ не указан') + '.', MUTED)
        blocks.append(section + rows + blank); section = []
    if section:
        blocks.append(section + line('Тестов пока нет.', MUTED) + blank)
    else:
        blocks.append(line('В истории сохраняются итог и условие теста; ответы и код не сохраняются.', MUTED) + blank)

    section = heading('04 / ЗАДАНИЯ ПО ПРИГЛАШЕНИЯМ')
    for assignment in profile['assignments']:
        rows = line(assignment['title'], WHITE, True) + line(assignment['project'], MUTED)
        state = assignment['status']
        rows += line(assignment['status_name'] + ' | ' + _date(assignment['updated_at']),
                     GREEN if state == 'accepted' else RED if state in ('declined', 'solution_rejected') else YELLOW)
        for index, task in enumerate(assignment['tasks']):
            rows += line(f'Задание {index + 1}', CYAN, True) + _lines(task, columns, indent='  ')
            rows += line('Решение кандидата', CYAN)
            answer = (assignment['answers'][index] if index < len(assignment['answers']) else '') or 'Решение ещё не отправлено.'
            rows += _lines(answer, columns, indent='  ')
        blocks.append(section + rows + blank); section = []
    if section:
        blocks.append(section + line('Приглашений и откликов с заданиями пока нет.', MUTED) + blank)

    section = heading('05 / СОРЕВНОВАНИЯ ФСП')
    for competition in profile['fsp']['competitions']:
        rows = line(competition['name'], WHITE, True)
        rows += line(f"{_date(competition['start_date'])} - {_date(competition['end_date'])} | "
                     f"{LEVELS.get(competition['level'], competition['level'])}", MUTED)
        rows += line(competition['result'] + f" | {competition['points']} б.", GREEN)
        rows += line('Роль: ' + competition['role'], YELLOW) + _lines(competition['task'], columns, indent='  ')
        rows += line('Стек: ' + ', '.join(competition['competencies']), MUTED)
        blocks.append(section + rows + blank); section = []
    if section:
        blocks.append(section + line('Соревнования пока не добавлены в профиль.', MUTED) + blank)
    blocks.append(line(r'C:\ITinder> _', GREEN))
    return blocks


def _pages(blocks):
    pages, current = [], []
    for block in blocks:
        if len(block) <= CAPACITY and len(current) + len(block) > CAPACITY:
            pages.append(current); current = []
        while block:
            amount = min(CAPACITY - len(current), len(block))
            current.extend(block[:amount]); block = block[amount:]
            if len(current) == CAPACITY:
                pages.append(current); current = []
    if current:
        pages.append(current)
    return pages or [[]]


def render(profile):
    columns = _fonts()
    pages = _pages(_blocks(profile, columns))
    stream = io.BytesIO()
    document = canvas.Canvas(stream, pagesize=A4, pageCompression=1)
    document.setTitle('ITinder - Профиль кандидата')
    document.setAuthor('ITinder')
    for number, rows in enumerate(pages, 1):
        document.setFillColor(HexColor('#F0F1F3')); document.rect(0, 0, WIDTH, HEIGHT, fill=1, stroke=0)
        document.setFillColor(HexColor('#101216')); document.rect(18, 22, WIDTH - 36, HEIGHT - 44, fill=1, stroke=0)
        document.setFillColor(HexColor('#C4C8CE')); document.rect(18, HEIGHT - 50, WIDTH - 36, 28, fill=1, stroke=0)
        document.setFillColor(HexColor('#161A21')); document.setFont('ITinderConsoleBold', 10)
        document.drawString(LEFT, HEIGHT - 40, 'C:\\Windows\\System32\\cmd.exe - ITinder')
        for x, symbol in ((WIDTH - 72, '_'), (WIDTH - 54, '[]'), (WIDTH - 36, 'x')):
            document.drawString(x, HEIGHT - 40, symbol)
        document.setFont('ITinderConsole', 8.5); document.setFillColor(HexColor(MUTED))
        document.drawString(LEFT, HEIGHT - 70, 'ITinder Profile Export [v1.0]')
        document.setFillColor(HexColor(GREEN)); document.setFont('ITinderConsole', FONT_SIZE)
        document.drawString(LEFT, HEIGHT - 87, r'C:\ITinder> profile --export pdf' if number == 1 else f'C:\\ITinder> profile --page {number}')
        for index, (text, color, bold) in enumerate(rows):
            document.setFont('ITinderConsoleBold' if bold else 'ITinderConsole', FONT_SIZE)
            document.setFillColor(HexColor(color)); document.drawString(LEFT, TOP - index * LINE_HEIGHT, text)
        document.setFillColor(HexColor(MUTED)); document.setFont('ITinderConsole', 8)
        document.drawString(LEFT, 32, 'ITinder / Профиль кандидата')
        document.drawRightString(WIDTH - LEFT, 32, f'{number:02d} / {len(pages):02d}')
        document.showPage()
    document.save()
    return stream.getvalue()


def export(user_id):
    return render(candidate_profile.self_profile(user_id))
