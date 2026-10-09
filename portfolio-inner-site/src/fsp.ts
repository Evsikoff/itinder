// «Достижения в ФСП» — связка профиля ITinder с профилем участника ФСП
// (значок id 1 на рабочем столе). Это имитация: сервер (app/tools/fsp.py)
// проверяет только формат ФСП ID и сам «находит» соревнования из
// app/db/fsp_competitions.json, где пользователь мог участвовать в роли своей
// специализации; итоги случайны. После связки по таймеру «случаются» будущие
// соревнования (app/db/fsp_future_competitions.json).
// Диаграмма последовательности — как связка работала бы с настоящим ФСП через
// Keycloak — рисуется по app/assets/presentation/fsp_link/scenes.json.
import { request } from './api';

// Как в app/tools/fsp.py: латинские FSP, дефис, четыре цифры, дефис, четыре цифры.
export const FSP_ID_MASK = 'FSP-0000-0000';
const FSP_ID = /^FSP-\d{4}-\d{4}$/;

// ФСП ID в каноническом виде (заглавными, без пробелов по краям) или null, если не по маске.
export function normalizeFspId(value: string): string | null {
    const id = value.trim().toUpperCase();
    return FSP_ID.test(id) ? id : null;
}

export type CompetencyKind = 'languages' | 'databases' | 'integrations' | 'testing';
export type ResultId = 'solution' | 'prize' | 'win';

export interface FspRole {
    id: string; // backend, frontend, qa, analyst
    name: string;
    specialization: string;
}

export interface FspCompetition {
    id: string;
    name: string;
    format: 'hackathon' | 'championship' | 'marathon';
    level: 'regional' | 'interregional' | 'national' | 'international';
    venue: 'offline' | 'online' | 'hybrid';
    city: string | null;
    start_date: string; // YYYY-MM-DD
    end_date: string;
    teams: number | null;
    case_partner: string;
    task: string;
    role: { id: string; name: string; task: string }; // роль пользователя и что она делала в кейсе
    result: { id: ResultId; name: string; points: number };
    level_points: number;
    points: number; // балл итога плюс балл уровня
    competencies: { kind: CompetencyKind; kind_name: string; id: string; name: string }[];
    added_at: string | null;
}

export interface FspCompetency {
    kind: CompetencyKind;
    kind_name: string;
    id: string;
    name: string;
    points: number;
    degree: number; // 1 — базовая, 2 — уверенная, 3 — высокая
    degree_name: string;
    competitions: string[];
}

export interface FspDegree {
    points: number;
    degree: number;
    degree_name: string;
}

// Как изменится компетенция: before — null, если она новая.
export interface FspChange {
    kind: CompetencyKind;
    kind_name: string;
    id: string;
    name: string;
    before: FspDegree | null;
    after: FspDegree;
}

export interface FspState {
    linked: boolean;
    fsp_id: string | null;
    linked_at: string | null;
    role: FspRole | null; // null — у пользователя нет специализации соискателя
    competitions: FspCompetition[];
    competencies: FspCompetency[];
    declined: { id: string; name: string }[];
    pending: { competitions: FspCompetition[]; changes: FspChange[] } | null; // новые после связки
    recheck_after: number | null; // через сколько секунд созреет следующее будущее соревнование
    mask: string;
}

export interface FspDraft {
    draft_id: string;
    fsp_id: string;
    role: FspRole;
    competitions: FspCompetition[];
    changes: FspChange[];
}

export function fetchFspState(userId: string): Promise<FspState> {
    return request('ФСП', `/api/fsp?user_id=${encodeURIComponent(userId)}`);
}

export function linkFsp(userId: string, fspId: string): Promise<FspDraft> {
    return request('Связка с ФСП', '/api/fsp/link', post({ user_id: userId, fsp_id: fspId }));
}

export function saveFsp(userId: string, draftId: string): Promise<FspState> {
    return request('Связка с ФСП', '/api/fsp/save', post({ user_id: userId, draft_id: draftId }));
}

export function decideFsp(userId: string, competitionIds: string[], add: boolean): Promise<FspState> {
    return request(
        'Новые соревнования ФСП',
        '/api/fsp/decide',
        post({ user_id: userId, competition_ids: competitionIds, add })
    );
}

