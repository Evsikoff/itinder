// Запросы к API сервера (app/tools/serve.py). При ошибке сервер отвечает
// { error } — что сказать пользователю, а подробности кладёт в failures (что
// случилось с каждой нейросетью) или detail (исключение на сервере). Пользователь
// видит только error, подробности уходят в консоль браузера.

export class ApiError extends Error {
  constructor(message, status, data = {}) {
    super(message);
    this.status = status; // 0 — сервер не ответил
    this.data = data;
  }
}

// Строки про нейросети: «• Gemini (gemini-3.8-flash): что случилось».
export const failureLines = (failures) => (failures ?? []).map((f) => `• ${f.llm} (${f.model}): ${f.error}`);

const TIMEOUT = 30_000; // мс на ответ сервера по умолчанию

// label — что делали, для консоли: «Распознавание резюме». timeout — сколько мс
// ждать ответа: дольше — ApiError, а не вечное ожидание.
async function post(label, path, body, type, timeout = TIMEOUT) {
  const started = performance.now();
  let response;
  let data;
  try {
    response = await fetch(new URL(path, window.location.origin), {
      method: 'POST', headers: { 'Content-Type': type }, body, signal: AbortSignal.timeout(timeout),
    });
    data = await response.json().catch(() => ({}));
  } catch (error) {
    if (error.name === 'TimeoutError') {
      console.error(`${label}: сервер не ответил за ${timeout / 1000} с (POST ${path}). Что он делал — в журнале serve.py.`);
      throw new ApiError('Сервер не ответил вовремя', 0);
    }
    console.error(`${label}: сервер не отвечает (POST ${path}: ${error.message}). Запущен ли app/tools/serve.py?`);
    throw new ApiError('Сервер не отвечает', 0);
  }
  console.debug(`${label}: HTTP ${response.status} за ${((performance.now() - started) / 1000).toFixed(1)} с`);
  if (response.ok) return data;
  // 4xx — ошибка в данных, её уже покажет интерфейс; 5xx — что-то сломалось.
  const lines = [`${label}: HTTP ${response.status} — ${data.error ?? 'сервер не объяснил ошибку'}`, ...failureLines(data.failures)];
  if (data.detail) lines.push(`• на сервере: ${data.detail} (подробности — в журнале serve.py)`);
  (response.status >= 500 ? console.error : console.warn)(lines.join('\n'));
  throw new ApiError(data.error ?? `Сервер ответил ${response.status}`, response.status, data);
}

export const postJson = (label, path, data, timeout) => post(label, path, JSON.stringify(data), 'application/json', timeout);
export const postFile = (label, path, file, type, timeout) => post(label, path, file, type, timeout);
