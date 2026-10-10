"""PDF профиля кандидата: окно командной строки, векторный текст и пагинация.

Одна вёрстка для двух выгрузок: собственный профиль (окно «PDF-профиль»,
export) и профиль кандидата, который открыл рекрутёр (export_candidate).
В резюме идут только успешно сданные тесты на грейд: непройденные попытки и
задания вакансий из приглашений и откликов в PDF не попадают.

Текст набирается моноширинным шрифтом по колонкам, как в консоли: каждая
строка — набор фрагментов (span) своего цвета, у фрагмента и строки может
быть цветная подложка, как у выделения в cmd.
"""

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
SOURCES = {'LLM': 'из резюме', 'Manual': 'выбран кандидатом'}
WHITE, MUTED, DIM, CYAN, GREEN, YELLOW = '#E6EDF3', '#96A4B3', '#454D59', '#74D7EB', '#91DA9B', '#EFCE88'
INK, CONSOLE, BAND, FRAME = '#0F1115', '#101216', '#15303A', '#3E6E7B'
MSK = timezone(timedelta(hours=3))
WIDTH, HEIGHT = A4
FONT_SIZE, LINE_HEIGHT = 9.5, 13.8
# Окно: поля страницы, заголовок окна, полоса прокрутки справа.
WINDOW_X, WINDOW_BOTTOM, WINDOW_TOP, RADIUS = 20, 40, HEIGHT - 22, 7
TITLE_HEIGHT, SCROLLBAR = 28, 11
LEFT, RIGHT = WINDOW_X + 14, WIDTH - WINDOW_X - SCROLLBAR - 10
HEADER = WINDOW_TOP - TITLE_HEIGHT - 22  # баннер, строка (c), пустая строка, команда
TOP = HEADER - 4 * LINE_HEIGHT
BOTTOM = WINDOW_BOTTOM + 14 + LINE_HEIGHT  # нижняя строка окна — «-- Далее --»
CAPACITY = math.floor((TOP - BOTTOM) / LINE_HEIGHT) + 1
# Псевдографика есть в Consolas и DejaVu Sans Mono; если шрифт её не знает — ASCII.
FALLBACK = str.maketrans({'■': '#', '□': '.', '═': '=', '─': '-', '│': '|', '└': '+', '►': '>', '·': '.'})
_font_lock = threading.Lock()


def _fonts():
    """Регистрирует шрифт консоли; возвращает ширину знака."""
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
    return pdfmetrics.stringWidth('M', 'ITinderConsole', FONT_SIZE)


def _clean(value):
    value = str(value or '').replace('\r\n', '\n').replace('\r', '\n').replace('\t', '    ')
    value = value.translate(str.maketrans({'—': '-', '–': '-', '‑': '-', '…': '...', '•': '*'}))
    glyphs = pdfmetrics.getFont('ITinderConsole').face.charToGlyph
    known = lambda character: character == '\n' or ord(character) in glyphs
    return ''.join(character if known(character) else character.translate(FALLBACK)
                   if known(character.translate(FALLBACK)) else '?'
                   for character in value if character == '\n' or ord(character) >= 32)


def _span(text, color=WHITE, bold=False, background=None):
    return (_clean(text).replace('\n', ' '), color, bold, background)


def _row(*spans, fill=None):
    """Одна строка консоли — список из одной строки, чтобы блоки складывались через +."""
    return [(spans, fill)]


def _width(spans):
    return sum(len(span[0]) for span in spans)


def _wrap(value, width):
    """Перенос слов и длинных токенов; исходные абзацы и пустые строки сохраняются."""
    rows = []
    for paragraph in _clean(value).split('\n'):
        while len(paragraph) > width:
            cut = paragraph.rfind(' ', 0, width + 1)
            if cut < width // 2:
                cut = width
            rows.append(paragraph[:cut].rstrip())
            paragraph = paragraph[cut:].lstrip()
        rows.append(paragraph)
    return rows


def _lines(value, columns, color=WHITE, bold=False, indent=''):
    return [((_span(indent + text, color, bold),), None) for text in _wrap(value, max(10, columns - len(indent)))]


