import { request } from './api';

export interface FeedbackInvitation {
    id: string;
    applicant_id: string;
    name: string | null;
    type: string;
    kind: 'invitation' | 'application';
    flow: 'plain' | 'assignment';
    status: string;
    status_name: string;
    revision: number;
    status_history: { status: string; at: string }[];
    relevance: number | null;
    created_at: string | null;
    email: string | null;
    assignments: string[];
    assignment_answers: string[];
    expert_email: string | null;
    can_send_to_expert: boolean;
    can_decide: boolean;
    can_respond_application: boolean;
}

export interface FeedbackVacancy {
    id: string;
    title: string;
    count: number;
    accepted: number;
    closed_at: string | null;
    can_close: boolean;
    invitations: FeedbackInvitation[];
}

export interface ProjectFeedbackData {
    project_id: string;
    vacancies: FeedbackVacancy[];
}

export function fetchProjectFeedback(userId: string, projectId: string): Promise<ProjectFeedbackData> {
    return request('Обратная связь проекта', `/api/projects/feedback?user_id=${encodeURIComponent(userId)}&project_id=${encodeURIComponent(projectId)}`);
}

export function reviewProjectInvitation(
    userId: string, projectId: string, invitation: FeedbackInvitation,
    action: 'send' | 'approve' | 'reject', email?: string
): Promise<{ id: string; status: string; revision: number }> {
    return request('Проверка решения', '/api/projects/feedback/review', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId, project_id: projectId, invitation_id: invitation.id,
            expected_revision: invitation.revision, action, email }),
    });
}

export function respondToApplication(
    userId: string, projectId: string, invitation: FeedbackInvitation, action: 'accept' | 'decline'
): Promise<{ id: string; status: string; revision: number }> {
    return request('Ответ на отклик', '/api/projects/feedback/respond', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId, project_id: projectId, invitation_id: invitation.id,
            expected_revision: invitation.revision, action }),
    });
}

export function closeFeedbackVacancy(userId: string, projectId: string, vacancyId: string): Promise<{ id: string; closed_at: string }> {
    return request('Закрытие вакансии', '/api/projects/feedback/close', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId, project_id: projectId, vacancy_id: vacancyId }),
    });
}
