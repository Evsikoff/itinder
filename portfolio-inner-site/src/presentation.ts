// Презентации окон: слайды, текст докладчика и пути к картинкам, видео и записям
// речи лежат в slides.json папки app/assets/presentation/<окно>; сервер
// (app/tools/serve.py) отдаёт его как обычный файл, правка видна без пересборки.
// Окно показывает свою презентацию при первом запуске — у каждого пользователя
// в этом браузере один раз, отметка лежит в localStorage.

const TIMEOUT = 15000; // мс на ответ сервера

export interface PresentationSource {
    url: string; // slides.json на сервере
    seenKey: string; // ключ отметки в localStorage, + id пользователя
}

// «Задачи на грейд»: как генератор собирает задания и почему их нельзя слить.
export const GRADE_TASKS_PRESENTATION: PresentationSource = {
    url: '/app/assets/presentation/grade_tasks/slides.json',
    seenKey: 'itinder.gradePresentation.seen.',
};

// «Соискатели»: как ITinder ранжирует кандидатов и как их пригласить.
export const APPLICANTS_PRESENTATION: PresentationSource = {
    url: '/app/assets/presentation/applicants/slides.json',
    seenKey: 'itinder.applicantsPresentation.seen.',
};

// «Вакансии»: как ITinder ранжирует вакансии для соискателя и как откликнуться.
export const VACANCIES_PRESENTATION: PresentationSource = {
    url: '/app/assets/presentation/vacancies/slides.json',
    seenKey: 'itinder.vacanciesPresentation.seen.',
};

// «Проекты и вакансии»: путь рекрутёра от анкеты проекта до найма.
export const PROJECTS_PRESENTATION: PresentationSource = {
    url: '/app/assets/presentation/projects_vacancies/slides.json',
    seenKey: 'itinder.projectsPresentation.seen.',
};

export interface PresentationMedia {
    name: string;
    url: string; // адрес на сервере: /app/assets/…
}

// Слайд — картинка или видео. Речь (audio) ведёт слайд: кончилась — следующий.
// У видео речи может не быть — тогда слайд ведёт звук самого видео; есть —
// видео идёт без звука по кругу, пока говорит докладчик. Текста докладчика
// у видео без речи может не быть (null) — тогда слайд занимает и его место.
export interface PresentationSlide {
    number: number; // порядок показа
    title: string;
    image?: PresentationMedia;
    video?: PresentationMedia;
    speaker_text?: string | null;
    audio?: PresentationMedia | null;
}

// Слайды по порядку. Ошибка — Error с тем, что сказать пользователю.
export async function fetchSlides(source: PresentationSource): Promise<PresentationSlide[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT);
    let response: Response | undefined;
    let data: unknown = null;
    try {
        response = await fetch(source.url, { cache: 'no-cache', signal: controller.signal });
        if (response.ok) data = await response.json();
    } catch (error) {
        console.error(`Презентация: не загрузилась (${source.url}: ${error}). Запущен ли app/tools/serve.py?`);
    } finally {
        clearTimeout(timer);
    }
    if (!response) throw new Error('Не удалось загрузить презентацию: сервер не отвечает');
    if (!response.ok) {
        console.error(`Презентация: HTTP ${response.status} (${source.url})`);
        throw new Error('Презентация не найдена на сервере');
    }
    const slides = (Array.isArray(data) ? data : []).filter(
        (slide: any) =>
            typeof slide?.number === 'number' &&
            (typeof slide.image?.url === 'string' || typeof slide.video?.url === 'string') &&
            (typeof slide.audio?.url === 'string' || typeof slide.video?.url === 'string') &&
            (typeof slide.speaker_text === 'string' || (slide.speaker_text == null && typeof slide.video?.url === 'string'))
    ) as PresentationSlide[];
    if (!slides.length) {
        console.error(`Презентация: в ${source.url} нет слайдов с number, image.url или video.url, audio.url и speaker_text (у видео без речи они не обязательны)`);
        throw new Error('В презентации нет слайдов');
    }
    return slides.sort((a, b) => a.number - b.number);
}

// Видел ли пользователь презентацию. Без localStorage (запрещён браузером) —
// считаем, что видел: иначе она открывалась бы при каждом запуске.
export function presentationSeen(source: PresentationSource, userId: string | null): boolean {
    try {
        return localStorage.getItem(source.seenKey + (userId ?? '')) !== null;
    } catch {
        return true;
    }
}

export function markPresentationSeen(source: PresentationSource, userId: string | null): void {
    try {
        localStorage.setItem(source.seenKey + (userId ?? ''), new Date().toISOString());
    } catch {
        // Не запомнили — покажем ещё раз, не страшно.
    }
}
