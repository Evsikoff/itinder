// «Проекты и вакансии» — окно рекрутёра (значок id 8 на рабочем столе).
// Рекрутёр заводит проект: название, компания, анкета (app/db/project_questionnaire.json,
// её считает projectQuestionnaire.ts), потом правит и утверждает вакансии.
// Сервер — app/tools/projects.py: проекты в app/db/user_project_company,
// утверждённые вакансии в app/db/projects_jobopenings, компании в app/db/companies.
import { request } from './api';
import type { Applicant, QuestionnaireSchema, StackCatalog, TeamRole } from './projectQuestionnaire';

export interface Company {
    id: string;
    name: string;
    industry: string | null; // id варианта вопроса domain анкеты
    city: string | null;
    description: string | null;
}

export type ProjectStatus = 'draft' | 'open' | 'completed';
export type Importance = 'required' | 'plus';
export type RequirementOrigin = 'fixed' | 'market' | 'legacy' | 'rule' | 'manual';

export interface Requirement {
    kind: 'languages' | 'databases' | 'integrations' | 'testing';
    ids: string[];
    match: 'all' | 'any';
    importance: Importance;
    min_degree: number; // 1–3, степень подтверждения в ФСП
    origin: RequirementOrigin;
    reasons: string[];
}

export interface Salary {
    from: number | null;
    to: number | null;
    currency?: string;
}

// Вакансия: черновик из анкеты или утверждённая (тогда есть id файла и поля записи).
export interface Vacancy {
    id: string | null;
    title: string;
    position: string;
    position_name: string;
    role_id: string;
    specialization: string;
    grade: string;
    count: number;
    task: string | null;
    requirements: Requirement[];
    assignments: string[]; // задания: суть каждого — текстом рекрутёра
    salary: Salary | null;
    notes: string | null;
    status?: 'draft' | 'ready';
    approved_at?: string;
    closed_at?: string; // явное закрытие после найма всех требуемых людей
}

export interface OpenQuestion {
    text: string;
    blocking: boolean;
    origin: string | null;
    resolved: boolean;
}

export interface ProjectSummary {
    id: string;
    name: string;
    company: Company;
    status: ProjectStatus;
    vacancies: number;
    people: number;
    created_at: string;
    updated_at: string;
    approved_at: string | null;
    completed_at: string | null;
    copied_from: string | null;
    news?: ProjectNews;
    valid_vacancies?: number; // существующие вакансии, ещё не заполненные наймом
}

export interface ProjectNews {
    new_applications: number;
    accepted_invitations: number;
    assignments_to_review: number;
}

export interface AcceptedNews {
    id: string;
    revision: number;
}

export interface TestFeedbackResult {
    created_applications: number;
    accepted_invitations: number;
    submitted_assignments: number;
    forwarded_assignments: number;
    created_invitations: number;
    updated_invitations: number;
    invitation_ids: string[];
}

export interface Project extends ProjectSummary {
    questionnaire: { id: string; version: number };
    answers: { [key: string]: any };
    summary: { open_questions: OpenQuestion[]; [key: string]: any };
    approved: boolean;
    vacancies_list: Vacancy[];
    accepted_news?: AcceptedNews[];
}

export interface ProjectCatalog {
    questionnaire: QuestionnaireSchema;
    stack: StackCatalog;
    roles: TeamRole[];
    companies: Company[];
    market: Applicant[];
}

export interface NewProject {
    name: string;
    company: { id: string } | { name: string };
    answers: { [key: string]: any };
    summary: { [key: string]: any };
    vacancies: Vacancy[];
}

const query = (userId: string) => `user_id=${encodeURIComponent(userId)}`;

function post(label: string, path: string, body: object): Promise<any> {
    return request(label, path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

export function fetchCatalog(userId: string): Promise<ProjectCatalog> {
    return request('Анкета проекта', `/api/projects/catalog?${query(userId)}`);
}

export async function fetchProjects(userId: string): Promise<ProjectSummary[]> {
    const data = await request('Проекты', `/api/projects?${query(userId)}`);
    return data.projects;
}

export function fetchProject(userId: string, projectId: string): Promise<Project> {
    return request('Проект', `/api/project?${query(userId)}&project_id=${encodeURIComponent(projectId)}`);
}

export function markProjectNewsRead(
    userId: string,
    projectId: string,
    acceptedNews: AcceptedNews[]
): Promise<{ project_id: string; news: ProjectNews }> {
    return post('Просмотр новостей проекта', '/api/projects/news/read', {
        user_id: userId, project_id: projectId, accepted_news: acceptedNews,
    });
}

export function generateTestFeedback(userId: string): Promise<TestFeedbackResult> {
    return post('Тестовая обратная связь', '/api/projects/test-feedback', { user_id: userId });
}

export function createProject(userId: string, project: NewProject): Promise<Project> {
    return post('Новый проект', '/api/projects', { user_id: userId, ...project });
}

export function approveVacancies(
    userId: string,
    projectId: string,
    vacancies: Vacancy[],
    openQuestions: OpenQuestion[]
): Promise<Project> {
    return post('Утверждение вакансий', '/api/projects/vacancies', {
        user_id: userId,
        project_id: projectId,
        vacancies,
        open_questions: openQuestions,
    });
}

export function copyProject(userId: string, projectId: string, name: string): Promise<Project> {
    return post('Копия проекта', '/api/projects/copy', { user_id: userId, project_id: projectId, name });
}

export function completeProject(userId: string, projectId: string, completed: boolean): Promise<Project> {
    return post('Набор по проекту', '/api/projects/complete', { user_id: userId, project_id: projectId, completed });
}

export function deleteProject(userId: string, projectId: string): Promise<{ deleted: string; name: string }> {
    return post('Удаление проекта', '/api/projects/delete', { user_id: userId, project_id: projectId });
}
