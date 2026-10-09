"""Запрос к нейросети с ответом в JSON.

ask(prompt) отправляет промпт в Gemini 3.8 Flash через прокси на Cloudflare
Workers. Если Gemini не ответила или ответ не разобрался как JSON, тот же
промпт уходит в DeepSeek V4.1 Flash; если Gemini молчит дольше HEDGE секунд —
тоже, и берётся первый годный ответ. Возвращается Answer: разобранный ответ —
объект (dict) или список (list) — и какая нейросеть его дала. Если
не справились обе, бросается LLMError с причиной по каждой.

Сеть: прокси — из настроек Windows или HTTPS_PROXY, заново на каждый запрос.
Если прокси не принимает подключения (VPN выключили, а прокси в настройках
остался), запрос идёт напрямую. На подключение — CONNECT_TIMEOUT: заблокированный
адрес не держит очередь, и до запасной модели доходит быстро.

Причины пишутся по-русски и называют, что сломалось: прокси или VPN не
запущен, сервис не ответил вовремя, ключ API не подошёл, кончились деньги или
квота, ответ — не JSON или не прошёл проверку. Ключей API в тексте нет.
Каждая причина — Failure(llm, model, error); у LLMError они в failures, у
Answer — failures моделей, которые не справились до той, что ответила.

ask(prompt, pdf=...) прикладывает к промпту файл PDF: обеим моделям уходит его
текст (пакет pypdf) после промпта. Сам файл получает только Gemini и только
если текста в нём нет (скан): без VPN провайдеры обрывают соединение с
Cloudflare, где стоит прокси Gemini, примерно после 24 КБ, а PDF в base64 —
это 60–150 КБ; текст резюме — 3–20 КБ. DeepSeek файлы не принимает, скан
она не прочтёт. Без VPN Gemini не прочтёт его тоже.

Ключи API берутся из GEMINI_API_KEY и DEEPSEEK_API_KEY в окружении.
Для локального запуска поддерживается игнорируемый git файл .env.local.

Запуск из корня проекта (выводит {"llm", "model", "data"}):
    python app/tools/llm.py "Придумай три вопроса по SQL. Ответ — JSON-список строк"
    python app/tools/llm.py < prompt.txt
    python app/tools/llm.py --pdf resume.pdf "Кто автор этого резюме? Ответ — JSON {\"name\"}"
"""

import argparse
import base64
import http.client
import io
import json
import logging
import os
import queue
import re
import socket
import ssl
import sys
import threading
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit
from urllib.request import HTTPSHandler, ProxyHandler, Request, build_opener, getproxies, proxy_bypass

ROOT = Path(__file__).resolve().parent.parent.parent
GEMINI_MODEL = "gemini-3.8-flash"
GEMINI_URL = "https://winter-frog-fd85.gsmevsikov.workers.dev/v1beta/models/{model}:generateContent?key={key}"
DEEPSEEK_MODEL = "deepseek-flash"  # DeepSeek-V4.1-Flash; deepseek-v4-pro умнее, но медленнее
DEEPSEEK_URL = "https://api.deepseek.com/chat/completions"
TIMEOUT = 120  # секунд на ответ одной модели, с размышлениями
CONNECT_TIMEOUT = 15  # секунд на подключение: заблокированный адрес не должен держать очередь 2 минуты
HEDGE = 20  # секунд молчания модели, после которых параллельно спрашивается следующая
# Cloudflare перед прокси отвечает 403 (error 1010) на User-Agent Python-urllib.
USER_AGENT = "ITinder/1.0"
SYSTEM = "Reply with valid JSON only: no markdown, no comments, no text around it."
PDF_TEXT_LIMIT = 60_000  # символов текста из PDF: резюме короче, остальное — мусор
CUT_SIZE = 20_000  # байт запроса: больше — без VPN к Cloudflare может не пройти (подсказка в ошибке)

KEY_ENV = {"gemini": "GEMINI_API_KEY", "deepseek": "DEEPSEEK_API_KEY"}

