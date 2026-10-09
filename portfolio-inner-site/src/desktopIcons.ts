// Дополнительные значки рабочего стола. Какие показать, решает сервер
// (app/tools/desktop_icons.py) по специализациям пользователя: рекрутеру —
// значки режима Recruiter, соискателю — Applicant, кто и то и другое — оба
// набора. Сами значки — app/db/additional_desktop_icons.json. У «Задач на грейд»
// сервер ставит тревогу (alert), пока пользователь не прошёл ни одного теста,
// у «Достижений в ФСП» — пока профиль не связан с ФСП и когда нашлись новые
// соревнования.
import { request } from './api';

export type DesktopMode = 'Applicant' | 'Recruiter';

export interface AdditionalDesktopIcon {
    id: number;
    mode: DesktopMode;
    name: string;
    image: string | null; // адрес картинки на сервере: /app/assets/fsp.png
    alert: string | null; // красный восклицательный знак у значка — о чём он (подсказка)
}

export interface DesktopIcons {
    modes: DesktopMode[]; // по порядку: сначала Applicant, потом Recruiter
    icons: AdditionalDesktopIcon[]; // в том же порядке режимов
    recheck_after: number | null; // через сколько секунд тревога может появиться сама — спросить снова
}

export function fetchDesktopIcons(userId: string): Promise<DesktopIcons> {
    return request('Значки рабочего стола', `/api/desktop_icons?user_id=${encodeURIComponent(userId)}`);
}
