// «Вакансии» — окно соискателя (значок id 3 на рабочем столе): открытые вакансии
// его специализаций по релевантности для него и отклики на них.
// Сервер — app/tools/vacancy_search.py (что показать, отклик), app/tools/vacancy_ranking.py
// (релевантность), отклики пишутся в app/db/invitations рядом с приглашениями.
import { request } from './api';
import type { Flow, GradeView, InvitationType, Kind, RequirementFit, StatusChange, Weights } from './applicants';
import type { CandidateInvitation } from './candidateInvitations';
import type { Requirement, Salary } from './projects';

// Компетенция ФСП соискателя и нужна ли она вакансии: share — доля в «сильных сторонах».
export interface StrengthItem {
    kind: Kind;
    id: string;
    degree: number;
    weight: number; // степень / 3 × 0,7^n — сильные первыми
    share: number; // 0 — не нужна, 1 — в обязательных требованиях
    relation: 'exact' | 'adjacent' | 'similar' | null;
    via: string | null; // какую компетенцию требования закрывает
    importance: 'required' | 'plus' | null;
}

// Подхожу — как рекрутёр видит соискателя на этой вакансии.
export interface Fit {
    score: number; // релевантность у рекрутёра / 100
    grade: GradeView;
    stack: { score: number; basis: 'requirements' | 'profile' } | null;
    meets: { grade: boolean; required: boolean | null };
    linked: boolean; // профиль связан с ФСП
    requirements: RequirementFit[] | null;
}

// Подходит — что вакансия даёт соискателю.
export interface Appeal {
    score: number;
    strengths: { score: number; basis: 'requirements' | 'free' | 'unknown'; items: StrengthItem[] };
    growth: { score: number; own: string | null; step: number | null }; // step — грейд вакансии минус свой
}

// Очередь — место в списке рекрутёра по вакансии.
export interface Queue {
    score: number;
    place: number;
    of: number;
    seats: number; // свободных мест
}

// Отклик или приглашение на вакансию: type делит их на «Отклики» и «Приглашения».
export interface OwnRecord {
    id: string;
    type: InvitationType;
    flow: Flow;
    status: string;
    status_history: StatusChange[];
    created_at: string | null;
}

export interface RankedVacancy {
    id: string;
    rank: number;
    relevance: number;
    mutual: number; // √(подхожу × подходит)
    title: string;
    position_name: string | null;
    specialization: string;
    grade: string;
    count: number;
    seats: number;
    task: string | null;
    notes: string | null;
    requirements: Requirement[];
    assignments: string[];
    salary: Salary | null;
    company: { id: string; name: string } | null;
    project: {
        id: string;
        name: string;
        summary: string | null;
        domain: string | null;
        stage: string | null;
        duration: string | null;
        start_date: string | null;
        work_format: string | null;
        city: string | null;
    };
    recruiter_name: string | null;
    approved_at: string | null;
    fit: Fit;
    appeal: Appeal;
    queue: Queue;
    record: OwnRecord | null;
    can_apply: boolean;
}

export interface VacanciesData {
    specializations: string[];
    fsp_linked: boolean;
    found: number;
    weights: { appeal: Weights; queue: number; fit: Weights };
    growth: { [step: string]: number };
    vacancies: RankedVacancy[];
    stack: { [kind: string]: { [id: string]: string } };
    kind_names: { [kind: string]: string };
    degree_names: { [degree: string]: string };
    flows: { [flow in Flow]: { [status: string]: string } };
    grades: string[];
}

export function fetchVacancies(userId: string): Promise<VacanciesData> {
    return request('Вакансии', `/api/vacancies?user_id=${encodeURIComponent(userId)}`);
}

// Отклик; у вакансии с заданиями — с решением каждого (answers).
export function applyToVacancy(userId: string, vacancyId: string, answers?: string[]): Promise<CandidateInvitation> {
    return request('Отклик на вакансию', '/api/vacancies/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId, vacancy_id: vacancyId, answers }),
    });
}