FENCE = re.compile(r"```(?:json)?\s*(.*?)\s*```", re.S | re.I)
MESSAGE_LIMIT = 300  # символов ответа сервера в тексте ошибки
log = logging.getLogger(__name__)

# Что значит код ответа сервиса нейросети.
HTTP_MEANINGS = {
    400: "запрос не принят",
    401: "ключ API не подошёл",
    402: "на счёте не хватает денег",
    403: "доступ запрещён: ключ, страна или защита Cloudflare",
    404: "нет такой модели или адреса",
    408: "сервис не дождался запроса",
    413: "запрос слишком большой",
    422: "в запросе ошибка",
    429: "слишком много запросов или кончилась квота",
    500: "сбой на стороне сервиса",
    502: "сервис недоступен",
    503: "сервис перегружен или недоступен",
    504: "сервис не ответил вовремя",
}
CLOUDFLARE_CODES = {"1010": "не пускает по User-Agent", "1015": "слишком часто, временный бан", "1020": "запрос заблокирован правилом"}
# Почему модель закончила ответ, ничего не написав (finishReason у Gemini, finish_reason у DeepSeek).
FINISH_REASONS = {
    "MAX_TOKENS": "ответ не уместился в лимит токенов",
    "LENGTH": "ответ не уместился в лимит токенов",
    "SAFETY": "ответ остановил фильтр безопасности",
    "CONTENT_FILTER": "ответ остановил фильтр безопасности",
    "RECITATION": "ответ остановлен: слишком похож на чужой текст",
    "PROHIBITED_CONTENT": "в запросе запрещённое содержимое",
}


@dataclass(frozen=True)
class Failure:
    """Почему модель не дала годный ответ: по-русски и без ключей API."""
    llm: str    # "Gemini" или "DeepSeek"
    model: str  # какую модель спрашивали
    error: str  # что случилось

    def __str__(self):
        return f"{self.llm} ({self.model}): {self.error}"

    def to_dict(self):
        return asdict(self)


@dataclass(frozen=True)
class Answer:
    data: dict | list     # ответ, разобранный из JSON
    llm: str              # какая нейросеть ответила: "Gemini" или "DeepSeek"
    model: str            # модель, как её назвал сервер в ответе, например "gemini-3.8-flash"
    failures: tuple = ()  # Failure моделей, которые не справились до неё


class LLMError(Exception):
    """Ни одна модель не дала годный ответ. summary — коротко, что случилось,
    failures — Failure по каждой модели. В тексте исключения — всё вместе."""

    def __init__(self, summary, failures=()):
        self.summary = summary
        self.failures = tuple(failures)
        super().__init__("\n".join([summary, *(f"  {failure}" for failure in self.failures)]))


class ModelError(Exception):
    """Одна модель не дала годный ответ. Текст — причина для Failure."""


# --- Ключи из окружения ---

def api_key(name):
    variable = KEY_ENV[name]
    key = os.environ.get(variable, "").strip()
    if not key:
        local_env = ROOT / ".env.local"
        if local_env.is_file():
            for line in local_env.read_text(encoding="utf-8-sig").splitlines():
                if line.strip().startswith(variable + "="):
                    key = line.strip().split("=", 1)[1].strip().strip("\"'")
                    break
    if not key:
        raise ModelError(f"не задана переменная окружения {variable}")
    return key


# --- Ошибки связи ---

def _short(text):
    text = re.sub(r"\s+", " ", str(text)).strip()
    return text if len(text) <= MESSAGE_LIMIT else text[:MESSAGE_LIMIT - 1] + "…"


def _scrub(text):
    """Убирает из текста ключи API: сервис или прокси может повторить адрес с ?key=."""
    text = re.sub(r"(key=)[^&\s\"'<>]+", r"\1***", text)
    for name in KEY_ENV:
        try:
            key = api_key(name)
        except ModelError:
            continue
        text = text.replace(key, "***")
    return text