def _spread(left, right, columns, leader=' '):
    """Левые фрагменты у начала строки, правые — у правого края, между ними leader.
    Не помещается — правая часть встаёт отдельной строкой, длинная левая переносится."""
    gap = columns - _width(left) - _width(right)
    if gap >= 2:
        return _row(*left, _span(' ' + leader * (gap - 2) + ' ', DIM), *right)
    main = left[-1] if left else _span('')
    rows = _row(*left) if _width(left) <= columns else _lines(''.join(span[0] for span in left), columns, main[1], main[2])
    return rows + _row(_span(' ' * max(0, columns - _width(right))), *right)


def _date(value):
    try:
        dt = datetime.fromisoformat(value)
        if dt.tzinfo:
            dt = dt.astimezone(MSK)
        return dt.strftime('%d.%m.%Y')
    except (TypeError, ValueError):
        return 'дата не указана'


def _heading(number, title, columns):
    label, text = _span(f' {number} ', INK, True, CYAN), _span(f' {title}', CYAN, True)
    return _row(label, text, fill=BAND) + _row()


def _card(profile, specializations, tests, columns, for_recruiter):
    """Шапка между двойными линиями: имя, специализации, контакт и сводка."""
    text = lambda value, color=WHITE, bold=False: _lines(value, columns, color, bold, indent='  ')
    email = profile['email'] or ('откроется после принятия приглашения или отклика' if for_recruiter else 'не указан')
    rows = _row(_span('═' * columns, FRAME))
    rows += text(profile['name'] or 'Имя не указано', CYAN, True)
    rows += text(' · '.join(s['name'] for s in specializations) or 'Специализация не указана')
    contact = (_span('  E-mail: ', MUTED), _span(email, WHITE if profile['email'] else MUTED))
    rows += _row(*contact) if _width(contact) <= columns else text('E-mail: ' + email, MUTED)
    rows += _row(_span('─' * columns, FRAME))
    stats = (('Компетенций ФСП: ', len(profile['fsp']['competencies'])), ('Сдано тестов на грейд: ', len(tests)),
             ('Соревнований: ', len(profile['fsp']['competitions'])))
    spans = [_span('  ')]
    for index, (label, value) in enumerate(stats):
        spans += [_span(' │ ' if index else '', FRAME), _span(label, MUTED), _span(str(value), WHITE, True)]
    rows += _row(*spans) if _width(spans) <= columns else text(' | '.join(f'{l}{v}' for l, v in stats), MUTED)
    return rows + _row(_span('═' * columns, FRAME)) + _row()


def _grades(specializations, columns):
    """Таблица специализаций; не помещается в ширину — по строке на поле."""
    header = ('СПЕЦИАЛИЗАЦИЯ', 'ПОДТВЕРЖДЕНО ТЕСТОМ', 'ЗАЯВЛЕНО')
    cells = [tuple(_clean(value).replace('\n', ' ') for value in (
                 s['name'], ('■ ' + s['confirmed']) if s['confirmed'] else '□ нет',
                 (s['declared'] + ' · ' + SOURCES.get(s['source'], 'источник не указан')) if s['declared'] else 'не указан'))
             for s in specializations]
    widths = [max(len(row[index]) for row in [header, *cells]) + 3 for index in range(3)]
    if 2 + sum(widths) - 3 > columns:
        return [row for (name, confirmed, declared), spec in zip(cells, specializations)
                for row in _row(_span('  ' + name, WHITE, True))
                + _lines('Подтверждено тестом: ' + confirmed, columns, GREEN if spec['confirmed'] else MUTED, indent='    ')
                + _lines('Заявлено: ' + declared, columns, MUTED, indent='    ')]
    rows = _row(_span('  '), *(_span(title.ljust(width), MUTED) for title, width in zip(header, widths)))
    for (name, confirmed, declared), spec in zip(cells, specializations):
        rows += _row(_span('  '), _span(name.ljust(widths[0]), WHITE, True),
                     _span(confirmed.ljust(widths[1]), GREEN if spec['confirmed'] else DIM, bool(spec['confirmed'])),
                     _span(declared, WHITE if spec['declared'] else MUTED))
    return rows


