// Окно кандидата (значок 4): входящие приглашения и исходящие отклики.
// Список не отмечает уведомления просмотренными; это отдельное действие при открытии записи.
// Вход в окно гасит только восклицательный знак значка (dismissCandidateInvitationsAlert).
import { request } from './api';
import type { Flow, InvitationType, StatusChange } from './applicants';
import type { Requirement, Salary } from './projects';

export interface InvitationVacancy {
    id: string;
    title: string;
    position_name?: string;
    specialization: string;
    grade: string;
    count?: number;
    company: { id: string; name: string } | null;
    project?: { name?: string; summary?: string; work_format?: string; city?: string | null } | null;
    task: string | null;
    requirements: Requirement[];
    assignments: string[];
    salary: Salary | null;
    notes?: string | null;
}

export interface CandidateInvitation {
    id: string;
    type: InvitationType;
    applicant_id?: string;
    recruiter_id: string;
    recruiter_name: string | null;
    vacancy: InvitationVacancy;
    flow: Flow;
    status: string;
    status_history: StatusChange[];
    revision: number;
    created_at: string;
    assignment_answers: string[] | null;
    unseen: boolean;
    can_respond: boolean;
}

export interface CandidateInvitationsData {
    invitations: CandidateInvitation[];
    flows: { [flow in Flow]: { [status: string]: string } };
    stack: { [kind: string]: { [id: string]: string } };
    kind_names: { [kind: string]: string };
    degree_names: { [degree: string]: string };
}

export interface GeneratedCandidateInvitations {
    created_invitations: number;
    invitation_ids: string[];
}

export function fetchCandidateInvitations(userId: string): Promise<CandidateInvitationsData> {
    return request('Приглашения и отклики', `/api/applicant/invitations?user_id=${encodeURIComponent(userId)}`);
}

export function generateCandidateInvitations(userId: string): Promise<GeneratedCandidateInvitations> {
    return request('Тестовые приглашения', '/api/applicant/invitations/test-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId }),
    });
}

export function markCandidateInvitationRead(
    userId: string,
    invitationId: string,
    expectedRevision: number
): Promise<CandidateInvitation> {
    return request('Просмотр приглашения', '/api/applicant/invitations/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId, invitation_id: invitationId, expected_revision: expectedRevision }),
    });
}

export interface ShownInvitation {
    id: string;
    revision: number;
}

export function dismissCandidateInvitationsAlert(
    userId: string,
    shown: ShownInvitation[]
): Promise<{ dismissed: number; alert: string | null }> {
    return request('Восклицательный знак приглашений', '/api/applicant/invitations/dismiss-alert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId, shown }),
    });
}

export function respondToCandidateInvitation(
    userId: string,
    invitationId: string,
    action: 'accept' | 'decline',
    expectedRevision: number,
    answers?: string[]
): Promise<CandidateInvitation> {
    return request('Ответ на приглашение', '/api/applicant/invitations/respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId, invitation_id: invitationId, action, expected_revision: expectedRevision, answers }),
    });
}