def _server_message(raw):
    """Что сервис написал в ответе: message из JSON, код ошибки Cloudflare,
    заголовок HTML-страницы или начало текста."""
    text = raw.decode("utf-8", "replace").strip()
    try:
        data = json.loads(text)
    except ValueError:
        data = None
    if isinstance(data, list) and data and isinstance(data[0], dict):
        data = data[0]  # Gemini иногда отвечает списком
    if isinstance(data, dict):
        error = data.get("error")
        if isinstance(error, dict):
            message = error.get("message") or error.get("status") or error.get("type")
        else:
            message = error or data.get("message")
        if message:
            return _short(message)
    cloudflare = re.search(r"error code:?\s*(\d{4})", text, re.I)
    if cloudflare:
        code = cloudflare.group(1)
        return f"Cloudflare, ошибка {code}" + (f" — {CLOUDFLARE_CODES[code]}" if code in CLOUDFLARE_CODES else "")
    title = re.search(r"<title[^>]*>(.*?)</title>", text, re.I | re.S)
    return _short(re.sub(r"<[^>]+>", " ", title.group(1) if title else text))


def _http_problem(error):
    try:
        raw = error.read()
    except OSError:
        raw = b""
    meaning = HTTP_MEANINGS.get(error.code) or ("сбой на стороне сервиса" if error.code >= 500 else "запрос отклонён")
    message = _server_message(raw)
    return _scrub(f"HTTP {error.code} — {meaning}" + (f". Сервис ответил: {message}" if message else ""))


def _proxy_for(url, proxies):
    """Прокси из proxies, через который urllib пойдёт по этому адресу, без логина
    и пароля; None — напрямую. Исключения — как у ProxyHandler (NO_PROXY, настройки Windows)."""
    parts = urlsplit(url)
    proxy = proxies.get(parts.scheme)
    if not proxy or proxy_bypass(parts.hostname or ""):
        return None
    return re.sub(r"//[^/@]*@", "//", proxy)


def _network_problem(error, url, proxies, size=0):
    reason = error.reason if isinstance(error, URLError) else error
    host = urlsplit(url).hostname
    proxy = _proxy_for(url, proxies)
    via = f" (через прокси {proxy})" if proxy else ""
    # Без VPN провайдеры пропускают к Cloudflare около 24 КБ на соединение, а дальше
    # глушат: обрыв, «ошибка TLS» или тишина. Большой запрос напрямую — вероятная причина.
    hint = f" — запрос {size // 1024} КБ, а без VPN провайдер пропускает к Cloudflare около 24 КБ" if not proxy and size > CUT_SIZE else ""
    if isinstance(reason, _ConnectTimeout):
        return f"не удалось подключиться к {host} за {CONNECT_TIMEOUT} с{via} — адрес недоступен или заблокирован"
    # Таймаут в URLError — пока запрос уходил, без обёртки — пока ждали ответ.
    if isinstance(reason, TimeoutError) and isinstance(error, URLError):
        return f"запрос к {host} не ушёл за {TIMEOUT} с{via} — передача замерла{hint}"
    if isinstance(reason, TimeoutError):
        return f"{host} не ответил за {TIMEOUT} с{via}{hint}"
    if isinstance(reason, ConnectionRefusedError):
        if proxy:
            return f"прокси {proxy} не принимает подключения — VPN или прокси-клиент не запущен?"
        return f"{host} отверг подключение"
    if isinstance(reason, socket.gaierror):
        name = urlsplit(proxy).hostname if proxy else host
        return f"не найден адрес {name} — нет интернета или не отвечает DNS"
    if isinstance(reason, ssl.SSLCertVerificationError):
        return f"сертификат {host} не прошёл проверку{via}: {reason.verify_message}"
    if isinstance(reason, ssl.SSLError):
        return f"ошибка TLS при связи с {host}{via}: {reason.reason or reason}{hint}"
    if isinstance(reason, (ConnectionResetError, ConnectionAbortedError)):
        return f"соединение с {host} оборвалось{via}{hint}"
    if "Tunnel connection failed" in str(reason):
        return f"прокси {proxy} не смог соединиться с {host}: {reason}"
    detail = reason.strerror if isinstance(reason, OSError) and reason.strerror else reason
    return f"нет связи с {host}{via}: {detail}"