def _blocks(profile, columns, for_recruiter):
    """Блоки строк; блок не разрывается между страницами, если помещается на одну."""
    tests = [test for test in profile['tests'] if test['passed']]
    passed = {test['specialization'] for test in tests}
    tested = {test['specialization'] for test in profile['tests']}
    # Специализация, известная только по непройденным попыткам, в резюме не попадает.
    specializations = [s for s in profile['specializations']
                       if s['declared'] or s['confirmed'] or s['name'] in passed or s['name'] not in tested]
    blank = _row()
    blocks = [_card(profile, specializations, tests, columns, for_recruiter)]

    section = _heading('01', 'СПЕЦИАЛИЗАЦИИ И ГРЕЙДЫ', columns)
    if specializations:
        blocks.append(section + _grades(specializations, columns) + blank)
    else:
        blocks.append(section + _lines('Специализации пока не указаны.', columns, MUTED, indent='  ') + blank)

    section = _heading('02', 'КОМПЕТЕНЦИИ ФСП', columns)
    for kind, label in KINDS.items():
        skills = [c for c in profile['fsp']['competencies'] if c['kind'] == kind]
        if not skills:
            continue
        group = _row(_span('  ' + label, YELLOW, True))
        for skill in skills:
            meter = (_span('  ' + '■' * skill['degree'], GREEN), _span('■' * (3 - skill['degree']) + ' ', DIM))
            rows = _spread((*meter, _span(skill['name'], WHITE, True)),
                           (_span(f"{skill['degree_name']} · {skill['points']} б.", GREEN),), columns, '.')
            evidence = [c['name'] for c in profile['fsp']['competitions'] if c['id'] in skill['competitions']]
            if evidence:
                rows += _lines('└ ' + '; '.join(evidence), columns, MUTED, indent='      ')
            blocks.append(section + group + rows); section = []; group = []
        blocks.append(blank)
    if section:
        blocks.append(section + _lines('Компетенции пока не подтверждены соревнованиями.', columns, MUTED, indent='  ') + blank)

    section = _heading('03', 'ТЕСТЫ НА ГРЕЙД', columns)
    for test in tests:
        badge = _span(' ЗАСЧИТАН ' if test['credited'] else ' СДАН ', INK, True, YELLOW if test['credited'] else GREEN)
        rows = _spread((_span('  ► ', GREEN), _span(_date(test['created_at']) + '  ', MUTED),
                        _span(f"{test['specialization']} / {test['grade']}", WHITE, True)), (badge,), columns)
        if test['resource']:
            rows += _lines(test['resource'], columns, YELLOW, indent='    ')
        for index, symptom in enumerate(test['symptoms'], 1):
            rows += _lines(f'{index}. {symptom}', columns, indent='    ')
        if not test['symptoms']:
            rows += _lines('Условие задания недоступно.', columns, MUTED, indent='    ')
        methods = 'засчитан в тестовой версии' if test['credited'] else ' и '.join(
            name for enabled, name in ((test['procedural_check'], 'по правилам'), (test['llm_check'], 'нейросетью')) if enabled)
        rows += _lines(('Язык: ' + test['language'] + ' · ' if test['language'] else '') + 'Проверка: '
                       + (methods or 'способ не указан'), columns, MUTED, indent='    ')
        blocks.append(section + rows + blank); section = []
    if section:
        blocks.append(section + _lines('Сданных тестов на грейд пока нет.', columns, MUTED, indent='  ') + blank)
    else:
        blocks.append(_lines('Показаны сданные тесты: итог и условие; ответы и код не сохраняются.', columns, MUTED, indent='  ') + blank)

    section = _heading('04', 'СОРЕВНОВАНИЯ ФСП', columns)
    for competition in profile['fsp']['competitions']:
        rows = _spread((_span('  ► ', CYAN), _span(competition['name'], WHITE, True)),
                       (_span(f"{_date(competition['start_date'])} - {_date(competition['end_date'])}", MUTED),), columns)
        rows += _lines(f"{LEVELS.get(competition['level'], competition['level'])} · {competition['result']} · "
                       f"{competition['points']} б.", columns, GREEN, indent='    ')
        rows += _lines('Роль: ' + competition['role'], columns, YELLOW, indent='    ')
        rows += _lines(competition['task'], columns, indent='    ')
        rows += _lines('Стек: ' + (', '.join(competition['competencies']) or 'не указан'), columns, MUTED, indent='    ')
        blocks.append(section + rows + blank); section = []
    if section:
        blocks.append(section + _lines('Соревнования пока не добавлены в профиль.', columns, MUTED, indent='  ') + blank)
    blocks.append(_row(_span(r'C:\ITinder>', GREEN), _span(' '), _span(' ', background=GREEN)))
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


