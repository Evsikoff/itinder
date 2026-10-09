// «Соискатели» — окно рекрутёра (значок id 9 на рабочем столе): поиск кандидатов
// по проекту, по вакансии, по специализации и грейду, приглашения.
// Сервер — app/tools/applicant_search.py (что показать), app/tools/ranking.py
// (релевантность), app/tools/invitations.py (приглашения в app/db/invitations).
import { request } from './api';
import type { Requirement, Salary } from './projects';

export type Kind = 'languages' | 'databases' | 'integrations' | 'testing';
export type Flow = 'plain' | 'assignment';
export type InvitationSource = 'team' | 'vacancy' | 'search';
export type InvitationType = 'От рекрутера кандидату' | 'От кандидата рекрутеру';

export interface StatusChange {
    status: string;
    at: string;
}

export interface Invitation {
    id: string;
    type: InvitationType;
    applicant_id: string;
    vacancy_id: string;
    project_id: string;
    title: string;
    flow: Flow; // набор статусов: без задания или с заданием
    status: string; // последний в истории
    status_history: StatusChange[];
    relevance: number | null;
    created_at: string;
}

export interface VacancyView {
    id: string;
    project_id: string;
    project_name: string;
    company: { id: string; name: string } | null;
    title: string;
    position_name: string;
    specialization: string;
    grade: string;
    count: number;
    task: string | null;
    requirements: Requirement[];
    assignments: string[];
    salary: Salary | null;
    status: 'draft' | 'ready';
    invited: { [status: string]: number }; // сколько приглашений сейчас в каждом статусе
    closed: boolean; // принятых приглашений не меньше count
    open: boolean; // готова и не закрыта: можно искать и приглашать
}

export interface ProjectView {
    id: string;
    name: string;
    company: { id: string; name: string };
    approved_at: string | null;
    vacancies: VacancyView[];
}

export interface Overview {
    projects: ProjectView[];
    stack: { [kind: string]: { [id: string]: string } }; // названия компетенций
    kind_names: { [kind: string]: string };
    degree_names: { [degree: string]: string };
    flows: { [flow in Flow]: { [status: string]: string } };
    specializations: string[];
    grades: string[];
    weights: { vacancy: Weights; specialization: Weights };
}

export interface Weights {
    grade: number;
    stack: number;
}

export interface GradeView {
    score: number;
    basis: string | null; // test, LLM, Manual или null — доказательств нет
    grade: string | null; // грейд того доказательства, что дало score
    declared: string | null;
    source: string | null;
    confirmed: string | null; // высший сданный тест
    refuted: boolean; // заявленный опровергнут тестом
}

export interface RequirementItem {
    id: string;
    via: string | null; // чем закрыто: сама компетенция или близкая
    relation: 'exact' | 'adjacent' | 'similar' | null;
    degree: number;
    score: number;
}

export interface RequirementFit {
    kind: Kind;
    ids: string[];
    match: 'all' | 'any';
    importance: 'required' | 'plus';
    min_degree: number;
    score: number;
    meets: boolean; // выполнено как написано
    items: RequirementItem[];
}

export interface Candidate {
    user_id: string;
    name: string | null;
    specialization: string;
    rank: number;
    relevance: number;
    grade: GradeView;
    stack: { score: number; basis: 'requirements' | 'profile' } | null;
    profile: { score: number; weight: number; kinds: { [kind: string]: { score: number; count: number } } } | null;
    fsp_linked: boolean;
    fsp_points: number | null;
    meets: { grade: boolean; required: boolean | null };
    competencies: { kind: Kind; id: string; degree: number }[];
    requirements: RequirementFit[] | null;
    invitation?: Invitation | null; // приглашение на вакансию экрана
    invitations?: Invitation[]; // все приглашения этого рекрутёра соискателю (поиск)
}

export interface TeamVacancy extends VacancyView {
    candidates: Candidate[];
    declined: number; // отказались или решение отклонено — в граф не попадают
}

export interface Team {
    project: { id: string; name: string; company: { id: string; name: string } };
    vacancies: TeamVacancy[];
    skipped: { closed: number; draft: number };
}

export interface Ranking {
    found: number;
    linked: number;
    meet_all: number;
    weights: Weights;
    candidates: Candidate[];
    unconfirmed: Candidate[];
}

export interface VacancyRanking extends Ranking {
    vacancy: VacancyView;
}

export interface SearchRanking extends Ranking {
    query: { specialization: string | null; grade: string | null };
}

export interface TestProjectsResult {
    created_projects: number;
    created_vacancies: number;
    project_ids: string[];
    vacancy_ids: string[];
}

const query = (params: { [name: string]: string }) =>
    Object.entries(params)
        .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
        .join('&');

export function fetchOverview(userId: string): Promise<Overview> {
    return request('Соискатели', `/api/applicants/overview?${query({ user_id: userId })}`);
}

export function fetchTeam(userId: string, projectId: string): Promise<Team> {
    return request('Команда проекта', `/api/applicants/team?${query({ user_id: userId, project_id: projectId })}`);
}

export function fetchVacancyRanking(userId: string, vacancyId: string): Promise<VacancyRanking> {
    return request('Соискатели вакансии', `/api/applicants/vacancy?${query({ user_id: userId, vacancy_id: vacancyId })}`);
}

export function fetchSearch(userId: string, specialization: string, grade: string): Promise<SearchRanking> {
    return request('Поиск соискателей', `/api/applicants/search?${query({ user_id: userId, specialization, grade })}`);
}

export function generateTestProjects(userId: string): Promise<TestProjectsResult> {
    return request('Тестовые проекты и вакансии', '/api/applicants/test-projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId }),
    });
}

export function sendInvitation(
    userId: string,
    vacancyId: string,
    applicantId: string,
    source: InvitationSource
): Promise<Invitation> {
    return request('Приглашение', '/api/invitations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId, vacancy_id: vacancyId, applicant_id: applicantId, source }),
    });
}