def _finish_problem(reason):
    meaning = FINISH_REASONS.get(str(reason).upper())
    return f"пустой ответ (причина: {reason}{f' — {meaning}' if meaning else ''})"


# --- Модели ---

class _ConnectTimeout(TimeoutError):
    """Не подключились за CONNECT_TIMEOUT."""


class _Connection(http.client.HTTPSConnection):
    """HTTPS с коротким временем на подключение (вместе с туннелем прокси и TLS):
    адрес, который молча блокируют, отваливается за CONNECT_TIMEOUT, и очередь
    доходит до следующей модели, а ответ модели по-прежнему ждётся TIMEOUT."""

    def connect(self):
        wait, self.timeout = self.timeout, CONNECT_TIMEOUT
        try:
            super().connect()
        except TimeoutError as error:
            raise _ConnectTimeout(str(error)) from None
        finally:
            self.timeout = wait
        self.sock.settimeout(wait)


class _HTTPSHandler(HTTPSHandler):
    def https_open(self, req):
        return self.do_open(_Connection, req, context=self._context)


def _open(url, data, headers, proxies):
    # Request каждый раз новый: ProxyHandler переписывает в нём адрес на прокси.
    request = Request(url, data=data, method="POST", headers=headers)
    with build_opener(ProxyHandler(proxies), _HTTPSHandler()).open(request, timeout=TIMEOUT) as response:
        return response.read()


def _post(url, body, headers=None):
    # Кириллица — как есть: в виде \uXXXX запрос вышел бы втрое больше.
    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    headers = {"Content-Type": "application/json", "User-Agent": USER_AGENT, **(headers or {})}
    # Прокси — заново на каждый запрос: urlopen запоминает их при первом вызове,
    # и сервер не заметил бы, что VPN включили или выключили после его запуска.
    proxies = getproxies()
    proxy = _proxy_for(url, proxies)
    # В адресе Gemini — ключ, поэтому адрес в текст ошибки и журнал не идёт: только хост.
    log.info("→ %s: %.1f КБ, %s", urlsplit(url).hostname, len(data) / 1024, f"через прокси {proxy}" if proxy else "напрямую")
    try:
        try:
            raw = _open(url, data, headers, proxies)
        except URLError as error:
            # VPN выключили, а его прокси остался в настройках Windows (или в
            # HTTPS_PROXY): порт закрыт. Тогда — напрямую, без прокси.
            if proxy is None or not isinstance(error.reason, ConnectionRefusedError):
                raise
            log.warning("Прокси %s не принимает подключения (VPN выключен?) — к %s напрямую", proxy, urlsplit(url).hostname)
            proxies = {}
            raw = _open(url, data, headers, proxies)
    except HTTPError as error:
        raise ModelError(_http_problem(error)) from None
    except OSError as error:  # URLError, таймаут, обрыв посреди ответа
        problem = _network_problem(error, url, proxies, len(data))
        if proxy and not proxies:
            problem = f"прокси {proxy} не принимает подключения, а напрямую: {problem}"
        raise ModelError(problem) from None
    try:
        return json.loads(raw.decode("utf-8"))
    except ValueError:
        raise ModelError(f"сервис ответил не JSON: {_scrub(_server_message(raw))}") from None