def _window(document, number, total):
    """Окно cmd.exe: тень, заголовок с кнопками, консоль и полоса прокрутки."""
    width, height = WIDTH - 2 * WINDOW_X, WINDOW_TOP - WINDOW_BOTTOM
    title = WINDOW_TOP - TITLE_HEIGHT
    document.setFillColor(HexColor('#E8EBEF')); document.rect(0, 0, WIDTH, HEIGHT, fill=1, stroke=0)
    document.saveState()
    document.setFillColor(HexColor('#1B2430'))
    for spread, alpha in ((6, 0.04), (4, 0.06), (2, 0.08)):
        document.setFillAlpha(alpha)
        document.roundRect(WINDOW_X - spread, WINDOW_BOTTOM - spread - 2, width + 2 * spread, height + 2 * spread,
                           RADIUS + spread, fill=1, stroke=0)
    document.restoreState()
    document.setFillColor(HexColor('#F5F6F8')); document.setStrokeColor(HexColor('#B9BFC8')); document.setLineWidth(0.6)
    document.roundRect(WINDOW_X, WINDOW_BOTTOM, width, height, RADIUS, fill=1, stroke=1)
    document.setFillColor(HexColor(CONSOLE))
    document.roundRect(WINDOW_X + 0.3, WINDOW_BOTTOM + 0.3, width - 0.6, title - WINDOW_BOTTOM, RADIUS, fill=1, stroke=0)
    document.rect(WINDOW_X + 0.3, title - RADIUS, width - 0.6, RADIUS, fill=1, stroke=0)
    # Значок консоли и путь в заголовке.
    middle = title + TITLE_HEIGHT / 2
    document.setFillColor(HexColor('#1F2329')); document.roundRect(LEFT, middle - 6, 15, 12, 2, fill=1, stroke=0)
    document.setFillColor(HexColor('#E6EDF3')); document.setFont('ITinderConsoleBold', 6.5)
    document.drawString(LEFT + 2.2, middle - 2.4, '>_')
    document.setFillColor(HexColor('#1F2329')); document.setFont('ITinderConsole', 8.8)
    document.drawString(LEFT + 23, middle - 3, r'C:\Windows\System32\cmd.exe - itinder profile')
    # Свернуть, развернуть, закрыть.
    document.setStrokeColor(HexColor('#2B3038')); document.setLineWidth(0.8)
    right = WINDOW_X + width
    document.line(right - 112, middle, right - 102, middle)
    document.rect(right - 72, middle - 4.5, 9, 9, fill=0, stroke=1)
    document.line(right - 33, middle - 4.5, right - 24, middle + 4.5)
    document.line(right - 33, middle + 4.5, right - 24, middle - 4.5)
    document.setStrokeColor(HexColor('#D3D7DD')); document.setLineWidth(0.6)
    document.line(WINDOW_X + 0.3, title, right - 0.3, title)
    # Полоса прокрутки: бегунок стоит там, где эта страница во всём профиле.
    bar_x, bar_bottom, bar_top = right - SCROLLBAR - 1, WINDOW_BOTTOM + RADIUS + 3, title - 1
    document.setFillColor(HexColor('#181B21')); document.rect(bar_x, bar_bottom, SCROLLBAR, bar_top - bar_bottom, fill=1, stroke=0)
    document.setFillColor(HexColor('#5B636F'))
    for tip, base in ((bar_top - 5, bar_top - 9), (bar_bottom + 5, bar_bottom + 9)):
        path = document.beginPath()
        path.moveTo(bar_x + SCROLLBAR / 2, tip); path.lineTo(bar_x + 2.5, base); path.lineTo(bar_x + SCROLLBAR - 2.5, base); path.close()
        document.drawPath(path, fill=1, stroke=0)
    track_top, track_bottom = bar_top - 13, bar_bottom + 13
    thumb = max(24, (track_top - track_bottom) / total)
    offset = (track_top - track_bottom - thumb) * (number - 1) / max(1, total - 1)
    document.setFillColor(HexColor('#3B424D'))
    document.roundRect(bar_x + 2, track_top - offset - thumb, SCROLLBAR - 4, thumb, 2.5, fill=1, stroke=0)