function post(body: object): RequestInit {
    return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

// --- Диаграмма последовательности ------------------------------------------------
// scenes.json: {"participants": [{"id", "name", "note"}], "scenes": [{"number",
// "title", "speaker_text", "audio": {"name", "url"}, "messages": [...]}]}.
// Сообщение — стрелка {"from", "to", "kind", "label", "detail"?, "at"?} или
// заметка {"note", "over": [id участника]}. kind: call — вызов (сплошная линия,
// закрашенный наконечник), reply — ответ (пунктир), event — событие без ожидания
// ответа (синяя линия, открытый наконечник); from = to — вызов самого себя.
// В label и detail {fsp_id} заменяется на ФСП ID пользователя. at — необязательно:
// в какой доле речи сцены (0…1) появляется стрелка; без него стрелки идут
// равномерно. Без записи речи сцена идёт в темпе чтения текста (FspSequence.tsx).

const SCENES_URL = '/app/assets/presentation/fsp_link/scenes.json';
const TIMEOUT = 15000;

export type MessageKind = 'call' | 'reply' | 'event';

export interface StoryParticipant {
    id: string;
    name: string;
    note: string;
}

export interface StoryArrow {
    from: string;
    to: string;
    kind: MessageKind;
    label: string;
    detail?: string;
    at?: number;
}

export interface StoryNote {
    note: string;
    over: string[];
    at?: number;
}

export type StoryMessage = StoryArrow | StoryNote;

export interface StoryScene {
    number: number;
    title: string;
    speaker_text: string;
    audio: { name: string; url: string };
    messages: StoryMessage[];
}

export interface Story {
    participants: StoryParticipant[];
    scenes: StoryScene[];
}

export function isNote(message: StoryMessage): message is StoryNote {
    return 'note' in message;
}

// Сценарий с сервера. Ошибка — Error с тем, что сказать пользователю.
export async function fetchStory(): Promise<Story> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT);
    let response: Response | undefined;
    let data: any = null;
    try {
        response = await fetch(SCENES_URL, { cache: 'no-cache', signal: controller.signal });
        if (response.ok) data = await response.json();
    } catch (error) {
        console.error(`Схема связки с ФСП: не загрузилась (${SCENES_URL}: ${error}). Запущен ли app/tools/serve.py?`);
    } finally {
        clearTimeout(timer);
    }
    if (!response) throw new Error('Не удалось загрузить схему: сервер не отвечает');
    if (!response.ok || !data) {
        console.error(`Схема связки с ФСП: HTTP ${response.status} (${SCENES_URL})`);
        throw new Error('Схема связки с ФСП не найдена на сервере');
    }
    const participants: StoryParticipant[] = Array.isArray(data.participants) ? data.participants : [];
    const known = new Set(participants.map((item) => item.id));
    const valid = (message: any): boolean =>
        typeof message?.note === 'string'
            ? Array.isArray(message.over) && message.over.length > 0 && message.over.every((id: string) => known.has(id))
            : known.has(message?.from) &&
              known.has(message?.to) &&
              ['call', 'reply', 'event'].includes(message?.kind) &&
              typeof message?.label === 'string';
    const scenes = (Array.isArray(data.scenes) ? data.scenes : []).filter(
        (scene: any) =>
            typeof scene?.number === 'number' &&
            typeof scene.speaker_text === 'string' &&
            typeof scene.audio?.url === 'string' &&
            Array.isArray(scene.messages)
    ) as StoryScene[];
    scenes.forEach((scene) => {
        const broken = scene.messages.filter((message) => !valid(message));
        if (broken.length) console.error(`Схема связки с ФСП: в сцене ${scene.number} пропущены сообщения`, broken);
        scene.messages = scene.messages.filter(valid);
    });
    if (participants.length < 2 || !scenes.length) {
        console.error(`Схема связки с ФСП: в ${SCENES_URL} нет участников или сцен`);
        throw new Error('В схеме связки с ФСП нет сцен');
    }
    return { participants, scenes: scenes.sort((a, b) => a.number - b.number) };
}
