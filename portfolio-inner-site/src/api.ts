// Кто сидит за компьютером и как спросить о нём сервер. Пользователя знает
// ITinder (app/web/src/session.js): после регистрации { id, email } лежит
// в sessionStorage вкладки под ключом itinder.user. Эта «операционная система»
// открыта с того же сервера (/os/, app/tools/serve.py) в той же вкладке —
// в iframe монитора комнаты resume3 — и видит ту же запись.

const SESSION_KEY = 'itinder.user';
const TIMEOUT = 15000; // мс на ответ сервера

export class ApiError extends Error {
    status: number; // 0 — сервер не ответил

    constructor(message: string, status: number) {
        super(message);
        this.status = status;
    }
}

// Идентификатор пользователя вкладки или null, если в ITinder он не входил.
export function currentUserId(): string | null {
    try {
        const user = JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? 'null');
        return typeof user?.id === 'string' ? user.id : null;
    } catch {
        return null;
    }
}

// Запрос к API сервера. Ошибка — ApiError с тем, что сказать пользователю:
// сервер отвечает { error }, подробности (detail) уходят в консоль.
// timeout — мс на ответ, если сервер думает дольше обычного (спрашивает нейросеть).
export async function request(label: string, path: string, init: RequestInit = {}, timeout = TIMEOUT): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    let response: Response | undefined;
    let data: any = {};
    try {
        response = await fetch(path, { ...init, signal: controller.signal });
        data = await response.json().catch(() => ({}));
    } catch (error) {
        console.error(`${label}: сервер не отвечает (${path}: ${error}). Запущен ли app/tools/serve.py?`);
    } finally {
        clearTimeout(timer);
    }
    if (!response) throw new ApiError('Сервер не отвечает', 0);
    if (response.ok) return data;
    // Не { error } от API, а страница ошибки: сервер запущен до того, как в нём
    // появился этот адрес. Для окна это то же, что сервер не ответил.
    if (data.error === undefined) {
        console.error(`${label}: HTTP ${response.status} без ответа API (${path}). Перезапустите app/tools/serve.py.`);
        throw new ApiError('Сервер устарел: перезапустите app/tools/serve.py', 0);
    }
    const detail = data.detail ? ` (на сервере: ${data.detail})` : '';
    (response.status >= 500 ? console.error : console.warn)(`${label}: HTTP ${response.status} — ${data.error}${detail}`);
    // Что случилось с каждой нейросетью, если сервер её спрашивал (app/tools/llm.py).
    if (Array.isArray(data.failures)) {
        data.failures.forEach((failure: any) => console.warn(`${label}: ${failure.llm} (${failure.model}): ${failure.error}`));
    }
    throw new ApiError(data.error, response.status);
}