def _draw(document, y, spans, fill, cell, columns):
    if fill:
        document.setFillColor(HexColor(fill))
        document.rect(LEFT - 3, y - 3.6, columns * cell + 6, LINE_HEIGHT, fill=1, stroke=0)
    column = 0
    for text, _, _, background in spans:
        if background and text:
            document.setFillColor(HexColor(background))
            document.rect(LEFT + column * cell, y - 3.6, len(text) * cell, LINE_HEIGHT, fill=1, stroke=0)
        column += len(text)
    # Одним текстовым объектом: строка копируется и ищется в PDF целиком.
    line = document.beginText(LEFT, y)
    for text, color, bold, _ in spans:
        line.setFont('ITinderConsoleBold' if bold else 'ITinderConsole', FONT_SIZE)
        line.setFillColor(HexColor(color)); line.textOut(text)
    document.drawText(line)


def render(profile, for_recruiter=False):
    cell = _fonts()
    columns = max(30, int((RIGHT - LEFT) / cell))
    pages = _pages(_blocks(profile, columns, for_recruiter))
    created = datetime.now(MSK).strftime('%d.%m.%Y %H:%M')
    command = 'candidate --export pdf' if for_recruiter else 'profile --export pdf'
    stream = io.BytesIO()
    document = canvas.Canvas(stream, pagesize=A4, pageCompression=1)
    document.setTitle('ITinder - Профиль кандидата' + (f" - {profile['name']}" if profile.get('name') else ''))
    document.setAuthor('ITinder')
    for number, rows in enumerate(pages, 1):
        _window(document, number, len(pages))
        _draw(document, HEADER, (_span('ITinder Profile Export [Version 1.1]', MUTED),), None, cell, columns)
        _draw(document, HEADER - LINE_HEIGHT, (_span(f'(c) ITinder. Сформировано {created} (МСК). '
                                                   f'Страница {number} из {len(pages)}.', MUTED),), None, cell, columns)
        _draw(document, HEADER - 2.5 * LINE_HEIGHT, (_span(r'C:\ITinder>', GREEN), _span(' ' + command
              + (f' --page {number}' if number > 1 else ''), WHITE)), None, cell, columns)
        for index, (spans, fill) in enumerate(rows):
            _draw(document, TOP - index * LINE_HEIGHT, spans, fill, cell, columns)
        if number < len(pages):
            _draw(document, BOTTOM - LINE_HEIGHT, (_span('-- Далее --', MUTED),), None, cell, columns)
        document.setFillColor(HexColor('#6B7480')); document.setFont('ITinderConsole', 7.5)
        document.drawString(WINDOW_X + 4, 22, 'ITinder · Профиль кандидата')
        document.drawRightString(WIDTH - WINDOW_X - 4, 22, f'{number:02d} / {len(pages):02d}')
        document.showPage()
    document.save()
    return stream.getvalue()


def export(user_id):
    """PDF собственного профиля соискателя."""
    return render(candidate_profile.self_profile(user_id))


def export_candidate(user_id, applicant_id):
    """PDF профиля кандидата для рекрутёра: те же права, что у candidate_profile.profile."""
    return render(candidate_profile.profile(user_id, applicant_id), for_recruiter=True)