def ask_gemini(prompt, pdf=None):
    url = GEMINI_URL.format(model=GEMINI_MODEL, key=quote(api_key("gemini"), safe=""))
    parts = [{"text": prompt}]
    if pdf is not None:
        # Текст вместо файла: так запрос в разы меньше и проходит к Cloudflare без VPN.
        try:
            parts = [{"text": _with_pdf_text(prompt, pdf_text(pdf))}]
        except ValueError:  # скан без текста (или нет pypdf) — тогда сам файл
            parts.insert(0, {"inline_data": {"mime_type": "application/pdf", "data": base64.b64encode(pdf).decode("ascii")}})
    data = _post(url, {
        "systemInstruction": {"parts": [{"text": SYSTEM}]},
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": {"responseMimeType": "application/json"},
    })
    try:
        candidate = data["candidates"][0]
        parts = (candidate.get("content") or {}).get("parts") or []
        text = "".join(part.get("text", "") for part in parts if not part.get("thought"))
    except (KeyError, IndexError, TypeError, AttributeError):
        block = (data.get("promptFeedback") or {}).get("blockReason") if isinstance(data, dict) else None
        if block:
            raise ModelError(f"запрос заблокирован (blockReason: {block})") from None
        raise ModelError(f"в ответе нет текста: {_short(json.dumps(data, ensure_ascii=False))}") from None
    if not text.strip():
        raise ModelError(_finish_problem(candidate.get("finishReason")))
    return text, data.get("modelVersion") or GEMINI_MODEL


def pdf_text(pdf):
    """Текстовый слой PDF. Нет текста (скан, картинка) — ValueError."""
    try:
        from pypdf import PdfReader
    except ImportError:
        raise ValueError("не читает PDF без пакета pypdf (pip install pypdf)") from None
    try:
        reader = PdfReader(io.BytesIO(pdf))
        text = "\n".join(page.extract_text() or "" for page in reader.pages)
    except Exception as error:  # pypdf бросает разное на битых файлах
        raise ValueError(f"PDF не разобрался ({error})") from None
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", re.sub(r" ?\n ?", "\n", text)).strip()
    if not text:
        raise ValueError("в PDF нет текстового слоя (скан?), а файлы DeepSeek не читает")
    return text[:PDF_TEXT_LIMIT]


def _with_pdf_text(prompt, text):
    return f"{prompt}\n\nТекст приложенного PDF:\n<<<\n{text}\n>>>"


def ask_deepseek(prompt, pdf=None):
    if pdf is not None:
        prompt = _with_pdf_text(prompt, pdf_text(pdf))
    data = _post(DEEPSEEK_URL, {
        "model": DEEPSEEK_MODEL,
        "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": prompt}],
    }, {"Authorization": f"Bearer {api_key('deepseek')}"})
    try:
        choice = data["choices"][0]
        text = choice["message"]["content"] or ""
    except (KeyError, IndexError, TypeError):
        raise ModelError(f"в ответе нет текста: {_short(json.dumps(data, ensure_ascii=False))}") from None
    if not text.strip():
        raise ModelError(_finish_problem(choice.get("finish_reason")))
    return text, data.get("model") or DEEPSEEK_MODEL


# Название, модель по умолчанию (для текста ошибки) и функция запроса.
MODELS = (("Gemini", GEMINI_MODEL, ask_gemini), ("DeepSeek", DEEPSEEK_MODEL, ask_deepseek))


# --- Ответ ---

def parse_json(text):
    """Разбирает ответ модели. Годится только объект или список JSON,
    в том числе обёрнутый в ```json ... ```."""
    text = text.strip()
    fenced = FENCE.fullmatch(text)
    if fenced:
        text = fenced.group(1)
    try:
        data = json.loads(text)
    except ValueError as error:
        raise ValueError(f"ответила не JSON ({error}): {_short(text)!r}") from None
    if not isinstance(data, (dict, list)):
        raise ValueError(f"ответила не объект и не список JSON: {_short(text)!r}")
    return data


def _attempt(call, prompt, pdf, check):
    """Годный ответ одной модели: (data, модель по словам сервера) или ModelError."""
    try:
        text, model = call(prompt, pdf)
    except ModelError:
        raise
    except (ValueError, OSError) as error:  # ключ не расшифровался, PDF не прочитан
        raise ModelError(str(error)) from None
    try:
        data = parse_json(text)
    except ValueError as error:
        raise ModelError(str(error)) from None
    if check:
        try:
            check(data)
        except ValueError as error:
            raise ModelError(f"ответ не прошёл проверку: {error}") from None
    return data, model


def ask(prompt, check=None, pdf=None):
    """Отправляет промпт и возвращает Answer: ответ модели, разобранный из JSON
    (dict или list), и какая нейросеть его дала.

    Модели спрашиваются по очереди MODELS: следующая — когда предыдущая не
    справилась или молчит дольше HEDGE секунд (тогда обе работают параллельно,
    берётся первый годный ответ). Заглушенное соединение без VPN не держит
    очередь на TIMEOUT.

    check(data) — необязательная проверка содержимого. Если она бросает ValueError,
    ответ считается негодным и промпт уходит следующей модели.
    pdf — содержимое файла PDF (bytes), который прикладывается к промпту.
    """
    if not isinstance(prompt, str) or not prompt.strip():
        raise ValueError("Пустой промпт")
    results = queue.Queue()
    start = time.monotonic()

    def run(index):
        name, model, call = MODELS[index]
        began = time.monotonic()
        try:
            data, answered = _attempt(call, prompt, pdf, check)
        except ModelError as error:
            failure = Failure(name, model, str(error))
            log.warning("%s (за %.1f с)", failure, time.monotonic() - began)
            results.put((index, failure, None))
        except BaseException as error:  # ошибка в коде — вызывающему, а не в пустоту
            results.put((index, None, error))
        else:
            log.info("%s ответила за %.1f с", name, time.monotonic() - began)
            results.put((index, None, (data, answered)))

    launched, pending, failures = 0, set(), {}

    def launch():
        nonlocal launched
        threading.Thread(target=run, args=(launched,), daemon=True, name=f"llm-{MODELS[launched][0]}").start()
        pending.add(launched)
        launched += 1

    launch()
    while pending:
        try:
            index, failure, outcome = results.get(timeout=HEDGE if launched < len(MODELS) else None)
        except queue.Empty:
            log.warning("%s молчит %d с — спрашиваю и %s", MODELS[launched - 1][0], HEDGE, MODELS[launched][0])
            launch()
            continue
        pending.discard(index)
        if isinstance(outcome, BaseException):
            raise outcome
        if failure:
            failures[index] = failure
            if not pending and launched < len(MODELS):
                launch()
            continue
        data, answered = outcome
        name = MODELS[index][0]
        waited = round(time.monotonic() - start)
        for other in pending:  # ещё думают — в ответ не попадут
            failures[other] = Failure(*MODELS[other][:2], f"не ответила за {waited} с — взят ответ {name}")
        return Answer(data, name, answered, tuple(failures[i] for i in sorted(failures)))
    raise LLMError("Ни одна нейросеть не дала годный ответ", [failures[i] for i in sorted(failures)])


def main():
    parser = argparse.ArgumentParser(description="Спросить нейросеть и получить ответ в JSON.")
    parser.add_argument("prompt", nargs="?", help="промпт; без него читается из stdin")
    parser.add_argument("--pdf", type=Path, help="приложить к промпту файл PDF")
    args = parser.parse_args()
    # Иначе на Windows через pipe и файлы идёт cp1251, а JSON — это UTF-8.
    sys.stdin.reconfigure(encoding="utf-8-sig")
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    prompt = args.prompt if args.prompt is not None else sys.stdin.read()
    try:
        answer = ask(prompt, pdf=args.pdf.read_bytes() if args.pdf else None)
    except LLMError as error:
        sys.exit(f"Ошибка: {error}")
    for failure in answer.failures:
        print(f"Не справилась {failure}", file=sys.stderr)
    print(json.dumps({"llm": answer.llm, "model": answer.model, "data": answer.data}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
